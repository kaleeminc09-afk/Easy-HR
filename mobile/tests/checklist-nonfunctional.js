// NorthShift Checklist Bot 2 — NON-FUNCTIONAL tests: security boundaries,
// performance, and resilience, run headless against the live project.
//
// Run from mobile/:
//   BOT_PASSWORD=<bot password> node tests/checklist-nonfunctional.js
//
// Same env + test accounts as tests/checklist-functional.js. It uploads
// one throwaway file of its own and deletes it at the end; nothing else
// is created.
//
// What it covers:
//   SECURITY — anonymous callers get 401 from team-status, invite-employee
//   and hr-ai-bot; employees get 403 from invite-employee; no user (even a
//   manager) reads another user's profile_private rows; no user lists or
//   downloads another user's storage folder.
//   PERFORMANCE — team-status, invite-duplicate and one brain read are
//   timed; the run fails only on egregious slowness (thresholds below),
//   timings are always printed.
//   RESILIENCE — a nonsense brain prompt returns a reply, not a crash;
//   five parallel team-status calls all succeed.
//
// NOTE: the storage cross-user checks exercise the employee-documents
// bucket policies — audit item 5, still unverified on the dashboard. If
// those two checks fail, that is the bucket policies talking, not a bot
// bug: verify the bucket policies, then re-run.

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) { console.error('❌ mobile/.env not found.'); process.exit(1); }
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
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) { console.error('❌ .env is missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY'); process.exit(1); }
if (!BOT_PASSWORD) { console.error('❌ Set BOT_PASSWORD in your shell (same bot password as tests/bot-assistant.js).'); process.exit(1); }

const BOT1 = { email: env.BOT_EMAIL || 'bot-test@northshift.test', name: 'Test Bot' };
const BOT2 = { email: env.BOT2_EMAIL || 'bot-test-2@northshift.test', name: 'Test Bot Two' };
const BOT3 = { email: env.BOT3_EMAIL || 'bot-manager@northshift.test', name: 'Test Manager' };

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const section = (t) => console.log(`\n── ${t} ──`);
const makeClient = () => createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function ensureUser(db, { email, name }) {
  const { data: signIn } = await db.auth.signInWithPassword({ email, password: BOT_PASSWORD });
  if (signIn?.session) return { id: signIn.session.user.id, token: signIn.session.access_token };
  const { data: signUp, error } = await db.auth.signUp({
    email, password: BOT_PASSWORD, options: { data: { full_name: name, role: 'employee' } },
  });
  if (error) throw new Error(`Auth failed for ${email}: ${error.message}`);
  if (!signUp.session) throw new Error(`No session for ${email} — turn OFF "Confirm email" in Supabase Auth settings (or confirm the user once), then re-run.`);
  return { id: signUp.user.id, token: signUp.session.access_token };
}

async function callFn(path, token, body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token || SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, data };
}

async function timed(name, fn, limitMs) {
  const t0 = Date.now();
  const out = await fn();
  const ms = Date.now() - t0;
  console.log(`  ⏱ ${name}: ${ms}ms (limit ${limitMs}ms)`);
  check(`${name} under ${limitMs}ms`, ms < limitMs, `${ms}ms`);
  return out;
}

(async () => {
  console.log('🤖 NorthShift Checklist Bot 2 (non-functional) starting...\n');
  const db1 = makeClient(), db2 = makeClient(), db3 = makeClient();
  const bot1 = await ensureUser(db1, BOT1);
  const bot2 = await ensureUser(db2, BOT2);
  const bot3 = await ensureUser(db3, BOT3);
  await db3.from('profiles').update({ role: 'manager' }).eq('id', bot3.id);
  console.log(`Bot employees ready: ${BOT1.name}, ${BOT2.name}; manager: ${BOT3.name}`);

  // ── 1. Anonymous boundaries ──
  section('1. Anonymous callers get 401');
  for (const fn of ['team-status', 'invite-employee', 'hr-ai-bot']) {
    const r = await callFn(fn, null, fn === 'hr-ai-bot' ? { prompt: 'hi', history: [] } : { email: 'nobody@northshift.test' });
    check(`anon -> ${fn} is 401`, r.status === 401, `HTTP ${r.status} ${r.data.error || ''}`);
  }

  // ── 2. Role boundaries ──
  section('2. Employee callers get 403 from invite-employee');
  const inv = await callFn('invite-employee', bot1.token, { email: 'someone-new@northshift.test' });
  check('employee -> invite-employee is 403', inv.status === 403, `HTTP ${inv.status} ${inv.data.error || ''}`);

  // ── 3. Cross-user denials ──
  section('3. Cross-user reads return nothing');
  const { data: empCross } = await db1.from('profile_private').select('user_id').eq('user_id', bot2.id);
  check('employee reads zero private rows for another user', Array.isArray(empCross) && empCross.length === 0, JSON.stringify(empCross));
  const { data: mgrCross } = await db3.from('profile_private').select('user_id').eq('user_id', bot2.id);
  check('manager reads zero private rows for another user', Array.isArray(mgrCross) && mgrCross.length === 0, JSON.stringify(mgrCross));

  // ── 4. Storage cross-user denials (audit item 5 territory) ──
  section('4. Storage cross-user denials');
  const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
  const ownPath = `${bot2.id}/nf-test.pdf`;
  const { error: upErr } = await db2.storage.from('employee-documents').upload(ownPath, pdf, { contentType: 'application/pdf', upsert: true });
  check('fixture upload by owner succeeds', !upErr, upErr?.message);
  if (!upErr) {
    const { data: listed, error: listErr } = await db1.storage.from('employee-documents').list(bot2.id);
    // Denied (error) and empty are both secure outcomes; only a returned
    // file would be a leak.
    check("employee listing another user's folder sees nothing", !!listErr || (Array.isArray(listed) && listed.length === 0), JSON.stringify(listed));
    const { error: dlErr } = await db1.storage.from('employee-documents').download(ownPath);
    check("employee downloading another user's file is denied", !!dlErr, 'download unexpectedly succeeded');
    await db2.storage.from('employee-documents').remove([ownPath]);
  }

  // ── 5. Resilience ──
  section('5. Brain robustness');
  const weird = await callFn('hr-ai-bot', bot1.token, { prompt: 'asdf qwer zxcv !@#$', userId: bot1.id, role: 'employee', history: [] });
  check('nonsense prompt returns a reply, not a crash', weird.status === 200 && typeof weird.data.reply === 'string' && weird.data.reply.length > 0,
    `HTTP ${weird.status} ${weird.data.error || ''}`);

  // ── 6. Performance ──
  section('6. Performance');
  await timed('team-status (employee)', () => callFn('team-status', bot1.token), 10000);
  await timed('invite-employee duplicate (manager)', () => callFn('invite-employee', bot3.token, { email: BOT1.email }), 10000);
  await timed('hr-ai-bot simple read', () => callFn('hr-ai-bot', bot1.token, { prompt: 'Who is clocked in right now?', userId: bot1.id, role: 'employee', history: [] }), 90000);

  // ── 7. Concurrency ──
  section('7. Concurrency');
  const parallel = await Promise.all(Array.from({ length: 5 }, () => callFn('team-status', bot1.token)));
  check('5 parallel team-status calls all return 200', parallel.every((r) => r.status === 200),
    parallel.map((r) => r.status).join(','));

  console.log(`\n✅ Non-functional: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
