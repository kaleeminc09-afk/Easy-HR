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

// Invite-link onboarding: a manager or admin invites a new employee by
// email. Supabase sends the invite email; the link opens the app
// (northshift://invite) and signs the employee in, and they set their password
// on the Profile screen. The service-role key never leaves this function,
// and the caller can NOT choose the invitee's role or business: every
// invite lands as an employee in the inviter's own business, which matches
// the single-business-per-workspace model.
//
// Deno.serve is the built-in entry point. The std `serve` import
// (deno.land/std@0.177.0) is no longer supported by Supabase's bundler —
// it fails the deploy with "Cannot import from deno.com". The Brain
// (hr-ai-bot) already runs on Deno.serve.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only." }, 405);
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Sign in to send invites." }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !user) return json({ error: "Sign in to send invites." }, 401);

    const db = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: caller } = await db
      .from("profiles")
      .select("role, business_id")
      .eq("id", user.id)
      .maybeSingle();
    if (!caller || (caller.role !== "manager" && caller.role !== "admin")) {
      return json({ error: "Only managers and admins can invite employees." }, 403);
    }

    // Billing gate (build #7): the service-role client bypasses RLS, and
    // invites have no DB gate at all — nothing stops a locked business
    // from inviting today. Check the same gate the DB uses for
    // shifts/worksites, before the invite is created (an invite cannot be
    // cleanly undone once the auth user + email exist). A manager with no
    // business yet cannot invite — there is no business to join.
    if (!caller.business_id) {
      return json({ error: "Set up your business first, then invite your team." }, 403);
    }
    const { data: allowed, error: gateErr } = await db.rpc("billing_write_allowed", { p_business_id: caller.business_id });
    if (gateErr) {
      return json({ error: "Couldn't check your subscription right now. Please try again." }, 500);
    }
    if (allowed !== true) {
      return json({ error: "Your trial ended — subscribe to invite more staff." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const first_name = String(body.first_name || "").trim();
    const last_name = String(body.last_name || "").trim();
    if (!/.+@.+\..+/.test(email)) return json({ error: "Enter a valid email to invite." }, 400);
    const full_name = `${first_name} ${last_name}`.trim() || email.split("@")[0];

    // Admin invite: creates the auth user and sends Supabase's invite
    // email. redirectTo must be listed in the dashboard's Redirect URLs.
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: invited, error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name, first_name, last_name, role: "employee" },
      redirectTo: "northshift://invite",
    });
    if (invErr) {
      const msg = invErr.message || "Invite failed.";
      if (/already|exists/i.test(msg)) {
        return json({ error: "That email already has an account. Ask them to sign in instead." }, 409);
      }
      return json({ error: msg }, 500);
    }
    if (!invited?.user?.id) return json({ error: "Invite failed: no user was created." }, 500);

    // Link the new profile to the inviter's business (the signup trigger
    // already created the row as employee; this only adds the business).
    const row: Record<string, unknown> = {
      id: invited.user.id,
      email,
      first_name: first_name || null,
      last_name: last_name || null,
      full_name,
    };
    if (caller.business_id) row.business_id = caller.business_id;
    const { error: upErr } = await db.from("profiles").upsert(row, { onConflict: "id" });
    if (upErr) return json({ error: upErr.message }, 500);

    return json({ ok: true, email, user_id: invited.user.id });
  } catch (e) {
    return json({ error: (e as Error).message || "invite-employee failed" }, 500);
  }
});
