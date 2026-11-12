-- NorthShift server-side billing enforcement — 2026-11-12.
--
-- Until now the trial lock lived ONLY in the app UI: a locked business
-- could still create shifts and worksites through a direct API call.
-- This migration enforces the same lock at the database, so the rule
-- holds no matter which client writes.
--
-- WHAT IT ENFORCES (mirrors the app gates exactly — nothing more):
--   * shifts INSERT: blocked when the business is locked. The app
--     blocks Build Schedule when locked (manager.js).
--   * worksites INSERT: blocked when the business is locked. The app
--     blocks new locations when locked (qrcodes.js).
-- WHAT IT DELIBERATELY DOES NOT TOUCH:
--   * Reads: never blocked (viewing, board, exports).
--   * Clock-in / clock-out (time_logs): never blocked.
--   * Shift edits, deletes, claims: the app only gates creation.
--   * Worksite claiming: the app does not gate the claim button.
--   * Time-off, documents, break/leave policies: the app does not
--     gate them on billing.
--   * Invites and Brain writes: those run through edge functions on
--     the service role, which bypasses RLS. They need their own
--     function-level checks — a separate code deploy, not this file.
--
-- THE STATE RULE is a line-for-line port of getBillingState() in
-- hr-ai-bot/logic.ts (TRIAL_DAYS 30, GRACE_DAYS 7, day = 86400000ms):
--   * status 'active' → allowed, always.
--   * status 'canceled' → allowed only until current_period_end.
--   * status 'past_due' / 'unpaid' → allowed during grace: until
--     grace_until, or 7 days from now when grace_until is NULL
--     (the same fallback the app uses).
--   * anything else (trialing, incomplete, or NO subscription row) →
--     allowed only while now() is before the trial end: the
--     subscription's trial_end when set, else the business's
--     created_at + 30 days. A business with no subscription row and
--     no usable creation date is locked, exactly as the app computes.
-- The function returns a guaranteed boolean (never NULL) and reads
-- through SECURITY DEFINER, in the exact shape of my_business_id() /
-- is_manager() / is_admin(), so it never trips the self-reference
-- rule that broke the first tenancy migration.
--
-- SAFE TO RE-RUN: function is CREATE OR REPLACE, policies are
-- DROP IF EXISTS + CREATE under their existing names. Rollback: run
-- files/northshift-billing-enforcement-rollback.sql (restores the
-- two policies without the billing condition and drops the function).
-- No new tables, so no grant question arises.

CREATE OR REPLACE FUNCTION public.billing_write_allowed(p_business_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT CASE
      WHEN s.status = 'active' THEN true
      WHEN s.status = 'canceled' THEN now() < s.current_period_end
      WHEN s.status IN ('past_due', 'unpaid') THEN now() < COALESCE(s.grace_until, now() + interval '7 days')
      ELSE now() < COALESCE(s.trial_end, b.created_at + interval '30 days')
    END
    FROM public.businesses b
    LEFT JOIN public.subscriptions s ON s.business_id = b.id
    WHERE b.id = p_business_id
  ), false);
$$;

-- shifts: creation requires a manager of the business AND a billing
-- state that allows writes. SELECT / UPDATE / DELETE unchanged.
DROP POLICY IF EXISTS "shifts_insert" ON public.shifts;
CREATE POLICY "shifts_insert" ON public.shifts
  FOR INSERT TO authenticated WITH CHECK (
    public.is_manager()
    AND business_id = public.my_business_id()
    AND public.billing_write_allowed(business_id));

-- worksites: new locations require a manager of the business AND a
-- billing state that allows writes. SELECT / claim unchanged.
DROP POLICY IF EXISTS "worksites_insert_manager_admin" ON public.worksites;
CREATE POLICY "worksites_insert_manager_admin" ON public.worksites
  FOR INSERT TO authenticated WITH CHECK (
    public.billing_write_allowed(worksites.business_id)
    AND EXISTS (SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.business_id = worksites.business_id
        AND profiles.role IN ('manager', 'admin')));
