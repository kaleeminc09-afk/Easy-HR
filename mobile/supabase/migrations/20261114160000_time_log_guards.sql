-- NorthShift: database-level guards for time logs (Nov 14, 2026).
-- Round 2C of the Nov 14 function-test gaps. The app already enforces
-- these rules in code; this migration makes the database enforce them
-- too, so no direct API call can bypass them.
--
-- PRE-CHECKS (run before this migration; both must return 0 rows):
--   1. Duplicate open shifts:
--      SELECT user_id, COUNT(*) FROM public.time_logs WHERE clock_out IS NULL GROUP BY user_id HAVING COUNT(*) > 1;
--   2. Overlapping assigned shifts for the same employee:
--      SELECT a.user_id, a.id, b.id FROM public.shifts a JOIN public.shifts b
--        ON a.user_id = b.user_id AND a.id < b.id
--       WHERE a.status = 'assigned' AND b.status = 'assigned'
--         AND a.start_time < b.end_time AND b.start_time < a.end_time;
-- If either returns rows, resolve them first (close/void the extra
-- open shift; delete or fix the overlapping shift), then run this.

-- 1. Clock-in/out coordinates on time_logs. The app stores clock-in
-- coordinates from both clock-in paths (GPS + QR). Clock-out
-- coordinates stay NULL in v1: clock-out reads no GPS today.
ALTER TABLE public.time_logs
  ADD COLUMN IF NOT EXISTS clock_in_latitude double precision,
  ADD COLUMN IF NOT EXISTS clock_in_longitude double precision,
  ADD COLUMN IF NOT EXISTS clock_out_latitude double precision,
  ADD COLUMN IF NOT EXISTS clock_out_longitude double precision;

-- 2. Geofence enforcement on insert. When the insert carries clock-in
-- coordinates and the worksite has a radius, the coordinates must be
-- inside the radius — unless an approved exception for this user +
-- worksite exists for today (day-scope rule). Inserts without
-- coordinates are allowed: legacy writers (checklist bots) send
-- none, and the app always sends them. SECURITY DEFINER so the
-- checks read worksites/exceptions the same way for every caller.
CREATE OR REPLACE FUNCTION public.check_geofence_on_clock_in()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  site_lat double precision;
  site_lng double precision;
  site_radius integer;
  dist_m double precision;
  has_approval boolean;
BEGIN
  IF NEW.worksite_id IS NULL OR NEW.clock_in_latitude IS NULL OR NEW.clock_in_longitude IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT latitude, longitude, radius_meters INTO site_lat, site_lng, site_radius
    FROM public.worksites WHERE id = NEW.worksite_id;
  IF NOT FOUND OR site_radius IS NULL THEN
    RETURN NEW;
  END IF;
  -- Haversine distance in metres.
  dist_m := 6371000 * 2 * asin(sqrt(
    power(sin(radians(NEW.clock_in_latitude - site_lat) / 2), 2) +
    cos(radians(site_lat)) * cos(radians(NEW.clock_in_latitude)) *
    power(sin(radians(NEW.clock_in_longitude - site_lng) / 2), 2)
  ));
  IF dist_m <= site_radius THEN
    RETURN NEW;
  END IF;
  -- Out of range: allowed only with an approved exception filed today
  -- (server date; the app's own check uses the device-local day and
  -- is the stricter one).
  SELECT EXISTS (
    SELECT 1 FROM public.time_exceptions
     WHERE user_id = NEW.user_id
       AND worksite_id = NEW.worksite_id
       AND status = 'approved'
       AND attempted_at >= CURRENT_DATE
  ) INTO has_approval;
  IF has_approval THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Clock-in rejected: %s m from worksite, radius %s m, no approved exception', round(dist_m), site_radius;
END;
$$;

DROP TRIGGER IF EXISTS time_logs_geofence_check ON public.time_logs;
CREATE TRIGGER time_logs_geofence_check
  BEFORE INSERT ON public.time_logs
  FOR EACH ROW EXECUTE FUNCTION public.check_geofence_on_clock_in();

-- 3. Duplicate micro-log flag. A clock-in minutes after a clock-out
-- at the same worksite gets flagged (the Nov 14 test found three
-- identical 0.09h entries). Only 'Normal Shift' flags are rewritten,
-- so an explicit flag (e.g. 'Exception Approved') is never clobbered.
CREATE OR REPLACE FUNCTION public.flag_duplicate_clock_in()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  recent_close timestamptz;
BEGIN
  IF NEW.worksite_id IS NULL OR NEW.ai_anomaly_flag IS DISTINCT FROM 'Normal Shift' THEN
    RETURN NEW;
  END IF;
  SELECT MAX(clock_out) INTO recent_close
    FROM public.time_logs
   WHERE user_id = NEW.user_id
     AND worksite_id = NEW.worksite_id
     AND clock_out IS NOT NULL
     AND clock_out <= NEW.clock_in
     AND clock_out > NEW.clock_in - INTERVAL '10 minutes';
  IF recent_close IS NOT NULL THEN
    NEW.ai_anomaly_flag := '⚠️ Flagged: Possible Duplicate (clock-in within 10 min of clock-out)';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS time_logs_duplicate_check ON public.time_logs;
CREATE TRIGGER time_logs_duplicate_check
  BEFORE INSERT ON public.time_logs
  FOR EACH ROW EXECUTE FUNCTION public.flag_duplicate_clock_in();

-- 4. One open shift per user. The app already guards double clock-in;
-- this index makes it impossible at the database level. Created only
-- when no user currently has two open shifts (pre-check 1 above);
-- otherwise it raises a NOTICE and the index must be created after
-- the duplicates are resolved.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.time_logs WHERE clock_out IS NULL GROUP BY user_id HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE 'Skipping time_logs_one_open_shift_per_user: a user has more than one open shift. Resolve the duplicates, then run: CREATE UNIQUE INDEX time_logs_one_open_shift_per_user ON public.time_logs (user_id) WHERE clock_out IS NULL;';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS time_logs_one_open_shift_per_user
      ON public.time_logs (user_id) WHERE clock_out IS NULL;
  END IF;
END $$;

-- 5. No overlapping assigned shifts for the same employee. tstzrange
-- is [start, end): back-to-back shifts do not overlap. Open shifts
-- (user_id NULL / status 'open') are excluded; claiming one
-- re-validates. Requires btree_gist for the GiST equality + range
-- combination.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE c.conname = 'shifts_no_overlap' AND t.relname = 'shifts'
  ) THEN
    ALTER TABLE public.shifts ADD CONSTRAINT shifts_no_overlap
      EXCLUDE USING gist (user_id WITH =, tstzrange(start_time, end_time) WITH &&)
      WHERE (status = 'assigned' AND user_id IS NOT NULL);
  END IF;
END $$;
