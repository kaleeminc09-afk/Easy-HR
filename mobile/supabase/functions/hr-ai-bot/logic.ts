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
