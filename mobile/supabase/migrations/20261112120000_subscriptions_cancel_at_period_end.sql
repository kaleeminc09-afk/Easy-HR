-- NorthShift billing fix — 2026-11-12.
-- The stripe-webhook handler writes cancel_at_period_end on every
-- subscription upsert, but no migration ever created the column: the
-- webhook 500'd on every delivery until the column was added by hand
-- in the SQL editor on 2026-11-11. This migration puts it in the repo
-- so a fresh database has it. Safe to re-run.
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;
