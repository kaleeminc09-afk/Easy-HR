-- NorthShift admin role migration.
-- Run this ONCE in the Supabase SQL editor (after rls-policies.sql).
-- It is safe to re-run.
--
-- What it does:
--  1. Allows 'admin' as a profile role.
--  2. is_manager() now returns true for admins too, so admins inherit
--     every manager data permission (logs, exceptions, tasks, exports).
--  3. Adds is_admin() for admin-only gates.
--  4. Adds a trigger so ONLY admins can change the role column. This
--     closes the role-escalation hole where a manager (or a user editing
--     their own row) could promote themselves.
--
-- After running, bootstrap your first admin (replace the email):
--   UPDATE public.profiles SET role = 'admin'
--   WHERE id = (SELECT id FROM auth.users WHERE email = 'you@example.com');

-- 1) Allow 'admin' in the role check constraint
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check CHECK (role IN ('employee', 'manager', 'admin'));

-- 2) Managers OR admins
CREATE OR REPLACE FUNCTION public.is_manager()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('manager', 'admin')
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- 3) Admins only
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- 4) Only admins may change the role column
CREATE OR REPLACE FUNCTION public.prevent_role_escalation()
RETURNS TRIGGER AS $$
BEGIN
  IF auth.jwt() IS NULL THEN
    RETURN NEW; -- direct DB / dashboard access is already fully trusted
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can change user roles';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS profiles_role_guard ON public.profiles;
CREATE TRIGGER profiles_role_guard
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.prevent_role_escalation();
