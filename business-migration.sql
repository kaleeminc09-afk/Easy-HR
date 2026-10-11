-- NorthShift business identity migration. Run once in the Supabase SQL editor.
-- Safe to re-run.
--
-- What it does:
--  1. Creates public.businesses: each client company gets a unique
--     account number (e.g. NS-7K2P9X) and an admin-editable business name.
--  2. Links public.profiles to a business via business_id.
--  3. Seeds one business per existing admin and assigns all existing
--     profiles to the first admin's business.
--
-- Notes:
--  - Only admins can create/edit businesses (RLS). Every signed-in user
--    can see their own business's name and account number.
--  - Support email shown in the app: support@northshiftapp.com
--    (confirm/create this mailbox before launch).

-- 1) Businesses table
CREATE TABLE IF NOT EXISTS public.businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_number TEXT UNIQUE NOT NULL,
  business_name TEXT NOT NULL DEFAULT 'My Business',
  owner_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2) Account number generator: NS-XXXXXX, collision-safe
CREATE OR REPLACE FUNCTION public.generate_account_number()
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  new_num TEXT;
BEGIN
  LOOP
    new_num := 'NS-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.businesses WHERE account_number = new_num);
  END LOOP;
  RETURN new_num;
END;
$$;

-- 3) Link profiles to a business
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

-- 4) RLS
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS businesses_select_own_or_admin ON public.businesses;
CREATE POLICY businesses_select_own_or_admin ON public.businesses
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR id IN (SELECT business_id FROM public.profiles WHERE id = auth.uid())
  );

DROP POLICY IF EXISTS businesses_admin_write ON public.businesses;
CREATE POLICY businesses_admin_write ON public.businesses
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 5) Seed: one business per existing admin
INSERT INTO public.businesses (account_number, business_name, owner_id)
SELECT public.generate_account_number(), 'My Business', id
FROM public.profiles
WHERE role = 'admin'
  AND NOT EXISTS (SELECT 1 FROM public.businesses WHERE owner_id = profiles.id);

-- 6) Assign every profile without a business to the first business
UPDATE public.profiles
SET business_id = (SELECT id FROM public.businesses ORDER BY created_at LIMIT 1)
WHERE business_id IS NULL
  AND EXISTS (SELECT 1 FROM public.businesses);
