import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Demo-request lead capture for the marketing site.
//
// The public "Request a demo" form posts here (no caller JWT, so
// verify_jwt must be false for this function in supabase/config.toml).
// The lead is ALWAYS saved first; the notification email is best
// effort and never fails the request. If RESEND_API_KEY is not set,
// the lead is saved and the email is skipped (logged, not errored).
//
// Anti-spam, kept simple: a honeypot field ("website") that humans
// never fill — a filled honeypot gets a fake success and nothing is
// stored — plus a same-email dedup window of one hour so a double
// submit does not spam the inbox.
//
// Secrets live only in Supabase secrets (RESEND_API_KEY); the
// recipient/sender fall back to the support inbox and the
// northshiftapp.com sender when the env overrides are absent.

const ALLOWED_ORIGINS = new Set([
  "https://northshiftapp.com",
  "https://www.northshiftapp.com",
]);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://northshiftapp.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validPhone(raw: string): boolean {
  const digits = raw.replace(/[\s\-().]/g, "");
  return /^\+?\d{7,15}$/.test(digits);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "POST only." }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(req, { error: "Invalid JSON." }, 400);
  }

  // Honeypot: bots fill it, humans never see it. Fake success, store nothing.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return json(req, { ok: true });
  }

  const firstName = typeof body.first_name === "string" ? body.first_name.trim() : "";
  const lastName = typeof body.last_name === "string" ? body.last_name.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const source = typeof body.source === "string" && body.source.trim() !== ""
    ? body.source.trim().slice(0, 50)
    : "website";

  if (!firstName || firstName.length > 100) return json(req, { error: "First name is required." }, 400);
  if (!lastName || lastName.length > 100) return json(req, { error: "Last name is required." }, 400);
  if (!validPhone(phone)) return json(req, { error: "A valid phone number is required." }, 400);
  if (!EMAIL_RE.test(email) || email.length > 254) return json(req, { error: "A valid email address is required." }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Dedup: same email within the last hour — treat as success, store nothing new.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: dup } = await supabase
    .from("demo_requests")
    .select("id")
    .eq("email", email)
    .gt("created_at", oneHourAgo)
    .limit(1);
  if (dup && dup.length > 0) return json(req, { ok: true });

  const { error: insertErr } = await supabase.from("demo_requests").insert({
    first_name: firstName,
    last_name: lastName,
    phone,
    email,
    source,
  });
  if (insertErr) {
    console.error("demo_requests insert failed", insertErr);
    return json(req, { error: "Could not save the request." }, 500);
  }

  // Notification email — best effort, never fails the request.
  try {
    const resendKey = Deno.env.get("RESEND_API_KEY") || "";
    if (!resendKey) {
      console.log("demo request saved; RESEND_API_KEY not set, email skipped");
    } else {
      const to = Deno.env.get("DEMO_REQUEST_TO") || "support@northshiftapp.com";
      const from = Deno.env.get("DEMO_REQUEST_FROM") || "NorthShift Demo <noreply@northshiftapp.com>";
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject: `Demo request — ${firstName} ${lastName}`,
          text: [
            "New demo request from northshiftapp.com",
            "",
            `First name: ${firstName}`,
            `Last name: ${lastName}`,
            `Phone: ${phone}`,
            `Email: ${email}`,
            `Source: ${source}`,
          ].join("\n"),
        }),
      });
      if (!res.ok) console.error("demo request email failed", res.status, await res.text());
    }
  } catch (err) {
    console.error("demo request email error", err);
  }

  return json(req, { ok: true });
});
