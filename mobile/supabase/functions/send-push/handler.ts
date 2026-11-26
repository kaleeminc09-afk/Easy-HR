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
//
// Quiet rule (plan page 5): request and billing pings arriving
// between 10 PM and 7 AM in the caller's timezone wait until 7 AM —
// they are logged as 'queued' with a deliver_at, and the reminder
// sweep (step 4) flushes them by calling send-push with
// flush_queued. Shift reminders are exempt (a 6 AM shift needs its
// 5 AM reminder), and a caller can pass ignore_quiet for the one
// exception the plan allows (a payment failure on the last grace
// day, step 5). A missing or invalid caller timezone fails open —
// the ping goes out now rather than being lost.

export type PushFamily = "reminders" | "requests" | "billing";

export const PUSH_FAMILIES: PushFamily[] = ["reminders", "requests", "billing"];

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_CHUNK_SIZE = 100;
// A 'sending' row older than this means the send crashed mid-flight;
// it must not block a retry forever.
export const STALE_SENDING_MINUTES = 10;
// Quiet hours, local time in the caller's timezone.
export const QUIET_START_HOUR = 22;
export const QUIET_END_HOUR = 7;

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
  // The caller's IANA timezone (device timezone from the app,
  // callerTz from the Brain). Drives the quiet rule.
  caller_tz?: string;
  // Step 5 only: a payment failure on the last grace day skips the
  // quiet rule. Every other caller leaves this off.
  ignore_quiet?: boolean;
  // Sweep only: deliver every queued row whose time has come.
  // Service callers only; no event fields needed.
  flush_queued?: boolean;
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

export interface QueuedRow {
  id: string;
  recipient_user_id: string;
  business_id: string | null;
  type: string;
  ref_type: string;
  ref_id: string;
  title: string;
  body: string;
  url: string | null;
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
  getDueQueued(nowIso: string): Promise<QueuedRow[]>;
  claimQueued(id: string): Promise<boolean>;
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
  queued?: number;
  flushed?: number;
  error?: string;
}

function prefKeyFor(family: PushFamily): keyof PushPreferences {
  return family === "reminders" ? "push_reminders" : family === "requests" ? "push_requests" : "push_billing";
}

// The family is derivable from the v1 type prefix, so a queued row
// needs no family column to re-check preferences at flush time.
export function familyForType(type: string): PushFamily | null {
  if (type.startsWith("shift_")) return "reminders";
  if (type.startsWith("timeoff_") || type.startsWith("exception_")) return "requests";
  if (type.startsWith("trial_") || type.startsWith("payment_") || type.startsWith("card_") || type.startsWith("grace_")) {
    return "billing";
  }
  return null;
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function localHourMinuteInTz(nowMs: number, tz: string): { hour: number; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date(nowMs));
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
    return { hour, minute };
  } catch {
    return null;
  }
}

// Minutes from now until 7 AM local time, or null when it is not
// quiet hours. Wall-clock arithmetic only — no offset lookup — so a
// DST transition moves delivery by at most an hour, twice a year.
function minutesToMorning(nowMs: number, tz: string): number | null {
  const hm = localHourMinuteInTz(nowMs, tz);
  if (!hm) return null;
  if (hm.hour >= QUIET_START_HOUR) return (24 - hm.hour + QUIET_END_HOUR) * 60 - hm.minute;
  if (hm.hour < QUIET_END_HOUR) return (QUIET_END_HOUR - hm.hour) * 60 - hm.minute;
  return null;
}

// The Expo send itself, shared by the live path and the flush path.
// Chunks the TOKENS so tickets[i] always belongs to tokenChunk[i].
// One dead token never fails the whole send: it is deactivated and
// the rest still go out.
async function pushToTokens(
  db: Db,
  expoFetch: ExpoFetch,
  tokens: PushTokenRow[],
  message: { title: string; body: string; data: Record<string, unknown> },
): Promise<{ anyOk: boolean; firstTicket: string | null; failure: string | null }> {
  let anyOk = false;
  let firstTicket: string | null = null;
  let failure: string | null = null;
  for (const tokenChunk of chunks(tokens, EXPO_CHUNK_SIZE)) {
    const messageChunk = tokenChunk.map((t) => ({
      to: t.token,
      title: message.title,
      body: message.body,
      data: message.data,
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
  return { anyOk, firstTicket, failure };
}

async function flushQueued(db: Db, expoFetch: ExpoFetch, nowMs: number): Promise<SendPushResult> {
  const result: SendPushResult = { sent: 0, skipped: 0, duplicates: 0, failed: 0, recipients: 0, flushed: 0 };
  const due = await db.getDueQueued(new Date(nowMs).toISOString());
  for (const row of due) {
    result.flushed!++;
    // Claim first: two sweep runs must not send the same row twice.
    // A lost claim means the other run took it — count it, move on.
    const claimed = await db.claimQueued(row.id);
    if (!claimed) {
      result.duplicates++;
      continue;
    }
    const family = familyForType(row.type);
    if (!family) {
      await db.updateLog(row.id, { status: "failed", error: "Unknown notification type." });
      result.failed++;
      continue;
    }
    const prefs = await db.getPreferences(row.recipient_user_id);
    if (prefs && prefs[prefKeyFor(family)] === false) {
      await db.updateLog(row.id, { status: "skipped_preference" });
      result.skipped++;
      continue;
    }
    const tokens = await db.getTokens(row.recipient_user_id);
    if (tokens.length === 0) {
      await db.updateLog(row.id, { status: "skipped_no_token", error: "No active tokens for this user." });
      result.skipped++;
      continue;
    }
    const { anyOk, firstTicket, failure } = await pushToTokens(db, expoFetch, tokens, {
      title: row.title,
      body: row.body,
      data: { url: row.url, type: row.type, ref_type: row.ref_type, ref_id: row.ref_id },
    });
    if (failure) {
      await db.updateLog(row.id, { status: "failed", error: failure });
      result.failed++;
    } else if (anyOk) {
      await db.updateLog(row.id, { status: "sent", expo_ticket_id: firstTicket });
      result.sent++;
    } else {
      await db.updateLog(row.id, { status: "failed", error: "Expo accepted no tickets." });
      result.failed++;
    }
  }
  return result;
}

export async function sendPush(
  db: Db,
  expoFetch: ExpoFetch,
  input: SendPushInput,
  nowMs: number = Date.now(),
): Promise<SendPushResult> {
  const empty: SendPushResult = { sent: 0, skipped: 0, duplicates: 0, failed: 0, recipients: 0 };

  // Flush mode first: it takes no event fields, and only a service
  // caller may trigger it — a user flushing the queue would send
  // other people's pings.
  if (input.flush_queued) {
    if (input.caller_user_id) return { ...empty, error: "Flush is service-only." };
    return flushQueued(db, expoFetch, nowMs);
  }

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

  // Quiet hours are computed once per call, in the caller's
  // timezone. A missing or invalid timezone fails open — the ping
  // goes out now rather than being lost.
  const quietMinutes = !input.ignore_quiet && input.caller_tz ? minutesToMorning(nowMs, input.caller_tz) : null;
  const deliverAt = quietMinutes === null ? null : new Date(nowMs + quietMinutes * 60 * 1000).toISOString();

  const result: SendPushResult = { sent: 0, skipped: 0, duplicates: 0, failed: 0, recipients: recipientIds.length, queued: 0 };
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

    // Dedupe: a live 'sent'/'sending'/'queued' row for this key means
    // this event already pinged (or queued a ping for) this person.
    // Stale 'sending' rows (a crashed earlier send) are cleared
    // first so a retry is possible.
    await db.clearStaleSending(rid, input.type, input.ref_type, input.ref_id);
    const live = await db.findLiveLog(rid, input.type, input.ref_type, input.ref_id);
    if (live) {
      await db.insertLog({ ...base, status: "duplicate" });
      result.duplicates++;
      continue;
    }

    // Quiet hours: queue for 7 AM instead of sending now. The row
    // carries deliver_at; the sweep's flush sends it in the morning.
    if (deliverAt) {
      const q = await db.insertLog({ ...base, status: "queued", deliver_at: deliverAt });
      if ("error" in q) {
        // Race backstop, same as the 'sending' insert below.
        const raced = await db.findLiveLog(rid, input.type, input.ref_type, input.ref_id);
        if (raced) result.duplicates++;
        else result.failed++;
      } else {
        result.queued!++;
      }
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

    const { anyOk, firstTicket, failure } = await pushToTokens(db, expoFetch, tokens, {
      title: input.title,
      body: input.body,
      data: { url: input.url || null, type: input.type, ref_type: input.ref_type, ref_id: input.ref_id },
    });
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
