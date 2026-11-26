import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  sendPush,
  STALE_SENDING_MINUTES,
  type Db,
  type PushPreferences,
  type SendPushInput,
} from "./handler.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// send-push — the one sender for every v1 notification. Callers: the
// app (user JWT), hr-ai-bot, the reminder sweep, stripe-webhook
// (service key). verify_jwt stays true (config.toml): the gateway
// validates the JWT either way, and this function then separates the
// two caller kinds — a user JWT resolves to a user, the service key is
// recognised by value. User callers are stamped from the JWT, never
// trusted from the body. Business scope is enforced in handler.ts.
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only." }, 405);
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Sign in to send push." }, 401);
    const isService = token === SERVICE_KEY;
    let callerUserId: string | null = null;
    if (!isService) {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const { data: { user }, error: userErr } = await userClient.auth.getUser(token);
      if (userErr || !user) return json({ error: "Sign in to send push." }, 401);
      callerUserId = user.id;
    }
    let input: SendPushInput;
    try {
      input = await req.json();
    } catch {
      return json({ error: "Invalid JSON." }, 400);
    }
    input.caller_user_id = callerUserId;
    const db = createClient(SUPABASE_URL, SERVICE_KEY);
    const svc: Db = {
      getCaller: async (userId) => {
        const { data } = await db.from("profiles").select("business_id, role").eq("id", userId).maybeSingle();
        return data as { business_id: string | null; role: string | null } | null;
      },
      getRecipientsByRole: async (businessId, role) => {
        const roles = role === "manager" ? ["manager", "admin"] : ["admin"];
        const { data } = await db.from("profiles").select("id").eq("business_id", businessId).in("role", roles);
        return (data || []) as { id: string }[];
      },
      getBusinessId: async (userId) => {
        const { data } = await db.from("profiles").select("business_id").eq("id", userId).maybeSingle();
        return (data as { business_id: string | null } | null)?.business_id || null;
      },
      getPreferences: async (userId) => {
        // If the preference columns do not exist yet (migration not
        // run), the select errors, data is null, and the handler
        // fails open — the ping goes out. Same pattern as the
        // webhook's manual_hold read.
        const { data } = await db
          .from("profiles")
          .select("push_reminders, push_requests, push_billing")
          .eq("id", userId)
          .maybeSingle();
        return data as PushPreferences | null;
      },
      getTokens: async (userId) => {
        const { data } = await db.from("push_tokens").select("id, token").eq("user_id", userId).eq("is_active", true);
        return (data || []) as { id: string; token: string }[];
      },
      findLiveLog: async (recipientId, type, refType, refId) => {
        // 'queued' counts as live: a ping already waiting for morning
        // must not be queued a second time.
        const { data } = await db
          .from("notification_log")
          .select("id, status")
          .eq("recipient_user_id", recipientId)
          .eq("type", type)
          .eq("ref_type", refType)
          .eq("ref_id", refId)
          .in("status", ["sent", "sending", "queued"])
          .maybeSingle();
        return data as { id: string; status: string } | null;
      },
      clearStaleSending: async (recipientId, type, refType, refId) => {
        const cutoff = new Date(Date.now() - STALE_SENDING_MINUTES * 60 * 1000).toISOString();
        await db
          .from("notification_log")
          .update({ status: "failed", error: "Send timed out." })
          .eq("recipient_user_id", recipientId)
          .eq("type", type)
          .eq("ref_type", refType)
          .eq("ref_id", refId)
          .eq("status", "sending")
          .lt("created_at", cutoff);
      },
      insertLog: async (row) => {
        const { data, error } = await db.from("notification_log").insert([row]).select("id").single();
        if (error) return { error: error.message };
        return { id: (data as { id: string }).id };
      },
      updateLog: async (id, patch) => {
        await db.from("notification_log").update(patch).eq("id", id);
      },
      deactivateToken: async (tokenId) => {
        await db.from("push_tokens").update({ is_active: false }).eq("id", tokenId);
      },
      getDueQueued: async (nowIso) => {
        const { data } = await db
          .from("notification_log")
          .select("id, recipient_user_id, business_id, type, ref_type, ref_id, title, body, url")
          .eq("status", "queued")
          .lte("deliver_at", nowIso)
          .order("deliver_at", { ascending: true });
        return (data || []) as {
          id: string;
          recipient_user_id: string;
          business_id: string | null;
          type: string;
          ref_type: string;
          ref_id: string;
          title: string;
          body: string;
          url: string | null;
        }[];
      },
      claimQueued: async (id) => {
        // Claim only if still queued: a second sweep run that already
        // flipped it to 'sending' updates zero rows, and this run
        // must not send the same row twice.
        const { data, error } = await db
          .from("notification_log")
          .update({ status: "sending" })
          .eq("id", id)
          .eq("status", "queued")
          .select("id")
          .maybeSingle();
        return !!data && !error;
      },
    };
    const result = await sendPush(svc, fetch, input);
    return json(result, result.error ? 403 : 200);
  } catch (e) {
    return json({ error: (e as Error).message || "send-push failed" }, 500);
  }
});
