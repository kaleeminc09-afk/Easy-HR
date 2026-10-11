-- NorthShift subscriptions table. Run once in the Supabase SQL editor.
-- Safe to re-run. Stores the business's plan; the Subscription screen
-- in the app reads this. (Payment processing via RevenueCat comes next.)

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'business')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'trialing', 'past_due', 'canceled')),
  employee_limit INT NOT NULL DEFAULT 5,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscriptions_select_owner_or_admin ON public.subscriptions;
CREATE POLICY subscriptions_select_owner_or_admin ON public.subscriptions
  FOR SELECT TO authenticated
  USING (auth.uid() = owner_id OR public.is_admin());

DROP POLICY IF EXISTS subscriptions_admin_write ON public.subscriptions;
CREATE POLICY subscriptions_admin_write ON public.subscriptions
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- Seed a Free plan row for every existing admin (so the screen has data).
-- Run the bootstrap UPDATE for your admin user BEFORE this.
INSERT INTO public.subscriptions (owner_id, plan, status, employee_limit)
SELECT id, 'free', 'active', 5 FROM public.profiles
WHERE role = 'admin'
  AND NOT EXISTS (SELECT 1 FROM public.subscriptions WHERE owner_id = profiles.id);
