// reset-bot-passwords.mjs — one-off: set the three NorthShift test-bot
// passwords to the new BOT_PASSWORD from mobile/.env via the Auth Admin API.
// Run from mobile/ (it reads .env from the current directory).
// Delete this file after running it.
import fs from 'node:fs';

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split('\n')
    .map((l) => l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')])
);
const url = env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const pw = env.BOT_PASSWORD;
if (!url || !serviceKey || !pw) { console.error('Missing URL, service key, or BOT_PASSWORD'); process.exit(1); }
const ids = [
  'fbd400a5-9a07-45b2-8cc8-319ba0f13e0b', // bot-test
  '01388918-617b-4c93-bf51-3ec05269444c', // bot-test-2
  'a85cedd5-551e-48ab-a801-bdf56cd8107e', // bot-manager
];
for (const id of ids) {
  const r = await fetch(`${url}/auth/v1/admin/users/${id}`, {
    method: 'PUT',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  console.log(id, r.status, r.status === 200 ? 'OK' : await r.text());
}
