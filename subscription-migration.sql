-- NorthShift subscriptions table. Run in the Supabase SQL editor.
-- Safe to re-run any number of times.
--
-- Pricing (locked 2026-10-11): first month free on every plan, then paid,
-- month-to-month, no annual lock-in. No permanent free tier.
--   Starter  $25/mo   up to 5 employees
--   Growth   $59/mo   up to 15 employees
--   Business $119/mo  up to 40 employees
-- (Payment processing via RevenueCat comes later. Discount options
--  5%/10%/20% and free-month promos are planned, not yet built.)

-- 0) Self-healing: make sure the admin helpers exist (earlier migrations
--    may have only partially applied).
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin');
$$;

CREATE OR REPLACE FUNCTION public.is_manager()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('manager', 'admin'));
$$;

-- 1) Table (new installs get the final shape immediately)
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter', 'growth', 'business')),
  status TEXT NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('active', 'trialing', 'past_due', 'canceled')),
  employee_limit INT NOT NULL DEFAULT 5,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- 2) Remap legacy plan names from earlier drafts (no-op on fresh installs)
UPDATE public.subscriptions SET plan = 'starter' WHERE plan IN ('free', 'pro');

-- 3) Enforce the final tier list (covers tables made by earlier migrations)
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_plan_check CHECK (plan IN ('starter', 'growth', 'business'));

-- 4) Sync employee limits to the locked tiers
UPDATE public.subscriptions SET employee_limit = 5 WHERE plan = 'starter';
UPDATE public.subscriptions SET employee_limit = 15 WHERE plan = 'growth';
UPDATE public.subscriptions SET employee_limit = 40 WHERE plan = 'business';

-- 5) RLS
DROP POLICY IF EXISTS subscriptions_select_owner_or_admin ON public.subscriptions;
CREATE POLICY subscriptions_select_owner_or_admin ON public.subscriptions
  FOR SELECT TO authenticated
  USING (auth.uid() = owner_id OR public.is_admin());

DROP POLICY IF EXISTS subscriptions_admin_write ON public.subscriptions;
CREATE POLICY subscriptions_admin_write ON public.subscriptions
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 6) Seed a 30-day free trial (Starter) for every admin without a row
INSERT INTO public.subscriptions (owner_id, plan, status, employee_limit, current_period_end)
SELECT id, 'starter', 'trialing', 5, now() + interval '30 days' FROM public.profiles
WHERE role = 'admin'
  AND NOT EXISTS (SELECT 1 FROM public.subscriptions WHERE owner_id = profiles.id);
