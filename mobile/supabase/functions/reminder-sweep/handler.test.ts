// Reminder sweep tests. FakeDb + a fake send-push: the sweep is
// pure logic, so every run is deterministic at a fixed "now".
import { runSweep } from "./handler.ts";
import type { SweepDb, SendPushCall, DueShift } from "./handler.ts";

const NOW = Date.UTC(2026, 10, 27, 13, 0, 0); // Nov 27 2026, 08:00 EST
const at = (minutesFromNow: number) => new Date(NOW + minutesFromNow * 60 * 1000).toISOString();

const BIZ_A = "biz_a";
const BIZ_B = "biz_b";
const EMP = "emp_1";

interface ShiftRow extends DueShift {
  business_id: string;
  status: string;
}

class FakeDb implements SweepDb {
  businesses = [
    { id: BIZ_A, reminder_lead_minutes: 60 },
    { id: BIZ_B, reminder_lead_minutes: 30 },
  ];
  shifts: ShiftRow[] = [
    { id: "shift_45", business_id: BIZ_A, user_id: EMP, worksite_name: "Main Office", start_time: at(45), status: "assigned" },
    { id: "shift_90", business_id: BIZ_A, user_id: EMP, worksite_name: "Main Office", start_time: at(90), status: "assigned" },
    { id: "shift_20", business_id: BIZ_A, user_id: EMP, worksite_name: "Test Site", start_time: at(20), status: "assigned" },
    { id: "shift_done", business_id: BIZ_A, user_id: EMP, worksite_name: "Main Office", start_time: at(30), status: "assigned" },
    { id: "shift_open", business_id: BIZ_A, user_id: "", worksite_name: "Main Office", start_time: at(30), status: "open" },
    { id: "shift_past", business_id: BIZ_A, user_id: EMP, worksite_name: "Main Office", start_time: at(-10), status: "assigned" },
    { id: "shift_b45", business_id: BIZ_B, user_id: EMP, worksite_name: "Depot", start_time: at(45), status: "assigned" },
    { id: "shift_b20", business_id: BIZ_B, user_id: EMP, worksite_name: "Depot", start_time: at(20), status: "assigned" },
  ];
  reminded = new Set<string>(["shift_done"]);

  async getBusinesses(businessId?: string) {
    return businessId ? this.businesses.filter((b) => b.id === businessId) : [...this.businesses];
  }
  async getDueShifts(businessId: string, windowStartIso: string, windowEndIso: string) {
    return this.shifts
      .filter(
        (s) =>
          s.business_id === businessId &&
          s.status === "assigned" &&
          s.user_id &&
          s.start_time >= windowStartIso &&
          s.start_time <= windowEndIso,
      )
      .map((s) => ({ id: s.id, user_id: s.user_id, worksite_name: s.worksite_name, start_time: s.start_time }));
  }
  async getRemindedShiftIds(shiftIds: string[]) {
    return new Set(shiftIds.filter((id) => this.reminded.has(id)));
  }
}

function fakeSendPush(failRefIds: Set<string> = new Set()) {
  const calls: Record<string, unknown>[] = [];
  const sendPush: SendPushCall = async (input) => {
    calls.push(input);
    if (input.flush_queued) return { sent: 1, flushed: 2 };
    if (failRefIds.has(input.ref_id as string)) return { sent: 0, error: "boom" };
    return { sent: 1 };
  };
  return { sendPush, calls };
}

describe("reminder sweep", () => {
  test("reminds shifts inside the lead window, once each", async () => {
    const db = new FakeDb();
    const { sendPush, calls } = fakeSendPush();
    const result = await runSweep(db, sendPush, {}, NOW);
    expect(result.businesses).toBe(2);
    expect(result.due).toBe(4); // 45, 20, done (A) + b20 (B)
    expect(result.sent).toBe(3); // 45, 20, b20 — done was already reminded
    expect(result.skipped).toBe(1); // shift_done
    expect(result.failed).toBe(0);
    expect(result.flushed).toBe(2);
    expect(result.flushSent).toBe(1);
    const remindedIds = calls.filter((c) => !c.flush_queued).map((c) => c.ref_id);
    expect(remindedIds.sort()).toEqual(["shift_20", "shift_45", "shift_b20"]);
    // The flush runs before any reminder.
    expect(calls[0].flush_queued).toBe(true);
    // The body names the worksite and the start time.
    const first = calls.find((c) => c.ref_id === "shift_45")!;
    expect(first.body as string).toContain("Main Office");
    expect(first.body as string).toContain("8:45 AM");
    expect(first.url).toBe("/");
    expect(first.family).toBe("reminders");
  });

  test("a shift 90 minutes out and a past shift do not remind", async () => {
    const db = new FakeDb();
    const { sendPush, calls } = fakeSendPush();
    await runSweep(db, sendPush, {}, NOW);
    const remindedIds = calls.map((c) => c.ref_id);
    expect(remindedIds).not.toContain("shift_90");
    expect(remindedIds).not.toContain("shift_past");
    expect(remindedIds).not.toContain("shift_open");
    expect(remindedIds).not.toContain("shift_b45"); // 45 min out, but B's lead is 30
  });

  test("a second sweep run reminds nothing new", async () => {
    const db = new FakeDb();
    const { sendPush, calls } = fakeSendPush();
    await runSweep(db, sendPush, {}, NOW);
    // The first run reminded three shifts; mark them reminded, as
    // the log would be after the first run.
    db.reminded = new Set(["shift_done", "shift_45", "shift_20", "shift_b20"]);
    const second = await runSweep(db, sendPush, {}, NOW);
    expect(second.sent).toBe(0);
    expect(second.due).toBe(4);
    expect(second.skipped).toBe(4);
    expect(calls.filter((c) => !c.flush_queued).length).toBe(3); // only the first run's calls
  });

  test("single-business input sweeps only that business", async () => {
    const db = new FakeDb();
    const { sendPush } = fakeSendPush();
    const result = await runSweep(db, sendPush, { business_id: BIZ_B }, NOW);
    expect(result.businesses).toBe(1);
    expect(result.due).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.flushed).toBe(2); // the flush is global, not per business
  });

  test("a send-push failure counts, never throws", async () => {
    const db = new FakeDb();
    const { sendPush } = fakeSendPush(new Set(["shift_20"]));
    const result = await runSweep(db, sendPush, {}, NOW);
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(2); // the other two still go out
  });
});
