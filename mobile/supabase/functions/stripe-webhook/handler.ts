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
//
// MANUAL HOLD (Phase 3): the backoffice can activate a subscription
// without Stripe (pilots, invoiced clients) by setting manual_hold on
// the subscriptions row. Stripe events must never overwrite a manual
// row — subscription and invoice events skip the upsert/update for a
// held row but still write the billing_events proof row. The ONE
// exception is checkout.session.completed: a real Stripe checkout
// supersedes the manual hold, and its upsert clears manual_hold.

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
  getManualHold(businessId: string): Promise<boolean>;
  getGraceUntil(businessId: string): Promise<string | null>;
  upsertSubscription(row: Record<string, unknown>): Promise<void>;
  updateSubscriptionByBusiness(businessId: string, patch: Record<string, unknown>): Promise<void>;
  insertBillingEvent(row: { business_id: string | null; event_type: string; stripe_event_id: string; detail: Record<string, unknown> }): Promise<void>;
}

export interface HandlerOpts {
  priceIds: Record<string, string>;
  fetchSubscription: (id: string) => Promise<StripeSubLike | null>;
  // Step 5: fire a billing alert through send-push. Implemented in
  // index.ts as a service-key fetch; never throws, so a failed ping
  // never breaks the billing record. Omitted in tests that do not
  // need it — then no ping is sent.
  notify?: (input: Record<string, unknown>) => Promise<void>;
  // Step 5: fetch a payment method for the card-expiry check.
  // Stripe sends no card-expiring webhook, so the card on file is
  // checked whenever a subscription event arrives.
  fetchPaymentMethod?: (id: string) => Promise<{ id: string; card?: { exp_month: number; exp_year: number } } | null>;
  nowMs?: number;
}

export type HandlerResult = { handled: boolean; businessId: string | null; action: string };

const GRACE_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
// Billing alerts carry no caller timezone (Stripe is the caller),
// so they use the business default — the same default the sweep
// uses. The quiet rule then holds overnight billing pings until
// 7 AM, except the one exception the plan allows (a payment
// failure on the last grace day, passed as ignore_quiet).
const BILLING_TZ = "America/Toronto";

// Step 5: one billing ping to the business owner. Skips silently
// when there is no notify hook, no owner, or no ref id — a ping
// must never break the billing record, and never throw.
async function notifyOwner(
  opts: HandlerOpts,
  businessId: string,
  ownerId: string | null,
  ping: { type: string; title: string; body: string; ref_id: string; ignore_quiet?: boolean },
): Promise<void> {
  if (!opts.notify || !ownerId || !ping.ref_id) return;
  try {
    await opts.notify({
      business_id: businessId,
      type: ping.type,
      family: "billing",
      title: ping.title,
      body: ping.body,
      url: "/subscription",
      ref_type: "subscription",
      ref_id: ping.ref_id,
      recipient_user_id: ownerId,
      caller_tz: BILLING_TZ,
      ...(ping.ignore_quiet ? { ignore_quiet: true } : {}),
    });
  } catch {
    // A failed ping never breaks the billing record.
  }
}

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
    manual_hold: false,
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
      const held = await db.getManualHold(businessId);
      const biz = await db.getBusiness(businessId);
      if (!held) {
        await db.upsertSubscription(subscriptionRowFromStripe(obj as unknown as StripeSubLike, businessId, biz?.owner_id ?? null, opts.priceIds));
      }
      await db.insertBillingEvent({
        business_id: businessId,
        event_type: type,
        stripe_event_id: event.id,
        detail: { subscription_id: typeof obj.id === "string" ? obj.id : null, status: typeof obj.status === "string" ? obj.status : null, manual_hold_skipped: held },
      });
      // Card expiring: Stripe sends no webhook for this, so check
      // the card on file whenever a subscription event arrives. A
      // card within 30 days of expiry pings the owner once per card
      // (the payment-method id is the dedupe key, so a replacement
      // card gets its own ping). Deleted subscriptions have no card
      // to warn about.
      if (!held && type !== "customer.subscription.deleted" && opts.fetchPaymentMethod) {
        const pmId = typeof obj.default_payment_method === "string" ? obj.default_payment_method : null;
        if (pmId) {
          const pm = await opts.fetchPaymentMethod(pmId).catch(() => null);
          const exp = pm?.card;
          if (exp && typeof exp.exp_month === "number" && typeof exp.exp_year === "number") {
            // Valid through the last day of exp_month: the expiry
            // instant is the 1st of the following month.
            const expMs = Date.UTC(exp.exp_year, exp.exp_month, 1);
            if (expMs > nowMs && expMs - nowMs <= 30 * DAY_MS) {
              await notifyOwner(opts, businessId, biz?.owner_id ?? null, {
                type: "card_expiring",
                title: "Card expiring soon",
                body: "Your card on file expires soon. Update it in the billing portal.",
                ref_id: pmId,
              });
            }
          }
        }
      }
      return { handled: true, businessId, action: held ? "skipped — manually managed subscription" : "subscription upserted" };
    }
    case "invoice.paid": {
      // Payment recovered: clear any grace window (never on a manual row).
      const row = await findRowForInvoice(db, obj as { subscription?: string | null; customer?: string | null });
      const held = row ? await db.getManualHold(row.business_id) : false;
      if (row && !held) await db.updateSubscriptionByBusiness(row.business_id, { grace_until: null, updated_at: nowIso });
      await db.insertBillingEvent({
        business_id: row?.business_id ?? null,
        event_type: type,
        stripe_event_id: event.id,
        detail: { invoice_id: typeof obj.id === "string" ? obj.id : null, subscription_id: typeof obj.subscription === "string" ? obj.subscription : null },
      });
      return { handled: true, businessId: row?.business_id ?? null, action: held ? "grace clear skipped — manually managed" : "grace cleared" };
    }
    case "invoice.payment_failed": {
      // Failed payment: 7 days' grace from now, then the app soft-locks setup (never on a manual row).
      const row = await findRowForInvoice(db, obj as { subscription?: string | null; customer?: string | null });
      const held = row ? await db.getManualHold(row.business_id) : false;
      // Read the existing grace window BEFORE overwriting it: it
      // decides both the grace ping and the quiet-rule exception.
      const graceUntil = row ? await db.getGraceUntil(row.business_id) : null;
      const graceUntilMs = graceUntil ? new Date(graceUntil).getTime() : null;
      const alreadyInGrace = graceUntilMs !== null && graceUntilMs > nowMs;
      // The plan's one quiet-rule exception: a payment failure on
      // the last grace day goes out immediately, day or night.
      const lastGraceDay = alreadyInGrace && graceUntilMs! - nowMs <= DAY_MS;
      if (row && !held) {
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
      if (row && !held) {
        const biz = await db.getBusiness(row.business_id);
        const ownerId = biz?.owner_id ?? null;
        const invoiceId = typeof obj.id === "string" ? obj.id : "";
        await notifyOwner(opts, row.business_id, ownerId, {
          type: "payment_failed",
          title: "Payment failed",
          body: "Your NorthShift payment failed. Update your card to avoid a lock.",
          ref_id: invoiceId,
          ignore_quiet: lastGraceDay,
        });
        // Grace warning: only on entry into grace, not on every
        // retry — a retry inside an open grace window is the same
        // window the owner already heard about.
        if (!alreadyInGrace) {
          await notifyOwner(opts, row.business_id, ownerId, {
            type: "grace_warning",
            title: "Grace period started",
            body: "NorthShift is in its grace period. Pay within 7 days to keep full access.",
            ref_id: invoiceId,
          });
        }
      }
      return { handled: true, businessId: row?.business_id ?? null, action: held ? "grace skipped — manually managed" : "grace_until set +7d" };
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
      // Step 5: the trial-ending ping to the owner (Stripe sends
      // this once, 3 days before the trial ends).
      if (businessId) {
        const biz = await db.getBusiness(businessId);
        await notifyOwner(opts, businessId, biz?.owner_id ?? null, {
          type: "trial_ending",
          title: "Free month ending",
          body: "Your free month ends in 3 days. Add billing to keep scheduling.",
          ref_id: typeof obj.id === "string" ? obj.id : "",
        });
      }
      return { handled: true, businessId, action: "trial-ending notice recorded" };
    }
    default:
      // Unknown event type: acknowledge and move on, never throw.
      return { handled: false, businessId: null, action: `ignored ${type}` };
  }
}
