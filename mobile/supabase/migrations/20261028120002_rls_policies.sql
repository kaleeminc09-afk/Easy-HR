-- NorthShift RLS policies — audit item 4 (2026-10-28).
-- Apply after 0001 and 0002. Safe to re-run (DROP IF EXISTS first).
--
-- This is the LIVE policy set verified 2026-10-28, with one deliberate
-- difference: the profiles "Allow all for profiles" policy (public,
-- USING true, WITH CHECK true) is NOT recreated here — it was dropped
-- that day because it made every other profiles policy meaningless.
-- Legacy tables (locations, clock_ins, geo_exceptions) get RLS enabled
-- with NO policies, which is deny-all for app keys, exactly as live.

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worksites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_off_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.break_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clock_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.geo_exceptions ENABLE ROW LEVEL SECURITY;

-- profiles
DROP POLICY IF EXISTS "profiles_select_own_or_manager" ON public.profiles;
CREATE POLICY "profiles_select_own_or_manager" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = id OR public.is_manager());
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
DROP POLICY IF EXISTS "profiles_update_own_or_manager" ON public.profiles;
CREATE POLICY "profiles_update_own_or_manager" ON public.profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = id OR public.is_manager())
  WITH CHECK (auth.uid() = id OR public.is_manager());

-- worksites: public read (live has both policies below) plus
-- authenticated read; nobody writes via the app.
DROP POLICY IF EXISTS "Allow public read worksites" ON public.worksites;
CREATE POLICY "Allow public read worksites" ON public.worksites
  FOR SELECT TO public USING (true);
DROP POLICY IF EXISTS "worksites_select_all" ON public.worksites;
CREATE POLICY "worksites_select_all" ON public.worksites
  FOR SELECT TO authenticated USING (true);

-- agent_audit_logs
DROP POLICY IF EXISTS "Users can view own agent logs" ON public.agent_audit_logs;
CREATE POLICY "Users can view own agent logs" ON public.agent_audit_logs
  FOR SELECT TO public USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own agent logs" ON public.agent_audit_logs;
CREATE POLICY "Users can insert own agent logs" ON public.agent_audit_logs
  FOR INSERT TO public WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "audit_select_own_or_manager" ON public.agent_audit_logs;
CREATE POLICY "audit_select_own_or_manager" ON public.agent_audit_logs
  FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.is_manager());
DROP POLICY IF EXISTS "audit_insert_own" ON public.agent_audit_logs;
CREATE POLICY "audit_insert_own" ON public.agent_audit_logs
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- time_logs
DROP POLICY IF EXISTS "time_logs_select_own_or_manager" ON public.time_logs;
CREATE POLICY "time_logs_select_own_or_manager" ON public.time_logs
  FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.is_manager());
DROP POLICY IF EXISTS "time_logs_insert_own" ON public.time_logs;
CREATE POLICY "time_logs_insert_own" ON public.time_logs
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "time_logs_update_own_or_manager" ON public.time_logs;
CREATE POLICY "time_logs_update_own_or_manager" ON public.time_logs
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.is_manager())
  WITH CHECK (auth.uid() = user_id OR public.is_manager());

-- time_breaks
DROP POLICY IF EXISTS "time_breaks_select_own_or_manager" ON public.time_breaks;
CREATE POLICY "time_breaks_select_own_or_manager" ON public.time_breaks
  FOR SELECT TO authenticated USING (
    public.is_manager() OR EXISTS (
      SELECT 1 FROM public.time_logs tl
      WHERE tl.id = time_breaks.time_log_id AND tl.user_id = auth.uid()));
DROP POLICY IF EXISTS "time_breaks_insert_own" ON public.time_breaks;
CREATE POLICY "time_breaks_insert_own" ON public.time_breaks
  FOR INSERT TO authenticated WITH CHECK (
    public.is_manager() OR EXISTS (
      SELECT 1 FROM public.time_logs tl
      WHERE tl.id = time_breaks.time_log_id AND tl.user_id = auth.uid()));
DROP POLICY IF EXISTS "time_breaks_update_own_or_manager" ON public.time_breaks;
CREATE POLICY "time_breaks_update_own_or_manager" ON public.time_breaks
  FOR UPDATE TO authenticated
  USING (public.is_manager() OR EXISTS (
      SELECT 1 FROM public.time_logs tl
      WHERE tl.id = time_breaks.time_log_id AND tl.user_id = auth.uid()))
  WITH CHECK (public.is_manager() OR EXISTS (
      SELECT 1 FROM public.time_logs tl
      WHERE tl.id = time_breaks.time_log_id AND tl.user_id = auth.uid()));

-- time_exceptions
DROP POLICY IF EXISTS "time_exceptions_select_own_or_manager" ON public.time_exceptions;
CREATE POLICY "time_exceptions_select_own_or_manager" ON public.time_exceptions
  FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.is_manager());
DROP POLICY IF EXISTS "time_exceptions_insert_own" ON public.time_exceptions;
CREATE POLICY "time_exceptions_insert_own" ON public.time_exceptions
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "time_exceptions_update_manager" ON public.time_exceptions;
CREATE POLICY "time_exceptions_update_manager" ON public.time_exceptions
  FOR UPDATE TO authenticated
  USING (public.is_manager())
  WITH CHECK (public.is_manager());

-- tasks
DROP POLICY IF EXISTS "tasks_select_assigned_or_manager" ON public.tasks;
CREATE POLICY "tasks_select_assigned_or_manager" ON public.tasks
  FOR SELECT TO authenticated USING (
    public.is_manager() OR auth.uid() = assigned_to OR auth.uid() = assigned_by);
DROP POLICY IF EXISTS "tasks_insert_manager" ON public.tasks;
CREATE POLICY "tasks_insert_manager" ON public.tasks
  FOR INSERT TO authenticated WITH CHECK (public.is_manager());
DROP POLICY IF EXISTS "tasks_update_manager" ON public.tasks;
CREATE POLICY "tasks_update_manager" ON public.tasks
  FOR UPDATE TO authenticated
  USING (public.is_manager())
  WITH CHECK (public.is_manager());

-- businesses
DROP POLICY IF EXISTS "businesses_select_own_or_admin" ON public.businesses;
CREATE POLICY "businesses_select_own_or_admin" ON public.businesses
  FOR SELECT TO authenticated USING (
    public.is_admin()
    OR id IN (SELECT business_id FROM public.profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "businesses_admin_write" ON public.businesses;
CREATE POLICY "businesses_admin_write" ON public.businesses
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- subscriptions
DROP POLICY IF EXISTS "subscriptions_select_owner_or_admin" ON public.subscriptions;
CREATE POLICY "subscriptions_select_owner_or_admin" ON public.subscriptions
  FOR SELECT TO authenticated USING (auth.uid() = owner_id OR public.is_admin());
DROP POLICY IF EXISTS "subscriptions_admin_write" ON public.subscriptions;
CREATE POLICY "subscriptions_admin_write" ON public.subscriptions
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- shifts
DROP POLICY IF EXISTS "shifts_select" ON public.shifts;
CREATE POLICY "shifts_select" ON public.shifts
  FOR SELECT TO authenticated USING (
    user_id = auth.uid() OR claimed_by = auth.uid() OR status = 'open'
    OR EXISTS (SELECT 1 FROM public.profiles me
      WHERE me.id = auth.uid() AND me.role IN ('manager', 'admin')));
DROP POLICY IF EXISTS "shifts_insert" ON public.shifts;
CREATE POLICY "shifts_insert" ON public.shifts
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles me
      WHERE me.id = auth.uid() AND me.role IN ('manager', 'admin')));
DROP POLICY IF EXISTS "shifts_update" ON public.shifts;
CREATE POLICY "shifts_update" ON public.shifts
  FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid() OR claimed_by = auth.uid() OR status = 'open'
    OR EXISTS (SELECT 1 FROM public.profiles me
      WHERE me.id = auth.uid() AND me.role IN ('manager', 'admin')))
  WITH CHECK (
    user_id = auth.uid() OR claimed_by = auth.uid() OR status = 'open'
    OR EXISTS (SELECT 1 FROM public.profiles me
      WHERE me.id = auth.uid() AND me.role IN ('manager', 'admin')));
DROP POLICY IF EXISTS "shifts_delete" ON public.shifts;
CREATE POLICY "shifts_delete" ON public.shifts
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles me
      WHERE me.id = auth.uid() AND me.role IN ('manager', 'admin')));

-- time_off_requests
DROP POLICY IF EXISTS "time_off_select" ON public.time_off_requests;
CREATE POLICY "time_off_select" ON public.time_off_requests
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles me
      WHERE me.id = auth.uid() AND me.role IN ('manager', 'admin')));
DROP POLICY IF EXISTS "time_off_insert" ON public.time_off_requests;
CREATE POLICY "time_off_insert" ON public.time_off_requests
  FOR INSERT TO authenticated WITH CHECK (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles me
      WHERE me.id = auth.uid() AND me.role IN ('manager', 'admin')));
DROP POLICY IF EXISTS "time_off_update" ON public.time_off_requests;
CREATE POLICY "time_off_update" ON public.time_off_requests
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles me
      WHERE me.id = auth.uid() AND me.role IN ('manager', 'admin')))
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles me
      WHERE me.id = auth.uid() AND me.role IN ('manager', 'admin')));
DROP POLICY IF EXISTS "time_off_delete" ON public.time_off_requests;
CREATE POLICY "time_off_delete" ON public.time_off_requests
  FOR DELETE TO authenticated USING (
    (user_id = auth.uid() AND status = 'pending')
    OR EXISTS (SELECT 1 FROM public.profiles me
      WHERE me.id = auth.uid() AND me.role IN ('manager', 'admin')));

-- documents
DROP POLICY IF EXISTS "documents_select" ON public.documents;
CREATE POLICY "documents_select" ON public.documents
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles me
      WHERE me.id = auth.uid() AND me.role IN ('manager', 'admin')));
DROP POLICY IF EXISTS "documents_insert" ON public.documents;
CREATE POLICY "documents_insert" ON public.documents
  FOR INSERT TO authenticated WITH CHECK (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles me
      WHERE me.id = auth.uid() AND me.role IN ('manager', 'admin')));
DROP POLICY IF EXISTS "documents_delete" ON public.documents;
CREATE POLICY "documents_delete" ON public.documents
  FOR DELETE TO authenticated USING (
    uploaded_by = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles me
      WHERE me.id = auth.uid() AND me.role IN ('manager', 'admin')));

-- break_policies (tenant-scoped; deliberately NOT the global is_manager())
DROP POLICY IF EXISTS "break_policies_select_same_business" ON public.break_policies;
CREATE POLICY "break_policies_select_same_business" ON public.break_policies
  FOR SELECT TO public USING (
    EXISTS (SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.business_id = break_policies.business_id));
DROP POLICY IF EXISTS "break_policies_write_same_business_manager" ON public.break_policies;
CREATE POLICY "break_policies_write_same_business_manager" ON public.break_policies
  FOR ALL TO public
  USING (
    EXISTS (SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.business_id = break_policies.business_id
        AND profiles.role IN ('manager', 'admin')))
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.business_id = break_policies.business_id
        AND profiles.role IN ('manager', 'admin')));
