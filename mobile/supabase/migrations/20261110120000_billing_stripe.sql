-- NorthShift billing (Stripe) — 2026-11-10.
-- The subscriptions table already exists (baseline migration): one row per
-- business owner, keyed by owner_id. This migration extends it for
-- Stripe instead of replacing it, so the Subscription/Payment screens
-- keep reading the same table. The webhook upserts by business_id.
--
-- Safe to re-run (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
-- DROP CONSTRAINT IF EXISTS / DROP POLICY IF EXISTS).

-- One subscription row per business, for the webhook's upsert.
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS trial_start timestamptz,
  ADD COLUMN IF NOT EXISTS trial_end timestamptz,
  ADD COLUMN IF NOT EXISTS current_period_start timestamptz,
  ADD COLUMN IF NOT EXISTS grace_until timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_business_id_key
  ON public.subscriptions (business_id);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_stripe_subscription_id_key
  ON public.subscriptions (stripe_subscription_id);

-- Backfill business_id from the owner link (businesses.owner_id), so
-- rows created before Stripe still resolve to their business.
UPDATE public.subscriptions s
SET business_id = b.id
FROM public.businesses b
WHERE b.owner_id = s.owner_id AND s.business_id IS NULL;

-- Stripe's subscription statuses are wider than the old check
-- (active/trialing/past_due/canceled). Widen it to the full Stripe set.
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'));

-- Proof log for billing: every webhook event the server acted on, and in
-- particular trial_will_end — the record that the pre-charge notice
-- event arrived. No app screen reads this table; the webhook writes it
-- with the service-role key only. business_id is nullable because an
-- invoice event can arrive for a customer the server cannot yet map.
CREATE TABLE IF NOT EXISTS public.billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  stripe_event_id text NOT NULL UNIQUE,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;

-- Members of the owning business can read its billing log. No
-- insert/update/delete policy for app roles: writes are service-role
-- only (the webhook). No grant is shipped for this table — no app
-- screen reads it, and grants need Kaleem's explicit approval.
DROP POLICY IF EXISTS "billing_events_select_same_business" ON public.billing_events;
CREATE POLICY "billing_events_select_same_business" ON public.billing_events
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.business_id = billing_events.business_id));

-- Managers need to read their own business's billing state (trial /
-- grace / locked) to know whether setup is locked. The old policy only
-- let the owner and admins read subscriptions. Widen the SELECT to
-- business members; the admin write policy is unchanged.
DROP POLICY IF EXISTS "subscriptions_select_owner_or_admin" ON public.subscriptions;
CREATE POLICY "subscriptions_select_owner_or_admin" ON public.subscriptions
  FOR SELECT TO authenticated USING (
    auth.uid() = owner_id
    OR public.is_admin()
    OR EXISTS (SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.business_id = subscriptions.business_id));

-- Grants: NOT shipped. Tables created after Oct 30, 2026 get NO automatic
-- Data API grants, and this block stays commented until Kaleem explicitly
-- approves it. No app screen reads billing_events, so nothing needs it.
-- grant select on public.billing_events to anon;
-- grant select, insert, update, delete on public.billing_events to authenticated;
-- grant select, insert, update, delete on public.billing_events to service_role;
