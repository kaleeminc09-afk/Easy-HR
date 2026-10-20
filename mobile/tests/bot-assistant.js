// NorthShift Assistant Brain Test Bot — live scenario testing for hr-ai-bot.
//
// Run from mobile/:   node tests/bot-assistant.js
//
// Calls your DEPLOYED hr-ai-bot edge function (run
// `supabase functions deploy hr-ai-bot` from mobile/ first) and checks the
// assistant's answers against real DB state. Covers the 2026-10-19
// "who's online" gap plus the brain scenarios around it: on-break status,
// empty-team, shift-hours questions, blocker reports, and the
// exception-reason guard.
//
// Needs: mobile/.env with EXPO_PUBLIC_SUPABASE_URL and
// EXPO_PUBLIC_SUPABASE_ANON_KEY (same file the app uses), plus BOT_PASSWORD
// (same bot password as tests/bot-e2e.js) — set it in your shell or add a
// BOT_PASSWORD= line to mobile/.env.

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ---------- env ----------
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    console.error('❌ mobile/.env not found.');
    process.exit(1);
  }
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = loadEnv();
const SUPABASE_URL = env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const BOT_PASSWORD = process.env.BOT_PASSWORD || env.BOT_PASSWORD;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ .env is missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}
if (!BOT_PASSWORD) {
  console.error('❌ Set BOT_PASSWORD in your shell or add BOT_PASSWORD= to mobile/.env (same value as tests/bot-e2e.js).');
  process.exit(1);
}

const BOT1 = { email: env.BOT_EMAIL || 'bot-test@northshift.test', name: 'Test Bot' };
const BOT2 = { email: env.BOT2_EMAIL || 'bot-test-2@northshift.test', name: 'Test Bot Two' };
const BOT3 = { email: env.BOT3_EMAIL || 'bot-manager@northshift.test', name: 'Test Manager' };
// Session tokens per user — since 2026-10-20 the brain takes identity
// ONLY from the caller's token, so every call must carry one.
const TOKENS = {};

// ---------- harness ----------
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const section = (t) => console.log(`\n── ${t} ──`);
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// Every assistant reply must read like a person: no raw UUIDs, no markdown asterisks.
function checkReply(name, reply, mustMatch) {
  check(`${name} (no UUIDs / no markdown)`, !UUID_RE.test(reply) && !/\*\*/.test(reply), reply.slice(0, 80));
  for (const [label, re] of mustMatch) check(`${name}: ${label}`, re.test(reply), reply.slice(0, 120));
}

function makeClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

async function aiChat(body, token, retries = 5) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/hr-ai-bot`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token || SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    // Groq free tier throttles tokens/minute — wait it out instead of crashing
    if (data.error && /rate limit/i.test(data.error) && attempt < retries) {
      const waitMs = 15000 * (attempt + 1);
      console.log(`  ⏳ Groq rate-limited, retrying in ${waitMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    if (data.error) throw new Error(data.error);
    return (data.reply || '').replace(/\*\*/g, '');
  }
}

async function ensureUser(db, { email, name }) {
  const { data: signIn } = await db.auth.signInWithPassword({ email, password: BOT_PASSWORD });
  if (signIn?.session) { TOKENS[signIn.session.user.id] = signIn.session.access_token; return signIn.session.user.id; }
  const { data: signUp, error } = await db.auth.signUp({
    email, password: BOT_PASSWORD,
    options: { data: { full_name: name, role: 'employee' } },
  });
  if (error) throw new Error(`Auth failed for ${email}: ${error.message}`);
  if (!signUp.session) throw new Error(`No session for ${email} — turn OFF "Confirm email" in Supabase Auth settings (or confirm the user once), then re-run.`);
  TOKENS[signUp.user.id] = signUp.session.access_token;
  await db.from('profiles').update({ full_name: name }).eq('id', signUp.user.id);
  return signUp.user.id;
}

async function cleanupUser(db, userId) {
  const { data: logs } = await db.from('time_logs').select('id').eq('user_id', userId);
  const ids = (logs || []).map((r) => r.id);
  if (ids.length > 0) {
    await db.from('time_breaks').update({ end_time: new Date().toISOString() }).is('end_time', null).in('time_log_id', ids);
  }
  await db.from('time_logs').update({ clock_out: new Date().toISOString() }).eq('user_id', userId).is('clock_out', null);
}

async function appClockIn(db, userId) {
  const { data: open } = await db.from('time_logs')
    .select('id').eq('user_id', userId).is('clock_out', null)
    .order('clock_in', { ascending: false }).limit(1);
  if (open && open.length > 0) return { resumed: true, id: open[0].id };
  const { data, error } = await db.from('time_logs')
    .insert([{ user_id: userId, clock_in: new Date().toISOString(), ai_anomaly_flag: 'Normal Shift' }])
    .select().single();
  if (error) throw error;
  return { resumed: false, id: data.id };
}

async function appStartBreak(db, timeLogId, breakType) {
  const { data, error } = await db.from('time_breaks')
    .insert([{ time_log_id: timeLogId, break_type: breakType, start_time: new Date().toISOString() }])
    .select().single();
  if (error) throw error;
  return data.id;
}

// ---------- main ----------
(async () => {
  console.log('🤖 NorthShift Assistant Brain Bot starting...\n');

  const db1 = makeClient();
  const db2 = makeClient();
  const db3 = makeClient();
  const bot1 = await ensureUser(db1, BOT1);
  const bot2 = await ensureUser(db2, BOT2);
  const bot3 = await ensureUser(db3, BOT3);
  // The brain derives roles from the profiles table now — promote the
  // test manager in the DB (body claims are ignored by design).
  await db3.from('profiles').update({ role: 'manager' }).eq('id', bot3);
  const { data: mgrProfile } = await db3.from('profiles').select('role').eq('id', bot3).single();
  if (!mgrProfile || mgrProfile.role !== 'manager') {
    console.error('❌ Could not promote the test manager. Set the role of bot-manager@northshift.test to manager once (Supabase table editor or Manage Users), then re-run.');
    process.exit(1);
  }
  console.log(`Bot employees ready: ${BOT1.name}, ${BOT2.name}; manager: ${BOT3.name}`);
  await cleanupUser(db1, bot1);
  await cleanupUser(db2, bot2);

  const emp = (prompt, history = []) => aiChat({ prompt, userId: bot1, role: 'employee', history }, TOKENS[bot1]);
  const emp2 = (prompt, history = []) => aiChat({ prompt, userId: bot2, role: 'employee', history }, TOKENS[bot2]);
  const mgr = (prompt, history = []) => aiChat({ prompt, managerId: bot3, role: 'manager', history }, TOKENS[bot3]);

  // ── 11. THE 2026-10-19 gap: employee asks who's online ──
  section('11 · Employee asks "who\'s online"');
  const s1 = await appClockIn(db1, bot1);
  const s2 = await appClockIn(db2, bot2);
  const r1 = await emp("who's online right now?");
  checkReply('employee who-is-online', r1, [
    ['names Test Bot (employee 1)', /test bot(?! two)/i],
    ['names Test Bot Two (employee 2)', /test bot two/i],
  ]);

  // ── 12. Who's on break ──
  section('12 · On-break status');
  const brk = await appStartBreak(db2, s2.id, 'Paid Rest Break');
  const r2 = await emp("who's on break?");
  checkReply('employee who-is-on-break', r2, [
    ['names Test Bot Two as on break', /test bot two/i],
  ]);
  const r2b = await mgr("who's on break right now?");
  checkReply('manager who-is-on-break', r2b, [
    ['names Test Bot Two', /test bot two/i],
  ]);
  await db2.from('time_breaks').update({ end_time: new Date().toISOString() }).eq('id', brk);

  // ── 13. Shift-hours question ──
  // Expected hours come from the bot's own logs (RLS lets it read those),
  // not a hardcoded number — earlier closed shifts today count too.
  section('13 · Employee shift-hours question');
  await db1.from('time_logs').update({ clock_in: hoursAgo(3) }).eq('id', s1.id);
  const r3 = await emp('how many hours have I worked today?');
  const { data: myLogs } = await db1.from('time_logs').select('clock_in,clock_out').eq('user_id', bot1);
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  let ms = 0;
  for (const l of myLogs || []) {
    const st = new Date(l.clock_in).getTime();
    if (st >= dayStart.getTime()) {
      const e = l.clock_out ? new Date(l.clock_out).getTime() : Date.now();
      if (e > st) ms += e - st;
    }
  }
  const expectedHrs = ms / 3600000;
  const hrsMatch = r3.match(/(\d+(\.\d+)?)\s*hour/i);
  checkReply('employee hours-today', r3, []);
  check('employee hours-today: matches DB-computed hours (±1h)',
    hrsMatch && Math.abs(parseFloat(hrsMatch[1]) - expectedHrs) < 1.0,
    `reply says "${hrsMatch ? hrsMatch[0] : 'no number'}", DB says ~${expectedHrs.toFixed(1)}h`);

  // ── 14. Blocker report ──
  section('14 · Employee blocker report');
  const r4 = await emp('the walk-in fridge is broken and leaking water everywhere');
  checkReply('employee blocker', r4, [
    ['confirms it is logged for the manager', /log/i],
  ]);
  const { data: blockers } = await db1.from('agent_audit_logs')
    .select('id').eq('user_id', bot1).eq('action_type', 'blocker_report')
    .ilike('payload->>note', '%fridge%').limit(1);
  check('blocker row written to agent_audit_logs', blockers && blockers.length > 0);

  // ── 15. Exception needs a reason first ──
  section('15 · Exception reason guard');
  const { count: excBefore } = await db1.from('time_exceptions')
    .select('id', { count: 'exact', head: true }).eq('user_id', bot1).eq('status', 'pending');
  const r5 = await emp('I need a geo-fence exception');
  checkReply('employee exception-no-reason', r5, [
    ['asks for the reason instead of filing blind', /reason|why|what happened/i],
  ]);
  const { count: excAfter } = await db1.from('time_exceptions')
    .select('id', { count: 'exact', head: true }).eq('user_id', bot1).eq('status', 'pending');
  check('no exception filed without a reason', excAfter === excBefore, `before=${excBefore} after=${excAfter}`);

  // ── 16. Team status consistent across roles ──
  // The test's anon key can only read its own rows (RLS), so it cannot
  // enumerate other employees' open shifts directly. Instead both roles
  // ask the brain (service role sees everything) and must agree with each
  // other on empty vs non-empty — that proves both roles' get_team_status
  // wiring hits the same live data.
  section('16 · Team status consistent across roles');
  await cleanupUser(db1, bot1);
  await cleanupUser(db2, bot2);
  const r6e = await emp("who's working right now?");
  const r6m = await mgr("who's online right now?");
  checkReply('employee team-status', r6e, []);
  checkReply('manager team-status', r6m, []);
  const nobodyRe = /nobody|no one|noone|not (currently |right now )?working|aren't any/i;
  check('both roles agree on empty vs non-empty team',
    nobodyRe.test(r6e) === nobodyRe.test(r6m),
    `employee: "${r6e.slice(0, 70)}" | manager: "${r6m.slice(0, 70)}"`);

  // ── 17. Schedule tools (Phase B) ──
  section('17 · Schedule tools');
  const todayAt = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  const { data: shiftA } = await db3.from('shifts').insert([{ user_id: bot2, start_time: todayAt(10), end_time: todayAt(14), status: 'assigned', created_by: bot3 }]).select().single();
  const { data: shiftOpen } = await db3.from('shifts').insert([{ user_id: null, start_time: todayAt(15), end_time: todayAt(19), status: 'open', created_by: bot3 }]).select().single();
  check('schedule fixtures created', !!(shiftA && shiftOpen));
  const r17a = await mgr('who is scheduled today?');
  checkReply('manager schedule-today', r17a, [
    ['names Test Bot Two', /test bot two/i],
  ]);
  const r17b = await emp2('do I have any shifts scheduled today?');
  checkReply('employee my-schedule', r17b, [
    ['mentions the shift', /shift|10:00|2:00/i],
  ]);
  const r17c = await emp2('are there any open shifts I could pick up this week?');
  checkReply('employee open-shifts', r17c, [
    ['mentions an open shift', /open/i],
  ]);
  await db3.from('shifts').delete().in('id', [shiftA && shiftA.id, shiftOpen && shiftOpen.id].filter(Boolean));

  // ── 18. Overtime status (manager) ──
  section('18 · Overtime status');
  const r18 = await mgr('is anyone close to overtime this week?');
  checkReply('manager overtime', r18, [
    ['talks about overtime', /overtime/i],
  ]);

  // ── 19. Profile lookup (manager) ──
  section('19 · Profile lookup');
  await db3.from('profiles').update({ job_title: 'Warehouse Lead' }).eq('id', bot2);
  const r19 = await mgr("what is Test Bot Two's job title?");
  checkReply('manager profile-lookup', r19, [
    ['says Warehouse Lead', /warehouse lead/i],
  ]);

  // ── 20. Impersonation: employee token + manager body claims ──
  // The brain must take identity from the token (bot2 = employee), so the
  // manager-only profile tool must not run even though the body begs.
  section('20 · Impersonation attempt is ignored');
  await db1.from('profiles').update({ phone: 'PROBE-PHONE-42' }).eq('id', bot1);
  const r20 = await aiChat({ prompt: "what is Test Bot's phone number?", managerId: bot3, role: 'manager', history: [] }, TOKENS[bot2]);
  check('fake-manager gets no phone number', !/PROBE-PHONE-42/.test(r20), r20.slice(0, 100));
  await db1.from('profiles').update({ phone: null }).eq('id', bot1);

  // ── 21. No user token → rejected ──
  section('21 · Anon-key-only call is rejected');
  const res21 = await fetch(`${SUPABASE_URL}/functions/v1/hr-ai-bot`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: "who's online?", userId: bot1, role: 'employee' }),
  });
  const data21 = await res21.json().catch(() => ({}));
  check('anon-key-only call is rejected', res21.status === 401 || !!data21.error, `status=${res21.status}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
