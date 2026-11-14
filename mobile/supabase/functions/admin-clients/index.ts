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

// CRM backoffice: client list + detail (Phase 1/2), write actions
// (Phase 3: notes/outreach, manual subscription activation, leads).
//
// The ONLY cross-business read/write path in the system. The caller
// must be signed in (verify_jwt = true) AND their email must be on the
// CRM_ADMIN_EMAILS allowlist (comma-separated Supabase secret). The
// check is server-side: hiding the UI is never the security boundary.
// Fails closed — an unset or empty allowlist authorizes nobody.
//
// Reads/writes use the service-role client (RLS never applies to it),
// so the CRM tables and the activity log keep zero app-role policies.
// Every Phase 3 write also lands in admin_audit.
//
// Manual subscriptions: activate_subscription sets manual_hold on the
// subscriptions row. The stripe-webhook never overwrites a held row;
// only a real Stripe checkout clears the hold (see handler.ts).
// A live Stripe subscription is never touched from here — it is
// managed in the Stripe dashboard, and these actions refuse to.
//
// Speed: every independent fetch runs in parallel (Promise.all). The
// first version ran them one after another and the list took far too
// long to load; sequential fetches are the thing not to reintroduce.

const PLAN_LIMITS: Record<string, number> = { starter: 5, growth: 15, business: 40 };
const INTERACTION_KINDS = ["note", "call", "email", "meeting"];

type Profile = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  role: string | null;
  business_id: string | null;
};

function displayName(p: Profile): string {
  const joined = [p.first_name, p.last_name].filter(Boolean).join(" ");
  return p.full_name || joined || p.email || "Unknown";
}

// Last sign-in per user, from the Auth admin API (paginated, capped
// at 1,000 users — far above current scale; revisit if it binds).
async function loadLastSeen(db: ReturnType<typeof createClient>): Promise<Map<string, string | null>> {
  const lastSeen = new Map<string, string | null>();
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 100 });
    const users = (data as { users?: Array<{ id: string; last_sign_in_at?: string | null }> } | null)?.users || [];
    if (error || users.length === 0) break;
    for (const u of users) lastSeen.set(u.id, u.last_sign_in_at ?? null);
    if (users.length < 100) break;
  }
  return lastSeen;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only." }, 405);
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Sign in to use the backoffice." }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !user) return json({ error: "Sign in to use the backoffice." }, 401);

    const adminEmails = (Deno.env.get("CRM_ADMIN_EMAILS") || "")
      .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!adminEmails.includes((user.email || "").toLowerCase())) {
      return json({ error: "Not authorized." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const db = createClient(SUPABASE_URL, SERVICE_KEY);

    // Audit trail for Phase 3 writes. Best-effort: a failed audit
    // insert never blocks the action itself, but it is logged.
    const writeAudit = async (auditAction: string, targetBusinessId: string | null, detail: Record<string, unknown>) => {
      const { error } = await db.from("admin_audit").insert([{
        actor_id: user.id, action: auditAction,
        target_business_id: targetBusinessId, detail,
      }]);
      if (error) console.error("admin_audit insert failed:", error.message);
    };
    const isStripeManaged = (sub: Record<string, unknown> | undefined) =>
      !!sub && !!sub.stripe_subscription_id && (sub.status === "active" || sub.status === "trialing") && sub.manual_hold !== true;

    // All independent reads in parallel — never sequential.
    const [bizRes, profRes, subRes, lastSeen] = await Promise.all([
      db.from("businesses").select("id, account_number, business_name, owner_id, created_at").order("created_at", { ascending: true }),
      db.from("profiles").select("id, first_name, last_name, full_name, email, phone, role, business_id"),
      db.from("subscriptions").select("business_id, plan, status, employee_limit, trial_end, current_period_end, stripe_customer_id, stripe_subscription_id, cancel_at_period_end, manual_hold, manual_note"),
      loadLastSeen(db),
    ]);
    const businesses = bizRes.data;
    const profiles = profRes.data;
    const subs = subRes.data;

    const bizList = businesses || [];
    const profList = (profiles || []) as Profile[];
    const subByBiz = new Map((subs || []).map((s: Record<string, unknown>) => [s.business_id as string, s]));
    const profById = new Map(profList.map((p) => [p.id, p]));
    const profsByBiz = new Map<string, Profile[]>();
    for (const p of profList) {
      if (!p.business_id) continue;
      const arr = profsByBiz.get(p.business_id) || [];
      arr.push(p);
      profsByBiz.set(p.business_id, arr);
    }

    if (action === "list") {
      // Recent activity, attributed per business (events with a NULL
      // business_id resolve through the actor's profile).
      const { data: events } = await db
        .from("activity_events")
        .select("business_id, user_id, event, created_at")
        .order("created_at", { ascending: false })
        .limit(1000);
      const lastActivity = new Map<string, string>();
      const events30d = new Map<string, number>();
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      for (const e of events || []) {
        const bizId = (e as { business_id: string | null }).business_id
          || profById.get((e as { user_id: string }).user_id)?.business_id
          || null;
        if (!bizId) continue;
        if (!lastActivity.has(bizId)) lastActivity.set(bizId, (e as { created_at: string }).created_at);
        if (new Date((e as { created_at: string }).created_at).getTime() >= cutoff) {
          events30d.set(bizId, (events30d.get(bizId) || 0) + 1);
        }
      }

      const q = String(body.search || "").trim().toLowerCase();
      const items = bizList.map((b: Record<string, unknown>) => {
        const id = b.id as string;
        const members = profsByBiz.get(id) || [];
        const owner = b.owner_id ? profById.get(b.owner_id as string) : undefined;
        const sub = subByBiz.get(id);
        let lastSignIn: string | null = null;
        for (const m of members) {
          const seen = lastSeen.get(m.id);
          if (seen && (!lastSignIn || seen > lastSignIn)) lastSignIn = seen;
        }
        return {
          id,
          account_number: b.account_number,
          business_name: b.business_name,
          created_at: b.created_at,
          owner: owner ? { name: displayName(owner), email: owner.email } : null,
          members: members.length,
          plan: sub?.plan ?? null,
          status: sub?.status ?? null,
          manual_hold: sub?.manual_hold === true,
          trial_end: sub?.trial_end ?? null,
          current_period_end: sub?.current_period_end ?? null,
          last_sign_in_at: lastSignIn,
          last_activity_at: lastActivity.get(id) || null,
          events_30d: events30d.get(id) || 0,
        };
      });
      if (!q) return json({ clients: items });
      const filtered = items.filter((it) => {
        const members = profsByBiz.get(it.id) || [];
        const hay = [it.business_name, it.account_number,
          ...members.map((m) => `${displayName(m)} ${m.email || ""}`)]
          .join(" ").toLowerCase();
        return hay.includes(q);
      });
      return json({ clients: filtered });
    }

    if (action === "detail") {
      const businessId = String(body.business_id || "");
      const biz = bizList.find((b: Record<string, unknown>) => b.id === businessId);
      if (!biz) return json({ error: "Business not found." }, 404);
      const members = profsByBiz.get(businessId) || [];
      const memberIds = members.map((m) => m.id);
      const sub = subByBiz.get(businessId) || null;

      // Footprint from tables that already exist (no new logging needed).
      // All counts in parallel, including the member-scoped time_logs.
      const countEq = async (table: string, col: string, val: string) => {
        const { count } = await db.from(table).select("*", { count: "exact", head: true }).eq(col, val);
        return count ?? 0;
      };
      const countIn = async (table: string, col: string, vals: string[]) => {
        if (vals.length === 0) return 0;
        const { count } = await db.from(table).select("*", { count: "exact", head: true }).in(col, vals);
        return count ?? 0;
      };
      const [shifts, expenses, documents, timeOff, timeLogs] = await Promise.all([
        countEq("shifts", "business_id", businessId),
        countEq("expenses", "business_id", businessId),
        countEq("documents", "business_id", businessId),
        countEq("time_off_requests", "business_id", businessId),
        countIn("time_logs", "user_id", memberIds),
      ]);

      // Activity log: recent events + counts (bounded fetch, small scale).
      // Runs in parallel with the interactions and audit reads.
      const [eventsRes, interactionsRes, auditRes] = await Promise.all([
        db.from("activity_events")
          .select("id, user_id, event, meta, created_at")
          .or(`business_id.eq.${businessId},user_id.in.(${memberIds.join(",") || "00000000-0000-0000-0000-000000000000"})`)
          .order("created_at", { ascending: false })
          .limit(2000),
        db.from("crm_interactions")
          .select("id, author_id, kind, body, created_at")
          .eq("business_id", businessId)
          .order("created_at", { ascending: false })
          .limit(50),
        db.from("admin_audit")
          .select("id, actor_id, action, detail, created_at")
          .eq("target_business_id", businessId)
          .order("created_at", { ascending: false })
          .limit(20),
      ]);
      const events = eventsRes.data;
      const interactions = interactionsRes.data;
      const audit = auditRes.data;
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const counts: Record<string, number> = {};
      const counts30d: Record<string, number> = {};
      for (const e of events || []) {
        const ev = (e as { event: string }).event;
        counts[ev] = (counts[ev] || 0) + 1;
        if (new Date((e as { created_at: string }).created_at).getTime() >= cutoff) {
          counts30d[ev] = (counts30d[ev] || 0) + 1;
        }
      }
      const recent = (events || []).slice(0, 50).map((e: Record<string, unknown>) => ({
        id: e.id,
        event: e.event,
        created_at: e.created_at,
        user: profById.get(e.user_id as string) ? displayName(profById.get(e.user_id as string)!) : null,
      }));

      return json({
        business: {
          id: biz.id,
          account_number: biz.account_number,
          business_name: biz.business_name,
          created_at: biz.created_at,
        },
        contacts: members.map((m) => ({
          id: m.id,
          name: displayName(m),
          email: m.email,
          phone: m.phone,
          role: m.role,
          last_sign_in_at: lastSeen.get(m.id) ?? null,
        })),
        subscription: sub,
        footprint: { shifts, time_logs: timeLogs, expenses, documents, time_off_requests: timeOff },
        activity: { counts, counts_30d: counts30d, recent },
        interactions: (interactions || []).map((i: Record<string, unknown>) => ({
          id: i.id,
          kind: i.kind,
          body: i.body,
          created_at: i.created_at,
          author: i.author_id && profById.get(i.author_id as string)
            ? displayName(profById.get(i.author_id as string)!)
            : null,
        })),
        audit: (audit || []).map((a: Record<string, unknown>) => ({
          id: a.id,
          action: a.action,
          detail: a.detail,
          created_at: a.created_at,
          actor: a.actor_id && profById.get(a.actor_id as string)
            ? displayName(profById.get(a.actor_id as string)!)
            : null,
        })),
      });
    }

    if (action === "add_interaction") {
      const businessId = String(body.business_id || "");
      const kind = String(body.kind || "");
      const text = String(body.body || "").trim();
      if (!bizList.find((b: Record<string, unknown>) => b.id === businessId)) {
        return json({ error: "Business not found." }, 404);
      }
      if (!INTERACTION_KINDS.includes(kind)) return json({ error: "Kind must be note, call, email, or meeting." }, 400);
      if (text.length < 1 || text.length > 4000) return json({ error: "Write something (1–4000 characters)." }, 400);
      const { error } = await db.from("crm_interactions").insert([{
        business_id: businessId, author_id: user.id, kind, body: text,
      }]);
      if (error) return json({ error: "Could not save the note." }, 500);
      await writeAudit("crm_interaction_add", businessId, { kind });
      return json({ ok: true });
    }

    if (action === "activate_subscription") {
      const businessId = String(body.business_id || "");
      const biz = bizList.find((b: Record<string, unknown>) => b.id === businessId);
      if (!biz) return json({ error: "Business not found." }, 404);
      const plan = String(body.plan || "");
      const note = String(body.note || "").trim().slice(0, 500);
      const trialEnd = new Date(String(body.trial_end || ""));
      if (!PLAN_LIMITS[plan]) return json({ error: "Plan must be starter, growth, or business." }, 400);
      if (isNaN(trialEnd.getTime())) return json({ error: "Pick a valid end date." }, 400);
      if (trialEnd.getTime() <= Date.now()) return json({ error: "End date must be in the future." }, 400);
      const existing = subByBiz.get(businessId);
      if (isStripeManaged(existing)) {
        return json({ error: "This subscription is managed by Stripe — change it in the Stripe dashboard, not here." }, 409);
      }
      const nowIso = new Date().toISOString();
      const { error } = await db.from("subscriptions").upsert([{
        business_id: businessId,
        owner_id: biz.owner_id ?? null,
        plan,
        status: "trialing",
        employee_limit: PLAN_LIMITS[plan],
        trial_start: nowIso,
        trial_end: trialEnd.toISOString(),
        current_period_start: null,
        current_period_end: null,
        cancel_at_period_end: false,
        stripe_subscription_id: null,
        grace_until: null,
        manual_hold: true,
        manual_note: note || null,
        updated_at: nowIso,
      }], { onConflict: "business_id" });
      if (error) return json({ error: "Could not activate the subscription." }, 500);
      await writeAudit("subscription_activate_manual", businessId, { plan, trial_end: trialEnd.toISOString(), note: note || null });
      return json({ ok: true });
    }

    if (action === "deactivate_subscription") {
      const businessId = String(body.business_id || "");
      if (!bizList.find((b: Record<string, unknown>) => b.id === businessId)) {
        return json({ error: "Business not found." }, 404);
      }
      const existing = subByBiz.get(businessId);
      if (isStripeManaged(existing)) {
        return json({ error: "This subscription is managed by Stripe — cancel it in the Stripe dashboard, not here." }, 409);
      }
      if (!existing) return json({ error: "No subscription to end." }, 400);
      const nowIso = new Date().toISOString();
      const { error } = await db.from("subscriptions")
        .update({ status: "canceled", current_period_end: nowIso, updated_at: nowIso })
        .eq("business_id", businessId);
      if (error) return json({ error: "Could not end the subscription." }, 500);
      await writeAudit("subscription_deactivate_manual", businessId, { plan: existing.plan ?? null });
      return json({ ok: true });
    }

    if (action === "list_leads") {
      const { data: leads, error } = await db.from("demo_requests")
        .select("id, first_name, last_name, phone, email, source, contacted_at, notes, created_at")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) return json({ error: "Could not load leads." }, 500);
      return json({ leads: leads || [] });
    }

    if (action === "mark_contacted") {
      const leadId = String(body.lead_id || "");
      const contacted = body.contacted === true;
      const { data: lead, error: findErr } = await db.from("demo_requests")
        .select("id, email").eq("id", leadId).maybeSingle();
      if (findErr || !lead) return json({ error: "Lead not found." }, 404);
      const { error } = await db.from("demo_requests")
        .update({ contacted_at: contacted ? new Date().toISOString() : null })
        .eq("id", leadId);
      if (error) return json({ error: "Could not update the lead." }, 500);
      await writeAudit(contacted ? "lead_contacted" : "lead_unmarked", null, { lead_id: leadId, email: (lead as { email: string }).email });
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || "Backoffice request failed." }, 500);
  }
});
