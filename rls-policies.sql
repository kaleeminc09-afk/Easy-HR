-- Easy HR: Row Level Security hardening
-- Run once in the Supabase dashboard SQL editor (project ejnkgsddglyabzsivcuu),
-- AFTER tasks-migration.sql.
--
-- What this does:
--  - Turns on RLS for every table (previously anyone with the app key could read/write everything).
--  - Employees can only touch their OWN rows; managers can see/manage everything.
--  - The AI edge function is unaffected (it uses the service-role key, which bypasses RLS).
--  - New signups automatically get a profiles row so the checks work from day one.
--  - Legacy tables (locations, clock_ins, geo_exceptions) are locked down completely.

-- 0. Tasks table (created here too so this script runs standalone —
--    safe to run even if tasks-migration.sql was already executed).
CREATE TABLE IF NOT EXISTS public.tasks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  assigned_to uuid,
  assigned_by uuid,
  status text NOT NULL DEFAULT 'pending'::text,
  due_date date,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT tasks_pkey PRIMARY KEY (id),
  CONSTRAINT tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.profiles(id),
  CONSTRAINT tasks_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.profiles(id)
);

-- 1. Manager check helper. SECURITY DEFINER avoids infinite recursion
--    when a profiles policy needs to look at the profiles table.
--    Admins inherit every manager permission.
CREATE OR REPLACE FUNCTION public.is_manager()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('manager', 'admin'));
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin');
$$;

-- 1b. Role guard: only admins may change the role column. Closes the
--     escalation hole where a manager (or a user on their own row)
--     could promote themselves.
CREATE OR REPLACE FUNCTION public.prevent_role_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.jwt() IS NULL THEN
    RETURN NEW; -- direct DB / dashboard access is already fully trusted
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can change user roles';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_role_guard ON public.profiles;
CREATE TRIGGER profiles_role_guard
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_role_escalation();

-- 2. Auto-create a profile row on every new signup (id = auth user id).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'role', 'employee')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 3. Enable RLS everywhere.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worksites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_audit_logs ENABLE ROW LEVEL SECURITY;
-- Legacy / unused tables: locked down completely (no policies = deny all).
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clock_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.geo_exceptions ENABLE ROW LEVEL SECURITY;

-- 4. profiles: own row, or everything for managers.
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

-- 5. worksites: everyone can read (needed for GPS clock-in); nobody writes via the app.
DROP POLICY IF EXISTS "worksites_select_all" ON public.worksites;
CREATE POLICY "worksites_select_all" ON public.worksites
  FOR SELECT TO authenticated USING (true);

-- 6. time_logs: own rows, or everything for managers.
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

-- 7. time_breaks: tied to the employee's own time_log.
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

-- 8. time_exceptions: employees file and view their own; only managers approve/reject.
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

-- 9. tasks: managers manage; employees see tasks assigned to/by them.
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

-- 10. agent_audit_logs: employees log their own blockers; managers review all.
DROP POLICY IF EXISTS "audit_select_own_or_manager" ON public.agent_audit_logs;
CREATE POLICY "audit_select_own_or_manager" ON public.agent_audit_logs
  FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.is_manager());
DROP POLICY IF EXISTS "audit_insert_own" ON public.agent_audit_logs;
CREATE POLICY "audit_insert_own" ON public.agent_audit_logs
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
