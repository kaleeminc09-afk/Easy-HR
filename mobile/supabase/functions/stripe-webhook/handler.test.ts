// NorthShift — unit tests for Stripe webhook event routing (handler.ts).
// Run with: npm test   (from the mobile/ folder)
// No live Stripe: a fake Db and a fake fetchSubscription stand in for
// Supabase and the Stripe API.

import { processStripeEvent, subscriptionRowFromStripe, type Db, type StripeSubLike } from "./handler.ts";
import { PRICE_IDS } from "./verify.ts";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const DAY = 86400000;

function sampleSub(overrides: Partial<StripeSubLike> = {}): StripeSubLike {
  return {
    id: "sub_test_1",
    status: "trialing",
    customer: "cus_test_1",
    trial_start: Math.floor(NOW / 1000),
    trial_end: Math.floor((NOW + 30 * DAY) / 1000),
    current_period_start: Math.floor(NOW / 1000),
    current_period_end: Math.floor((NOW + 30 * DAY) / 1000),
    cancel_at_period_end: false,
    metadata: { business_id: "biz_1" },
    items: { data: [{ price: { id: PRICE_IDS.growth } }] },
    ...overrides,
  };
}

class FakeDb implements Db {
  businesses = new Map<string, { id: string; owner_id: string | null }>([
    ["biz_1", { id: "biz_1", owner_id: "owner_1" }],
  ]);
  rows: Record<string, Record<string, unknown>> = {};
  events: Array<{ business_id: string | null; event_type: string; stripe_event_id: string; detail: Record<string, unknown> }> = [];

  async getBusiness(businessId: string) {
    return this.businesses.get(businessId) || null;
  }
  async getSubscriptionByStripeId(sid: string) {
    const row = Object.values(this.rows).find((r) => r.stripe_subscription_id === sid);
    return row ? { business_id: row.business_id as string } : null;
  }
  async getSubscriptionByCustomer(cid: string) {
    const row = Object.values(this.rows).find((r) => r.stripe_customer_id === cid);
    return row ? { business_id: row.business_id as string } : null;
  }
  async getManualHold(businessId: string) {
    return this.rows[businessId]?.manual_hold === true;
  }
  async getGraceUntil(businessId: string) {
    const v = this.rows[businessId]?.grace_until;
    return typeof v === "string" ? v : null;
  }
  async upsertSubscription(row: Record<string, unknown>) {
    this.rows[row.business_id as string] = { ...(this.rows[row.business_id as string] || {}), ...row };
  }
  async updateSubscriptionByBusiness(businessId: string, patch: Record<string, unknown>) {
    this.rows[businessId] = { ...(this.rows[businessId] || { business_id: businessId }), ...patch };
  }
  async insertBillingEvent(row: { business_id: string | null; event_type: string; stripe_event_id: string; detail: Record<string, unknown> }) {
    this.events.push(row);
  }
}

function event(id: string, type: string, object: Record<string, unknown>) {
  return { id, type, data: { object } };
}

// Step 5: a fake send-push sink and a fake payment method.
function fakeNotify() {
  const calls: Record<string, unknown>[] = [];
  const notify = async (input: Record<string, unknown>) => {
    calls.push(input);
  };
  return { notify, calls };
}
function fakePm(expMonth: number, expYear: number) {
  return async (id: string) => ({ id, card: { exp_month: expMonth, exp_year: expYear } });
}

describe("subscriptionRowFromStripe", () => {
  test("maps a growth subscription to the growth plan with limits", () => {
    const row = subscriptionRowFromStripe(sampleSub(), "biz_1", "owner_1", PRICE_IDS);
    expect(row.plan).toBe("growth");
    expect(row.employee_limit).toBe(15);
    expect(row.status).toBe("trialing");
    expect(row.stripe_subscription_id).toBe("sub_test_1");
    expect(row.stripe_customer_id).toBe("cus_test_1");
    expect(row.trial_end).toBe(new Date(NOW + 30 * DAY).toISOString());
  });

  test("unknown price falls back to starter", () => {
    const row = subscriptionRowFromStripe(sampleSub({ items: { data: [{ price: { id: "price_nope" } }] } }), "biz_1", "owner_1", PRICE_IDS);
    expect(row.plan).toBe("starter");
    expect(row.employee_limit).toBe(5);
  });

  test("a Stripe subscription row always clears the manual hold", () => {
    const row = subscriptionRowFromStripe(sampleSub(), "biz_1", "owner_1", PRICE_IDS);
    expect(row.manual_hold).toBe(false);
  });
});

describe("processStripeEvent", () => {
  test("checkout.session.completed upserts from the fetched subscription", async () => {
    const db = new FakeDb();
    const sub = sampleSub();
    const res = await processStripeEvent(
      db,
      event("evt_1", "checkout.session.completed", { subscription: "sub_test_1", customer: "cus_test_1", metadata: { business_id: "biz_1" } }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => sub, nowMs: NOW },
    );
    expect(res.handled).toBe(true);
    expect(db.rows["biz_1"].plan).toBe("growth");
    expect(db.rows["biz_1"].status).toBe("trialing");
    expect(db.events).toHaveLength(1);
    expect(db.events[0].event_type).toBe("checkout.session.completed");
  });

  test("checkout without business metadata is not handled", async () => {
    const db = new FakeDb();
    const res = await processStripeEvent(
      db,
      event("evt_2", "checkout.session.completed", { subscription: "sub_test_1", customer: "cus_test_1", metadata: {} }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => sampleSub(), nowMs: NOW },
    );
    expect(res.handled).toBe(false);
    expect(Object.keys(db.rows)).toHaveLength(0);
  });

  test("customer.subscription.updated upserts the new status", async () => {
    const db = new FakeDb();
    db.rows["biz_1"] = { business_id: "biz_1", status: "trialing" };
    const res = await processStripeEvent(
      db,
      event("evt_3", "customer.subscription.updated", { ...(sampleSub({ status: "active" }) as unknown as Record<string, unknown>) }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => null, nowMs: NOW },
    );
    expect(res.handled).toBe(true);
    expect(db.rows["biz_1"].status).toBe("active");
    expect(db.rows["biz_1"].plan).toBe("growth");
  });

  test("invoice.payment_failed sets grace_until to now + 7 days", async () => {
    const db = new FakeDb();
    db.rows["biz_1"] = { business_id: "biz_1", status: "past_due", stripe_subscription_id: "sub_test_1", stripe_customer_id: "cus_test_1" };
    const res = await processStripeEvent(
      db,
      event("evt_4", "invoice.payment_failed", { id: "in_test_1", subscription: "sub_test_1", customer: "cus_test_1" }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => null, nowMs: NOW },
    );
    expect(res.handled).toBe(true);
    expect(db.rows["biz_1"].grace_until).toBe(new Date(NOW + 7 * DAY).toISOString());
    expect(db.events[0].event_type).toBe("invoice.payment_failed");
  });

  test("invoice.paid clears grace_until", async () => {
    const db = new FakeDb();
    db.rows["biz_1"] = { business_id: "biz_1", status: "active", grace_until: new Date(NOW - DAY).toISOString(), stripe_subscription_id: "sub_test_1" };
    const res = await processStripeEvent(
      db,
      event("evt_5", "invoice.paid", { id: "in_test_2", subscription: "sub_test_1", customer: "cus_test_1" }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => null, nowMs: NOW },
    );
    expect(res.handled).toBe(true);
    expect(db.rows["biz_1"].grace_until).toBeNull();
  });

  test("trial_will_end only writes the proof event, no subscription change", async () => {
    const db = new FakeDb();
    const res = await processStripeEvent(
      db,
      event("evt_6", "customer.subscription.trial_will_end", { ...(sampleSub() as unknown as Record<string, unknown>) }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => null, nowMs: NOW },
    );
    expect(res.handled).toBe(true);
    expect(res.action).toBe("trial-ending notice recorded");
    expect(Object.keys(db.rows)).toHaveLength(0);
    expect(db.events).toHaveLength(1);
    expect(db.events[0].detail.trial_end).toBe(new Date(NOW + 30 * DAY).toISOString());
  });

  test("unknown event types are ignored, never thrown", async () => {
    const db = new FakeDb();
    const res = await processStripeEvent(
      db,
      event("evt_7", "customer.created", { id: "cus_test_1" }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => null, nowMs: NOW },
    );
    expect(res.handled).toBe(false);
    expect(db.events).toHaveLength(0);
  });

  test("subscription.updated on a manual-hold row skips the upsert but still logs the event", async () => {
    const db = new FakeDb();
    db.rows["biz_1"] = { business_id: "biz_1", plan: "starter", status: "trialing", manual_hold: true, stripe_customer_id: "cus_test_1" };
    const res = await processStripeEvent(
      db,
      event("evt_8", "customer.subscription.updated", { ...(sampleSub({ status: "active" }) as unknown as Record<string, unknown>) }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => null, nowMs: NOW },
    );
    expect(res.handled).toBe(true);
    expect(res.action).toMatch(/manually managed/);
    expect(db.rows["biz_1"].status).toBe("trialing");
    expect(db.rows["biz_1"].plan).toBe("starter");
    expect(db.rows["biz_1"].manual_hold).toBe(true);
    expect(db.events).toHaveLength(1);
    expect(db.events[0].detail.manual_hold_skipped).toBe(true);
  });

  test("checkout.session.completed supersedes a manual hold and clears it", async () => {
    const db = new FakeDb();
    db.rows["biz_1"] = { business_id: "biz_1", plan: "starter", status: "trialing", manual_hold: true, stripe_customer_id: "cus_test_1" };
    const res = await processStripeEvent(
      db,
      event("evt_9", "checkout.session.completed", { subscription: "sub_test_1", customer: "cus_test_1", metadata: { business_id: "biz_1" } }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => sampleSub(), nowMs: NOW },
    );
    expect(res.handled).toBe(true);
    expect(db.rows["biz_1"].plan).toBe("growth");
    expect(db.rows["biz_1"].manual_hold).toBe(false);
    expect(db.rows["biz_1"].stripe_subscription_id).toBe("sub_test_1");
  });

  test("invoice.payment_failed on a manual-hold row sets no grace but still logs the event", async () => {
    const db = new FakeDb();
    db.rows["biz_1"] = { business_id: "biz_1", status: "trialing", manual_hold: true, stripe_customer_id: "cus_test_1" };
    const res = await processStripeEvent(
      db,
      event("evt_10", "invoice.payment_failed", { id: "in_test_3", subscription: null, customer: "cus_test_1" }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => null, nowMs: NOW },
    );
    expect(res.handled).toBe(true);
    expect(db.rows["biz_1"].grace_until).toBeUndefined();
    expect(db.events).toHaveLength(1);
  });

  // Step 5: billing alerts.
  test("trial_will_end pings the owner once", async () => {
    const db = new FakeDb();
    const { notify, calls } = fakeNotify();
    const res = await processStripeEvent(
      db,
      event("evt_11", "customer.subscription.trial_will_end", { ...(sampleSub() as unknown as Record<string, unknown>) }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => null, notify, nowMs: NOW },
    );
    expect(res.handled).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("trial_ending");
    expect(calls[0].family).toBe("billing");
    expect(calls[0].recipient_user_id).toBe("owner_1");
    expect(calls[0].ref_id).toBe("sub_test_1");
    expect(calls[0].url).toBe("/subscription");
  });

  test("a first failed payment pings payment_failed AND grace_warning", async () => {
    const db = new FakeDb();
    db.rows["biz_1"] = { business_id: "biz_1", status: "active", stripe_subscription_id: "sub_test_1", stripe_customer_id: "cus_test_1" };
    const { notify, calls } = fakeNotify();
    const res = await processStripeEvent(
      db,
      event("evt_12", "invoice.payment_failed", { id: "in_test_4", subscription: "sub_test_1", customer: "cus_test_1" }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => null, notify, nowMs: NOW },
    );
    expect(res.handled).toBe(true);
    expect(db.rows["biz_1"].grace_until).toBe(new Date(NOW + 7 * DAY).toISOString());
    expect(calls.map((c) => c.type)).toEqual(["payment_failed", "grace_warning"]);
    expect(calls[0].ref_id).toBe("in_test_4");
    expect(calls[0].ignore_quiet).toBeUndefined(); // a first failure can wait until morning
    expect(calls[1].ref_id).toBe("in_test_4");
  });

  test("a retry inside an open grace window pings payment_failed only", async () => {
    const db = new FakeDb();
    db.rows["biz_1"] = { business_id: "biz_1", status: "past_due", grace_until: new Date(NOW + 3 * DAY).toISOString(), stripe_subscription_id: "sub_test_1", stripe_customer_id: "cus_test_1" };
    const { notify, calls } = fakeNotify();
    await processStripeEvent(
      db,
      event("evt_13", "invoice.payment_failed", { id: "in_test_5", subscription: "sub_test_1", customer: "cus_test_1" }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => null, notify, nowMs: NOW },
    );
    expect(calls.map((c) => c.type)).toEqual(["payment_failed"]);
    expect(calls[0].ignore_quiet).toBeUndefined();
  });

  test("a failure on the last grace day skips the quiet rule", async () => {
    const db = new FakeDb();
    db.rows["biz_1"] = { business_id: "biz_1", status: "past_due", grace_until: new Date(NOW + 12 * 3600 * 1000).toISOString(), stripe_subscription_id: "sub_test_1", stripe_customer_id: "cus_test_1" };
    const { notify, calls } = fakeNotify();
    await processStripeEvent(
      db,
      event("evt_14", "invoice.payment_failed", { id: "in_test_6", subscription: "sub_test_1", customer: "cus_test_1" }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => null, notify, nowMs: NOW },
    );
    expect(calls.map((c) => c.type)).toEqual(["payment_failed"]);
    expect(calls[0].ignore_quiet).toBe(true);
  });

  test("a card expiring within 30 days pings once per card; a later card does not", async () => {
    const db = new FakeDb();
    const soon = fakeNotify();
    await processStripeEvent(
      db,
      event("evt_15", "customer.subscription.updated", { ...(sampleSub({ status: "active" }) as unknown as Record<string, unknown>), default_payment_method: "pm_soon" }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => null, notify: soon.notify, fetchPaymentMethod: fakePm(11, 2026), nowMs: NOW },
    );
    expect(soon.calls).toHaveLength(1);
    expect(soon.calls[0].type).toBe("card_expiring");
    expect(soon.calls[0].ref_id).toBe("pm_soon");
    expect(soon.calls[0].recipient_user_id).toBe("owner_1");

    const later = fakeNotify();
    await processStripeEvent(
      db,
      event("evt_16", "customer.subscription.updated", { ...(sampleSub({ status: "active" }) as unknown as Record<string, unknown>), default_payment_method: "pm_later" }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => null, notify: later.notify, fetchPaymentMethod: fakePm(12, 2026), nowMs: NOW },
    );
    expect(later.calls).toHaveLength(0);
  });

  test("a manual-hold row gets no billing pings", async () => {
    const db = new FakeDb();
    db.rows["biz_1"] = { business_id: "biz_1", status: "trialing", manual_hold: true, stripe_customer_id: "cus_test_1" };
    const { notify, calls } = fakeNotify();
    await processStripeEvent(
      db,
      event("evt_17", "invoice.payment_failed", { id: "in_test_7", subscription: null, customer: "cus_test_1" }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => null, notify, nowMs: NOW },
    );
    expect(calls).toHaveLength(0);
  });

  test("a business with no owner gets no ping, and nothing throws", async () => {
    const db = new FakeDb();
    db.businesses.set("biz_2", { id: "biz_2", owner_id: null });
    const { notify, calls } = fakeNotify();
    const res = await processStripeEvent(
      db,
      event("evt_18", "customer.subscription.trial_will_end", { ...(sampleSub({ metadata: { business_id: "biz_2" } }) as unknown as Record<string, unknown>) }),
      { priceIds: PRICE_IDS, fetchSubscription: async () => null, notify, nowMs: NOW },
    );
    expect(res.handled).toBe(true);
    expect(calls).toHaveLength(0);
    expect(db.events).toHaveLength(1);
  });
});
