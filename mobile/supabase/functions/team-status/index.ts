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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Audit item 6 fix: this function used to answer anyone holding the
    // publishable anon key — no signed-in user, no role, no business.
    // Now it requires a real user session. It is deliberately NOT
    // manager-only: the Team board is linked from both the employee home
    // and the Manager Portal, and the brain answers employees about team
    // status too, so employees keep the board — scoped to their own
    // business, which is what actually closes the leak.
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Sign in to see team status." }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !user) return json({ error: "Sign in to see team status." }, 401);

    const db = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: caller } = await db
      .from("profiles")
      .select("role, business_id")
      .eq("id", user.id)
      .maybeSingle();
    if (!caller) return json({ error: "Could not load your profile." }, 403);

    const { data: shifts, error: sErr } = await db
      .from("time_logs")
      .select("id, user_id, clock_in, profiles!time_logs_user_id_fkey(full_name, business_id)")
      .is("clock_out", null);
    if (sErr) return json({ error: sErr.message }, 500);

    const { data: brks } = await db
      .from("time_breaks")
      .select("time_log_id")
      .is("end_time", null);

    // A break row whose shift is already closed matches no open shift id,
    // so stale break rows are ignored by construction.
    const onBreakIds = new Set((brks || []).map((b: any) => b.time_log_id));
    const online: Array<{ name: string; since: string }> = [];
    const on_break: Array<{ name: string; since: string }> = [];
    // Same-business scope (single-tenant model): a caller with a business
    // sees only teammates in that business. A caller with no business
    // link is a legacy profile — no filter, same as before, but still
    // only after the signed-in check above.
    const visible = (shifts || []).filter((s: any) =>
      !caller.business_id || s.profiles?.business_id === caller.business_id);
    for (const s of visible) {
      const member = {
        name: (s.profiles?.full_name || "").trim() || "Unknown",
        since: s.clock_in,
      };
      (onBreakIds.has(s.id) ? on_break : online).push(member);
    }
    return json({
      online,
      on_break,
      online_count: online.length,
      on_break_count: on_break.length,
    });
  } catch (e) {
    return json({ error: e.message || "team-status failed" }, 500);
  }
});
