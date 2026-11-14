-- CRM backoffice, Phase 1 (foundation): activity log + CRM tables.
-- Account numbers already exist (businesses.account_number, NS-XXXXXX,
-- created by the create-business function) — no change needed there.
--
-- activity_events: the app footprint log. The app inserts its own rows
-- (sign_in / sign_out in Phase 1; feature events later) through the
-- INSERT policy below — own user id, own business or NULL business
-- (fresh sign-ins resolve their business before any profile read).
-- There is deliberately NO select policy: clients can never read the
-- log. Only the admin-clients edge function (service role) reads it.
-- Policies never query their own table inline (see the 2026-11-12
-- recursion outage) — the business check goes through my_business_id().
--
-- crm_interactions + admin_audit: written only by the admin-clients
-- function (service role). RLS enabled, zero policies: app roles see
-- nothing. Idempotent: safe to re-run.

create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  event text not null check (char_length(event) between 1 and 60),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.activity_events enable row level security;

drop policy if exists activity_events_insert_own on public.activity_events;
create policy activity_events_insert_own
  on public.activity_events
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and (business_id is null or business_id = public.my_business_id())
  );

create index if not exists activity_events_business_created_idx
  on public.activity_events (business_id, created_at desc);
create index if not exists activity_events_user_created_idx
  on public.activity_events (user_id, created_at desc);

create table if not exists public.crm_interactions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  kind text not null check (kind in ('note', 'call', 'email', 'meeting')),
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

alter table public.crm_interactions enable row level security;

create index if not exists crm_interactions_business_created_idx
  on public.crm_interactions (business_id, created_at desc);

create table if not exists public.admin_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null check (char_length(action) between 1 and 80),
  target_business_id uuid references public.businesses(id) on delete cascade,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.admin_audit enable row level security;

create index if not exists admin_audit_business_created_idx
  on public.admin_audit (target_business_id, created_at desc);
