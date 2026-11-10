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

// Stripe Billing Portal — plan changes, card updates, and cancellation
// all happen on Stripe's hosted portal, never in our UI. The app only
// shows a "Manage billing" button. Requires a Customer Portal
// configuration in the Stripe dashboard (a default one is created on
// first use there); without it Stripe returns an error here.
// Secrets live only in Supabase secrets (STRIPE_SECRET_KEY).
const APP_URL = "https://app.northshiftapp.com";

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
    if (!token) return json({ error: "Sign in to manage billing." }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !user) return json({ error: "Sign in to manage billing." }, 401);

    const db = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: caller } = await db
      .from("profiles")
      .select("role, business_id")
      .eq("id", user.id)
      .maybeSingle();
    if (!caller || (caller.role !== "manager" && caller.role !== "admin")) {
      return json({ error: "Only managers and admins can manage billing." }, 403);
    }
    if (!caller.business_id) return json({ error: "This account has no business yet." }, 400);

    const { data: sub } = await db
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("business_id", caller.business_id)
      .maybeSingle();
    const customerId = sub?.stripe_customer_id as string | null;
    if (!customerId) return json({ error: "No billing account yet — subscribe first." }, 409);

    const res = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ customer: customerId, return_url: `${APP_URL}/subscription` }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `Stripe portal failed (${res.status})`);

    return json({ url: data.url as string });
  } catch (e) {
    return json({ error: (e as Error).message || "create-portal-session failed" }, 500);
  }
});
