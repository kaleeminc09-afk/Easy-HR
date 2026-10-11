// Deletes the calling user's own account. Called from the Profile screen's
// "Delete My Account" flow. Apple requires in-app account deletion for apps
// with account creation (guideline 5.1.1).
//
// Uses the service-role key, so it bypasses RLS. The caller's identity is
// derived server-side from the Bearer JWT — never trust a client-supplied id.
//
// Deploy: supabase functions deploy delete-my-account
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  try {
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!jwt) return json({ error: "Missing authorization" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser(jwt);
    if (userError || !user) return json({ error: "Unauthorized" }, 401);

    // Remove the profile row first (in case the FK has no ON DELETE CASCADE).
    await supabase.from("profiles").delete().eq("id", user.id);

    const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id);
    if (deleteError) throw deleteError;

    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: e.message || "Delete failed" }, 500);
  }
});
