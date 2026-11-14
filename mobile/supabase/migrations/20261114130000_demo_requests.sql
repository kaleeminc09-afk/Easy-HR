-- Demo-request leads from the marketing site ("Request a demo" form).
-- Written ONLY by the submit-demo-request edge function (service role).
-- RLS is enabled with NO policies: app roles see nothing, and the
-- public cannot read or list leads. The function validates, dedups,
-- and notifies; this table is the record that is never lost.
-- Idempotent: safe to re-run.
create table if not exists public.demo_requests (
  id uuid primary key default gen_random_uuid(),
  first_name text not null check (char_length(first_name) between 1 and 100),
  last_name text not null check (char_length(last_name) between 1 and 100),
  phone text not null check (char_length(phone) between 7 and 30),
  email text not null check (char_length(email) between 3 and 254),
  source text not null default 'website',
  contacted_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

alter table public.demo_requests enable row level security;

create index if not exists demo_requests_email_created_idx
  on public.demo_requests (email, created_at desc);
