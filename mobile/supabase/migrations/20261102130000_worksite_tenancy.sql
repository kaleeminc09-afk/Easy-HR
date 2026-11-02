-- Worksite tenancy: a location belongs to one business.
-- Until now worksites had no business column at all and were public-read,
-- so any employee standing inside another business's radius could clock
-- in on its QR code. This closes the clock-in hole:
--   1. business_id column (nullable: existing rows predate scoping).
--   2. Best-effort backfill: the business most of a site's clock-ins
--      belong to. Sites with no clock-ins stay NULL ("unclaimed").
--   3. The onboarding insert policy is tightened: a location must belong
--      to the caller's own business (NULL callers can no longer insert).
--   4. Claim policy: managers/admins can claim an unclaimed site for
--      their own business from the QR screen.
-- The scan screen enforces the rest in code (foreign site = denied before
-- any clock-in). No new tables here, so the post-Oct-30 grant question
-- does not arise. Run in the Supabase SQL editor, AFTER the onboarding
-- migration (20261102120000) if that has not run yet.
ALTER TABLE public.worksites ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL;

UPDATE public.worksites w SET business_id = (
  SELECT p.business_id FROM public.time_logs tl
  JOIN public.profiles p ON p.id = tl.user_id
  WHERE tl.worksite_id = w.id AND p.business_id IS NOT NULL
  GROUP BY p.business_id ORDER BY count(*) DESC LIMIT 1
) WHERE w.business_id IS NULL;

DROP POLICY IF EXISTS "worksites_insert_manager_admin" ON public.worksites;
CREATE POLICY "worksites_insert_manager_admin" ON public.worksites
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.business_id = worksites.business_id
        AND profiles.role IN ('manager', 'admin')));

DROP POLICY IF EXISTS "worksites_claim_unclaimed" ON public.worksites;
CREATE POLICY "worksites_claim_unclaimed" ON public.worksites
  FOR UPDATE TO authenticated
  USING (business_id IS NULL
    AND EXISTS (SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('manager', 'admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles
    WHERE profiles.id = auth.uid()
      AND profiles.business_id = worksites.business_id
      AND profiles.role IN ('manager', 'admin')));
