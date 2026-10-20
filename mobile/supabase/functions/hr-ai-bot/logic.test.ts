// Easy HR — unit tests for the bot's core logic (logic.ts).
// Run with: npm test   (from the mobile/ folder)

import {
  haversineMeters,
  computeTodayHours,
  matchByName,
  findNearestWorksite,
  anomalyFlagForShift,
  getTeamStatus,
  computeWeeklyOvertime,
  weekStartMs,
  checkMealBreakCompliance,
  findMealBreakViolations,
  OT_THRESHOLD_HOURS,
  OT_ALERT_HOURS,
} from "./logic";

describe("haversineMeters", () => {
  test("same point is zero distance", () => {
    expect(haversineMeters(43.6532, -79.3832, 43.6532, -79.3832)).toBe(0);
  });

  test("Toronto downtown to Scarborough is roughly 15km", () => {
    // Downtown Toronto -> Scarborough Town Centre, ~15km apart
    const d = haversineMeters(43.6532, -79.3832, 43.7731, -79.2578);
    expect(d).toBeGreaterThan(12000);
    expect(d).toBeLessThan(18000);
  });

  test("150m geofence boundary behaves", () => {
    // ~100m north of a point should be inside a 150m fence
    const d = haversineMeters(43.6532, -79.3832, 43.6541, -79.3832);
    expect(d).toBeGreaterThan(50);
    expect(d).toBeLessThan(150);
  });
});

describe("computeTodayHours", () => {
  // Fixed "now": 2026-10-10 18:00 local
  const now = new Date(2026, 9, 10, 18, 0, 0).getTime();

  test("sums today's completed shifts", () => {
    const logs = [
      { clock_in: new Date(2026, 9, 10, 9, 0, 0).toISOString(), clock_out: new Date(2026, 9, 10, 13, 0, 0).toISOString() },
      { clock_in: new Date(2026, 9, 10, 14, 0, 0).toISOString(), clock_out: new Date(2026, 9, 10, 17, 30, 0).toISOString() },
    ];
    expect(computeTodayHours(logs, now)).toBe(7.5);
  });

  test("counts an open shift up to now", () => {
    const logs = [
      { clock_in: new Date(2026, 9, 10, 9, 0, 0).toISOString(), clock_out: null },
    ];
    expect(computeTodayHours(logs, now)).toBe(9);
  });

  test("ignores yesterday's shifts", () => {
    const logs = [
      { clock_in: new Date(2026, 9, 9, 9, 0, 0).toISOString(), clock_out: new Date(2026, 9, 9, 17, 0, 0).toISOString() },
    ];
    expect(computeTodayHours(logs, now)).toBe(0);
  });

  test("ignores corrupt rows where clock_out is before clock_in", () => {
    const logs = [
      { clock_in: new Date(2026, 9, 10, 17, 0, 0).toISOString(), clock_out: new Date(2026, 9, 10, 9, 0, 0).toISOString() },
    ];
    expect(computeTodayHours(logs, now)).toBe(0);
  });
});

describe("matchByName", () => {
  const people = [
    { id: "1", full_name: "Ahmed Khan" },
    { id: "2", full_name: "Ahmed Raza" },
    { id: "3", full_name: "Sara Malik" },
  ];
  const getName = (p: { full_name: string }) => p.full_name;

  test("exact single match", () => {
    const m = matchByName(people, getName, "Sara Malik");
    expect(m.kind).toBe("one");
    if (m.kind === "one") expect(m.value.id).toBe("3");
  });

  test("case-insensitive partial match", () => {
    const m = matchByName(people, getName, "sara");
    expect(m.kind).toBe("one");
  });

  test("ambiguous name returns many", () => {
    const m = matchByName(people, getName, "ahmed");
    expect(m.kind).toBe("many");
    if (m.kind === "many") expect(m.values).toHaveLength(2);
  });

  test("unknown name returns none", () => {
    expect(matchByName(people, getName, "Zubair").kind).toBe("none");
  });

  test("blank needle returns none", () => {
    expect(matchByName(people, getName, "   ").kind).toBe("none");
  });
});

describe("findNearestWorksite", () => {
  const sites = [
    { id: "a", name: "Downtown Office", latitude: 43.6532, longitude: -79.3832 },
    { id: "b", name: "Scarborough Depot", latitude: 43.7731, longitude: -79.2578 },
  ];

  test("picks the closest site with rounded meters", () => {
    const r = findNearestWorksite(sites, 43.654, -79.384, )!;
    expect(r.site.id).toBe("a");
    expect(r.distanceMeters).toBeGreaterThan(0);
    expect(Number.isInteger(r.distanceMeters)).toBe(true);
  });

  test("empty site list returns null", () => {
    expect(findNearestWorksite([], 43.65, -79.38)).toBeNull();
  });
});

describe("anomalyFlagForShift", () => {
  test("normal 8h shift is clean", () => {
    expect(anomalyFlagForShift("2026-10-10T09:00:00Z", "2026-10-10T17:00:00Z")).toBe("Normal Shift");
  });

  test("13h shift is flagged excessive", () => {
    expect(anomalyFlagForShift("2026-10-10T06:00:00Z", "2026-10-10T19:00:00Z")).toContain("Excessive Duration");
  });

  test("1-minute shift is flagged short", () => {
    expect(anomalyFlagForShift("2026-10-10T09:00:00Z", "2026-10-10T09:01:00Z")).toContain("Unusually Short Shift");
  });

  test("exactly 12h is NOT flagged", () => {
    expect(anomalyFlagForShift("2026-10-10T06:00:00Z", "2026-10-10T18:00:00Z")).toBe("Normal Shift");
  });
});
describe("getTeamStatus", () => {
  const now = new Date(2026, 9, 10, 18, 0, 0).toISOString();
  const shifts = [
    { log_id: "l1", user_id: "u1", full_name: "Ahmed Khan", clock_in: new Date(2026, 9, 10, 9, 0, 0).toISOString() },
    { log_id: "l2", user_id: "u2", full_name: "Sara Malik", clock_in: new Date(2026, 9, 10, 10, 0, 0).toISOString() },
    { log_id: "l3", user_id: "u3", full_name: "John Doe", clock_in: new Date(2026, 9, 10, 8, 30, 0).toISOString() },
  ];

  test("empty shift list means nobody working", () => {
    const st = getTeamStatus([], new Set());
    expect(st.online).toHaveLength(0);
    expect(st.on_break).toHaveLength(0);
  });

  test("splits online vs on-break correctly", () => {
    const st = getTeamStatus(shifts, new Set(["l2"]));
    expect(st.online.map((m) => m.name)).toEqual(["Ahmed Khan", "John Doe"]);
    expect(st.on_break.map((m) => m.name)).toEqual(["Sara Malik"]);
    expect(st.on_break[0].since).toBe(shifts[1].clock_in);
  });

  test("accepts a plain array of break log ids too", () => {
    const st = getTeamStatus(shifts, ["l1", "l3"]);
    expect(st.online.map((m) => m.name)).toEqual(["Sara Malik"]);
    expect(st.on_break).toHaveLength(2);
  });

  test("break row with no matching open shift is ignored", () => {
    const st = getTeamStatus(shifts.slice(0, 1), new Set(["ghost-log-id"]));
    expect(st.online).toHaveLength(1);
    expect(st.on_break).toHaveLength(0);
  });

  test("blank name falls back to Unknown", () => {
    const st = getTeamStatus(
      [{ log_id: "l9", user_id: "u9", full_name: "   ", clock_in: now }],
      new Set(),
    );
    expect(st.online[0].name).toBe("Unknown");
  });
});

describe("weekly overtime (Ontario ESA 44h)", () => {
  // Wed Oct 21, 2026, noon local. Week = Mon Oct 19 - Sun Oct 25.
  const NOW = new Date(2026, 9, 21, 12, 0, 0).getTime();
  const at = (day: number, h: number) => new Date(2026, 9, day, h, 0, 0).toISOString();
  const shift = (user_id: string, name: string, ci: string, co: string | null) =>
    ({ user_id, full_name: name, clock_in: ci, clock_out: co });

  test("Ontario ESA constants", () => {
    expect(OT_THRESHOLD_HOURS).toBe(44);
    expect(OT_ALERT_HOURS).toBe(40);
  });

  test("weekStartMs lands on Monday 00:00 local", () => {
    expect(weekStartMs(NOW)).toBe(new Date(2026, 9, 19, 0, 0, 0).getTime());
    // Sunday belongs to the week that started the previous Monday
    expect(weekStartMs(new Date(2026, 9, 25, 23, 0, 0).getTime()))
      .toBe(new Date(2026, 9, 19, 0, 0, 0).getTime());
    // Next Monday starts a new week
    expect(weekStartMs(new Date(2026, 9, 26, 0, 0, 0).getTime()))
      .toBe(new Date(2026, 9, 26, 0, 0, 0).getTime());
  });

  test("sums the week per person and ignores last week", () => {
    const rows = computeWeeklyOvertime([
      shift("u1", "Asha", at(19, 9), at(19, 17)),  // 8h Mon
      shift("u1", "Asha", at(20, 9), at(20, 17)),  // 8h Tue
      shift("u1", "Asha", at(12, 9), at(12, 17)),  // last week - ignored
      shift("u2", "Ben", at(19, 9), at(19, 13)),   // 4h
    ], NOW);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ user_id: "u1", hours: 16, status: "ok" });
    expect(rows[1]).toMatchObject({ user_id: "u2", hours: 4, status: "ok" });
  });

  test("open shift counts up to now", () => {
    const rows = computeWeeklyOvertime([
      shift("u1", "Asha", at(21, 8), null), // Wed 08:00 -> noon = 4h
    ], NOW);
    expect(rows[0].hours).toBe(4);
  });

  test("alert at 40h, overtime at 44h with overage", () => {
    const rows = computeWeeklyOvertime([
      shift("u1", "Asha", at(19, 6), at(19, 18)), // 12
      shift("u1", "Asha", at(20, 6), at(20, 18)), // 12
      shift("u1", "Asha", at(21, 0), at(21, 12)), // 12 -> 36 ok
      shift("u2", "Ben", at(19, 0), at(20, 20)),  // 44 exactly -> overtime, 0 over
      shift("u3", "Cid", at(19, 6), at(19, 18)),
      shift("u3", "Cid", at(20, 6), at(20, 18)),
      shift("u3", "Cid", at(21, 0), at(21, 4)),    // 28... plus below
      shift("u3", "Cid", at(19, 18), at(20, 6)),  // 12 -> total 40 -> approaching
    ], NOW);
    const byId = Object.fromEntries(rows.map(r => [r.user_id, r]));
    expect(byId.u1.status).toBe("ok");
    expect(byId.u2).toMatchObject({ hours: 44, status: "overtime", overtime_hours: 0 });
    expect(byId.u3).toMatchObject({ hours: 40, status: "approaching" });
  });

  test("overtime_hours reports hours past 44", () => {
    const rows = computeWeeklyOvertime([
      shift("u1", "Asha", at(19, 0), at(20, 22)), // 46h
    ], NOW);
    expect(rows[0]).toMatchObject({ hours: 46, overtime_hours: 2, status: "overtime" });
  });

  test("blank name becomes Unknown, empty input is empty output", () => {
    expect(computeWeeklyOvertime([], NOW)).toEqual([]);
    const rows = computeWeeklyOvertime([shift("u9", "  ", at(19, 9), at(19, 10))], NOW);
    expect(rows[0].name).toBe("Unknown");
  });
});

describe("meal-break compliance (Ontario ESA)", () => {
  const T0 = new Date(2026, 9, 19, 9, 0, 0); // Mon 09:00 local
  const iso = (h: number, m = 0) => new Date(T0.getTime() + (h * 60 + m) * 60000).toISOString();
  const NOW = T0.getTime() + 12 * 3600000;
  const brk = (sh: number, sm: number, eh: number, em = 0) =>
    ({ start_time: iso(sh, sm), end_time: iso(eh, em) });

  test("short shift with no break is compliant", () => {
    expect(checkMealBreakCompliance({ clock_in: iso(0), clock_out: iso(4) }, [], NOW)).toBeNull();
  });

  test("exactly 5 hours with no break is compliant, 5h01 is not", () => {
    expect(checkMealBreakCompliance({ clock_in: iso(0), clock_out: iso(5) }, [], NOW)).toBeNull();
    const v = checkMealBreakCompliance({ clock_in: iso(0), clock_out: iso(5, 1) }, [], NOW);
    expect(v).not.toBeNull();
    expect(v!.longest_work_minutes).toBe(301);
  });

  test("6h shift, no break: violation reports the full stretch", () => {
    const v = checkMealBreakCompliance({ clock_in: iso(0), clock_out: iso(6) }, [], NOW);
    expect(v!.longest_work_minutes).toBe(360);
    expect(v!.message).toContain("6h 00m");
  });

  test("30-minute break at 3h makes a 6h shift compliant", () => {
    expect(checkMealBreakCompliance(
      { clock_in: iso(0), clock_out: iso(6) }, [brk(3, 0, 3, 30)], NOW)).toBeNull();
  });

  test("a single 15-minute break is not enough", () => {
    const v = checkMealBreakCompliance(
      { clock_in: iso(0), clock_out: iso(6) }, [brk(3, 0, 3, 15)], NOW);
    expect(v).not.toBeNull();
  });

  test("two 15-minute breaks totalling 30 satisfy the rule (split provision)", () => {
    expect(checkMealBreakCompliance(
      { clock_in: iso(0), clock_out: iso(6) },
      [brk(2, 0, 2, 15), brk(4, 0, 4, 15)], NOW)).toBeNull();
  });

  test("a satisfied break resets the clock for the next span", () => {
    // 4h50 work, 30m break, 4h50 work, end: both spans under 5h
    expect(checkMealBreakCompliance(
      { clock_in: iso(0), clock_out: iso(10, 10) },
      [brk(4, 50, 5, 20)], NOW)).toBeNull();
    // ...but 5h10 in the second span is a violation
    const v = checkMealBreakCompliance(
      { clock_in: iso(0), clock_out: iso(10, 30) },
      [brk(4, 50, 5, 20)], NOW);
    expect(v).not.toBeNull();
  });

  test("open shift is measured up to now", () => {
    const v = checkMealBreakCompliance({ clock_in: iso(0), clock_out: null }, [], T0.getTime() + 6 * 3600000);
    expect(v).not.toBeNull();
  });

  test("findMealBreakViolations maps names and sorts newest first", () => {
    const flags = findMealBreakViolations([
      { log_id: "a", user_id: "u1", full_name: "Asha", clock_in: iso(0), clock_out: iso(6), breaks: [] },
      { log_id: "b", user_id: "u2", full_name: "Ben", clock_in: iso(1), clock_out: iso(3), breaks: [] },
      { log_id: "c", user_id: "u3", full_name: " ", clock_in: iso(2), clock_out: iso(9), breaks: [] },
    ], NOW);
    expect(flags.map(f => f.log_id)).toEqual(["c", "a"]);
    expect(flags[0].name).toBe("Unknown");
  });
});
