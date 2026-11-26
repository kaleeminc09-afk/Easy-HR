// NorthShift — shift reminder sweep (reminder-sweep). Thin wrapper:
// the schedule lives in config.toml, the logic in handler.ts.
// Service-only: the platform's cron call carries the service key,
// and no user caller may run a sweep for every business.
import { serve } from "https://deno.land/[email protected]/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runSweep } from "./handler.ts";
import type { SweepDb, SendPushCall } from "./handler.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const db = createClient(SUPABASE_URL, SERVICE_KEY);

    // The sweep is a platform cron call. Anything else — a user JWT,
    // the anon key, no key at all — is refused.
    const authHeader = req.headers.get("Authorization") || "";
    if (authHeader !== `Bearer ${SERVICE_KEY}`) {
      return json({ error: "Sweep is service-only." }, 403);
    }

    const input = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const businessId = typeof input.business_id === "string" ? input.business_id : undefined;

    const svc: SweepDb = {
      getBusinesses: async (businessId) => {
        let q = db.from("businesses").select("id, reminder_lead_minutes").order("id", { ascending: true });
        if (businessId) q = q.eq("id", businessId);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        return (data || []) as { id: string; reminder_lead_minutes: number | null }[];
      },
      getDueShifts: async (businessId, windowStartIso, windowEndIso) => {
        const { data, error } = await db
          .from("shifts")
          .select("id, user_id, start_time, worksites(name)")
          .eq("business_id", businessId)
          .eq("status", "assigned")
          .gte("start_time", windowStartIso)
          .lte("start_time", windowEndIso)
          .not("user_id", "is", null)
          .order("start_time", { ascending: true });
        if (error) throw new Error(error.message);
        return (data || []).map((s: any) => ({
          id: s.id,
          user_id: s.user_id,
          worksite_name: s.worksites?.name ?? null,
          start_time: s.start_time,
        }));
      },
      getRemindedShiftIds: async (shiftIds) => {
        if (shiftIds.length === 0) return new Set<string>();
        const { data, error } = await db
          .from("notification_log")
          .select("ref_id")
          .eq("type", "shift_reminder")
          .eq("ref_type", "shift")
          .in("ref_id", shiftIds)
          .in("status", ["sent", "sending", "queued"]);
        if (error) throw new Error(error.message);
        return new Set((data || []).map((r: any) => r.ref_id as string));
      },
    };

    const sendPush: SendPushCall = async (payload) => {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
          method: "POST",
          headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) return { sent: 0, error: `send-push returned ${res.status}.` };
        return (await res.json()) as { sent: number; error?: string };
      } catch {
        return { sent: 0, error: "send-push request failed." };
      }
    };

    const result = await runSweep(svc, sendPush, { business_id: businessId });
    return json(result);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
