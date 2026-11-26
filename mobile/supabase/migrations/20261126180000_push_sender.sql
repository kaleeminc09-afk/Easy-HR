-- Push v1, step 2: the send log (dedupe + audit) and the three
-- preference switches on profiles. The sender (send-push, service
-- role) reads and writes these; the app only reads its own log rows.
-- The partial unique index is the dedupe backstop: only 'sent' and
-- 'sending' rows block a retry, so a skipped or failed attempt never
-- stops a later one. New tables on this project arrive with full
-- default grants; RLS below is the real boundary.
create table if not exists public.notification_log (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references public.profiles(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete cascade,
  caller_user_id uuid references public.profiles(id) on delete set null,
  type text not null,
  ref_type text not null,
  ref_id text not null,
  title text not null,
  body text not null,
  url text,
  status text not null check (status in ('sending', 'sent', 'failed', 'skipped_preference', 'skipped_no_token', 'duplicate')),
  expo_ticket_id text,
  error text,
  created_at timestamptz not null default now()
);

alter table public.notification_log enable row level security;

drop policy if exists "notification_log_select_own" on public.notification_log;
create policy "notification_log_select_own" on public.notification_log
  for select to authenticated using (auth.uid() = recipient_user_id);

create unique index if not exists notification_log_dedupe_idx
  on public.notification_log (recipient_user_id, type, ref_type, ref_id)
  where status in ('sent', 'sending');
create index if not exists notification_log_business_id_idx on public.notification_log (business_id);
create index if not exists notification_log_created_at_idx on public.notification_log (created_at desc);

alter table public.profiles add column if not exists push_reminders boolean not null default true;
alter table public.profiles add column if not exists push_requests boolean not null default true;
alter table public.profiles add column if not exists push_billing boolean not null default true;
