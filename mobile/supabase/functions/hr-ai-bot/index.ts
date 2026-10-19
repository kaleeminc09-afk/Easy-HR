import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { computeTodayHours, matchByName, findNearestWorksite, getTeamStatus } from "./logic.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ---------- Manager tools ----------
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
  },
  {
    type: "function",
    function: {
      name: "get_team_status",
      description: "Lists who is currently clocked in (online) and who is on break right now. Use when anyone asks who's working, who's online, who's on break, or for a team status snapshot.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "clock_out_employee",
      description: "Clocks out an employee, ending their active shift right now (also ends any open break). Use when the manager says 'clock out Ahmed' or 'clock them out' — resolve 'them' from the conversation history.",
      parameters: {
        type: "object",
        properties: {
          employee_name: { type: "string", description: "Employee's full or first name." },
        },
        required: ["employee_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assign_task",
      description: "Assigns a task to an employee. Use when the manager says things like 'assign fridge restock to Ahmed' or 'ask Sara to count inventory by Friday'.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short task title, e.g. 'Restock the fridge'." },
          employee_name: { type: "string", description: "Employee's full or first name." },
          description: { type: "string", description: "Extra details for the task." },
          due_date: { type: "string", description: "Due date as YYYY-MM-DD." },
        },
        required: ["title", "employee_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task_status",
      description: "Updates a task's status. Identify the task by a title fragment, optionally narrowed by employee name.",
      parameters: {
        type: "object",
        properties: {
          title_contains: { type: "string", description: "Fragment of the task title to find it." },
          employee_name: { type: "string", description: "Employee name to narrow the search." },
          status: { type: "string", enum: ["pending", "in_progress", "done"] },
        },
        required: ["title_contains", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_tasks",
      description: "Lists tasks, optionally filtered by status or employee name. Use for 'show me pending tasks' or 'what is Ahmed working on'.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "in_progress", "done"] },
          employee_name: { type: "string", description: "Filter by employee name." },
        },
        required: [],
      },
    },
  }
];

// ---------- Employee tools ----------
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
      name: "get_team_status",
      description: "Lists who is currently clocked in (online) and who is on break right now. Use when anyone asks who's working, who's online, who's on break, or for a team status snapshot.",
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

const managerSystemPrompt = `You are the NorthShift AI Manager Assistant.

CRITICAL FORMATTING RULES:
1. NEVER display raw UUIDs (e.g., 98c9a23e...) to the user. Keep IDs hidden in your memory.
2. NEVER use markdown — no **bold**, no *italics*, no # headers. This chat shows plain text, so asterisks look broken. Write naturally.
3. For lists, use a simple dash (-) at the start of each line, or just write it as a sentence.
4. Format distances and dates nicely (e.g. "Oct 11, 4:37 PM", "120m away").
5. If a tool returns a direct error message, tell the user exactly what the error string is so they can debug it.

TONE — TALK LIKE A PERSON, NOT A FORM:
- Short, warm, conversational. This is a phone chat, not a report.
- Vary your phrasing — never open every reply the same way ("Sure!", "Certainly!").
- Answer directly, then stop. Don't narrate what you're doing ("Let me check that...") and don't pad with filler.
- When you do something (clock someone out, assign a task), confirm it in one natural sentence: who + what happened.
- Match the user's energy: quick question gets a quick answer.

If a manager says "reject all" or "approve all", fetch the exceptions first, then use bulk_update_exceptions.

CONVERSATION MEMORY:
- You receive the recent conversation history with every request. USE IT.
- Resolve pronouns ("them", "him", "her", "they") and bare names against people mentioned earlier in this conversation. If the user just asked about working employees and then says "clock them out", "them" means those employees — do not ask who they mean.
- If a follow-up message is just a name, treat it as the answer to your last question and continue the task.

CLOCK OUT:
- "clock out Ahmed" or "clock them out" (resolve "them" from history) → clock_out_employee. Confirm who was clocked out in one natural sentence.

TEAM STATUS:
- "who's working", "who's online", "who's on break" → get_team_status. Answer as one short list, no extra commentary.

TASK DELEGATION:
- You can assign tasks ("assign fridge restock to Ahmed due Friday"), list them ("show pending tasks", "what is Ahmed working on"), and update them ("mark the fridge task done").
- When assigning, if the employee name is ambiguous or you cannot find them, ask the manager to clarify before creating the task.
- Confirm each delegation back in one short sentence: who, what, and due date if given.`;

function employeeSystemPrompt(location: any): string {
  const locLine = location?.latitude != null
    ? `Employee's current GPS: ${location.latitude}, ${location.longitude} (captured by the app).`
    : `Employee's GPS was not captured — if they need an exception, ask them to enable location and try again.`;
  return `You are the NorthShift Employee Assistant, a friendly helper for staff members.

${locLine}

CRITICAL FORMATTING RULES:
1. NEVER display raw UUIDs to the user. Keep IDs hidden.
2. NEVER use markdown — no **bold**, no *italics*. This chat shows plain text, so asterisks look broken. Write naturally.
3. Present shift data in a clean, short list — a dash (-) per line, or a plain sentence.
4. Format dates and times nicely (e.g. "Oct 10, 9:02 AM").

TONE — TALK LIKE A PERSON:
- Short, warm, conversational. Vary your phrasing; don't open every reply the same way.
- Answer directly, then stop. No filler, no narrating what you're doing.
- When you file something (exception, blocker), confirm it in one natural sentence.

CAPABILITIES:
- Shift/hours questions: use get_my_shifts.
- Team status: if they ask who's online, who's working, or who's on break, use get_team_status.
- Geo-fence exception: if they need one, make sure you have their reason first (ask if missing), then call submit_exception_request with the reason. Their GPS is already in your context.
- Blocker/issue report: call report_blocker with what they described, then confirm it is logged for their manager.

CONVERSATION MEMORY:
- You receive the recent conversation history with every request. USE IT.
- Resolve pronouns and short follow-ups ("yes", "him", a bare name) against what was just discussed instead of asking the user to repeat themselves.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { prompt, managerId, userId, role, location, history } = await req.json();

    // Sanitize client-supplied history: user/assistant roles only, text only, last 20.
    const cleanHistory = Array.isArray(history)
      ? history
          .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .slice(-20)
          .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
      : [];

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
      ...cleanHistory,
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

        // ----- Manager handlers -----
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
        } else if (fn === "get_team_status") {
          const { data: shifts, error: sErr } = await supabase
            .from("time_logs")
            .select("id, user_id, clock_in, profiles!time_logs_user_id_fkey(full_name)")
            .is("clock_out", null);
          if (sErr) {
            output = { error: sErr.message };
          } else {
            const { data: brks } = await supabase
              .from("time_breaks")
              .select("time_log_id")
              .is("end_time", null);
            const status = getTeamStatus(
              (shifts || []).map((s: any) => ({
                log_id: s.id,
                user_id: s.user_id,
                full_name: s.profiles?.full_name || "Unknown",
                clock_in: s.clock_in,
              })),
              new Set((brks || []).map((b: any) => b.time_log_id)),
            );
            output = status.online.length === 0 && status.on_break.length === 0
              ? { message: "Nobody is clocked in right now." }
              : {
                  online_count: status.online.length,
                  on_break_count: status.on_break.length,
                  online: status.online,
                  on_break: status.on_break,
                };
          }
        } else if (fn === "clock_out_employee") {
          const { data: profs, error: pErr } = await supabase
            .from("profiles")
            .select("id, full_name")
            .ilike("full_name", `%${args.employee_name}%`)
            .limit(5);

          if (pErr) {
            output = { error: pErr.message };
          } else {
            const match = matchByName(profs || [], (p: any) => p.full_name || "", args.employee_name);
            if (match.kind === "none") {
              output = { error: `No employee found matching "${args.employee_name}". Ask the manager for the exact name.` };
            } else if (match.kind === "many") {
              output = { error: `Multiple employees match "${args.employee_name}": ${match.values.map((p: any) => p.full_name).join(", ")}. Ask the manager which one.` };
            } else {
              const { data: shifts } = await supabase.from("time_logs")
                .select("id").eq("user_id", match.value.id).is("clock_out", null)
                .order("clock_in", { ascending: false }).limit(1);
              if (!shifts || shifts.length === 0) {
                output = { error: `${match.value.full_name} has no active shift to clock out from.` };
              } else {
                const nowTs = new Date().toISOString();
                await supabase.from("time_breaks").update({ end_time: nowTs }).eq("time_log_id", shifts[0].id).is("end_time", null);
                const { error: coErr } = await supabase.from("time_logs").update({ clock_out: nowTs }).eq("id", shifts[0].id);
                output = coErr
                  ? { error: coErr.message }
                  : { success: true, clocked_out: match.value.full_name, at: nowTs };
              }
            }
          }
        } else if (fn === "assign_task") {
          const { data: profs, error: pErr } = await supabase
            .from("profiles")
            .select("id, full_name")
            .ilike("full_name", `%${args.employee_name}%`)
            .limit(5);

          if (pErr) {
            output = { error: pErr.message };
          } else {
            const match = matchByName(profs || [], (p: any) => p.full_name || "", args.employee_name);
            if (match.kind === "none") {
              output = { error: `No employee found matching "${args.employee_name}". Ask the manager for the exact name.` };
            } else if (match.kind === "many") {
              output = { error: `Multiple employees match "${args.employee_name}": ${match.values.map((p: any) => p.full_name).join(", ")}. Ask the manager which one.` };
            } else {
              const { error: insErr } = await supabase.from("tasks").insert([{
                title: args.title,
                description: args.description || null,
                assigned_to: match.value.id,
                assigned_by: managerId,
                due_date: args.due_date || null,
                status: "pending",
              }]);
              output = insErr
                ? { error: insErr.message }
                : { success: true, task: args.title, assigned_to: match.value.full_name, due_date: args.due_date || "no due date", status: "pending" };
            }
          }
        } else if (fn === "update_task_status") {
          const { data, error } = await supabase
            .from("tasks")
            .select("id, title, status, profiles!tasks_assigned_to_fkey(full_name)")
            .ilike("title", `%${args.title_contains}%`);

          if (error) {
            output = { error: error.message };
          } else {
            let candidates = data || [];
            if (args.employee_name) {
              const m = matchByName(candidates, (t: any) => t.profiles?.full_name || "", args.employee_name);
              candidates = m.kind === "one" ? [m.value] : m.kind === "many" ? m.values : [];
            }
            if (candidates.length === 0) {
              output = { error: `No task found matching "${args.title_contains}".` };
            } else if (candidates.length > 1) {
              output = { error: `Multiple tasks match: ${candidates.map((t: any) => `"${t.title}" (${t.profiles?.full_name || "unassigned"})`).join(", ")}. Ask which one.` };
            } else {
              const { error: updErr } = await supabase.from("tasks").update({ status: args.status, updated_at: new Date().toISOString() }).eq("id", candidates[0].id);
              output = updErr
                ? { error: updErr.message }
                : { success: true, task: candidates[0].title, new_status: args.status };
            }
          }
        } else if (fn === "get_tasks") {
          let query = supabase
            .from("tasks")
            .select("title, description, status, due_date, profiles!tasks_assigned_to_fkey(full_name)")
            .order("created_at", { ascending: false })
            .limit(20);
          if (args.status) query = query.eq("status", args.status);
          const { data, error } = await query;

          if (error) {
            output = { error: error.message };
          } else {
            let rows = data || [];
            if (args.employee_name) {
              const m = matchByName(rows, (t: any) => t.profiles?.full_name || "", args.employee_name);
              rows = m.kind === "one" ? [m.value] : m.kind === "many" ? m.values : [];
            }
            output = rows.length === 0
              ? { message: "No tasks found." }
              : rows.map((t: any) => ({
                  title: t.title,
                  assigned_to: t.profiles?.full_name || "Unassigned",
                  status: t.status,
                  due_date: t.due_date,
                  description: t.description,
                }));
          }
        }

        // ----- Employee handlers -----
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
            const shifts = data.map((item: any) => ({
              worksite: item.worksites?.name || "Unknown",
              clock_in: item.clock_in,
              clock_out: item.clock_out,
              flag: item.ai_anomaly_flag,
            }));
            output = { today_hours: computeTodayHours(data, Date.now()), shifts };
          }
        } else if (fn === "submit_exception_request") {
          if (location?.latitude == null || location?.longitude == null) {
            output = { error: "No GPS location was attached to this chat. Ask the employee to enable location services and try again." };
          } else {
            const { data: worksites, error: wsError } = await supabase.from("worksites").select("id, name, latitude, longitude, radius_meters");
            if (wsError || !worksites || worksites.length === 0) {
              output = { error: "No worksites are configured yet." };
            } else {
              const nearest = findNearestWorksite(worksites, location.latitude, location.longitude)!;
              const { error: insError } = await supabase.from("time_exceptions").insert([{
                user_id: effectiveUserId,
                worksite_id: nearest.site.id,
                latitude: location.latitude,
                longitude: location.longitude,
                distance_meters: nearest.distanceMeters,
                reason_note: args.reason_note,
                status: "pending",
              }]);
              output = insError
                ? { error: insError.message }
                : { success: true, worksite: nearest.site.name, distance_meters: nearest.distanceMeters, status: "pending — sent to your manager for review" };
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
