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
});
