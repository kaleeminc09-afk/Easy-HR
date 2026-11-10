// NorthShift — Stripe webhook event routing (no Deno/Supabase imports).
// index.ts wires this to the real Supabase client + Stripe API; the Jest
// tests in handler.test.ts drive it with a fake Db and a fake
// fetchSubscription, so the routing is verified without a live Stripe.
//
// The webhook is the record of truth for billing: every subscription
// change lands here and upserts the one subscriptions row per business.
// billing_events is the proof log — in particular trial_will_end, which
// is the record that the pre-charge notice event arrived (Stripe's
// built-in trial-ending email itself is a dashboard setting).

import { priceIdToPlan, stripeTsToIso, PLAN_LIMITS } from "./verify.ts";

export interface StripeSubLike {
  id: string;
  status: string;
  customer: string | { id: string } | null;
  trial_start?: number | null;
  trial_end?: number | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean | null;
  metadata?: Record<string, string> | null;
  items?: { data?: Array<{ price?: { id?: string | null } | null }> | null } | null;
}

export interface Db {
  getBusiness(businessId: string): Promise<{ id: string; owner_id: string | null } | null>;
  getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<{ business_id: string } | null>;
  getSubscriptionByCustomer(stripeCustomerId: string): Promise<{ business_id: string } | null>;
  upsertSubscription(row: Record<string, unknown>): Promise<void>;
  updateSubscriptionByBusiness(businessId: string, patch: Record<string, unknown>): Promise<void>;
  insertBillingEvent(row: { business_id: string | null; event_type: string; stripe_event_id: string; detail: Record<string, unknown> }): Promise<void>;
}

export interface HandlerOpts {
  priceIds: Record<string, string>;
  fetchSubscription: (id: string) => Promise<StripeSubLike | null>;
  nowMs?: number;
}

export type HandlerResult = { handled: boolean; businessId: string | null; action: string };

const GRACE_MS = 7 * 24 * 3600 * 1000;

export function subscriptionRowFromStripe(
  sub: StripeSubLike,
  businessId: string,
  ownerId: string | null,
  priceIds: Record<string, string>,
): Record<string, unknown> {
  const priceId = sub?.items?.data?.[0]?.price?.id ?? null;
  const plan = priceIdToPlan(priceId, priceIds) || "starter";
  return {
    business_id: businessId,
    owner_id: ownerId,
    plan,
    status: sub.status,
    employee_limit: PLAN_LIMITS[plan] ?? 5,
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null,
    stripe_subscription_id: sub.id,
    trial_start: stripeTsToIso(sub.trial_start),
    trial_end: stripeTsToIso(sub.trial_end),
    current_period_start: stripeTsToIso(sub.current_period_start),
    current_period_end: stripeTsToIso(sub.current_period_end),
    cancel_at_period_end: !!sub.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  };
}

async function findRowForInvoice(
  db: Db,
  invoice: { subscription?: string | null; customer?: string | null },
): Promise<{ business_id: string } | null> {
  const subId = typeof invoice.subscription === "string" ? invoice.subscription : null;
  if (subId) {
    const row = await db.getSubscriptionByStripeId(subId);
    if (row) return row;
  }
  const custId = typeof invoice.customer === "string" ? invoice.customer : null;
  if (custId) {
    const row = await db.getSubscriptionByCustomer(custId);
    if (row) return row;
  }
  return null;
}

export async function processStripeEvent(
  db: Db,
  event: { id: string; type: string; data: { object: Record<string, unknown> } },
  opts: HandlerOpts,
): Promise<HandlerResult> {
  const obj = (event?.data?.object || {}) as Record<string, unknown> & { metadata?: Record<string, string> };
  const type = event?.type || "";
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const businessIdFrom = (o: Record<string, unknown>): string | null => {
    const m = (o as { metadata?: Record<string, string> }).metadata;
    return typeof m?.business_id === "string" && m.business_id ? m.business_id : null;
  };

  switch (type) {
    case "checkout.session.completed": {
      const businessId = businessIdFrom(obj);
      const subId = typeof obj.subscription === "string" ? obj.subscription : null;
      if (!businessId || !subId) return { handled: false, businessId, action: "checkout.session.completed without business or subscription" };
      const sub = await opts.fetchSubscription(subId);
      if (!sub) return { handled: false, businessId, action: "subscription fetch failed" };
      const biz = await db.getBusiness(businessId);
      await db.upsertSubscription(subscriptionRowFromStripe(sub, businessId, biz?.owner_id ?? null, opts.priceIds));
      await db.insertBillingEvent({
        business_id: businessId,
        event_type: type,
        stripe_event_id: event.id,
        detail: { subscription_id: subId, customer_id: typeof obj.customer === "string" ? obj.customer : null },
      });
      return { handled: true, businessId, action: "subscription upserted from checkout" };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const businessId = businessIdFrom(obj);
      if (!businessId) return { handled: false, businessId: null, action: `${type} without business metadata` };
      const biz = await db.getBusiness(businessId);
      await db.upsertSubscription(subscriptionRowFromStripe(obj as unknown as StripeSubLike, businessId, biz?.owner_id ?? null, opts.priceIds));
      await db.insertBillingEvent({
        business_id: businessId,
        event_type: type,
        stripe_event_id: event.id,
        detail: { subscription_id: typeof obj.id === "string" ? obj.id : null, status: typeof obj.status === "string" ? obj.status : null },
      });
      return { handled: true, businessId, action: "subscription upserted" };
    }
    case "invoice.paid": {
      // Payment recovered: clear any grace window.
      const row = await findRowForInvoice(db, obj as { subscription?: string | null; customer?: string | null });
      if (row) await db.updateSubscriptionByBusiness(row.business_id, { grace_until: null, updated_at: nowIso });
      await db.insertBillingEvent({
        business_id: row?.business_id ?? null,
        event_type: type,
        stripe_event_id: event.id,
        detail: { invoice_id: typeof obj.id === "string" ? obj.id : null, subscription_id: typeof obj.subscription === "string" ? obj.subscription : null },
      });
      return { handled: true, businessId: row?.business_id ?? null, action: "grace cleared" };
    }
    case "invoice.payment_failed": {
      // Failed payment: 7 days' grace from now, then the app soft-locks setup.
      const row = await findRowForInvoice(db, obj as { subscription?: string | null; customer?: string | null });
      if (row) {
        await db.updateSubscriptionByBusiness(row.business_id, {
          grace_until: new Date(nowMs + GRACE_MS).toISOString(),
          updated_at: nowIso,
        });
      }
      await db.insertBillingEvent({
        business_id: row?.business_id ?? null,
        event_type: type,
        stripe_event_id: event.id,
        detail: { invoice_id: typeof obj.id === "string" ? obj.id : null, subscription_id: typeof obj.subscription === "string" ? obj.subscription : null },
      });
      return { handled: true, businessId: row?.business_id ?? null, action: "grace_until set +7d" };
    }
    case "customer.subscription.trial_will_end": {
      // Proof record for the pre-charge notice. No subscription change.
      const businessId = businessIdFrom(obj);
      await db.insertBillingEvent({
        business_id: businessId,
        event_type: type,
        stripe_event_id: event.id,
        detail: {
          subscription_id: typeof obj.id === "string" ? obj.id : null,
          trial_end: stripeTsToIso(typeof obj.trial_end === "number" ? obj.trial_end : null),
        },
      });
      return { handled: true, businessId, action: "trial-ending notice recorded" };
    }
    default:
      // Unknown event type: acknowledge and move on, never throw.
      return { handled: false, businessId: null, action: `ignored ${type}` };
  }
}
