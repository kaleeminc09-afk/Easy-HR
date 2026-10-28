-- NorthShift baseline schema — audit item 4 (2026-10-28).
-- Rebuilds the live database from scratch on a FRESH project.
-- DO NOT RUN THIS ON THE LIVE PROJECT: the live database already has
-- these tables, and re-running CREATE TABLE IF NOT EXISTS is harmless
-- but the seed/alter steps in later migrations are not needed there.
--
-- Source of truth: the live schema listing verified 2026-10-28 (16 tables,
-- columns, nullability, and RLS policies), plus the two fixes applied
-- that same day:
--   * profiles.created_at added (was missing; Manage Users reads it)
--   * profiles "Allow all" policy dropped (see 0003 policies file)
-- Foreign keys, defaults, and indexes below are INFERRED from the app
-- code and the repo's older migration files, because the listing did
-- not include them. They are safe for a fresh project; if a fresh
-- build ever disagrees with the live database, the live database wins
-- and this file gets corrected.
-- Data API grants are deliberately NOT in these files (see README.md).

-- Legacy tables (locations, clock_ins, geo_exceptions) are kept here
-- because they exist live and are locked down by RLS (no policies).
-- No app code references them; do not build new features on them.

CREATE TABLE IF NOT EXISTS public.locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  radius_meters integer NOT NULL
);

CREATE TABLE IF NOT EXISTS public.worksites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  radius_meters integer,
  created_at timestamptz DEFAULT now(),
  address text
);

-- profiles: id is the auth user id, so it has no generated default.
-- business_id FK is added at the end (businesses references profiles
-- for owner_id, so the two tables reference each other).
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY,
  first_name text,
  last_name text,
  full_name text,
  email text,
  role text CHECK (role IN ('employee', 'manager', 'admin')),
  business_id uuid,
  phone text,
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
  job_title text,
  department text,
  start_date date,
  employment_type text,
  primary_worksite_id uuid REFERENCES public.worksites(id) ON DELETE SET NULL,
  employee_number text,
  vacation_days_entitlement numeric DEFAULT 10,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_number text UNIQUE NOT NULL,
  business_name text NOT NULL DEFAULT 'My Business',
  owner_id uuid,
  created_at timestamptz DEFAULT now()
);

-- Circular pair, added after both tables exist.
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE SET NULL;
ALTER TABLE public.businesses
  ADD CONSTRAINT businesses_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.time_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  worksite_id uuid REFERENCES public.worksites(id) ON DELETE SET NULL,
  clock_in timestamptz NOT NULL,
  clock_out timestamptz,
  ai_anomaly_flag text
);

CREATE TABLE IF NOT EXISTS public.time_breaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  time_log_id uuid REFERENCES public.time_logs(id) ON DELETE CASCADE,
  break_type text NOT NULL,
  start_time timestamptz,
  end_time timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.time_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  worksite_id uuid REFERENCES public.worksites(id) ON DELETE SET NULL,
  attempted_at timestamptz,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  distance_meters integer NOT NULL,
  reason_note text NOT NULL,
  status text,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.clock_ins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id text NOT NULL,
  employee_name text NOT NULL,
  created_at timestamptz DEFAULT now(),
  status text
);

CREATE TABLE IF NOT EXISTS public.geo_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id text NOT NULL,
  requested_at timestamptz DEFAULT now(),
  distance_meters numeric NOT NULL,
  reason text NOT NULL,
  status text,
  approved_by text,
  approved_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.tasks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  assigned_to uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  due_date date,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT tasks_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter', 'growth', 'business')),
  status text NOT NULL DEFAULT 'trialing' CHECK (status IN ('active', 'trialing', 'past_due', 'canceled')),
  employee_limit integer NOT NULL DEFAULT 5,
  current_period_end timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  worksite_id uuid REFERENCES public.worksites(id) ON DELETE SET NULL,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  status text NOT NULL,
  claimed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.time_off_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  half_day boolean NOT NULL,
  reason text,
  status text NOT NULL,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  uploaded_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  file_name text NOT NULL,
  storage_path text NOT NULL,
  content_type text,
  size_bytes integer,
  category text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.break_policies (
  business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  province text NOT NULL DEFAULT 'ON',
  meal_minutes integer NOT NULL DEFAULT 30,
  rest_minutes integer NOT NULL DEFAULT 15,
  rest_max_per_shift integer NOT NULL DEFAULT 2,
  meal_paid_if_available boolean NOT NULL DEFAULT true,
  updated_at timestamptz DEFAULT now()
);

-- Indexes from audit item 9 (manager loads otherwise hit the
-- PostgREST row cap as teams grow). Added here, not live-verified.
CREATE INDEX IF NOT EXISTS time_logs_user_clock_out_idx ON public.time_logs (user_id, clock_out);
CREATE INDEX IF NOT EXISTS shifts_user_start_idx ON public.shifts (user_id, start_time);
CREATE INDEX IF NOT EXISTS time_off_user_status_idx ON public.time_off_requests (user_id, status);
CREATE INDEX IF NOT EXISTS profiles_business_idx ON public.profiles (business_id);
