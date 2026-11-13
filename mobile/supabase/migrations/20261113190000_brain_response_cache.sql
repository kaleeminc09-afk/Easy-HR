-- Brain reply cache: exact-repeat knowledge answers, so a repeated
-- question costs no tokens. Written and read ONLY by the hr-ai-bot
-- edge function through the service role. RLS is enabled with no
-- policies, so no app role can read or write it (service role
-- bypasses RLS). Rows older than 7 days are ignored by the function
-- and pruned on the next cache write.
create table if not exists public.brain_response_cache (
  id uuid primary key default gen_random_uuid(),
  cache_key text not null unique,
  reply text not null,
  created_at timestamptz not null default now()
);

alter table public.brain_response_cache enable row level security;

create index if not exists brain_response_cache_created_at_idx
  on public.brain_response_cache (created_at);
