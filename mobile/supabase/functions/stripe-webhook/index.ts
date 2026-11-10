import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyStripeSignature, priceIdsFromEnv } from "./verify.ts";
import { processStripeEvent, type Db } from "./handler.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Stripe webhook — the billing record of truth. Stripe calls this, NOT
// the app, so there is no caller JWT: verify_jwt must be false for this
// function in supabase/config.toml. Authenticity comes from the
// Stripe-Signature header (HMAC-SHA256 over the raw body), verified
// BEFORE any JSON parse — parsing first would break the signature.
// Secrets live only in Supabase secrets (STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET); nothing secret is in this file.
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only." }, 405);
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
    const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
    if (!WEBHOOK_SECRET) return json({ error: "Webhook secret not configured." }, 500);

    // Raw body FIRST — the signature is computed over these exact bytes.
    const raw = await req.text();
    const signatureOk = await verifyStripeSignature(raw, req.headers.get("Stripe-Signature"), WEBHOOK_SECRET);
    if (!signatureOk) return json({ error: "Invalid signature." }, 400);

    let event: { id: string; type: string; data: { object: Record<string, unknown> } };
    try {
      event = JSON.parse(raw);
    } catch {
      return json({ error: "Invalid JSON." }, 400);
    }
    if (!event?.id || !event?.type) return json({ error: "Invalid event." }, 400);

    const db = createClient(SUPABASE_URL, SERVICE_KEY);
    const svc: Db = {
      getBusiness: async (id) => {
        const { data } = await db.from("businesses").select("id, owner_id").eq("id", id).maybeSingle();
        return data as { id: string; owner_id: string | null } | null;
      },
      getSubscriptionByStripeId: async (sid) => {
        const { data } = await db.from("subscriptions").select("business_id").eq("stripe_subscription_id", sid).maybeSingle();
        return data as { business_id: string } | null;
      },
      getSubscriptionByCustomer: async (cid) => {
        const { data } = await db.from("subscriptions").select("business_id").eq("stripe_customer_id", cid).maybeSingle();
        return data as { business_id: string } | null;
      },
      upsertSubscription: async (row) => {
        const { error } = await db.from("subscriptions").upsert(row, { onConflict: "business_id" });
        if (error) throw error;
      },
      updateSubscriptionByBusiness: async (businessId, patch) => {
        const { error } = await db.from("subscriptions").update(patch).eq("business_id", businessId);
        if (error) throw error;
      },
      insertBillingEvent: async (row) => {
        const { error } = await db.from("billing_events").insert([row]);
        if (error) throw error;
      },
    };

    // Dedupe by Stripe event id: Stripe retries deliveries, and a
    // retried event must not double-apply (or double-log) anything.
    const { data: seen } = await db
      .from("billing_events")
      .select("id")
      .eq("stripe_event_id", event.id)
      .maybeSingle();
    if (seen) return json({ received: true, duplicate: true });

    const fetchSubscription = async (id: string) => {
      if (!STRIPE_KEY) return null;
      const res = await fetch(`https://api.stripe.com/v1/subscriptions/${id}`, {
        headers: { Authorization: `Bearer ${STRIPE_KEY}` },
      });
      if (!res.ok) return null;
      return (await res.json()) as never;
    };

    const result = await processStripeEvent(
      svc,
      event,
      { priceIds: priceIdsFromEnv((k) => Deno.env.get(k)), fetchSubscription },
    );
    return json({ received: true, ...result });
  } catch (e) {
    return json({ error: (e as Error).message || "stripe-webhook failed" }, 500);
  }
});
