-- NorthShift tenancy RLS — 2026-11-12.
--
-- THE HOLE THIS CLOSES: until now, is_manager() / is_admin() were
-- GLOBAL role checks. Any manager of ANY business could read and
-- change EVERY business's profiles, time logs, shifts, time-off
-- requests, documents, and businesses through the API — the app's
-- own-business filters only hid it in the UI. Worksite reads were
-- worse: USING (true) for everyone, including anonymous callers.
-- This migration scopes every policy to the caller's own business,
-- following the break_policies / leave_policies pattern that already
-- works live. No new tables, so no grant question arises.
--
-- WHAT IS PRESERVED (verified against the app code before writing):
--   * Claim flow: unclaimed worksites (business_id NULL) stay
--     readable so managers can claim them from QR Codes; the claim
--     policy itself is unchanged.
--   * Scan flow: a foreign QR now returns "not found" (RLS hides the
--     row) instead of "Not your worksite" — still denied, and it no
--     longer leaks whether the site exists. Unclaimed sites still scan.
--   * Onboarding / invites: business creation and role/business
--     assignment run through the create-business and invite-employee
--     edge functions on the service role, which bypasses RLS and the
--     new trigger (same auth.jwt() bypass the role guard already uses).
--   * Brain: hr-ai-bot uses the service role and sets business_id on
--     every shift it creates, so its rows stay visible to the app.
--   * Shifts / time-off / documents inserts already set business_id
--     in the app, so the new WITH CHECKs accept them.
--   * Open-shift claiming: an employee can still claim an open shift
--     in their own business (USING sees status 'open', WITH CHECK
--     sees claimed_by = self).
--
-- WHAT CHANGES DELIBERATELY:
--   * subscriptions has NO app-role write policy anymore. Nothing in
--     the app writes subscriptions (reads only); only the webhook and
--     checkout functions write it on the service role. This closes a
--     self-activation hole: any admin could previously set their own
--     row to active without paying.
--   * profiles business_id can no longer change through the app role
--     at all (new trigger, mirroring the role guard). Nobody in the
--     app legitimately changes it — assignment happens only via
--     onboarding and invites on the service role.
--   * tasks (unused by the app) is scoped the same way rather than
--     left open for a future feature to trip over.
--
-- SAFE TO RE-RUN: DROP POLICY IF EXISTS before every CREATE, trigger
-- function is CREATE OR REPLACE, backfills only touch NULL rows,
-- indexes are IF NOT EXISTS. Rollback: run
-- files/northshift-tenancy-rls-rollback.sql (restores the previous
-- policies verbatim; backfills and indexes are additive and stay).

-- ------------------------------------------------------------------
-- Backfills: rows created before business_id was always set. A row
-- with a NULL business_id would be invisible under the new policies,
-- so place each one in its owner's business first. Idempotent.
-- ------------------------------------------------------------------
UPDATE public.shifts s SET business_id = p.business_id
FROM public.profiles p
WHERE p.id = s.user_id AND s.business_id IS NULL AND p.business_id IS NOT NULL;

UPDATE public.shifts s SET business_id = w.business_id
FROM public.worksites w
WHERE w.id = s.worksite_id AND s.business_id IS NULL AND w.business_id IS NOT NULL;

UPDATE public.time_off_requests t SET business_id = p.business_id
FROM public.profiles p
WHERE p.id = t.user_id AND t.business_id IS NULL AND p.business_id IS NOT NULL;

UPDATE public.documents d SET business_id = p.business_id
FROM public.profiles p
WHERE p.id = d.user_id AND d.business_id IS NULL AND p.business_id IS NOT NULL;

-- Indexes for the business_id comparisons the new policies run.
CREATE INDEX IF NOT EXISTS shifts_business_idx ON public.shifts (business_id);
CREATE INDEX IF NOT EXISTS time_off_business_idx ON public.time_off_requests (business_id);
CREATE INDEX IF NOT EXISTS documents_business_idx ON public.documents (business_id);

-- ------------------------------------------------------------------
-- Guard: business assignment can only change on the service role
-- (onboarding / invites). Mirrors prevent_role_escalation, including
-- its auth.jwt() bypass, which the live role guard already proves.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_business_id_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.jwt() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.business_id IS DISTINCT FROM OLD.business_id THEN
    RAISE EXCEPTION 'Business assignment can only change via onboarding or invite';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_business_guard ON public.profiles;
CREATE TRIGGER profiles_business_guard
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_business_id_change();

-- RLS stays enabled everywhere (idempotent; re-asserts it).
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worksites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_off_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------
-- profiles: own row, or anyone in my business. (Sensitive columns
-- already live in owner-only profile_private, so the directory fields
-- here are safe to share within a business. Insert policy unchanged.)
-- ------------------------------------------------------------------
DROP POLICY IF EXISTS "profiles_select_own_or_manager" ON public.profiles;
CREATE POLICY "profiles_select_same_business" ON public.profiles
  FOR SELECT TO authenticated USING (
    auth.uid() = id
    OR business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "profiles_update_own_or_manager" ON public.profiles;
CREATE POLICY "profiles_update_same_business" ON public.profiles
  FOR UPDATE TO authenticated
  USING (
    auth.uid() = id
    OR (business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())
      AND public.is_manager()))
  WITH CHECK (
    auth.uid() = id
    OR (business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())
      AND public.is_manager()));

-- ------------------------------------------------------------------
-- worksites: my business's sites, plus unclaimed sites (claim flow).
-- Drops BOTH USING (true) policies, including the anonymous one.
-- Insert and claim policies are already scoped; untouched.
-- ------------------------------------------------------------------
DROP POLICY IF EXISTS "Allow public read worksites" ON public.worksites;
DROP POLICY IF EXISTS "worksites_select_all" ON public.worksites;
CREATE POLICY "worksites_select_own_or_unclaimed" ON public.worksites
  FOR SELECT TO authenticated USING (
    business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())
    OR business_id IS NULL);

-- ------------------------------------------------------------------
-- businesses: my own business, or one I own. Writes: admin of that
-- business only. No INSERT policy: creation is function-only
-- (create-business); the app never inserts businesses directly.
-- ------------------------------------------------------------------
DROP POLICY IF EXISTS "businesses_select_own_or_admin" ON public.businesses;
CREATE POLICY "businesses_select_own" ON public.businesses
  FOR SELECT TO authenticated USING (
    id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())
    OR owner_id = auth.uid());

DROP POLICY IF EXISTS "businesses_admin_write" ON public.businesses;
CREATE POLICY "businesses_update_own_admin" ON public.businesses
  FOR UPDATE TO authenticated
  USING (
    id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())
    AND public.is_admin())
  WITH CHECK (
    id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())
    AND public.is_admin());
CREATE POLICY "businesses_delete_own_admin" ON public.businesses
  FOR DELETE TO authenticated USING (
    id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())
    AND public.is_admin());

-- ------------------------------------------------------------------
-- subscriptions: owner, or a member of the business. The global
-- is_admin() branch is gone. NO write policy: only the service-role
-- webhook and checkout functions write this table.
-- ------------------------------------------------------------------
DROP POLICY IF EXISTS "subscriptions_select_owner_or_admin" ON public.subscriptions;
CREATE POLICY "subscriptions_select_same_business" ON public.subscriptions
  FOR SELECT TO authenticated USING (
    auth.uid() = owner_id
    OR business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "subscriptions_admin_write" ON public.subscriptions;

-- ------------------------------------------------------------------
-- shifts: same shape as before (own / claimed / open / manager),
-- now bounded to my business.
-- ------------------------------------------------------------------
DROP POLICY IF EXISTS "shifts_select" ON public.shifts;
CREATE POLICY "shifts_select" ON public.shifts
  FOR SELECT TO authenticated USING (
    business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())
    AND (user_id = auth.uid() OR claimed_by = auth.uid() OR status = 'open' OR public.is_manager()));

DROP POLICY IF EXISTS "shifts_insert" ON public.shifts;
CREATE POLICY "shifts_insert" ON public.shifts
  FOR INSERT TO authenticated WITH CHECK (
    public.is_manager()
    AND business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "shifts_update" ON public.shifts;
CREATE POLICY "shifts_update" ON public.shifts
  FOR UPDATE TO authenticated
  USING (
    business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())
    AND (user_id = auth.uid() OR claimed_by = auth.uid() OR status = 'open' OR public.is_manager()))
  WITH CHECK (
    business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())
    AND (user_id = auth.uid() OR claimed_by = auth.uid() OR status = 'open' OR public.is_manager()));

DROP POLICY IF EXISTS "shifts_delete" ON public.shifts;
CREATE POLICY "shifts_delete" ON public.shifts
  FOR DELETE TO authenticated USING (
    public.is_manager()
    AND business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()));

-- ------------------------------------------------------------------
-- time_off_requests: same shape as before, bounded to my business.
-- ------------------------------------------------------------------
DROP POLICY IF EXISTS "time_off_select" ON public.time_off_requests;
CREATE POLICY "time_off_select" ON public.time_off_requests
  FOR SELECT TO authenticated USING (
    business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())
    AND (user_id = auth.uid() OR public.is_manager()));

DROP POLICY IF EXISTS "time_off_insert" ON public.time_off_requests;
CREATE POLICY "time_off_insert" ON public.time_off_requests
  FOR INSERT TO authenticated WITH CHECK (
    business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())
    AND (user_id = auth.uid() OR public.is_manager()));

DROP POLICY IF EXISTS "time_off_update" ON public.time_off_requests;
CREATE POLICY "time_off_update" ON public.time_off_requests
  FOR UPDATE TO authenticated
  USING (
    public.is_manager()
    AND business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()))
  WITH CHECK (
    public.is_manager()
    AND business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "time_off_delete" ON public.time_off_requests;
CREATE POLICY "time_off_delete" ON public.time_off_requests
  FOR DELETE TO authenticated USING (
    business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())
    AND ((user_id = auth.uid() AND status = 'pending') OR public.is_manager()));

-- ------------------------------------------------------------------
-- documents: same shape as before, bounded to my business.
-- (File bytes live under storage policies — separate follow-up.)
-- ------------------------------------------------------------------
DROP POLICY IF EXISTS "documents_select" ON public.documents;
CREATE POLICY "documents_select" ON public.documents
  FOR SELECT TO authenticated USING (
    business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())
    AND (user_id = auth.uid() OR public.is_manager()));

DROP POLICY IF EXISTS "documents_insert" ON public.documents;
CREATE POLICY "documents_insert" ON public.documents
  FOR INSERT TO authenticated WITH CHECK (
    business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())
    AND (user_id = auth.uid() OR public.is_manager()));

DROP POLICY IF EXISTS "documents_delete" ON public.documents;
CREATE POLICY "documents_delete" ON public.documents
  FOR DELETE TO authenticated USING (
    business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())
    AND (uploaded_by = auth.uid() OR public.is_manager()));

-- ------------------------------------------------------------------
-- time_logs: no business_id column, so the manager branch joins
-- through the log owner's profile. Insert policy unchanged (own row).
-- ------------------------------------------------------------------
DROP POLICY IF EXISTS "time_logs_select_own_or_manager" ON public.time_logs;
CREATE POLICY "time_logs_select_own_or_manager" ON public.time_logs
  FOR SELECT TO authenticated USING (
    auth.uid() = user_id
    OR (public.is_manager() AND EXISTS (
      SELECT 1 FROM public.profiles owner
      WHERE owner.id = time_logs.user_id
        AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()))));

DROP POLICY IF EXISTS "time_logs_update_own_or_manager" ON public.time_logs;
CREATE POLICY "time_logs_update_own_or_manager" ON public.time_logs
  FOR UPDATE TO authenticated
  USING (
    auth.uid() = user_id
    OR (public.is_manager() AND EXISTS (
      SELECT 1 FROM public.profiles owner
      WHERE owner.id = time_logs.user_id
        AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()))))
  WITH CHECK (
    auth.uid() = user_id
    OR (public.is_manager() AND EXISTS (
      SELECT 1 FROM public.profiles owner
      WHERE owner.id = time_logs.user_id
        AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()))));

-- ------------------------------------------------------------------
-- time_breaks: through the parent time log, same scoping as above.
-- ------------------------------------------------------------------
DROP POLICY IF EXISTS "time_breaks_select_own_or_manager" ON public.time_breaks;
CREATE POLICY "time_breaks_select_own_or_manager" ON public.time_breaks
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.time_logs tl
    WHERE tl.id = time_breaks.time_log_id
      AND (tl.user_id = auth.uid()
        OR (public.is_manager() AND EXISTS (
          SELECT 1 FROM public.profiles owner
          WHERE owner.id = tl.user_id
            AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()))))));

DROP POLICY IF EXISTS "time_breaks_insert_own" ON public.time_breaks;
CREATE POLICY "time_breaks_insert_own" ON public.time_breaks
  FOR INSERT TO authenticated WITH CHECK (EXISTS (
    SELECT 1 FROM public.time_logs tl
    WHERE tl.id = time_breaks.time_log_id
      AND (tl.user_id = auth.uid()
        OR (public.is_manager() AND EXISTS (
          SELECT 1 FROM public.profiles owner
          WHERE owner.id = tl.user_id
            AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()))))));

DROP POLICY IF EXISTS "time_breaks_update_own_or_manager" ON public.time_breaks;
CREATE POLICY "time_breaks_update_own_or_manager" ON public.time_breaks
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.time_logs tl
    WHERE tl.id = time_breaks.time_log_id
      AND (tl.user_id = auth.uid()
        OR (public.is_manager() AND EXISTS (
          SELECT 1 FROM public.profiles owner
          WHERE owner.id = tl.user_id
            AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()))))))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.time_logs tl
    WHERE tl.id = time_breaks.time_log_id
      AND (tl.user_id = auth.uid()
        OR (public.is_manager() AND EXISTS (
          SELECT 1 FROM public.profiles owner
          WHERE owner.id = tl.user_id
            AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()))))));

-- ------------------------------------------------------------------
-- time_exceptions: same user-join scoping. Insert policy unchanged.
-- ------------------------------------------------------------------
DROP POLICY IF EXISTS "time_exceptions_select_own_or_manager" ON public.time_exceptions;
CREATE POLICY "time_exceptions_select_own_or_manager" ON public.time_exceptions
  FOR SELECT TO authenticated USING (
    auth.uid() = user_id
    OR (public.is_manager() AND EXISTS (
      SELECT 1 FROM public.profiles owner
      WHERE owner.id = time_exceptions.user_id
        AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()))));

DROP POLICY IF EXISTS "time_exceptions_update_manager" ON public.time_exceptions;
CREATE POLICY "time_exceptions_update_manager" ON public.time_exceptions
  FOR UPDATE TO authenticated
  USING (
    public.is_manager() AND EXISTS (
      SELECT 1 FROM public.profiles owner
      WHERE owner.id = time_exceptions.user_id
        AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())))
  WITH CHECK (
    public.is_manager() AND EXISTS (
      SELECT 1 FROM public.profiles owner
      WHERE owner.id = time_exceptions.user_id
        AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())));

-- ------------------------------------------------------------------
-- agent_audit_logs: replaces all four old policies (two were
-- redundant TO public copies) with the same scoping.
-- ------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own agent logs" ON public.agent_audit_logs;
DROP POLICY IF EXISTS "Users can insert own agent logs" ON public.agent_audit_logs;
DROP POLICY IF EXISTS "audit_select_own_or_manager" ON public.agent_audit_logs;
DROP POLICY IF EXISTS "audit_insert_own" ON public.agent_audit_logs;
CREATE POLICY "audit_select_own_or_manager" ON public.agent_audit_logs
  FOR SELECT TO authenticated USING (
    auth.uid() = user_id
    OR (public.is_manager() AND EXISTS (
      SELECT 1 FROM public.profiles owner
      WHERE owner.id = agent_audit_logs.user_id
        AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()))));
CREATE POLICY "audit_insert_own" ON public.agent_audit_logs
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- ------------------------------------------------------------------
-- tasks: unused by the app, scoped anyway so a future feature does
-- not inherit the global-manager hole.
-- ------------------------------------------------------------------
DROP POLICY IF EXISTS "tasks_select_assigned_or_manager" ON public.tasks;
CREATE POLICY "tasks_select_assigned_or_manager" ON public.tasks
  FOR SELECT TO authenticated USING (
    auth.uid() = assigned_to OR auth.uid() = assigned_by
    OR (public.is_manager() AND (
      EXISTS (
        SELECT 1 FROM public.profiles owner
        WHERE owner.id = tasks.assigned_to
          AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()))
      OR EXISTS (
        SELECT 1 FROM public.profiles owner
        WHERE owner.id = tasks.assigned_by
          AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())))));

DROP POLICY IF EXISTS "tasks_insert_manager" ON public.tasks;
CREATE POLICY "tasks_insert_manager" ON public.tasks
  FOR INSERT TO authenticated WITH CHECK (
    public.is_manager()
    AND (assigned_to IS NULL OR EXISTS (
      SELECT 1 FROM public.profiles owner
      WHERE owner.id = tasks.assigned_to
        AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()))));

DROP POLICY IF EXISTS "tasks_update_manager" ON public.tasks;
CREATE POLICY "tasks_update_manager" ON public.tasks
  FOR UPDATE TO authenticated
  USING (
    auth.uid() = assigned_to OR auth.uid() = assigned_by
    OR (public.is_manager() AND (
      EXISTS (
        SELECT 1 FROM public.profiles owner
        WHERE owner.id = tasks.assigned_to
          AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()))
      OR EXISTS (
        SELECT 1 FROM public.profiles owner
        WHERE owner.id = tasks.assigned_by
          AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())))))
  WITH CHECK (
    auth.uid() = assigned_to OR auth.uid() = assigned_by
    OR (public.is_manager() AND (
      EXISTS (
        SELECT 1 FROM public.profiles owner
        WHERE owner.id = tasks.assigned_to
          AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid()))
      OR EXISTS (
        SELECT 1 FROM public.profiles owner
        WHERE owner.id = tasks.assigned_by
          AND owner.business_id = (SELECT business_id FROM public.profiles WHERE id = auth.uid())))));
