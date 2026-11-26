// NorthShift — unit tests for the push sender (send-push/handler.ts).
// Run with: npm test   (from the mobile/ folder)
// No live Supabase, no live Expo: a fake Db and a fake Expo fetch
// stand in for both.

import {
  sendPush,
  type Db,
  type ExpoFetch,
  type PushPreferences,
  type SendPushInput,
} from "./handler.ts";

const BIZ = "biz_1";
const EMP = "emp_1";
const MGR = "mgr_1";
const OWNER = "owner_1";
const OTHER_BIZ_USER = "other_1";

function baseInput(overrides: Partial<SendPushInput> = {}): SendPushInput {
  return {
    business_id: BIZ,
    type: "timeoff_requested",
    family: "requests",
    title: "New time-off request",
    body: "Test Bot asked for Dec 24-27.",
    url: "/timeoff",
    ref_type: "time_off_request",
    ref_id: "req_1",
    recipient_role: "manager",
    caller_user_id: EMP,
    ...overrides,
  };
}

class FakeDb implements Db {
  businesses = new Map<string, string>([
    [EMP, BIZ],
    [MGR, BIZ],
    [OWNER, BIZ],
    [OTHER_BIZ_USER, "biz_2"],
  ]);
  roles = new Map<string, string>([
    [EMP, "employee"],
    [MGR, "manager"],
    [OWNER, "admin"],
  ]);
  prefs = new Map<string, PushPreferences>([
    [MGR, { push_reminders: true, push_requests: true, push_billing: true }],
    [EMP, { push_reminders: true, push_requests: true, push_billing: true }],
    [OWNER, { push_reminders: true, push_requests: true, push_billing: true }],
  ]);
  tokens = new Map<string, Array<{ id: string; token: string }>>([
    [MGR, [{ id: "tok_mgr_1", token: "ExponentPushToken[mgr1]" }]],
    [OWNER, [{ id: "tok_owner_1", token: "ExponentPushToken[owner1]" }]],
    [EMP, [{ id: "tok_emp_1", token: "ExponentPushToken[emp1]" }]],
  ]);
  deactivated: string[] = [];
  logs: Array<Record<string, unknown>> = [];

  async getCaller(userId: string) {
    const business_id = this.businesses.get(userId);
    if (!business_id) return null;
    return { business_id, role: this.roles.get(userId) || null };
  }
  async getRecipientsByRole(businessId: string, role: "manager" | "admin") {
    const ids: string[] = [];
    for (const [uid, biz] of this.businesses) {
      if (biz !== businessId) continue;
      const r = this.roles.get(uid);
      if (role === "manager" ? r === "manager" || r === "admin" : r === "admin") ids.push(uid);
    }
    return ids.map((id) => ({ id }));
  }
  async getBusinessId(userId: string) {
    return this.businesses.get(userId) || null;
  }
  async getPreferences(userId: string) {
    return this.prefs.get(userId) || null;
  }
  async getTokens(userId: string) {
    return this.tokens.get(userId) || [];
  }
  async findLiveLog(recipientId: string, type: string, refType: string, refId: string) {
    const row = this.logs.find(
      (l) =>
        l.recipient_user_id === recipientId &&
        l.type === type &&
        l.ref_type === refType &&
        l.ref_id === refId &&
        (l.status === "sent" || l.status === "sending" || l.status === "queued"),
    );
    return row ? { id: row.id as string, status: row.status as string } : null;
  }
  async clearStaleSending(recipientId: string, type: string, refType: string, refId: string) {
    for (const l of this.logs) {
      if (
        l.recipient_user_id === recipientId &&
        l.type === type &&
        l.ref_type === refType &&
        l.ref_id === refId &&
        l.status === "sending"
      ) {
        const age = Date.now() - new Date(l.created_at as string).getTime();
        if (age > 10 * 60 * 1000) {
          l.status = "failed";
          l.error = "Send timed out.";
        }
      }
    }
  }
  async insertLog(row: Record<string, unknown>) {
    const live = await this.findLiveLog(
      row.recipient_user_id as string,
      row.type as string,
      row.ref_type as string,
      row.ref_id as string,
    );
    if (live && (row.status === "sending" || row.status === "queued")) return { error: "duplicate key" };
    const id = `log_${this.logs.length + 1}`;
    this.logs.push({ ...row, id, created_at: new Date().toISOString() });
    return { id };
  }
  async updateLog(id: string, patch: Record<string, unknown>) {
    const row = this.logs.find((l) => l.id === id);
    if (row) Object.assign(row, patch);
  }
  async deactivateToken(tokenId: string) {
    this.deactivated.push(tokenId);
    for (const list of this.tokens.values()) {
      const i = list.findIndex((t) => t.id === tokenId);
      if (i >= 0) list.splice(i, 1);
    }
  }
  async getDueQueued(nowIso: string) {
    return this.logs
      .filter((l) => l.status === "queued" && (l.deliver_at as string) <= nowIso)
      .map((l) => ({
        id: l.id as string,
        recipient_user_id: l.recipient_user_id as string,
        business_id: (l.business_id as string) || null,
        type: l.type as string,
        ref_type: l.ref_type as string,
        ref_id: l.ref_id as string,
        title: l.title as string,
        body: l.body as string,
        url: (l.url as string) || null,
      }));
  }
  async claimQueued(id: string) {
    const row = this.logs.find((l) => l.id === id);
    if (!row || row.status !== "queued") return false;
    row.status = "sending";
    return true;
  }
}

// Fake Expo: records every call, answers with the tickets given.
function fakeExpo(
  tickets: Array<{ status: "ok" | "error"; id?: string; message?: string; details?: { error?: string } }>,
): { fetch: ExpoFetch; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetch: ExpoFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ data: tickets }) };
  };
  return { fetch, calls };
}

describe("sendPush", () => {
  test("sends a manager ping once and logs it sent", async () => {
    const db = new FakeDb();
    const expo = fakeExpo([{ status: "ok", id: "ticket_1" }]);
    const result = await sendPush(db, expo.fetch, baseInput());
    expect(result.sent).toBe(2);
    expect(result.recipients).toBe(2); // manager + admin both count as managers
    expect(result.duplicates).toBe(0);
    expect(expo.calls.length).toBe(2);
    expect((expo.calls[0].body as Array<Record<string, unknown>>)[0].to).toBe("ExponentPushToken[mgr1]");
    expect((expo.calls[0].body as Array<Record<string, unknown>>)[0].title).toBe("New time-off request");
    const sent = db.logs.filter((l) => l.status === "sent");
    expect(sent.length).toBe(2);
    expect(sent[0].expo_ticket_id).toBe("ticket_1");
  });

  test("respects a switched-off family", async () => {
    const db = new FakeDb();
    db.prefs.set(MGR, { push_reminders: true, push_requests: false, push_billing: true });
    db.prefs.set(OWNER, { push_reminders: true, push_requests: false, push_billing: true });
    const expo = fakeExpo([{ status: "ok", id: "ticket_1" }]);
    const result = await sendPush(db, expo.fetch, baseInput());
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(2);
    expect(expo.calls.length).toBe(0);
    expect(db.logs.every((l) => l.status === "skipped_preference")).toBe(true);
  });

  test("dedupes a second send for the same event", async () => {
    const db = new FakeDb();
    const expo = fakeExpo([{ status: "ok", id: "ticket_1" }]);
    const first = await sendPush(db, expo.fetch, baseInput());
    expect(first.sent).toBe(2);
    const second = await sendPush(db, expo.fetch, baseInput());
    expect(second.duplicates).toBe(2);
    expect(second.sent).toBe(0);
    expect(expo.calls.length).toBe(2); // no new Expo calls on the retry
  });

  test("refuses a caller from another business", async () => {
    const db = new FakeDb();
    const expo = fakeExpo([{ status: "ok", id: "ticket_1" }]);
    const result = await sendPush(db, expo.fetch, baseInput({ caller_user_id: OTHER_BIZ_USER }));
    expect(result.error).toMatch("not in this business");
    expect(result.sent).toBe(0);
    expect(expo.calls.length).toBe(0);
    expect(db.logs.length).toBe(0);
  });

  test("refuses a recipient from another business", async () => {
    const db = new FakeDb();
    const expo = fakeExpo([{ status: "ok", id: "ticket_1" }]);
    const result = await sendPush(db, expo.fetch, baseInput({ recipient_user_id: OTHER_BIZ_USER, recipient_role: undefined }));
    expect(result.error).toMatch("not in this business");
    expect(result.sent).toBe(0);
    expect(expo.calls.length).toBe(0);
  });

  test("deactivates a dead token but still sends to the live one", async () => {
    const db = new FakeDb();
    db.tokens.set(MGR, [
      { id: "tok_live", token: "ExponentPushToken[live]" },
      { id: "tok_dead", token: "ExponentPushToken[dead]" },
    ]);
    const expo = fakeExpo([
      { status: "ok", id: "ticket_live" },
      { status: "error", message: "Device not registered", details: { error: "DeviceNotRegistered" } },
    ]);
    const result = await sendPush(db, expo.fetch, baseInput({ recipient_user_id: MGR, recipient_role: undefined }));
    expect(result.sent).toBe(1);
    expect(db.deactivated).toContain("tok_dead");
    expect(db.deactivated).not.toContain("tok_live");
    const log = db.logs.find((l) => l.recipient_user_id === MGR);
    expect(log?.status).toBe("sent");
  });

  test("skips when the recipient has no tokens", async () => {
    const db = new FakeDb();
    db.tokens.set(MGR, []);
    db.tokens.set(OWNER, []);
    const expo = fakeExpo([{ status: "ok", id: "ticket_1" }]);
    const result = await sendPush(db, expo.fetch, baseInput());
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(2);
    expect(expo.calls.length).toBe(0);
    expect(db.logs.every((l) => l.status === "skipped_no_token")).toBe(true);
  });

  test("service caller needs no caller profile", async () => {
    const db = new FakeDb();
    const expo = fakeExpo([{ status: "ok", id: "ticket_1" }]);
    const result = await sendPush(
      db,
      expo.fetch,
      baseInput({ caller_user_id: null, recipient_user_id: EMP, recipient_role: undefined }),
    );
    expect(result.sent).toBe(1);
    expect(result.error).toBeUndefined();
  });

  test("a stale sending row does not block a retry", async () => {
    const db = new FakeDb();
    db.logs.push({
      id: "log_old",
      recipient_user_id: MGR,
      business_id: BIZ,
      type: "timeoff_requested",
      ref_type: "time_off_request",
      ref_id: "req_1",
      title: "New time-off request",
      body: "old",
      status: "sending",
      created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    });
    const expo = fakeExpo([{ status: "ok", id: "ticket_1" }]);
    const result = await sendPush(db, expo.fetch, baseInput({ recipient_user_id: MGR, recipient_role: undefined }));
    expect(result.sent).toBe(1);
    expect(result.duplicates).toBe(0);
    expect(db.logs.find((l) => l.id === "log_old")?.status).toBe("failed");
  });

  test("no managers means no recipients", async () => {
    const db = new FakeDb();
    db.businesses.delete(MGR);
    db.businesses.delete(OWNER);
    const expo = fakeExpo([{ status: "ok", id: "ticket_1" }]);
    const result = await sendPush(db, expo.fetch, baseInput());
    expect(result.recipients).toBe(0);
    expect(result.sent).toBe(0);
    expect(expo.calls.length).toBe(0);
  });

  // Quiet hours: 10 PM–7 AM in the caller's timezone queues until 7 AM.
  const NOV_26_23_00_EST = Date.UTC(2026, 10, 27, 4, 0, 0); // Nov 26 23:00 EST
  const NOV_27_07_00_EST = Date.UTC(2026, 10, 27, 12, 0, 0); // Nov 27 07:00 EST

  test("queues an overnight request ping until 7 AM", async () => {
    const db = new FakeDb();
    const expo = fakeExpo([{ status: "ok", id: "ticket_1" }]);
    const result = await sendPush(
      db,
      expo.fetch,
      baseInput({ caller_tz: "America/Toronto", recipient_user_id: MGR, recipient_role: undefined }),
      NOV_26_23_00_EST,
    );
    expect(result.queued).toBe(1);
    expect(result.sent).toBe(0);
    expect(expo.calls.length).toBe(0);
    const queued = db.logs.find((l) => l.status === "queued");
    expect(queued).toBeDefined();
    expect(new Date(queued!.deliver_at as string).getTime()).toBe(NOV_27_07_00_EST);
  });

  test("quiet ends at 7 AM, and an invalid timezone sends now", async () => {
    const db = new FakeDb();
    const expo = fakeExpo([{ status: "ok", id: "ticket_1" }]);
    // 06:59 EST is still quiet.
    const early = await sendPush(
      db,
      expo.fetch,
      baseInput({ caller_tz: "America/Toronto", recipient_user_id: MGR, recipient_role: undefined }),
      Date.UTC(2026, 10, 27, 11, 59, 0),
    );
    expect(early.queued).toBe(1);
    // 07:00 EST is not.
    const morning = await sendPush(
      db,
      expo.fetch,
      baseInput({ caller_tz: "America/Toronto", recipient_user_id: EMP, recipient_role: undefined, ref_id: "req_2" }),
      Date.UTC(2026, 10, 27, 12, 0, 0),
    );
    expect(morning.sent).toBe(1);
    // A bad timezone fails open — the ping goes out now.
    const badTz = await sendPush(
      db,
      expo.fetch,
      baseInput({ caller_tz: "Not/AZone", recipient_user_id: EMP, recipient_role: undefined, ref_id: "req_3" }),
      NOV_26_23_00_EST,
    );
    expect(badTz.sent).toBe(1);
  });

  test("a queued event is not queued twice", async () => {
    const db = new FakeDb();
    const expo = fakeExpo([{ status: "ok", id: "ticket_1" }]);
    const input = baseInput({ caller_tz: "America/Toronto", recipient_user_id: MGR, recipient_role: undefined });
    const first = await sendPush(db, expo.fetch, input, NOV_26_23_00_EST);
    expect(first.queued).toBe(1);
    const second = await sendPush(db, expo.fetch, input, NOV_26_23_00_EST + 5 * 60 * 1000);
    expect(second.duplicates).toBe(1);
    expect(second.queued).toBe(0);
    expect(db.logs.filter((l) => l.status === "queued").length).toBe(1);
  });

  test("flush sends due queued rows and refuses user callers", async () => {
    const db = new FakeDb();
    db.logs.push({
      id: "log_q1",
      recipient_user_id: MGR,
      business_id: BIZ,
      type: "timeoff_requested",
      ref_type: "time_off_request",
      ref_id: "req_1",
      title: "New time-off request",
      body: "Test Bot asked for Dec 24-27.",
      url: "/timeoff",
      status: "queued",
      deliver_at: new Date(Date.now() - 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    });
    const expo = fakeExpo([{ status: "ok", id: "ticket_1" }]);
    // A user caller may not flush the queue.
    const refused = await sendPush(db, expo.fetch, { ...baseInput(), flush_queued: true, caller_user_id: EMP });
    expect(refused.error).toMatch("service-only");
    expect(expo.calls.length).toBe(0);
    // The service caller flushes it.
    const flushed = await sendPush(db, expo.fetch, { ...baseInput(), flush_queued: true, caller_user_id: null });
    expect(flushed.flushed).toBe(1);
    expect(flushed.sent).toBe(1);
    expect(db.logs.find((l) => l.id === "log_q1")?.status).toBe("sent");
  });

  test("flush skips a switched-off family and fails an unknown type", async () => {
    const db = new FakeDb();
    db.prefs.set(MGR, { push_reminders: true, push_requests: false, push_billing: true });
    db.logs.push(
      {
        id: "log_q2", recipient_user_id: MGR, business_id: BIZ, type: "timeoff_requested",
        ref_type: "time_off_request", ref_id: "req_9", title: "t", body: "b", url: "/timeoff",
        status: "queued", deliver_at: new Date(Date.now() - 60 * 1000).toISOString(), created_at: new Date().toISOString(),
      },
      {
        id: "log_q3", recipient_user_id: MGR, business_id: BIZ, type: "mystery_thing",
        ref_type: "thing", ref_id: "x1", title: "t", body: "b", url: null,
        status: "queued", deliver_at: new Date(Date.now() - 60 * 1000).toISOString(), created_at: new Date().toISOString(),
      },
    );
    const expo = fakeExpo([{ status: "ok", id: "ticket_1" }]);
    const flushed = await sendPush(db, expo.fetch, { ...baseInput(), flush_queued: true, caller_user_id: null });
    expect(flushed.flushed).toBe(2);
    expect(flushed.skipped).toBe(1);
    expect(flushed.failed).toBe(1);
    expect(db.logs.find((l) => l.id === "log_q2")?.status).toBe("skipped_preference");
    expect(db.logs.find((l) => l.id === "log_q3")?.status).toBe("failed");
    expect(expo.calls.length).toBe(0);
  });
});
