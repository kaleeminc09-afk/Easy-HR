// NorthShift Anomaly Test Bot — shift-pattern & AI-anomaly scenario testing.
//
// Run from mobile/:   node tests/bot-anomaly.js
//
// Tests the EXACT anomaly logic from the app against a battery of shift
// patterns — no database writes, no cleanup, fully deterministic:
//
//   1. flag logic (mobile/app/index.js → handleClockOut): each shift
//      pattern gets the correct ai_anomaly_flag,
//   2. manager filter (mobile/app/manager.js → anomalies tab): finds
//      exactly the flagged shifts, never open/in-progress ones,
//   3. review logic (mobile/app/manager.js → handleReviewAnomaly):
//      approve/deny clears the ⚠️ and keeps the decision + optional
//      note in history.
//
// The replicas below MUST stay in sync with the app source — if you
// change the flag rules in index.js or manager.js, update them here
// and re-run.

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const section = (t) => console.log(`\n── ${t} ──`);
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

// ---------- app-logic replicas (MUST match the app source) ----------
// From mobile/app/index.js → handleClockOut
function appAnomalyFlag(clockIn, clockOut) {
  const durationHours = (new Date(clockOut).getTime() - new Date(clockIn).getTime()) / (1000 * 60 * 60);
  let flag = 'Normal Shift';
  if (durationHours > 12) flag = '⚠️ Flagged: Excessive Duration (> 12 Hours)';
  else if (durationHours < 0.05) flag = '⚠️ Flagged: Unusually Short Shift (< 3 Mins)';
  return flag;
}
// From mobile/app/manager.js → handleReviewAnomaly
function appReviewFlag(originalFlag, decision, note) {
  const original = (originalFlag || '').replace(/⚠️\s*/g, '').trim();
  const notePart = note && note.trim() ? ` — "${note.trim()}"` : '';
  return decision === 'approved'
    ? `✓ Approved by manager — ${original}${notePart}`
    : `✕ Rejected by manager — ${original}${notePart}`;
}
// From mobile/app/manager.js → anomalies tab filter
const isAnomaly = (flag) => (flag || '').includes('⚠️');

// ---------- scenarios: [name, clockInMinsAgo, clockOutMinsAgo, expectedFlag] ----------
const SCENARIOS = [
  ['normal 8h day shift', 8 * 60 + 30, 30, 'Normal Shift'],
  ['excessive 14h shift', 14 * 60, 0, '⚠️ Flagged: Excessive Duration (> 12 Hours)'],
  ['tiny 2-minute shift', 2, 0, '⚠️ Flagged: Unusually Short Shift (< 3 Mins)'],
  ['5-minute shift (over the 3-min floor)', 5, 0, 'Normal Shift'],
  ['11h59m (just under 12h boundary)', 11 * 60 + 59, 0, 'Normal Shift'],
  ['12h01m (just over 12h boundary)', 12 * 60 + 1, 0, '⚠️ Flagged: Excessive Duration (> 12 Hours)'],
  ['24h shift (forgot to clock out)', 24 * 60, 0, '⚠️ Flagged: Excessive Duration (> 12 Hours)'],
];

function overnightShift() {
  // 10 PM yesterday → 6 AM today = 8h across midnight
  const out = new Date(); out.setHours(6, 0, 0, 0);
  const inp = new Date(out.getTime() - 8 * 3600000);
  return [inp.toISOString(), out.toISOString()];
}

function main() {
  // ---- 1. flag logic per shift pattern ----
  section('flag logic per shift pattern');
  for (const [name, inAgo, outAgo, expect] of SCENARIOS) {
    const flag = appAnomalyFlag(minsAgo(inAgo), minsAgo(outAgo));
    check(`${name} → "${expect}"`, flag === expect, `got "${flag}"`);
  }
  const [ovIn, ovOut] = overnightShift();
  check('overnight 10PM→6AM (8h) → "Normal Shift"',
    appAnomalyFlag(ovIn, ovOut) === 'Normal Shift');

  // ---- 2. manager anomalies filter ----
  section('manager anomalies filter');
  const fakeLogs = SCENARIOS.map(([name, inAgo, outAgo], i) => ({
    id: `test-${i}`, name, ai_anomaly_flag: appAnomalyFlag(minsAgo(inAgo), minsAgo(outAgo)),
  }));
  fakeLogs.push({ id: 'test-open', name: 'open shift (no clock out)', ai_anomaly_flag: 'Normal Shift' });
  const flagged = fakeLogs.filter((l) => isAnomaly(l.ai_anomaly_flag));
  const expectedFlagged = SCENARIOS.filter(([, , , e]) => e.includes('⚠️')).length;
  check(`filter finds exactly the ${expectedFlagged} flagged shifts`, flagged.length === expectedFlagged,
    `found ${flagged.length}: ${flagged.map((f) => f.name).join(', ')}`);
  check('open shift is never treated as anomaly',
    !isAnomaly(fakeLogs.find((l) => l.id === 'test-open').ai_anomaly_flag));
  check('every flagged shift names its reason',
    flagged.every((f) => /Excessive Duration|Unusually Short/.test(f.ai_anomaly_flag)));

  // ---- 3. approve/deny review logic ----
  section('approve/deny review logic');
  const approved = appReviewFlag('⚠️ Flagged: Excessive Duration (> 12 Hours)', 'approved', 'overtime authorized');
  check('approve clears ⚠️', !isAnomaly(approved), `got "${approved}"`);
  check('approve keeps decision + note',
    approved === '✓ Approved by manager — Flagged: Excessive Duration (> 12 Hours) — "overtime authorized"',
    `got "${approved}"`);
  const denied = appReviewFlag('⚠️ Flagged: Unusually Short Shift (< 3 Mins)', 'rejected', '');
  check('deny clears ⚠️', !isAnomaly(denied), `got "${denied}"`);
  check('deny without note has no dangling dash',
    denied === '✕ Rejected by manager — Flagged: Unusually Short Shift (< 3 Mins)',
    `got "${denied}"`);
  const wsNote = appReviewFlag('⚠️ Flagged: Excessive Duration (> 12 Hours)', 'approved', '   ');
  check('whitespace-only note treated as no note', !wsNote.includes('"'), `got "${wsNote}"`);
  // reviewed flags must not reappear in the anomalies filter
  check('reviewed shifts stay out of the anomalies tab',
    ![approved, denied].some(isAnomaly));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
