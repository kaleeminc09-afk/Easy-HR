-- CRM backoffice, Phase 3: manual subscription management.
--
-- manual_hold: when true, the backoffice activated this subscription
-- without Stripe (pilot, invoiced client). The stripe-webhook skips
-- subscription/invoice upserts for held rows — only a real Stripe
-- checkout (checkout.session.completed) clears the hold. The billing
-- enforcement function and the app read status/trial_end only, so a
-- manual trial behaves exactly like a Stripe trial (access until
-- trial_end, then the setup soft-lock). Idempotent: safe to re-run.

alter table public.subscriptions
  add column if not exists manual_hold boolean not null default false;

alter table public.subscriptions
  add column if not exists manual_note text;
