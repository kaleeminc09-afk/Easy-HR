import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Stripe Checkout (hosted page) for NorthShift plans. The app sends ONLY
// a plan slug (starter / growth / business); the server maps it to a
// Stripe price — the client never picks a price ID or an amount. Cards
// are collected on Stripe's page only; no card data ever touches our
// code. Model: card at signup (day 1), 30 days free, charged day 31
// unless cancelled. A business that already had a subscription gets NO
// second free trial — the trial applies to the first subscription only.
// Secrets live only in Supabase secrets (STRIPE_SECRET_KEY,
// STRIPE_PRICE_*); nothing secret is in this file.
// TEST-mode price IDs, created 2026-11-10. Live mode MUST override them
// with the STRIPE_PRICE_STARTER / _GROWTH / _BUSINESS secrets — never
// edit these to live IDs in the repo. (Kept local to this function on
// purpose: a function deploys as its own folder, so it cannot import
// from a sibling function's folder.)
const PRICE_IDS: Record<string, string> = {
  starter: "price_1UaLUr4CKkTxZIvG3uTcrG9J",
  growth: "price_1UaLUs4CKkTxZIvGBBM0gZpe",
  business: "price_1UaLUu4CKkTxZIvG08wFKSfS",
};
const PLAN_LIMITS: Record<string, number> = { starter: 5, growth: 15, business: 40 };

function priceIdsFromEnv(): Record<string, string> {
  return {
    starter: Deno.env.get("STRIPE_PRICE_STARTER") || PRICE_IDS.starter,
    growth: Deno.env.get("STRIPE_PRICE_GROWTH") || PRICE_IDS.growth,
    business: Deno.env.get("STRIPE_PRICE_BUSINESS") || PRICE_IDS.business,
  };
}

const APP_URL = "https://app.northshiftapp.com";

async function stripePost(path: string, params: Record<string, string>, key: string) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Stripe ${path} failed (${res.status})`);
  return data;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only." }, 405);
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
    if (!STRIPE_KEY) return json({ error: "Billing is not configured yet." }, 500);

    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Sign in to subscribe." }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !user) return json({ error: "Sign in to subscribe." }, 401);

    const db = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: caller } = await db
      .from("profiles")
      .select("role, business_id")
      .eq("id", user.id)
      .maybeSingle();
    if (!caller || (caller.role !== "manager" && caller.role !== "admin")) {
      return json({ error: "Only managers and admins can subscribe." }, 403);
    }
    if (!caller.business_id) return json({ error: "This account has no business yet." }, 400);

    const body = await req.json().catch(() => ({}));
    const plan = String(body.plan || "").trim().toLowerCase();
    const priceIds = priceIdsFromEnv();
    if (!priceIds[plan]) return json({ error: "Pick a plan: starter, growth, or business." }, 400);

    // Already paying (or trialing)? Plan changes and card updates go
    // through the Billing Portal, not a second Checkout.
    const { data: existing } = await db
      .from("subscriptions")
      .select("status, stripe_subscription_id, stripe_customer_id")
      .eq("business_id", caller.business_id)
      .maybeSingle();
    if (existing?.stripe_subscription_id && (existing.status === "active" || existing.status === "trialing")) {
      return json({ error: "You already have an active subscription — manage it from Manage billing." }, 409);
    }
    const hadSubscriptionBefore = !!existing?.stripe_subscription_id;

    // One Stripe Customer per business, reused across checkouts.
    let customerId = existing?.stripe_customer_id as string | null;
    if (!customerId) {
      const customer = await stripePost("/customers", {
        email: user.email || "",
        "metadata[business_id]": caller.business_id,
      }, STRIPE_KEY);
      customerId = customer.id as string;
      await db.from("subscriptions").upsert(
        {
          business_id: caller.business_id,
          owner_id: user.id,
          plan,
          status: "trialing",
          employee_limit: PLAN_LIMITS[plan] ?? 5,
          stripe_customer_id: customerId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "business_id" },
      );
    }

    const sessionParams: Record<string, string> = {
      mode: "subscription",
      customer: customerId,
      "line_items[0][price]": priceIds[plan],
      "line_items[0][quantity]": "1",
      // Card at signup, always — even for the free trial.
      payment_method_collection: "always",
      success_url: `${APP_URL}/subscription?checkout=success`,
      cancel_url: `${APP_URL}/subscription?checkout=cancelled`,
      "metadata[business_id]": caller.business_id,
      "subscription_data[metadata][business_id]": caller.business_id,
    };
    if (!hadSubscriptionBefore) sessionParams["subscription_data[trial_period_days]"] = "30";
    const session = await stripePost("/checkout/sessions", sessionParams, STRIPE_KEY);

    return json({ url: session.url as string });
  } catch (e) {
    return json({ error: (e as Error).message || "create-checkout-session failed" }, 500);
  }
});
