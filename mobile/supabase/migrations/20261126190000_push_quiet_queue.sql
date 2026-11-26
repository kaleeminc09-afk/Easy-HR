-- Push v1, step 3: the overnight queue. Request and billing pings
-- arriving between 10 PM and 7 AM in the caller's timezone are
-- logged as 'queued' with a deliver_at (7 AM) instead of sending
-- now; the step-4 sweep flushes them. The dedupe index gains
-- 'queued' so the same event cannot be queued twice, and the
-- status check gains the new status.
alter table public.notification_log add column if not exists deliver_at timestamptz;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'notification_log_status_check' and conrelid = 'public.notification_log'::regclass) then
    alter table public.notification_log drop constraint notification_log_status_check;
  end if;
end $$;
alter table public.notification_log add constraint notification_log_status_check
  check (status in ('sending', 'sent', 'failed', 'skipped_preference', 'skipped_no_token', 'duplicate', 'queued'));

drop index if exists public.notification_log_dedupe_idx;
create unique index notification_log_dedupe_idx
  on public.notification_log (recipient_user_id, type, ref_type, ref_id)
  where status in ('sent', 'sending', 'queued');

create index if not exists notification_log_queued_idx
  on public.notification_log (deliver_at) where status = 'queued';
