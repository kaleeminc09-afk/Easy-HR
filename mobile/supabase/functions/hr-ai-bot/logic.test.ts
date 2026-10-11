// Easy HR — unit tests for the bot's core logic (logic.ts).
// Run with: npm test   (from the mobile/ folder)

import {
  haversineMeters,
  computeTodayHours,
  matchByName,
  findNearestWorksite,
  anomalyFlagForShift,
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
