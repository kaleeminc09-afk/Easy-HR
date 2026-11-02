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

// Owner onboarding: the first thing a brand-new business owner does.
// Before this existed, signup created a profile with no business and no
// way to make one in the app — a new owner landed on an empty app.
// This function (service role, so it bypasses RLS) creates the business
// and promotes its creator to admin in one call. The caller can NOT pick
// someone else's business: if their profile already has one, they get 409.
// Account numbers mirror the repo's generate_account_number() (NS-XXXXXX)
// but are generated here, so onboarding works even though that DB
// function was never applied to the live database.
function newAccountNumber(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return "NS-" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only." }, 405);
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Sign in to create a business." }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !user) return json({ error: "Sign in to create a business." }, 401);

    const db = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: caller } = await db
      .from("profiles")
      .select("business_id, role")
      .eq("id", user.id)
      .maybeSingle();
    if (!caller) return json({ error: "No profile found for this account." }, 404);
    if (caller.business_id) {
      return json({ error: "This account already has a business." }, 409);
    }

    const body = await req.json().catch(() => ({}));
    const business_name = String(body.business_name || "").trim();
    if (!business_name) return json({ error: "Enter a business name." }, 400);

    // Insert with retries on account-number collision (unique column).
    let business: { id: string; account_number: string } | null = null;
    for (let attempt = 0; attempt < 5 && !business; attempt++) {
      const { data, error } = await db
        .from("businesses")
        .insert([{ business_name, account_number: newAccountNumber(), owner_id: user.id }])
        .select("id, account_number")
        .single();
      if (!error && data) { business = data; break; }
      if (error && (error as { code?: string }).code !== "23505") throw error;
    }
    if (!business) return json({ error: "Could not create the business. Try again." }, 500);

    const { error: profErr } = await db
      .from("profiles")
      .update({ business_id: business.id, role: "admin" })
      .eq("id", user.id);
    if (profErr) {
      // Compensate: don't leave an orphan business behind.
      await db.from("businesses").delete().eq("id", business.id);
      throw profErr;
    }

    return json({ business_id: business.id, business_name, account_number: business.account_number });
  } catch (e) {
    return json({ error: (e as Error).message || "Could not create the business." }, 500);
  }
});
