// NorthShift — push sender (send-push). Pure logic: no Deno, no HTTP.
// The HTTP wrapper lives in index.ts, the tests in handler.test.ts.
// One call = one event, one recipient set, one tap target. The sender
// enforces business scope (caller and every recipient share one
// business), honours the recipient's family preference, dedupes by
// (recipient, type, ref) through notification_log, sends through the
// Expo Push API (free, no key), and deactivates tokens Expo reports
// dead. A failed send never throws: the caller gets counts, and the
// failure sits in the log for follow-up. A failed send never blocks
// the action that caused it — the call sites fire and forget.

export type PushFamily = "reminders" | "requests" | "billing";

export const PUSH_FAMILIES: PushFamily[] = ["reminders", "requests", "billing"];

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_CHUNK_SIZE = 100;
// A 'sending' row older than this means the send crashed mid-flight;
// it must not block a retry forever.
export const STALE_SENDING_MINUTES = 10;

export interface SendPushInput {
  business_id: string;
  type: string; // e.g. "shift_reminder", "timeoff_requested"
  family: PushFamily;
  title: string;
  body: string;
  url?: string; // deep-link path, e.g. "/timeoff"
  ref_type: string; // "shift" | "time_off_request" | "time_exception" | "subscription"
  ref_id: string;
  recipient_user_id?: string;
  recipient_role?: "manager" | "admin";
  // Stamped from the JWT by index.ts for user callers; null for
  // service-role callers (Brain, sweep, webhook). Never trusted from
  // the request body for user callers.
  caller_user_id: string | null;
}

export interface PushRecipient {
  id: string;
}

export interface PushTokenRow {
  id: string;
  token: string;
}

export interface PushPreferences {
  push_reminders: boolean;
  push_requests: boolean;
  push_billing: boolean;
}

export interface PushLogRow {
  id: string;
  status: string;
}

export interface Db {
  getCaller(userId: string): Promise<{ business_id: string | null; role: string | null } | null>;
  getRecipientsByRole(businessId: string, role: "manager" | "admin"): Promise<PushRecipient[]>;
  getBusinessId(userId: string): Promise<string | null>;
  getPreferences(userId: string): Promise<PushPreferences | null>;
  getTokens(userId: string): Promise<PushTokenRow[]>;
  findLiveLog(recipientId: string, type: string, refType: string, refId: string): Promise<PushLogRow | null>;
  clearStaleSending(recipientId: string, type: string, refType: string, refId: string): Promise<void>;
  insertLog(row: Record<string, unknown>): Promise<{ id: string } | { error: string }>;
  updateLog(id: string, patch: Record<string, unknown>): Promise<void>;
  deactivateToken(tokenId: string): Promise<void>;
}

export interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

export type ExpoFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface SendPushResult {
  sent: number;
  skipped: number;
  duplicates: number;
  failed: number;
  recipients: number;
  error?: string;
}

function prefKeyFor(family: PushFamily): keyof PushPreferences {
  return family === "reminders" ? "push_reminders" : family === "requests" ? "push_requests" : "push_billing";
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function sendPush(db: Db, expoFetch: ExpoFetch, input: SendPushInput): Promise<SendPushResult> {
  const empty: SendPushResult = { sent: 0, skipped: 0, duplicates: 0, failed: 0, recipients: 0 };
  if (!input.business_id || !input.type || !input.ref_type || !input.ref_id) {
    return { ...empty, error: "Missing business_id, type, ref_type or ref_id." };
  }
  if (!PUSH_FAMILIES.includes(input.family)) {
    return { ...empty, error: "Unknown family." };
  }
  if (!input.title || !input.body) {
    return { ...empty, error: "Missing title or body." };
  }
  if ((input.recipient_user_id && input.recipient_role) || (!input.recipient_user_id && !input.recipient_role)) {
    return { ...empty, error: "Exactly one of recipient_user_id, recipient_role." };
  }

  // User callers must belong to the business they are notifying.
  // Service-role callers (caller_user_id null) are first-party
  // functions and carry the business in the payload instead.
  if (input.caller_user_id) {
    const caller = await db.getCaller(input.caller_user_id);
    if (!caller || caller.business_id !== input.business_id) {
      return { ...empty, error: "Caller is not in this business." };
    }
  }

  // Resolve recipients, and prove each one is in the same business.
  // A role recipient means the managers of the business ('manager'
  // resolves to managers AND admins — admins are managers too).
  let recipientIds: string[] = [];
  if (input.recipient_user_id) {
    const biz = await db.getBusinessId(input.recipient_user_id);
    if (!biz || biz !== input.business_id) {
      return { ...empty, error: "Recipient is not in this business." };
    }
    recipientIds = [input.recipient_user_id];
  } else {
    const users = await db.getRecipientsByRole(input.business_id, input.recipient_role as "manager" | "admin");
    recipientIds = users.map((u) => u.id);
  }
  if (recipientIds.length === 0) {
    return { ...empty, recipients: 0 };
  }

  const result: SendPushResult = { sent: 0, skipped: 0, duplicates: 0, failed: 0, recipients: recipientIds.length };
  const prefKey = prefKeyFor(input.family);

  for (const rid of recipientIds) {
    const base: Record<string, unknown> = {
      recipient_user_id: rid,
      business_id: input.business_id,
      caller_user_id: input.caller_user_id,
      type: input.type,
      ref_type: input.ref_type,
      ref_id: input.ref_id,
      title: input.title,
      body: input.body,
      url: input.url || null,
    };

    // Preference: a switched-off family is a skip, logged so "I never
    // got it" is answerable. A missing preference row (or missing
    // columns) fails open — the ping goes out.
    const prefs = await db.getPreferences(rid);
    if (prefs && prefs[prefKey] === false) {
      await db.insertLog({ ...base, status: "skipped_preference" });
      result.skipped++;
      continue;
    }

    // Dedupe: a live 'sent'/'sending' row for this key means this
    // event already pinged this person. Stale 'sending' rows (a
    // crashed earlier send) are cleared first so a retry is possible.
    await db.clearStaleSending(rid, input.type, input.ref_type, input.ref_id);
    const live = await db.findLiveLog(rid, input.type, input.ref_type, input.ref_id);
    if (live) {
      await db.insertLog({ ...base, status: "duplicate" });
      result.duplicates++;
      continue;
    }
    const ins = await db.insertLog({ ...base, status: "sending" });
    if ("error" in ins) {
      // Race backstop: the unique index rejected the insert, so
      // another call for the same key won. Re-check before calling
      // it a failure — a real log-write failure must not send blind.
      const raced = await db.findLiveLog(rid, input.type, input.ref_type, input.ref_id);
      if (raced) {
        result.duplicates++;
      } else {
        result.failed++;
      }
      continue;
    }
    const logId = ins.id;

    const tokens = await db.getTokens(rid);
    if (tokens.length === 0) {
      await db.updateLog(logId, { status: "skipped_no_token", error: "No active tokens for this user." });
      result.skipped++;
      continue;
    }

    // Send in chunks of 100 (Expo's per-request limit), chunking the
    // TOKENS so tickets[i] always belongs to tokenChunk[i]. One dead
    // token never fails the whole send: it is deactivated and the
    // rest still go out.
    let anyOk = false;
    let firstTicket: string | null = null;
    let failure: string | null = null;
    for (const tokenChunk of chunks(tokens, EXPO_CHUNK_SIZE)) {
      const messageChunk = tokenChunk.map((t) => ({
        to: t.token,
        title: input.title,
        body: input.body,
        data: { url: input.url || null, type: input.type, ref_type: input.ref_type, ref_id: input.ref_id },
        sound: "default",
      }));
      let res: { ok: boolean; status: number; json(): Promise<unknown> };
      try {
        res = await expoFetch(EXPO_PUSH_URL, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(messageChunk),
        });
      } catch {
        failure = "Expo request failed.";
        break;
      }
      if (!res.ok) {
        failure = `Expo returned ${res.status}.`;
        break;
      }
      const payload = (await res.json()) as { data?: ExpoTicket[] };
      const tickets = payload.data || [];
      tickets.forEach((tk, i) => {
        const tokenRow = tokenChunk[i];
        if (tk.status === "ok") {
          anyOk = true;
          if (!firstTicket) firstTicket = tk.id || null;
        } else if (tk.details?.error === "DeviceNotRegistered" && tokenRow) {
          // Best-effort: a dead token must not fail the send.
          db.deactivateToken(tokenRow.id).catch(() => undefined);
        }
      });
    }
    if (failure) {
      await db.updateLog(logId, { status: "failed", error: failure });
      result.failed++;
    } else if (anyOk) {
      await db.updateLog(logId, { status: "sent", expo_ticket_id: firstTicket });
      result.sent++;
    } else {
      await db.updateLog(logId, { status: "failed", error: "Expo accepted no tickets." });
      result.failed++;
    }
  }
  return result;
}
