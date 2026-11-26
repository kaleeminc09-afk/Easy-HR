-- Push v1, step 4: the per-business reminder lead time, in
-- minutes before a shift starts. Default 60 (the plan's default);
-- a business that suits 30 minutes changes one value, and step 6
-- exposes it in settings. 5–480 keeps a typo from silencing
-- reminders for a whole day.
alter table public.businesses
  add column if not exists reminder_lead_minutes integer not null default 60
  check (reminder_lead_minutes between 5 and 480);
