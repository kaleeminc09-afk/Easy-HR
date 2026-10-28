# Supabase migrations — NorthShift

## What this is
Audit item 4, closed in code on 2026-10-28: the database schema now lives in
the repo, in order, so a fresh Supabase project can be rebuilt from these
files. Before this, the schema only existed as SQL run in the dashboard.

## DO NOT run these on the live project
The live database already has all of this. These files are for a **fresh or
throwaway project** (rebuild test, staging, disaster recovery). Running them
on live is mostly harmless (IF NOT EXISTS / DROP IF EXISTS guards) but
pointless, and the policy file would recreate policies that are already there.

## Order
1. `20261028120000_baseline_tables.sql` — all 16 tables, foreign keys,
   defaults, and the audit-item-9 indexes.
2. `20261028120001_functions_triggers.sql` — is_manager/is_admin, the role
   guard, the signup trigger (hardcoded 'employee'), account-number generator.
3. `20261028120002_rls_policies.sql` — RLS on, every live policy, minus the
   profiles "Allow all" policy dropped 2026-10-28.

## What is verified vs inferred
- **Verified 2026-10-28** against the live schema listing: table names,
  column names and types, nullability, and the full policy set (with the two
  same-day fixes: profiles.created_at added, profiles "Allow all" dropped).
- **Inferred** from app code and the repo's older migration files, because
  the listing did not include them: foreign keys, column defaults, and the
  three manager indexes. If a fresh build ever disagrees with live, live wins
  and these files get corrected.

## What is NOT in here (do these separately on a fresh project)
- **Storage bucket `employee-documents`** (private, 10 MB, PDF/image/Word
  only, 5-minute signed URLs) and its bucket policies — buckets are not
  created by table migrations; create it in the dashboard or via the
  Storage API, then apply its policies.
- **Data API grants.** Tables created in `public` on/after 2026-10-30 get no
  automatic Data API grants, so a fresh project built from these files will
  need explicit grants (anon select; authenticated and service_role full
  access) before the app can read through PostgREST. The grant block is
  intentionally NOT in this patch: per Kaleem's standing rule, no grant
  block ships until he explicitly approves it. When he approves, add it as
  a fourth migration file, not by editing these three.
- **Seed data.** No businesses, profiles, or subscriptions are seeded here.
  On a fresh project, create the first admin through the app signup, then
  promote that profile to admin from the SQL editor, exactly as the live
  project was bootstrapped.

## How to verify a rebuild
1. Create a throwaway Supabase project.
2. Run the three files in order in its SQL editor.
3. Create the storage bucket (above), then point a dev build at the new
   project (env vars + dev-server restart) and run: signup, sign-in,
   clock-in/out, a break, a shift claim, a time-off request, a document
   upload, and the manager view.
4. Run the Jest suite from `mobile/` (`npm test`).
5. If anything disagrees with live, fix the migration file, not the live
   database, and re-test from step 2.
