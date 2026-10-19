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
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const db = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: shifts, error: sErr } = await db
      .from("time_logs")
      .select("id, user_id, clock_in, profiles!time_logs_user_id_fkey(full_name)")
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
    for (const s of shifts || []) {
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
