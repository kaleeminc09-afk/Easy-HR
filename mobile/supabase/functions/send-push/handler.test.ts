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
        (l.status === "sent" || l.status === "sending"),
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
    if (live && row.status === "sending") return { error: "duplicate key" };
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
});
