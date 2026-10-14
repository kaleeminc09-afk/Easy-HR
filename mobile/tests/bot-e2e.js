// NorthShift E2E Bot — automated feature testing.
//
// Run from mobile/:   node tests/bot-e2e.js
//
// Signs in as two bot employees (each on its own connection) against your
// LIVE Supabase and runs the exact flows the app uses — clock in/out, all
// three break types, the double-tap guards, half shifts, AI conversation
// memory, AI clock-out, exceptions, task delegation, and idempotency
// edges — printing pass/fail for each. No real waiting: time is simulated
// by backdating rows.
//
// PREREQUISITE: redeploy hr-ai-bot after applying its patch
//   (supabase functions deploy hr-ai-bot) — the AI clock-out test needs it.
//
// Needs: mobile/.env with EXPO_PUBLIC_SUPABASE_URL and
// EXPO_PUBLIC_SUPABASE_ANON_KEY (the same file the app uses).

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ---------- env ----------
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    console.error('❌ mobile/.env not found. Rename env.txt to .env first.');
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
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ .env is missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}

const BOT1 = { email: env.BOT_EMAIL || 'bot-test@northshift.test', name: 'Test Bot' };
const BOT2 = { email: env.BOT2_EMAIL || 'bot-test-2@northshift.test', name: 'Test Bot Two' };
const BOT_PASSWORD = env.BOT_PASSWORD || 'BotTest1234!';

// Each bot gets its own client: signing in on one client must not
// clobber the other bot's session (that breaks RLS user checks).
const makeClient = () => createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const section = (t) => console.log(`\n── ${t} ──`);
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

// ---------- app-flow replicas (must match mobile/app/index.js logic) ----------
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
  const { data: active } = await db.from('time_breaks')
    .select('id').eq('time_log_id', timeLogId).is('end_time', null).limit(1);
  if (active && active.length > 0) return { blocked: true, id: active[0].id };
  const { data, error } = await db.from('time_breaks')
    .insert([{ time_log_id: timeLogId, break_type: breakType, start_time: new Date().toISOString() }])
    .select().single();
  if (error) throw error;
  return { blocked: false, id: data.id };
}

async function appEndBreak(db, breakId) {
  const { error } = await db.from('time_breaks')
    .update({ end_time: new Date().toISOString() }).eq('id', breakId);
  if (error) throw error;
}

async function appClockOut(db, timeLogId) {
  const { error } = await db.from('time_logs')
    .update({ clock_out: new Date().toISOString() }).eq('id', timeLogId);
  if (error) throw error;
}

async function openShiftId(db, userId) {
  const { data } = await db.from('time_logs').select('id')
    .eq('user_id', userId).is('clock_out', null)
    .order('clock_in', { ascending: false }).limit(1);
  return data && data.length > 0 ? data[0].id : null;
}

async function aiChat(body, retries = 5) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/hr-ai-bot`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
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
  if (signIn?.session) return signIn.session.user.id;
  const { data: signUp, error } = await db.auth.signUp({
    email, password: BOT_PASSWORD,
    options: { data: { full_name: name, role: 'employee' } },
  });
  if (error) throw new Error(`Auth failed for ${email}: ${error.message}`);
  if (!signUp.session) throw new Error(`No session for ${email} — turn OFF "Confirm email" in Supabase Auth settings (or confirm the user once), then re-run.`);
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

// ---------- main ----------
(async () => {
  console.log('🤖 NorthShift E2E Bot starting...\n');

  const db1 = makeClient();
  const db2 = makeClient();
  const bot1 = await ensureUser(db1, BOT1);
  const bot2 = await ensureUser(db2, BOT2);
  console.log(`Bot employees ready: ${BOT1.name}, ${BOT2.name}`);
  await cleanupUser(db1, bot1);
  await cleanupUser(db2, bot2);

  // ── 1. Clock in + double-tap guard ──
  section('1 · Clock in / double-tap guard');
  const c1 = await appClockIn(db1, bot1);
  check('clock-in creates one open shift', !c1.resumed);
  const c2 = await appClockIn(db1, bot1);
  check('second clock-in resumes instead of duplicating', c2.resumed && c2.id === c1.id);
  const { count: openCount } = await db1.from('time_logs')
    .select('id', { count: 'exact', head: true }).eq('user_id', bot1).is('clock_out', null);
  check('exactly one open shift in DB', openCount === 1, `found ${openCount}`);
  const shiftId = c1.id;

  // ── 2. Second employee clocks in; AI sees both ──
  section('2 · Two employees on shift');
  await appClockIn(db2, bot2);
  const r1 = await aiChat({ prompt: 'current working employees', managerId: bot1, role: 'manager', history: [] });
  check('AI lists both working employees', /test bot/i.test(r1) && /two/i.test(r1), r1.slice(0, 100));

  // ── 3. THE user-reported scenario: AI clocks out one employee ──
  section('3 · AI clock-out ("clock them out")');
  const h = [
    { role: 'user', content: 'current working employees' },
    { role: 'assistant', content: r1 },
  ];
  const r2 = await aiChat({ prompt: 'clock out Test Bot Two', managerId: bot1, role: 'manager', history: h });
  const bot2Open = await openShiftId(db2, bot2);
  const bot1Open = await openShiftId(db1, bot1);
  check('AI clocked out Test Bot Two (DB)', bot2Open === null, r2.slice(0, 100));
  check('Test Bot still clocked in', bot1Open === shiftId);
  check('AI confirms naturally, no asterisks', /clocked out/i.test(r2) && !/\*\*/.test(r2), r2.slice(0, 100));

  // ── 4. AI memory follow-up ──
  section('4 · AI conversation memory');
  const h3 = [...h, { role: 'user', content: 'clock out Test Bot Two' }, { role: 'assistant', content: r2 }];
  const r3 = await aiChat({ prompt: 'how many are working now?', managerId: bot1, role: 'manager', history: h3 });
  check('follow-up resolved from history',
    !/which employee/i.test(r3) && /(\d|one|two|three|four|five|six|seven|eight|nine|ten)/i.test(r3),
    r3.slice(0, 100));

  // ── 5. All three break types with durations ──
  section('5 · Break types + durations');
  for (const [breakType, minutes] of [['Unpaid Lunch', 30], ['Paid Lunch', 45], ['Paid Rest Break', 15]]) {
    const b = await appStartBreak(db1, shiftId, breakType);
    check(`${breakType}: starts`, !b.blocked);
    await db1.from('time_breaks').update({ start_time: minsAgo(minutes) }).eq('id', b.id);
    await appEndBreak(db1, b.id);
    const { data: row } = await db1.from('time_breaks').select('start_time, end_time').eq('id', b.id).single();
    const durMin = (new Date(row.end_time) - new Date(row.start_time)) / 60000;
    check(`${breakType}: duration ≈ ${minutes} min`, Math.abs(durMin - minutes) < 2, `${durMin.toFixed(1)} min`);
  }

  // ── 6. Double-break guard ──
  section('6 · Double-break guard');
  const b1 = await appStartBreak(db1, shiftId, 'Paid Rest Break');
  check('break starts', !b1.blocked);
  const b2 = await appStartBreak(db1, shiftId, 'Paid Rest Break');
  check('second break blocked while one is open', b2.blocked && b2.id === b1.id);
  await appEndBreak(db1, b1.id);
  check('break ends cleanly', true);

  // ── 7. Exception request flow ──
  section('7 · Exception request');
  const { data: sites } = await db1.from('worksites').select('id').limit(1);
  if (sites && sites.length > 0) {
    await db1.from('time_exceptions').insert([{
      user_id: bot1, worksite_id: sites[0].id,
      latitude: 43.65, longitude: -79.38, distance_meters: 250,
      reason_note: 'stuck in traffic on DVP', status: 'pending',
    }]);
    const r4 = await aiChat({ prompt: 'show pending exceptions', managerId: bot1, role: 'manager', history: [] });
    check('AI lists the pending exception', /dvp|traffic/i.test(r4), r4.slice(0, 100));
  } else {
    console.log('  ⊘ skipped — no worksites configured');
  }

  // ── 8. Task delegation via AI ──
  section('8 · AI task delegation');
  const r5 = await aiChat({ prompt: 'assign mopping the lobby floors to Test Bot Two', managerId: bot1, role: 'manager', history: [] });
  const { data: tasks } = await db2.from('tasks').select('id')
    .ilike('title', '%mopping%').eq('assigned_to', bot2).limit(1);
  check('AI created the task for the right employee', tasks && tasks.length > 0, r5.slice(0, 100));

  // ── 9. Idempotency edges ──
  section('9 · Idempotency edges');
  try { await appEndBreak(db1, b1.id); check('ending an already-ended break does not crash', true); }
  catch (e) { check('ending an already-ended break does not crash', false, e.message); }
  try { await appClockOut(db1, '00000000-0000-0000-0000-000000000000'); check('clock-out with no shift does not crash', true); }
  catch (e) { check('clock-out with no shift does not crash', false, e.message); }

  // ── 10. Clock out + half shift ──
  section('10 · Clock out + half shift');
  await appClockOut(db1, shiftId);
  const { data: closed } = await db1.from('time_logs').select('clock_out').eq('id', shiftId).single();
  check('shift closed', !!closed.clock_out);
  const { data: half } = await db1.from('time_logs')
    .insert([{ user_id: bot1, clock_in: hoursAgo(4), ai_anomaly_flag: 'Normal Shift' }])
    .select().single();
  await appClockOut(db1, half.id);
  const { data: halfRow } = await db1.from('time_logs').select('clock_in, clock_out').eq('id', half.id).single();
  const halfHours = (new Date(halfRow.clock_out) - new Date(halfRow.clock_in)) / 3600000;
  check('4-hour shift measures ≈ 4h', Math.abs(halfHours - 4) < 0.05, `${halfHours.toFixed(2)}h`);

  // ── summary ──
  console.log(`\n${failed === 0 ? '🎉' : '⚠️'}  ${passed} passed, ${failed} failed`);
  console.log('\nCleanup SQL (bot test rows, if you want them gone):');
  for (const [email, id] of [[BOT1.email, bot1], [BOT2.email, bot2]]) {
    console.log(`-- ${email}`);
    console.log(`DELETE FROM public.time_breaks WHERE time_log_id IN (SELECT id FROM public.time_logs WHERE user_id = '${id}');`);
    console.log(`DELETE FROM public.time_logs WHERE user_id = '${id}';`);
    console.log(`DELETE FROM public.tasks WHERE assigned_to = '${id}' OR assigned_by = '${id}';`);
    console.log(`DELETE FROM public.time_exceptions WHERE user_id = '${id}';`);
  }
  await db1.auth.signOut();
  await db2.auth.signOut();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('\n❌ Bot crashed:', e.message); process.exit(1); });
