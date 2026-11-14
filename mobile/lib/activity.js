// Best-effort activity logging for the CRM footprint.
// Phase 1 events: sign_in / sign_out. Feature events (clock-in,
// expenses, reports, Brain) arrive in Phase 4 through this same helper.
//
// Logging must NEVER break the app: failures are swallowed, every call
// is capped at 3s so a slow network never hangs sign-in or sign-out,
// and a missing session simply logs nothing.
import { supabase } from './supabase';

const LOG_TIMEOUT_MS = 3000;

export async function logActivity(event, opts = {}) {
  try {
    let userId = opts.userId || null;
    if (!userId) {
      const { data: { user } } = await supabase.auth.getUser();
      userId = user?.id || null;
    }
    if (!userId) return;
    const insert = supabase.from('activity_events').insert({
      user_id: userId,
      business_id: opts.businessId || null,
      event,
      meta: opts.meta || {},
    });
    await Promise.race([insert, new Promise((r) => setTimeout(r, LOG_TIMEOUT_MS))]);
  } catch {
    // Logging never breaks the app.
  }
}
