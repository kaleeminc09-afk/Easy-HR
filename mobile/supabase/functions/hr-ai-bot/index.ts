import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ---------- Shared helpers ----------
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// ---------- Manager tools (existing) ----------
const managerTools = [
  {
    type: "function",
    function: {
      name: "get_pending_exceptions",
      description: "Fetches all pending geo-location exception requests.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "bulk_update_exceptions",
      description: "Approves or rejects one or multiple exception requests at the same time.",
      parameters: {
        type: "object",
        properties: {
          exception_ids: { type: "array", items: { type: "string" }, description: "List of exception IDs to update." },
          status: { type: "string", enum: ["approved", "rejected"] },
        },
        required: ["exception_ids", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_time_logs",
      description: "Fetches employee shifts, logs, or discrepancies.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", enum: ["all", "anomalies"], description: "Whether to fetch all logs or just anomalies/discrepancies" }
        },
        required: ["filter"],
      },
    },
  }
];

// ---------- Employee tools (new) ----------
const employeeTools = [
  {
    type: "function",
    function: {
      name: "get_my_shifts",
      description: "Fetches the employee's recent clock-in/out logs and today's total hours. Use for any shift, hours, or pay-period question.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_exception_request",
      description: "Files a geo-fence exception request for the employee. Only call once you know the employee's reason. The employee's current GPS is in your context — pass it through.",
      parameters: {
        type: "object",
        properties: {
          reason_note: { type: "string", description: "Employee's reason for being out of range, e.g. client visit at customer site." },
        },
        required: ["reason_note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "report_blocker",
      description: "Logs a blocker or issue the employee reports (broken equipment, missing access, safety concern) for their manager to review.",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string", description: "Description of the blocker or issue." },
        },
        required: ["note"],
      },
    },
  }
];

const managerSystemPrompt = `You are the Easy HR AI Manager Assistant.

CRITICAL FORMATTING RULES:
1. NEVER display raw UUIDs (e.g., 98c9a23e...) to the user. Keep IDs hidden in your memory.
2. Present data in a clean, professional, bulleted list.
3. Format distances and dates nicely.
4. If a tool returns a direct error message, tell the user exactly what the error string is so they can debug it.

If a manager says "reject all" or "approve all", fetch the exceptions first, then use bulk_update_exceptions.`;

function employeeSystemPrompt(location: any): string {
  const locLine = location?.latitude != null
    ? `Employee's current GPS: ${location.latitude}, ${location.longitude} (captured by the app).`
    : `Employee's GPS was not captured — if they need an exception, ask them to enable location and try again.`;
  return `You are the Easy HR Employee Assistant, a friendly helper for staff members.

${locLine}

CRITICAL FORMATTING RULES:
1. NEVER display raw UUIDs to the user. Keep IDs hidden.
2. Present shift data in a clean, short, bulleted list.
3. Format dates and times nicely (e.g. "Oct 10, 9:02 AM").
4. Keep replies short and conversational — this is a phone chat.

CAPABILITIES:
- Shift/hours questions: use get_my_shifts.
- Geo-fence exception: if they need one, make sure you have their reason first (ask if missing), then call submit_exception_request with the reason. Their GPS is already in your context.
- Blocker/issue report: call report_blocker with what they described, then confirm it is logged for their manager.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { prompt, managerId, userId, role, location } = await req.json();

    const GROQ_API_KEY = Deno.env.get("OPENAI_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Role resolution: explicit role wins, otherwise managerId => manager (backwards compatible)
    const effectiveRole = role || (managerId ? "manager" : "employee");
    const effectiveUserId = managerId || userId;
    const tools = effectiveRole === "manager" ? managerTools : employeeTools;
    const systemPrompt = effectiveRole === "manager" ? managerSystemPrompt : employeeSystemPrompt(location);

    let messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ];

    let iterations = 0;
    while (iterations < 4) {
      iterations++;

      let response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          messages,
          tools,
          tool_choice: "auto",
        }),
      });

      let result = await response.json();
      if (result.error) throw new Error(`Groq API Error: ${result.error.message || JSON.stringify(result.error)}`);

      let choice = result.choices[0].message;

      if (!choice.tool_calls) {
        return new Response(JSON.stringify({ reply: choice.content }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      messages.push(choice);

      for (const toolCall of choice.tool_calls) {
        const fn = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || "{}");
        let output: any = {};

        // ----- Manager handlers (existing) -----
        if (fn === "get_pending_exceptions") {
          // Explicitly targeting the employee foreign key relation to avoid ambiguity
          const { data, error } = await supabase
            .from("time_exceptions")
            .select("id, attempted_at, distance_meters, reason_note, profiles!time_exceptions_user_id_fkey(full_name), worksites(name)")
            .eq("status", "pending");

          if (error) {
            output = { error: error.message };
          } else if (!data || data.length === 0) {
            output = { message: "There are currently 0 pending exceptions." };
          } else {
            output = data.map((item: any) => ({
              exception_id: item.id,
              employee: item.profiles?.full_name || "Unknown",
              worksite: item.worksites?.name || "Unknown",
              distance: `${item.distance_meters} meters`,
              date: item.attempted_at,
              reason: item.reason_note
            }));
          }
        } else if (fn === "bulk_update_exceptions") {
          const { data, error } = await supabase.from("time_exceptions").update({ status: args.status, reviewed_by: managerId }).in("id", args.exception_ids).select();
          output = error ? { error: error.message } : { success: true, updated_count: data?.length || 0 };
        } else if (fn === "get_time_logs") {
          const { data, error } = await supabase
            .from("time_logs")
            .select("id, clock_in, clock_out, ai_anomaly_flag, profiles!time_logs_user_id_fkey(full_name), worksites(name)")
            .order("clock_in", { ascending: false })
            .limit(10);

          if (error) {
            output = { error: error.message };
          } else if (!data || data.length === 0) {
            output = { message: "No time logs found." };
          } else {
            output = data.map((item: any) => ({
              log_id: item.id,
              employee: item.profiles?.full_name || "Unknown",
              worksite: item.worksites?.name || "Unknown",
              clock_in: item.clock_in,
              clock_out: item.clock_out,
              flag: item.ai_anomaly_flag
            }));
          }
        }

        // ----- Employee handlers (new) -----
        else if (fn === "get_my_shifts") {
          const { data, error } = await supabase
            .from("time_logs")
            .select("clock_in, clock_out, ai_anomaly_flag, worksites(name)")
            .eq("user_id", effectiveUserId)
            .order("clock_in", { ascending: false })
            .limit(10);

          if (error) {
            output = { error: error.message };
          } else if (!data || data.length === 0) {
            output = { message: "No shifts found yet." };
          } else {
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            let todayMs = 0;
            const shifts = data.map((item: any) => {
              const s = new Date(item.clock_in).getTime();
              if (s >= todayStart.getTime()) {
                const e = item.clock_out ? new Date(item.clock_out).getTime() : Date.now();
                if (e > s) todayMs += e - s;
              }
              return {
                worksite: item.worksites?.name || "Unknown",
                clock_in: item.clock_in,
                clock_out: item.clock_out,
                flag: item.ai_anomaly_flag,
              };
            });
            output = { today_hours: +(todayMs / 3600000).toFixed(2), shifts };
          }
        } else if (fn === "submit_exception_request") {
          if (location?.latitude == null || location?.longitude == null) {
            output = { error: "No GPS location was attached to this chat. Ask the employee to enable location services and try again." };
          } else {
            const { data: worksites, error: wsError } = await supabase.from("worksites").select("id, name, latitude, longitude, radius_meters");
            if (wsError || !worksites || worksites.length === 0) {
              output = { error: "No worksites are configured yet." };
            } else {
              let nearest: any = null;
              let minDist = Infinity;
              for (const site of worksites) {
                const d = haversineMeters(location.latitude, location.longitude, site.latitude, site.longitude);
                if (d < minDist) { minDist = d; nearest = site; }
              }
              const { error: insError } = await supabase.from("time_exceptions").insert([{
                user_id: effectiveUserId,
                worksite_id: nearest.id,
                latitude: location.latitude,
                longitude: location.longitude,
                distance_meters: Math.round(minDist),
                reason_note: args.reason_note,
                status: "pending",
              }]);
              output = insError
                ? { error: insError.message }
                : { success: true, worksite: nearest.name, distance_meters: Math.round(minDist), status: "pending — sent to your manager for review" };
            }
          }
        } else if (fn === "report_blocker") {
          const { error } = await supabase.from("agent_audit_logs").insert([{
            user_id: effectiveUserId,
            action_type: "blocker_report",
            payload: { note: args.note, reported_at: new Date().toISOString() },
            status: "logged",
          }]);
          output = error ? { error: error.message } : { success: true, message: "Blocker logged for manager review." };
        }

        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: fn,
          content: JSON.stringify(output),
        });
      }
    }

    return new Response(JSON.stringify({ reply: "I processed the tasks, but reached my thought limit before I could summarize." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
