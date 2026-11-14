// NorthShift — auto-close sweep for forgotten open shifts.
//
// One implementation, used by the employee home screen (own shifts)
// and the Manager Portal (every shift the manager can see — RLS
// scopes the read to their business). A shift open 24 hours or more
// is closed at exactly clock_in + 24h and VOIDED: it stays visible
// as a record, counts 0 hours everywhere, and every close writes an
// agent_audit_logs row. No void without a trail: if the audit insert
// fails, the close is rolled back. The update is guarded by
// clock_out IS NULL, so two sweeps racing each other close a shift
// exactly once. Best-effort overall: a sweep failure never blocks
// the screen that triggered it.

import { autoCloseForOpenShift, AUTO_CLOSE_HOURS } from '../supabase/functions/hr-ai-bot/logic';

/**
 * Close + void every open shift older than the 24h threshold.
 * @param {object} supabase - the app client
 * @param {string} actorId - auth.uid() of the signed-in user (the audit row's user_id)
 * @param {string|null} onlyUserId - when set, only this user's shifts (employee home)
 * @returns {Promise<number>} how many shifts were closed
 */
export async function sweepStaleOpenShifts(supabase, actorId, onlyUserId) {
  try {
    if (!actorId) return 0;
    const cutoff = new Date(Date.now() - AUTO_CLOSE_HOURS * 3600 * 1000).toISOString();
    let query = supabase
      .from('time_logs')
      .select('id, user_id, clock_in, ai_anomaly_flag')
      .is('clock_out', null)
      .lt('clock_in', cutoff);
    if (onlyUserId) query = query.eq('user_id', onlyUserId);
    const { data: stale, error } = await query;
    if (error || !stale || stale.length === 0) return 0;

    let closed = 0;
    for (const log of stale) {
      const result = autoCloseForOpenShift(log.clock_in, Date.now());
      if (!result) continue;
      const { data: updated } = await supabase
        .from('time_logs')
        .update({ clock_out: result.clock_out, ai_anomaly_flag: result.flag })
        .eq('id', log.id)
        .is('clock_out', null)
        .select('id');
      if (!updated || updated.length === 0) continue; // another sweep got it first
      const { error: auditError } = await supabase.from('agent_audit_logs').insert([{
        user_id: actorId,
        action_type: 'time_log_auto_closed',
        payload: {
          log_id: log.id,
          employee_user_id: log.user_id,
          clock_in: log.clock_in,
          clock_out: result.clock_out,
          previous_flag: log.ai_anomaly_flag,
          reason: 'Open over 24 hours — auto-closed and voided',
        },
        status: 'completed',
      }]);
      if (auditError) {
        // No void without a trail: roll the close back.
        await supabase.from('time_logs')
          .update({ clock_out: null, ai_anomaly_flag: log.ai_anomaly_flag })
          .eq('id', log.id);
        console.error('Auto-close audit failed, rolled back:', auditError.message);
        continue;
      }
      closed++;
    }
    return closed;
  } catch (e) {
    console.error('Auto-close sweep failed:', e.message);
    return 0;
  }
}
