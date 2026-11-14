-- Live legal rules for the Brain: break rules and minimum-wage
-- figures, read from this table on every chat request. A law change
-- is one UPDATE statement here — no code change, no redeploy — and
-- the Brain's reply cache invalidates itself because the rules
-- fingerprint in the cache key changes with the rows.
-- RLS is enabled with no policies: only the service-role function
-- reads this table. Updates run through the SQL editor (the postgres
-- role bypasses RLS). Record the official source URL on every update.
create table if not exists public.legal_rules (
  rule_key text primary key,
  province text not null,
  rule_type text not null check (rule_type in ('break', 'min_wage')),
  payload jsonb not null,
  verified_date date not null,
  source_url text,
  updated_at timestamptz not null default now()
);

alter table public.legal_rules enable row level security;

create or replace function public.set_legal_rules_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists legal_rules_updated_at on public.legal_rules;
create trigger legal_rules_updated_at
  before update on public.legal_rules
  for each row execute function public.set_legal_rules_updated_at();

-- Seed: break rows copied exactly from the code fallback table
-- (summarised 2026-10-28), except Ontario, verified 2026-11-13.
-- Ontario wage rows verified 2026-11-13 (rates effective Oct 1, 2026).
-- ON CONFLICT DO NOTHING keeps this re-runnable without clobbering
-- any live update already applied to a row.
insert into public.legal_rules (rule_key, province, rule_type, payload, verified_date, source_url) values
  ('ON.break', 'ON', 'break', '{"code":"ON","name":"Ontario","meal_threshold_minutes":300,"meal_minutes":30,"split_allowed":true,"second_meal_threshold_minutes":null,"paid_if_available":true,"min_shift_minutes_for_meal":null,"note":"Eating period after no more than 5 consecutive hours; may be split into two 15-minute periods by agreement."}', '2026-11-13', null),
  ('BC.break', 'BC', 'break', '{"code":"BC","name":"British Columbia","meal_threshold_minutes":300,"meal_minutes":30,"split_allowed":false,"second_meal_threshold_minutes":null,"paid_if_available":true,"min_shift_minutes_for_meal":null,"note":"30 minutes after 5 consecutive hours; paid if the employee must remain available."}', '2026-10-28', null),
  ('AB.break', 'AB', 'break', '{"code":"AB","name":"Alberta","meal_threshold_minutes":300,"meal_minutes":30,"split_allowed":true,"second_meal_threshold_minutes":600,"paid_if_available":true,"min_shift_minutes_for_meal":null,"note":"30 minutes (or two 15-minute periods) after 5 hours; a second 30-minute break for shifts over 10 hours."}', '2026-10-28', null),
  ('QC.break', 'QC', 'break', '{"code":"QC","name":"Quebec","meal_threshold_minutes":300,"meal_minutes":30,"split_allowed":false,"second_meal_threshold_minutes":null,"paid_if_available":true,"min_shift_minutes_for_meal":null,"note":"30 minutes after 5 consecutive hours; paid if the employee is not allowed to leave the workstation."}', '2026-10-28', null),
  ('MB.break', 'MB', 'break', '{"code":"MB","name":"Manitoba","meal_threshold_minutes":300,"meal_minutes":30,"split_allowed":false,"second_meal_threshold_minutes":null,"paid_if_available":true,"min_shift_minutes_for_meal":null,"note":"30 minutes after 5 consecutive hours."}', '2026-10-28', null),
  ('SK.break', 'SK', 'break', '{"code":"SK","name":"Saskatchewan","meal_threshold_minutes":300,"meal_minutes":30,"split_allowed":false,"second_meal_threshold_minutes":null,"paid_if_available":true,"min_shift_minutes_for_meal":360,"note":"Meal within the first 5 hours, owed on shifts over 6 hours."}', '2026-10-28', null),
  ('NS.break', 'NS', 'break', '{"code":"NS","name":"Nova Scotia","meal_threshold_minutes":300,"meal_minutes":30,"split_allowed":false,"second_meal_threshold_minutes":null,"paid_if_available":true,"min_shift_minutes_for_meal":null,"note":"30 minutes after 5 consecutive hours."}', '2026-10-28', null),
  ('NB.break', 'NB', 'break', '{"code":"NB","name":"New Brunswick","meal_threshold_minutes":null,"meal_minutes":0,"split_allowed":false,"second_meal_threshold_minutes":null,"paid_if_available":false,"min_shift_minutes_for_meal":null,"note":"No express statutory meal break — employer policy governs; the app flags nothing as a legal violation here."}', '2026-10-28', null),
  ('NL.break', 'NL', 'break', '{"code":"NL","name":"Newfoundland and Labrador","meal_threshold_minutes":300,"meal_minutes":60,"split_allowed":false,"second_meal_threshold_minutes":null,"paid_if_available":true,"min_shift_minutes_for_meal":null,"note":"1 hour after 5 consecutive hours."}', '2026-10-28', null),
  ('PE.break', 'PE', 'break', '{"code":"PE","name":"Prince Edward Island","meal_threshold_minutes":300,"meal_minutes":30,"split_allowed":false,"second_meal_threshold_minutes":null,"paid_if_available":true,"min_shift_minutes_for_meal":null,"note":"30 minutes after 5 consecutive hours."}', '2026-10-28', null),
  ('YT.break', 'YT', 'break', '{"code":"YT","name":"Yukon","meal_threshold_minutes":300,"meal_minutes":30,"split_allowed":false,"second_meal_threshold_minutes":null,"paid_if_available":true,"min_shift_minutes_for_meal":null,"note":"30 minutes after 5 consecutive hours."}', '2026-10-28', null),
  ('NT.break', 'NT', 'break', '{"code":"NT","name":"Northwest Territories","meal_threshold_minutes":300,"meal_minutes":30,"split_allowed":false,"second_meal_threshold_minutes":null,"paid_if_available":true,"min_shift_minutes_for_meal":null,"note":"30 minutes after 5 consecutive hours."}', '2026-10-28', null),
  ('NU.break', 'NU', 'break', '{"code":"NU","name":"Nunavut","meal_threshold_minutes":300,"meal_minutes":30,"split_allowed":false,"second_meal_threshold_minutes":null,"paid_if_available":true,"min_shift_minutes_for_meal":null,"note":"30 minutes after 5 consecutive hours."}', '2026-10-28', null),
  ('FED.break', 'FED', 'break', '{"code":"FED","name":"Federal (Canada Labour Code)","meal_threshold_minutes":300,"meal_minutes":30,"split_allowed":false,"second_meal_threshold_minutes":null,"paid_if_available":true,"min_shift_minutes_for_meal":null,"note":"30 minutes for every 5 consecutive hours; paid if the employee must be at the employer''s disposal."}', '2026-10-28', null),
  ('ON.min_wage_general', 'ON', 'min_wage', '{"category":"general","label":"General","amount_cents":1795,"effective_from":"2026-10-01"}', '2026-11-13', null),
  ('ON.min_wage_student', 'ON', 'min_wage', '{"category":"student","label":"Student (under 18)","amount_cents":1690,"effective_from":"2026-10-01"}', '2026-11-13', null),
  ('ON.min_wage_homeworker', 'ON', 'min_wage', '{"category":"homeworker","label":"Homeworker","amount_cents":1970,"effective_from":"2026-10-01"}', '2026-11-13', null)
on conflict (rule_key) do nothing;
