-- Audit item 7 fix: date of birth, home address, and emergency contacts
-- move out of profiles into an owner-only table. RLS is row-level, not
-- column-level, so as long as these columns lived on profiles, any
-- manager could read them with select * even though no manager screen
-- displays them. After this move, a manager query of profiles physically
-- cannot return them: the columns no longer exist there.
-- Run in the Supabase SQL editor. The copy runs before the drop, and
-- every statement is guarded, so re-running the file is safe.
-- No GRANT block is included here by policy (grant blocks ship only
-- with explicit approval).
CREATE TABLE IF NOT EXISTS public.profile_private (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  date_of_birth date,
  address_line text,
  city text,
  province text,
  postal_code text,
  emergency_contact_1_name text,
  emergency_contact_1_relationship text,
  emergency_contact_1_phone text,
  emergency_contact_2_name text,
  emergency_contact_2_relationship text,
  emergency_contact_2_phone text,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.profile_private ENABLE ROW LEVEL SECURITY;

-- Owner-only, by design: no manager or admin policy exists on this
-- table. A future "managers may see addresses" permission, if ever
-- wanted, would be an explicit new policy here, not a default.
DROP POLICY IF EXISTS "profile_private_select_own" ON public.profile_private;
CREATE POLICY "profile_private_select_own" ON public.profile_private
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "profile_private_insert_own" ON public.profile_private;
CREATE POLICY "profile_private_insert_own" ON public.profile_private
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "profile_private_update_own" ON public.profile_private;
CREATE POLICY "profile_private_update_own" ON public.profile_private
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Copy existing values first (new rows are created by the app on save).
INSERT INTO public.profile_private (
  user_id, date_of_birth, address_line, city, province, postal_code,
  emergency_contact_1_name, emergency_contact_1_relationship, emergency_contact_1_phone,
  emergency_contact_2_name, emergency_contact_2_relationship, emergency_contact_2_phone
)
SELECT
  id, date_of_birth, address_line, city, province, postal_code,
  emergency_contact_1_name, emergency_contact_1_relationship, emergency_contact_1_phone,
  emergency_contact_2_name, emergency_contact_2_relationship, emergency_contact_2_phone
FROM public.profiles
ON CONFLICT (user_id) DO NOTHING;

-- Only now remove the columns from profiles: this is what closes the
-- manager select * exposure.
ALTER TABLE public.profiles DROP COLUMN IF EXISTS date_of_birth;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS address_line;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS city;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS province;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS postal_code;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS emergency_contact_1_name;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS emergency_contact_1_relationship;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS emergency_contact_1_phone;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS emergency_contact_2_name;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS emergency_contact_2_relationship;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS emergency_contact_2_phone;
