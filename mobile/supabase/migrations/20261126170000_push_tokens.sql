-- Push v1, step 1: one row per device per user for Expo push tokens.
-- The sender (step 2, service role) reads these; the app only ever
-- touches its own rows. A token is NOT globally unique: two users on
-- one shared phone hold separate rows for the same device token, and
-- the sender dedupes by token value. New tables on this project arrive
-- with full default grants; RLS below is the real boundary.
create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete cascade,
  token text not null,
  platform text not null check (platform in ('ios', 'android')),
  is_active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, token)
);

alter table public.push_tokens enable row level security;

drop policy if exists "push_tokens_select_own" on public.push_tokens;
create policy "push_tokens_select_own" on public.push_tokens
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "push_tokens_insert_own" on public.push_tokens;
create policy "push_tokens_insert_own" on public.push_tokens
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "push_tokens_update_own" on public.push_tokens;
create policy "push_tokens_update_own" on public.push_tokens
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "push_tokens_delete_own" on public.push_tokens;
create policy "push_tokens_delete_own" on public.push_tokens
  for delete to authenticated using (auth.uid() = user_id);

create index if not exists push_tokens_user_id_idx on public.push_tokens (user_id);
create index if not exists push_tokens_token_idx on public.push_tokens (token);
create index if not exists push_tokens_business_id_idx on public.push_tokens (business_id);
