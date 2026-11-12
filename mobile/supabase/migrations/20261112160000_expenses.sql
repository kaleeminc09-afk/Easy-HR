-- NorthShift expenses (step 1 of the expense module build).
-- Design: files/northshift-expense-module-design.md. Decisions (2026-11-12):
--   * Receipt HARD REQUIRED for money expenses (CHECK constraint below);
--     mileage needs kilometres, not a receipt.
--   * NO billing gate on expense creation (Kaleem's call) — unlike shifts/worksites.
--   * Fields cut: worksite, payment method. All approved items are reimbursable.
--   * Storage: new private bucket expense-receipts, paths
--     <business_id>/<user_id>/<expense_id>/<filename>, policies scoped to the
--     caller's own business (unlike the older employee-documents policies, whose
--     manager branch is global — flagged separately, not changed here).
-- Policies go through the SECURITY DEFINER helpers my_business_id() / is_manager()
-- and NEVER query their own table inline (see the 2026-11-12 recursion outage).
-- GRANTS: this migration deliberately contains NO grant block. The app cannot use
-- this table through the Data API until the grants in
-- files/northshift-expenses-grants.sql are approved and run (post-Oct-30-2026
-- tables get no automatic grants). No anon grant: expenses are never public.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('expense', 'mileage')),
  expense_date date NOT NULL DEFAULT CURRENT_DATE,
  category text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL DEFAULT 'CAD',
  merchant text,
  note text,
  receipt_path text,
  mileage_km numeric(10, 2),
  mileage_rate_cents integer,
  origin text,
  destination text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  review_note text,
  reimbursement_status text NOT NULL DEFAULT 'unpaid' CHECK (reimbursement_status IN ('unpaid', 'paid')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expenses_receipt_required CHECK (type <> 'expense' OR receipt_path IS NOT NULL),
  CONSTRAINT expenses_mileage_km_required CHECK (type <> 'mileage' OR (mileage_km IS NOT NULL AND mileage_km > 0))
);

CREATE INDEX IF NOT EXISTS expenses_business_date_idx ON public.expenses (business_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS expenses_user_date_idx ON public.expenses (user_id, expense_date DESC);

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

-- updated_at maintenance.
CREATE OR REPLACE FUNCTION public.set_expenses_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS expenses_updated_at ON public.expenses;
CREATE TRIGGER expenses_updated_at
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.set_expenses_updated_at();

-- Status guard: only a manager/admin may change review fields, and only a
-- manager/admin may touch a row once it leaves 'pending'. Mirrors the
-- profiles_role_guard / profiles_business_guard pattern, including the
-- service-role bypass (functions and the Brain run without a user JWT).
-- The UPDATE policy already scopes rows to the caller's own business, so the
-- global is_manager() check here only ever fires within that business.
CREATE OR REPLACE FUNCTION public.expenses_status_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.jwt() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'expenses: business_id and user_id cannot be changed';
  END IF;
  IF OLD.status <> 'pending' AND NOT public.is_manager() THEN
    RAISE EXCEPTION 'expenses: only a manager can change a reviewed expense';
  END IF;
  IF (NEW.status IS DISTINCT FROM OLD.status
      OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
      OR NEW.review_note IS DISTINCT FROM OLD.review_note
      OR NEW.reimbursement_status IS DISTINCT FROM OLD.reimbursement_status)
     AND NOT public.is_manager() THEN
    RAISE EXCEPTION 'expenses: only a manager can review or mark reimbursement';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS expenses_status_guard ON public.expenses;
CREATE TRIGGER expenses_status_guard
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.expenses_status_guard();

DROP POLICY IF EXISTS "expenses_select_own_or_manager" ON public.expenses;
CREATE POLICY "expenses_select_own_or_manager" ON public.expenses
  FOR SELECT TO authenticated USING (
    business_id = public.my_business_id()
    AND (user_id = auth.uid() OR public.is_manager()));

DROP POLICY IF EXISTS "expenses_insert_own" ON public.expenses;
CREATE POLICY "expenses_insert_own" ON public.expenses
  FOR INSERT TO authenticated WITH CHECK (
    business_id = public.my_business_id() AND user_id = auth.uid());

DROP POLICY IF EXISTS "expenses_update_own_or_manager" ON public.expenses;
CREATE POLICY "expenses_update_own_or_manager" ON public.expenses
  FOR UPDATE TO authenticated
  USING (
    business_id = public.my_business_id()
    AND (user_id = auth.uid() OR public.is_manager()))
  WITH CHECK (
    business_id = public.my_business_id()
    AND (user_id = auth.uid() OR public.is_manager()));

DROP POLICY IF EXISTS "expenses_delete_own_pending_or_manager" ON public.expenses;
CREATE POLICY "expenses_delete_own_pending_or_manager" ON public.expenses
  FOR DELETE TO authenticated USING (
    business_id = public.my_business_id()
    AND ((user_id = auth.uid() AND status = 'pending') OR public.is_manager()));

-- Receipt bucket: private, 10 MB, photos + PDF (same size limit as documents).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('expense-receipts', 'expense-receipts', false, 10485760,
        ARRAY['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- Receipt file policies: path segment 1 is the business, segment 2 is the user.
-- Employees reach only their own folder inside their own business; managers reach
-- any folder inside their own business. No cross-business access, no UPDATE
-- policy (delete + re-upload, same as documents).
DROP POLICY IF EXISTS "exp_receipts_select" ON storage.objects;
CREATE POLICY "exp_receipts_select" ON storage.objects
  FOR SELECT TO authenticated USING (
    bucket_id = 'expense-receipts'
    AND (storage.foldername(name))[1] = public.my_business_id()::text
    AND ((storage.foldername(name))[2] = auth.uid()::text OR public.is_manager()));

DROP POLICY IF EXISTS "exp_receipts_insert" ON storage.objects;
CREATE POLICY "exp_receipts_insert" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'expense-receipts'
    AND (storage.foldername(name))[1] = public.my_business_id()::text
    AND ((storage.foldername(name))[2] = auth.uid()::text OR public.is_manager()));

DROP POLICY IF EXISTS "exp_receipts_delete" ON storage.objects;
CREATE POLICY "exp_receipts_delete" ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'expense-receipts'
    AND (storage.foldername(name))[1] = public.my_business_id()::text
    AND ((storage.foldername(name))[2] = auth.uid()::text OR public.is_manager()));
