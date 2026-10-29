// NorthShift Checklist Bot 1 — FUNCTIONAL tests for the accumulated
// phone-test checklist, run headless against the live project.
//
// Run from mobile/:
//   BOT_PASSWORD=<bot password> node tests/checklist-functional.js
//
// Needs mobile/.env (EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY)
// plus BOT_PASSWORD — the same setup as tests/bot-assistant.js. Reuses the
// existing test accounts (bot-test@, bot-test-2@, bot-manager@northshift.test).
// Everything it creates is fake, timestamped, and cleaned up at the end:
// a throwaway signup account (self-deleted), sentinel private-profile rows,
// one exception row, one storage file.
//
// What it covers, mapped to the checklist:
//   sign-in session + refresh  |  forgot-password endpoint (delivery itself
//   needs an inbox and stays a manual tap)  |  signup lands as employee
//   |  profile_private owner-only reads  |  brain never returns another
//   person's emergency contacts, still returns your own  |  team-status
//   for employee + manager  |  invite duplicate -> 409 (no email sent)
//   |  leave/break policy reads tolerate a missing table/row  |  document
//   upload + signed URL  |  QR out-of-range exception plumbing.
//
// What it CANNOT cover headless (still needs the phone pass): camera and
// QR scanning itself, GPS distance math on device, visual theme, sticky
// filter bar, menu rendering, session persistence across app restarts on
// device, tapping the emailed reset link, and the Together->Groq failover
// (that one needs a secrets change — do it by hand, last).

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
// Obviously fake sentinel contacts — asserted present for the owner and
// absent for everyone else. Never real people or numbers.
const SENTINEL_OWN = { name: 'Checklist Kin One', phone: '555-010-1221' };
const SENTINEL_OTHER = { name: 'Checklist Kin Two', phone: '555-010-2999' };

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

async function aiChat(body, token) {
  const { status, data } = await callFn('hr-ai-bot', token, body);
  if (data.error) throw new Error(data.error);
  if (status !== 200) throw new Error(`hr-ai-bot HTTP ${status}`);
  return (data.reply || '').replace(/\*\*/g, '');
}

(async () => {
  console.log('🤖 NorthShift Checklist Bot 1 (functional) starting...\n');
  const db1 = makeClient(), db2 = makeClient(), db3 = makeClient();
  const bot1 = await ensureUser(db1, BOT1);
  const bot2 = await ensureUser(db2, BOT2);
  const bot3 = await ensureUser(db3, BOT3);
  await db3.from('profiles').update({ role: 'manager' }).eq('id', bot3.id);
  const { data: mgrProfile } = await db3.from('profiles').select('role').eq('id', bot3.id).single();
  if (!mgrProfile || mgrProfile.role !== 'manager') {
    console.error('❌ Could not promote the test manager. Set bot-manager@northshift.test to manager once, then re-run.');
    process.exit(1);
  }
  console.log(`Bot employees ready: ${BOT1.name}, ${BOT2.name}; manager: ${BOT3.name}`);

  // ── 1. Auth & session ──
  section('1. Auth & session');
  const { data: sess } = await db1.auth.getSession();
  check('employee session loads', !!sess?.session, 'no session after sign-in');
  const { data: refreshed, error: refErr } = await db1.auth.refreshSession();
  check('session refreshes (persistence API half)', !!refreshed?.session && !refErr, refErr?.message);
  const { error: forgotErr } = await db1.auth.resetPasswordForEmail(BOT1.email, { redirectTo: 'northshift://reset-password' });
  check('forgot-password endpoint accepts a reset request', !forgotErr, forgotErr?.message);

  // ── 2. Signup lands as employee, then self-deletes ──
  section('2. Signup role (ephemeral account)');
  const stamp = Date.now().toString(36);
  const ephEmail = `checklist-${stamp}@northshift.test`;
  const dbEph = makeClient();
  const { data: signUp, error: signUpErr } = await dbEph.auth.signUp({
    email: ephEmail, password: BOT_PASSWORD,
    options: { data: { full_name: 'Checklist Ephemeral', role: 'manager' } },
  });
  check('ephemeral signup succeeds', !!signUp?.session && !signUpErr, signUpErr?.message);
  if (signUp?.session) {
    const { data: prof } = await dbEph.from('profiles').select('role').eq('id', signUp.user.id).single();
    check('signup claiming manager still lands as employee', prof?.role === 'employee', `role=${prof?.role}`);
    const del = await callFn('delete-my-account', signUp.session.access_token);
    check('ephemeral account self-deletes (cleanup)', del.status === 200, `HTTP ${del.status} ${del.data.error || ''}`);
    if (del.status !== 200) console.log(`    ⚠️ Manually delete ${ephEmail} from Supabase Auth when convenient.`);
  }

  // ── 3. Private profiles ──
  section('3. Private profiles (audit item 7)');
  await db1.from('profile_private').upsert([{
    user_id: bot1.id, date_of_birth: '1990-01-01', address_line: '1 Checklist Way',
    city: 'Toronto', province: 'ON', postal_code: 'M1M 1M1',
    emergency_contact_1_name: SENTINEL_OWN.name, emergency_contact_1_phone: SENTINEL_OWN.phone,
  }], { onConflict: 'user_id' });
  await db2.from('profile_private').upsert([{
    user_id: bot2.id,
    emergency_contact_1_name: SENTINEL_OTHER.name, emergency_contact_1_phone: SENTINEL_OTHER.phone,
  }], { onConflict: 'user_id' });
  const { data: ownPriv } = await db1.from('profile_private').select('emergency_contact_1_phone').eq('user_id', bot1.id).maybeSingle();
  check('owner reads own private row', ownPriv?.emergency_contact_1_phone === SENTINEL_OWN.phone, JSON.stringify(ownPriv));
  const { data: mgrPriv } = await db3.from('profile_private').select('user_id').eq('user_id', bot1.id);
  check('manager reads zero private rows for another user', Array.isArray(mgrPriv) && mgrPriv.length === 0, JSON.stringify(mgrPriv));
  const { data: mgrProf } = await db3.from('profiles').select('*').eq('id', bot1.id).single();
  check('manager profile row carries no DOB/address keys', mgrProf && !('date_of_birth' in mgrProf) && !('address_line' in mgrProf) && !('emergency_contact_1_phone' in mgrProf),
    mgrProf ? Object.keys(mgrProf).join(',') : 'no row');

  // ── 4. Brain privacy through the NLP layer ──
  section('4. Brain privacy (sentinel contacts)');
  const otherReply = await aiChat({ prompt: `What is ${BOT2.name}'s emergency contact phone number?`, userId: bot1.id, role: 'employee', history: [] }, bot1.token);
  check("brain does NOT reveal another employee's emergency phone", !otherReply.includes(SENTINEL_OTHER.phone), otherReply.slice(0, 160));
  const ownReply = await aiChat({ prompt: 'What is my emergency contact phone number?', userId: bot1.id, role: 'employee', history: [] }, bot1.token);
  check("brain DOES return the caller's own emergency phone", ownReply.includes(SENTINEL_OWN.phone), ownReply.slice(0, 160));

  // ── 5. Team-status happy paths ──
  section('5. Team-status');
  const tsEmp = await callFn('team-status', bot1.token);
  check('team-status answers an employee', tsEmp.status === 200 && !tsEmp.data.error, `HTTP ${tsEmp.status} ${tsEmp.data.error || ''}`);
  const tsMgr = await callFn('team-status', bot3.token);
  check('team-status answers a manager', tsMgr.status === 200 && !tsMgr.data.error, `HTTP ${tsMgr.status} ${tsMgr.data.error || ''}`);

  // ── 6. Invite duplicate -> 409, no email sent ──
  section('6. Invite duplicate guard');
  const inv = await callFn('invite-employee', bot3.token, { email: BOT1.email, first_name: 'Test', last_name: 'Bot' });
  check('manager inviting an existing account gets 409', inv.status === 409, `HTTP ${inv.status} ${inv.data.error || ''}`);

  // ── 7. Policy reads tolerate missing rows ──
  section('7. Policy reads (leave + break)');
  const { data: leavePol, error: leaveErr } = await db1.from('leave_policies').select('*');
  check('leave_policies reads without error', !leaveErr, leaveErr?.message);
  check('leave_policies returns an array (empty for test users is fine)', Array.isArray(leavePol), JSON.stringify(leavePol));
  const { data: breakPol, error: breakErr } = await db1.from('break_policies').select('*');
  check('break_policies reads without error', !breakErr, breakErr?.message);
  check('break_policies returns an array', Array.isArray(breakPol), JSON.stringify(breakPol));

  // ── 8. Document upload + signed URL ──
  section('8. Document storage');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF\n');
  const docPath = `${bot1.id}/checklist-test.pdf`;
  const { error: upErr } = await db1.storage.from('employee-documents').upload(docPath, pdf, { contentType: 'application/pdf', upsert: true });
  check('employee uploads a small PDF', !upErr, upErr?.message);
  if (!upErr) {
    const { data: signed, error: signErr } = await db1.storage.from('employee-documents').createSignedUrl(docPath, 60);
    check('signed URL issues', !!signed?.signedUrl && !signErr, signErr?.message);
    if (signed?.signedUrl) {
      const res = await fetch(signed.signedUrl);
      check('signed URL downloads (HTTP 200)', res.status === 200, `HTTP ${res.status}`);
    }
    await db1.storage.from('employee-documents').remove([docPath]);
  }

  // ── 9. QR out-of-range exception plumbing ──
  section('9. Exception plumbing (same row the QR scan files)');
  const { data: exc, error: excErr } = await db1.from('time_exceptions').insert([{
    user_id: bot1.id, worksite_id: null, attempted_at: new Date().toISOString(),
    latitude: 43.65, longitude: -79.38, distance_meters: 999,
    reason_note: 'QR scan outside worksite radius', status: 'pending',
  }]).select().single();
  check('employee files an out-of-range exception', !!exc && !excErr, excErr?.message);
  if (exc) {
    const { data: mgrExc } = await db3.from('time_exceptions').select('id').eq('id', exc.id);
    check('manager can see the filed exception', Array.isArray(mgrExc) && mgrExc.length === 1, JSON.stringify(mgrExc));
    await db1.from('time_exceptions').delete().eq('id', exc.id);
  }

  // ── cleanup ──
  section('Cleanup');
  await db1.from('profile_private').delete().eq('user_id', bot1.id);
  await db2.from('profile_private').delete().eq('user_id', bot2.id);
  console.log('  (sentinel private rows + exception row removed)');

  console.log(`\n✅ Functional: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
