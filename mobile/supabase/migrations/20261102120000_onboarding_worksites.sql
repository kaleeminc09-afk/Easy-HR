-- Owner onboarding, part 2: managers and admins can add worksites from
-- the app. Until now the worksites policies were read-only ("nobody
-- writes via the app"), so a location could only exist if created outside
-- the app — one more reason a new owner was stuck.
-- The check uses an EXISTS subquery on profiles, not the is_manager()
-- helper: like the leave/break policies, this must work even though the
-- baseline helper functions were never applied to the live database.
-- No new tables here, so the post-Oct-30 grant question does not arise.
-- Run in the Supabase SQL editor.
DROP POLICY IF EXISTS "worksites_insert_manager_admin" ON public.worksites;
CREATE POLICY "worksites_insert_manager_admin" ON public.worksites
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('manager', 'admin')));
