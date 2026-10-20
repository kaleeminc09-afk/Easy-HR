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
