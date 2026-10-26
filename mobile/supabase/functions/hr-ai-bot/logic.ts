// Easy HR — pure, testable logic for hr-ai-bot.
//
// This module has NO Deno or Supabase imports on purpose: every function here is
// deterministic and unit-testable with plain Jest (see logic.test.ts).
// index.ts imports these so the deployed bot and the tests run the same code.

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export interface ShiftLog {
  clock_in: string;
  clock_out: string | null;
}

/** Total hours worked since local midnight, given raw time_logs rows. */
export function computeTodayHours(logs: ShiftLog[], nowMs: number): number {
  const todayStart = new Date(nowMs);
  todayStart.setHours(0, 0, 0, 0);
  let ms = 0;
  for (const log of logs) {
    const s = new Date(log.clock_in).getTime();
    if (s >= todayStart.getTime()) {
      const e = log.clock_out ? new Date(log.clock_out).getTime() : nowMs;
      if (e > s) ms += e - s;
    }
  }
  return +(ms / 3600000).toFixed(2);
}

export type NameMatch<T> =
  | { kind: "one"; value: T }
  | { kind: "many"; values: T[] }
  | { kind: "none" };

/**
 * Fuzzy name lookup used by assign_task / update_task_status / get_tasks.
 * Returns exactly-one, ambiguous-many, or none — the bot turns each case
 * into either an action or a clarifying question.
 */
export function matchByName<T>(items: T[], getName: (t: T) => string, needle: string): NameMatch<T> {
  const n = needle.trim().toLowerCase();
  if (!n) return { kind: "none" };
  // An exact full-name match wins over longer substring matches, so
  // "Test Bot" resolves to Test Bot alone, not Test Bot + Test Bot Two.
  const exact = items.filter((i) => getName(i).toLowerCase() === n);
  if (exact.length === 1) return { kind: "one", value: exact[0] };
  if (exact.length > 1) return { kind: "many", values: exact };
  const hits = items.filter((i) => getName(i).toLowerCase().includes(n));
  if (hits.length === 1) return { kind: "one", value: hits[0] };
  if (hits.length > 1) return { kind: "many", values: hits };
  return { kind: "none" };
}

export interface Worksite {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

/** Nearest worksite to a GPS fix, with rounded distance in meters. */
export function findNearestWorksite(
  sites: Worksite[],
  lat: number,
  lng: number
): { site: Worksite; distanceMeters: number } | null {
  if (sites.length === 0) return null;
  let best = sites[0];
  let bestD = haversineMeters(lat, lng, best.latitude, best.longitude);
  for (const s of sites.slice(1)) {
    const d = haversineMeters(lat, lng, s.latitude, s.longitude);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return { site: best, distanceMeters: Math.round(bestD) };
}

/**
 * Mirrors the clock-out anomaly rule in mobile/app/index.js.
 * Keep both in sync: >12h shift or <3min shift gets flagged.
 */
export function anomalyFlagForShift(clockInIso: string, clockOutIso: string): string {
  const hrs = (new Date(clockOutIso).getTime() - new Date(clockInIso).getTime()) / 3600000;
  if (hrs > 12) return "⚠️ Flagged: Excessive Duration (> 12 Hours)";
  if (hrs < 0.05) return "⚠️ Flagged: Unusually Short Shift (< 3 Mins)";
  return "Normal Shift";
}
export interface ActiveShift {
  log_id: string;
  user_id: string;
  full_name: string;
  clock_in: string;
}

export interface TeamMember {
  name: string;
  since: string;
}

export interface TeamStatus {
  online: TeamMember[];
  on_break: TeamMember[];
}

/**
 * Who is currently working, from open shifts + open breaks.
 * Pure and deterministic: the edge function feeds it DB rows, the bot
 * narrates the result. A break row with no matching open shift is ignored
 * (stale data can never put a ghost on break).
 */
export function getTeamStatus(
  openShifts: ActiveShift[],
  openBreakLogIds: Set<string> | string[],
): TeamStatus {
  const onBreak = new Set(openBreakLogIds);
  const online: TeamMember[] = [];
  const on_break: TeamMember[] = [];
  for (const s of openShifts) {
    const member: TeamMember = {
      name: (s.full_name || "").trim() || "Unknown",
      since: s.clock_in,
    };
    if (onBreak.has(s.log_id)) on_break.push(member);
    else online.push(member);
  }
  return { online, on_break };
}

// ---- Weekly overtime (Ontario ESA: overtime after 44 hours in a work week) ----

export const OT_THRESHOLD_HOURS = 44;
export const OT_ALERT_HOURS = 40;

export interface WeeklyShiftLog {
  user_id: string;
  full_name?: string | null;
  clock_in: string;
  clock_out: string | null;
}

export type OvertimeStatus = "ok" | "approaching" | "overtime";

export interface OvertimeRow {
  user_id: string;
  name: string;
  hours: number;
  overtime_hours: number;
  status: OvertimeStatus;
}

/** Monday 00:00 local time of the week containing nowMs. */
export function weekStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // Mon=0 ... Sun=6
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

/**
 * Hours per person for the current work week (Mon-Sun, local).
 * Shifts are bucketed by their clock-in time; open shifts count up to nowMs.
 * Same gross-hours convention as computeTodayHours (breaks not deducted).
 */
export function computeWeeklyOvertime(logs: WeeklyShiftLog[], nowMs: number): OvertimeRow[] {
  const start = weekStartMs(nowMs);
  const end = start + 7 * 24 * 3600 * 1000;
  const totals = new Map<string, { name: string; ms: number }>();
  for (const log of logs) {
    const s = new Date(log.clock_in).getTime();
    if (Number.isNaN(s) || s < start || s >= end) continue;
    const e = log.clock_out ? new Date(log.clock_out).getTime() : nowMs;
    if (e <= s) continue;
    const cur = totals.get(log.user_id) || {
      name: (log.full_name || "").trim() || "Unknown",
      ms: 0,
    };
    cur.ms += e - s;
    totals.set(log.user_id, cur);
  }
  const rows: OvertimeRow[] = [];
  for (const [user_id, t] of totals) {
    const hours = +(t.ms / 3600000).toFixed(2);
    const overtime_hours = +Math.max(0, hours - OT_THRESHOLD_HOURS).toFixed(2);
    const status: OvertimeStatus =
      hours >= OT_THRESHOLD_HOURS ? "overtime" : hours >= OT_ALERT_HOURS ? "approaching" : "ok";
    rows.push({ user_id, name: t.name, hours, overtime_hours, status });
  }
  return rows.sort((a, b) => b.hours - a.hours);
}

// ---- Ontario ESA meal-break compliance ----
// An employee must not work more than 5 consecutive hours without a
// 30-minute eating period. The 30 minutes may be split into two periods
// totalling 30 within the same 5-hour span (both are modelled here).

export const MEAL_BREAK_MAX_WORK_MINUTES = 300; // 5 hours
export const MEAL_BREAK_REQUIRED_MINUTES = 30;

export interface BreakInterval {
  start_time: string;
  end_time: string | null;
}

export interface ShiftWindow {
  clock_in: string;
  clock_out: string | null;
}

export interface MealBreakViolation {
  longest_work_minutes: number;
  message: string;
}

function mealBreakViolation(longestWorkMin: number): MealBreakViolation {
  const h = Math.floor(longestWorkMin / 60);
  const m = Math.round(longestWorkMin % 60);
  return {
    longest_work_minutes: Math.round(longestWorkMin),
    message: `Worked ${h}h ${String(m).padStart(2, "0")}m without a 30-minute meal break (Ontario ESA)`,
  };
}

/**
 * Checks one shift against the ESA meal-break rule.
 * Walks the shift chronologically: work minutes accumulate; break minutes
 * accumulate as credit; reaching 30 credit minutes satisfies the span and
 * resets the clock. Crossing 300 work minutes with <30 credit is a violation.
 * Open breaks/shifts are measured up to nowMs. Returns null when compliant.
 */
export function checkMealBreakCompliance(
  shift: ShiftWindow,
  breaks: BreakInterval[],
  nowMs: number,
): MealBreakViolation | null {
  const start = new Date(shift.clock_in).getTime();
  if (Number.isNaN(start)) return null;
  const end = shift.clock_out ? new Date(shift.clock_out).getTime() : nowMs;
  if (end <= start) return null;

  const ivs = breaks
    .map((b) => {
      const s = Math.max(start, new Date(b.start_time).getTime());
      const e = Math.min(end, b.end_time ? new Date(b.end_time).getTime() : end);
      return { s, e };
    })
    .filter((iv) => iv.e > iv.s)
    .sort((a, b) => a.s - b.s);

  let workMin = 0;
  let creditMin = 0;
  let cursor = start;

  for (const iv of ivs) {
    if (iv.s > cursor) {
      workMin += (iv.s - cursor) / 60000;
      if (workMin > MEAL_BREAK_MAX_WORK_MINUTES && creditMin < MEAL_BREAK_REQUIRED_MINUTES) {
        return mealBreakViolation(workMin);
      }
    }
    creditMin += (iv.e - iv.s) / 60000;
    if (creditMin >= MEAL_BREAK_REQUIRED_MINUTES) {
      workMin = 0;
      creditMin = 0;
    }
    cursor = Math.max(cursor, iv.e);
  }
  if (end > cursor) {
    workMin += (end - cursor) / 60000;
    if (workMin > MEAL_BREAK_MAX_WORK_MINUTES && creditMin < MEAL_BREAK_REQUIRED_MINUTES) {
      return mealBreakViolation(workMin);
    }
  }
  return null;
}

export interface ShiftWithBreaks extends ShiftWindow {
  log_id: string;
  user_id: string;
  full_name?: string | null;
  breaks: BreakInterval[];
}

export interface ComplianceFlag {
  log_id: string;
  user_id: string;
  name: string;
  clock_in: string;
  longest_work_minutes: number;
  message: string;
}

/** Flags every non-compliant shift, newest first. */
export function findMealBreakViolations(shifts: ShiftWithBreaks[], nowMs: number): ComplianceFlag[] {
  const flags: ComplianceFlag[] = [];
  for (const s of shifts) {
    const v = checkMealBreakCompliance(s, s.breaks, nowMs);
    if (v) {
      flags.push({
        log_id: s.log_id,
        user_id: s.user_id,
        name: (s.full_name || "").trim() || "Unknown",
        clock_in: s.clock_in,
        longest_work_minutes: v.longest_work_minutes,
        message: v.message,
      });
    }
  }
  return flags.sort((a, b) => (a.clock_in < b.clock_in ? 1 : -1));
}

// ---- Audit-ready CSV export ----
// One row per completed shift: the record an ESA auditor or payroll run
// needs. Paid hours = gross shift hours minus unpaid (lunch) break time.
// Weekly totals/overtime use the same Mon-Sun week + 44h rule as the
// overtime watch; meal-break compliance uses the ESA check above.

export interface AuditBreak {
  break_type: string;
  start_time: string;
  end_time: string | null;
}

export interface AuditShift {
  log_id: string;
  user_id: string;
  full_name?: string | null;
  email?: string | null;
  worksite_name?: string | null;
  clock_in: string;
  clock_out: string | null;
  anomaly_flag?: string | null;
  breaks: AuditBreak[];
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function buildAuditCsv(shifts: AuditShift[], nowMs: number): string {
  const closed = shifts.filter((s) => s.clock_out);

  // Person-week gross totals (Mon-Sun local), the overtime base.
  const weekTotals = new Map<string, number>();
  for (const s of closed) {
    const key = `${s.user_id}|${weekStartMs(new Date(s.clock_in).getTime())}`;
    const hrs = (new Date(s.clock_out as string).getTime() - new Date(s.clock_in).getTime()) / 3600000;
    weekTotals.set(key, (weekTotals.get(key) || 0) + hrs);
  }

  const header = [
    "Employee", "Email", "Worksite", "Date", "Clock In", "Clock Out",
    "Shift Hours", "Unpaid Break (min)", "Paid Hours", "Breaks",
    "Anomaly Flag", "Meal Break Compliant", "Week Total Hours",
    "Overtime Hours (Week)",
  ];
  const lines: string[] = [header.join(",")];

  const nameOf = (s: AuditShift) => (s.full_name || "").trim() || "Unknown";
  const sorted = [...closed].sort((a, b) => {
    const n = nameOf(a).localeCompare(nameOf(b));
    return n !== 0 ? n : a.clock_in.localeCompare(b.clock_in);
  });

  for (const s of sorted) {
    const inMs = new Date(s.clock_in).getTime();
    const outMs = new Date(s.clock_out as string).getTime();
    const grossMin = (outMs - inMs) / 60000;

    let unpaidMin = 0;
    const breakParts: string[] = [];
    for (const b of [...s.breaks].sort((x, y) => x.start_time.localeCompare(y.start_time))) {
      const bs = Math.max(inMs, new Date(b.start_time).getTime());
      const be = Math.min(outMs, b.end_time ? new Date(b.end_time).getTime() : outMs);
      const mins = Math.max(0, Math.round((be - bs) / 60000));
      if (b.break_type === "Unpaid Lunch") unpaidMin += mins;
      breakParts.push(`${b.break_type} ${mins}m`);
    }

    const weekKey = `${s.user_id}|${weekStartMs(inMs)}`;
    const weekTotal = weekTotals.get(weekKey) || 0;
    const weekOt = Math.max(0, weekTotal - OT_THRESHOLD_HOURS);
    const compliant = checkMealBreakCompliance(s, s.breaks, nowMs) ? "No" : "Yes";

    const row = [
      nameOf(s),
      (s.email || "").trim(),
      (s.worksite_name || "").trim(),
      fmtDate(s.clock_in),
      fmtTime(s.clock_in),
      fmtTime(s.clock_out as string),
      (grossMin / 60).toFixed(2),
      String(unpaidMin),
      ((grossMin - unpaidMin) / 60).toFixed(2),
      breakParts.length > 0 ? breakParts.join("; ") : "None",
      (s.anomaly_flag || "").trim(),
      compliant,
      weekTotal.toFixed(2),
      weekOt.toFixed(2),
    ];
    lines.push(row.map(csvCell).join(","));
  }
  return lines.join("\n");
}

// ---- Shift scheduling ----

export interface ShiftLike {
  start_time: string;
  end_time: string;
}

/** True when two shifts overlap in time. Touching endpoints (one ends
 *  exactly when the other starts) do NOT overlap. */
export function shiftsOverlap(a: ShiftLike, b: ShiftLike): boolean {
  const as = new Date(a.start_time).getTime();
  const ae = new Date(a.end_time).getTime();
  const bs = new Date(b.start_time).getTime();
  const be = new Date(b.end_time).getTime();
  return as < be && bs < ae;
}

/** Returns a plain-language problem, or null when the shift times are valid. */
export function validateShiftInput(startIso: string, endIso: string): string | null {
  const s = new Date(startIso).getTime();
  const e = new Date(endIso).getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) return "Enter a valid date and start/end times.";
  if (e <= s) return "End time must be after start time. For an overnight shift, turn on 'Ends next day'.";
  if (e - s > 24 * 3600 * 1000) return "A shift cannot be longer than 24 hours.";
  return null;
}

export function shiftDurationHours(s: ShiftLike): number {
  return +(((new Date(s.end_time).getTime() - new Date(s.start_time).getTime()) / 3600000).toFixed(2));
}

// ---- Time off ----
// Dates are YYYY-MM-DD strings, parsed as UTC midnights so weekday math
// never drifts with the local timezone.

export interface TimeOffLike {
  type: string;
  start_date: string;
  end_date: string;
  half_day?: boolean;
  status: string;
}

function dateOnlyMs(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1);
}

/** Business days (Mon-Fri) in an inclusive date range; a half-day
 *  single-day request counts 0.5. Returns 0 for invalid/reversed ranges. */
export function countBusinessDays(startDate: string, endDate: string, halfDay = false): number {
  const s = dateOnlyMs(startDate);
  const e = dateOnlyMs(endDate);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 0;
  if (halfDay && startDate === endDate) {
    const dow = new Date(s).getUTCDay();
    return dow === 0 || dow === 6 ? 0 : 0.5;
  }
  let count = 0;
  const d = new Date(s);
  while (d.getTime() <= e) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

/** Inclusive date-range overlap (sharing a day counts as overlapping). */
export function dateRangesOverlap(
  a: { start_date: string; end_date: string },
  b: { start_date: string; end_date: string },
): boolean {
  return a.start_date <= b.end_date && b.start_date <= a.end_date;
}

/** Approved vacation business days attributed to a calendar year
 *  (by the request's start date). */
export function vacationDaysUsed(requests: TimeOffLike[], year: number): number {
  let used = 0;
  for (const r of requests) {
    if (r.status !== "approved" || r.type !== "Vacation") continue;
    if (new Date(dateOnlyMs(r.start_date)).getUTCFullYear() !== year) continue;
    used += countBusinessDays(r.start_date, r.end_date, !!r.half_day);
  }
  return +used.toFixed(1);
}

export interface VacationBalance {
  entitlement: number;
  used: number;
  remaining: number;
}

export function vacationBalance(entitlement: number, requests: TimeOffLike[], year: number): VacationBalance {
  const used = vacationDaysUsed(requests, year);
  return { entitlement, used, remaining: +(entitlement - used).toFixed(1) };
}

// ---- Planned vs actual ----
// A planned shift counts as worked when the employee has any clock-in on
// the same local calendar day. Hours are gross (breaks not deducted),
// matching the overtime and audit views.

export interface PlannedShift {
  user_id: string | null;
  start_time: string;
  end_time: string;
}

export interface PlannedVsActualRow {
  userId: string;
  plannedHours: number;
  actualHours: number;
  /** actual - planned (negative = under plan). */
  varianceHours: number;
  plannedCount: number;
  workedCount: number;
  /** Planned shifts fully in the past with no clock-in that day. */
  missedCount: number;
  /** Clock-ins on days with no planned shift. */
  unscheduledCount: number;
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function plannedVsActual(
  shifts: PlannedShift[],
  logs: WeeklyShiftLog[],
  weekStart: number,
  now: number,
): PlannedVsActualRow[] {
  const weekEnd = weekStart + 7 * 24 * 3600 * 1000;
  const rows = new Map<string, PlannedVsActualRow>();
  const ensure = (userId: string): PlannedVsActualRow => {
    let r = rows.get(userId);
    if (!r) {
      r = { userId, plannedHours: 0, actualHours: 0, varianceHours: 0, plannedCount: 0, workedCount: 0, missedCount: 0, unscheduledCount: 0 };
      rows.set(userId, r);
    }
    return r;
  };

  const logDaysByUser = new Map<string, Set<string>>();
  for (const l of logs) {
    const ci = Date.parse(l.clock_in);
    if (Number.isNaN(ci)) continue;
    if (!logDaysByUser.has(l.user_id)) logDaysByUser.set(l.user_id, new Set());
    logDaysByUser.get(l.user_id)!.add(localDayKey(ci));
  }
  const plannedDaysByUser = new Map<string, Set<string>>();
  for (const s of shifts) {
    if (!s.user_id) continue;
    const st = Date.parse(s.start_time);
    if (Number.isNaN(st)) continue;
    if (!plannedDaysByUser.has(s.user_id)) plannedDaysByUser.set(s.user_id, new Set());
    plannedDaysByUser.get(s.user_id)!.add(localDayKey(st));
  }

  for (const s of shifts) {
    if (!s.user_id) continue;
    const st = Date.parse(s.start_time);
    const en = Date.parse(s.end_time);
    if (Number.isNaN(st) || Number.isNaN(en) || st < weekStart || st >= weekEnd) continue;
    const row = ensure(s.user_id);
    row.plannedCount++;
    row.plannedHours += Math.max(0, (en - st) / 3600000);
    const worked = logDaysByUser.get(s.user_id)?.has(localDayKey(st)) ?? false;
    if (worked) row.workedCount++;
    else if (en <= now) row.missedCount++;
  }

  for (const l of logs) {
    const ci = Date.parse(l.clock_in);
    if (Number.isNaN(ci) || ci < weekStart || ci >= weekEnd) continue;
    const row = ensure(l.user_id);
    const co = l.clock_out ? Date.parse(l.clock_out) : now;
    if (!Number.isNaN(co)) row.actualHours += Math.max(0, (co - ci) / 3600000);
    const scheduled = plannedDaysByUser.get(l.user_id)?.has(localDayKey(ci)) ?? false;
    if (!scheduled) row.unscheduledCount++;
  }

  for (const r of rows.values()) {
    r.plannedHours = +r.plannedHours.toFixed(2);
    r.actualHours = +r.actualHours.toFixed(2);
    r.varianceHours = +(r.actualHours - r.plannedHours).toFixed(2);
  }
  return [...rows.values()];
}

// ---- Documents ----

/** Keep only safe characters for a storage object name. */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+/, "");
  return (cleaned || "file").slice(0, 80);
}

/** Object path inside the documents bucket: <userId>/<ts>-<safe name>.
 *  The first segment is the security boundary the storage policies use. */
export function buildStoragePath(userId: string, fileName: string, timestampMs: number): string {
  return `${userId}/${timestampMs}-${sanitizeFileName(fileName)}`;
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Convert a wall-clock date + time in an IANA timezone to a UTC instant
 * (ms). Two offset passes settle DST-boundary cases. NaN on bad input.
 * Example: ("2026-10-23", "09:00", "America/Toronto") -> 13:00Z (EDT).
 */
export function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): number {
  const [y, mo, d] = (dateStr || "").split("-").map(Number);
  const [hh, mm] = (timeStr || "").split(":").map(Number);
  if ([y, mo, d, hh, mm].some((n) => typeof n !== "number" || Number.isNaN(n))) return NaN;
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const offsetAt = (utcMs: number): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    return asUtc - utcMs;
  };
  const utc = guess - offsetAt(guess - offsetAt(guess));
  return utc;
}
