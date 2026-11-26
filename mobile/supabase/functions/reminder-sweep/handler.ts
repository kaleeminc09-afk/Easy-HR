// NorthShift — shift reminder sweep (reminder-sweep). Pure logic:
// no Deno, no HTTP. The HTTP wrapper lives in index.ts, the tests
// in handler.test.ts. Runs every 15 minutes on the platform's own
// schedule (config.toml). For each business it finds assigned shifts
// starting inside the lead-time window (default 60 minutes, per
// business reminder_lead_minutes), skips shifts the log already
// reminded, and hands the rest to send-push. It also flushes the
// overnight queue first, so a request ping held until 7 AM goes out
// on the morning sweep. Service-only: the sweep sends for every
// business, so no user caller may trigger it.
//
// Times are formatted in America/Toronto. A cron job has no caller
// timezone, and no business timezone is stored yet — Toronto is the
// default until a business timezone exists (the Brain's per-caller
// timezone does not apply here).

export const DEFAULT_LEAD_MINUTES = 60;
export const SWEEP_TIMEZONE = "America/Toronto";

export interface SweepBusiness {
  id: string;
  reminder_lead_minutes: number | null;
}

export interface DueShift {
  id: string;
  user_id: string;
  worksite_name: string | null;
  start_time: string;
}

export interface SweepDb {
  getBusinesses(businessId?: string): Promise<SweepBusiness[]>;
  getDueShifts(businessId: string, windowStartIso: string, windowEndIso: string): Promise<DueShift[]>;
  getRemindedShiftIds(shiftIds: string[]): Promise<Set<string>>;
}

export interface SendPushOutcome {
  sent: number;
  queued?: number;
  skipped?: number;
  duplicates?: number;
  failed?: number;
  flushed?: number;
  error?: string;
}

export type SendPushCall = (input: Record<string, unknown>) => Promise<SendPushOutcome>;

export interface SweepInput {
  business_id?: string; // one business only (live test); omit for all
}

export interface SweepResult {
  businesses: number;
  due: number;
  sent: number;
  skipped: number;
  failed: number;
  flushed: number;
  flushSent: number;
}

function fmtStart(startIso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: SWEEP_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(startIso));
}

export async function runSweep(
  db: SweepDb,
  sendPush: SendPushCall,
  input: SweepInput,
  nowMs: number = Date.now(),
): Promise<SweepResult> {
  const result: SweepResult = { businesses: 0, due: 0, sent: 0, skipped: 0, failed: 0, flushed: 0, flushSent: 0 };

  // 1. Flush the overnight queue first. A failed flush must not
  // stop the reminders — the queue simply waits for the next run.
  try {
    const flush = await sendPush({ flush_queued: true });
    result.flushed = flush.flushed || 0;
    result.flushSent = flush.sent || 0;
  } catch {
    // Queue waits for the next sweep.
  }

  // 2. Reminders, per business, inside that business's lead window.
  const businesses = await db.getBusinesses(input.business_id);
  result.businesses = businesses.length;
  for (const biz of businesses) {
    const lead = biz.reminder_lead_minutes ?? DEFAULT_LEAD_MINUTES;
    const windowStart = new Date(nowMs).toISOString();
    const windowEnd = new Date(nowMs + lead * 60 * 1000).toISOString();
    const due = await db.getDueShifts(biz.id, windowStart, windowEnd);
    result.due += due.length;
    if (due.length === 0) continue;
    // The log is the dedupe guard: a shift already reminded (sent,
    // sending, or queued) is never handed to send-push twice.
    const reminded = await db.getRemindedShiftIds(due.map((s) => s.id));
    for (const shift of due) {
      if (reminded.has(shift.id)) {
        result.skipped++;
        continue;
      }
      const site = shift.worksite_name || "your worksite";
      const outcome = await sendPush({
        business_id: biz.id,
        type: "shift_reminder",
        family: "reminders",
        title: "Shift reminder",
        body: `Your shift at ${site} starts at ${fmtStart(shift.start_time)}.`,
        url: "/",
        ref_type: "shift",
        ref_id: shift.id,
        recipient_user_id: shift.user_id,
      });
      if (outcome.error) {
        result.failed++;
      } else if (outcome.sent > 0) {
        result.sent++;
      } else {
        // No token, preference off, or send-push deduped it — the
        // reason sits in notification_log; count it, move on.
        result.skipped++;
      }
    }
  }
  return result;
}
