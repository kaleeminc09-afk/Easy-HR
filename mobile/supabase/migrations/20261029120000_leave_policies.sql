-- Leave policies (per business) — mirrors break_policies.
-- Vacation is deliberately NOT here: each employee's vacation days live
-- on their profile (vacation_days_entitlement, edited in Manage Users).
-- This table covers the business-wide rules: sick/personal annual caps
-- (NULL = no annual limit) and which leave types employees may request.
-- Run in the Supabase SQL editor. No GRANT block is included here by
-- policy (grant blocks ship only with explicit approval).
CREATE TABLE IF NOT EXISTS public.leave_policies (
  business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  sick_days integer,
  personal_days integer,
  sick_offered boolean NOT NULL DEFAULT true,
  personal_offered boolean NOT NULL DEFAULT true,
  other_offered boolean NOT NULL DEFAULT true,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.leave_policies ENABLE ROW LEVEL SECURITY;

-- leave_policies (tenant-scoped; deliberately NOT the global is_manager())
DROP POLICY IF EXISTS "leave_policies_select_same_business" ON public.leave_policies;
CREATE POLICY "leave_policies_select_same_business"
  FOR SELECT TO public USING (
    EXISTS (SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.business_id = leave_policies.business_id));
DROP POLICY IF EXISTS "leave_policies_write_same_business_manager" ON public.leave_policies;
CREATE POLICY "leave_policies_write_same_business_manager"
  FOR ALL TO public
  USING (
    EXISTS (SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.business_id = leave_policies.business_id
        AND profiles.role IN ('manager', 'admin')))
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.business_id = leave_policies.business_id
        AND profiles.role IN ('manager', 'admin')));
