-- Living Brain v1: gap log + approved knowledge.
--
-- brain_gaps: questions the Brain could not answer, logged by hr-ai-bot
-- through the service role (one row per ask; grouped by question_hash
-- in the backoffice). Answering a gap means approving a brain_knowledge
-- row, then marking the gap answered. The Brain never writes its own
-- answers — every knowledge entry is human-approved.
--
-- brain_knowledge: curated answers approved in the backoffice. The
-- Brain reads active rows on every request and quotes them. Retiring
-- a row (is_active = false) removes it from the Brain immediately.
--
-- RLS is enabled with no policies on both tables: service-role only,
-- like legal_rules and brain_response_cache. The backoffice reads and
-- writes through the admin-clients function (service role).

create table if not exists public.brain_gaps (
  id uuid primary key default gen_random_uuid(),
  business_id uuid,
  user_id uuid,
  question text not null,
  question_hash text not null,
  status text not null default 'open' check (status in ('open', 'answered', 'dismissed')),
  created_at timestamptz not null default now()
);

alter table public.brain_gaps enable row level security;

create index if not exists brain_gaps_hash_idx
  on public.brain_gaps (question_hash);
create index if not exists brain_gaps_created_at_idx
  on public.brain_gaps (created_at desc);

create table if not exists public.brain_knowledge (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  answer text not null,
  source_url text,
  verified_date date not null default current_date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.brain_knowledge enable row level security;

create or replace function public.set_brain_knowledge_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists brain_knowledge_updated_at on public.brain_knowledge;
create trigger brain_knowledge_updated_at
  before update on public.brain_knowledge
  for each row execute function public.set_brain_knowledge_updated_at();
