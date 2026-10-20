import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { computeTodayHours, matchByName, findNearestWorksite, getTeamStatus, computeWeeklyOvertime, findMealBreakViolations, weekStartMs } from "./logic.ts";

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
  },
  {
    type: "function",
    function: {
      name: "get_schedule",
      description: "Lists scheduled shifts (the rota) for today, this week, or next week. Use for 'who's scheduled', 'what shifts are on Saturday', 'the rota this week'. Optionally filter to one employee.",
      parameters: {
        type: "object",
        properties: {
          range: { type: "string", enum: ["today", "this_week", "next_week"] },
          employee_name: { type: "string", description: "Limit to one employee." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_open_shifts",
      description: "Lists open (unassigned) shifts and, for managers, shifts with a pending claim. Use for 'any open shifts', 'shifts nobody has taken', 'pending claims'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_overtime_status",
      description: "Shows every team member's hours this week (Mon-Sun) with Ontario overtime status: approaching at 40h, in overtime past 44h. Use for 'who's close to overtime', 'overtime this week'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_break_violations",
      description: "Lists shifts from the last 14 days that broke the Ontario meal-break rule (more than 5 hours worked without a 30-minute eating period). Use for 'any break violations', 'meal break compliance'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_employee_profile",
      description: "Looks up an employee's profile: job title, department, start date, employment type, employee number, primary worksite, phone, and emergency contacts. Use for 'what's Asha's job title', 'who is the emergency contact for Ben'. Never includes home address or date of birth.",
      parameters: {
        type: "object",
        properties: {
          employee_name: { type: "string", description: "Employee's full or first name." },
        },
        required: ["employee_name"],
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
  },
  {
    type: "function",
    function: {
      name: "get_schedule",
      description: "Lists the employee's own scheduled shifts (the rota) for today, this week, or next week. Use for 'my shifts this week', 'am I working Saturday', 'when is my next shift'.",
      parameters: {
        type: "object",
        properties: {
          range: { type: "string", enum: ["today", "this_week", "next_week"] },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_open_shifts",
      description: "Lists open (unassigned) shifts the employee could claim in the Schedule tab. Use for 'any open shifts', 'extra shifts I can pick up'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_profile",
      description: "Shows the employee's own profile: job title, department, start date, employment type, primary worksite, phone, emergency contacts, and anything important that is missing. Use for 'my job title', 'who is my emergency contact', 'is my profile complete'.",
      parameters: { type: "object", properties: {}, required: [] },
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
- Confirm each delegation back in one short sentence: who, what, and due date if given.

SCHEDULE:
- Rota questions ("who's scheduled Saturday", "shifts this week") → get_schedule; pick the range from the wording (today / this_week / next_week).
- Open shifts and pending claims → get_open_shifts. You cannot approve or deny claims in chat yet — point the manager to the Schedule screen for approvals.
- Shift results include a ready-made "when" label in the team's local time — use it word-for-word for the date and times instead of converting timestamps yourself.

OVERTIME & COMPLIANCE:
- "who's close to overtime" → get_overtime_status. "any break violations" → get_break_violations.
- Quote the returned numbers exactly — never estimate hours yourself. Ontario overtime starts past 44 hours in a week (Mon-Sun); the warning level is 40.

PROFILES:
- Job title, department, start date, phone, or emergency contact questions → get_employee_profile.
- You never receive home addresses or dates of birth — if asked for those, say they are not available in chat.`;

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
- Schedule questions ("my shifts this week", "am I working Saturday") → get_schedule. Open shifts they could pick up → get_open_shifts; claiming happens in the Schedule tab, tell them to tap Claim there.
- Shift results include a ready-made "when" label in local time — use it word-for-word for the date and times instead of converting timestamps yourself.
- Their own profile ("my job title", "who's my emergency contact", "is my profile complete") → get_my_profile. If it reports missing items, gently suggest completing them in the Profile tab.

CONVERSATION MEMORY:
- You receive the recent conversation history with every request. USE IT.
- Resolve pronouns and short follow-ups ("yes", "him", a bare name) against what was just discussed instead of asking the user to repeat themselves.`;
}

// "Tue, Oct 20, 3:00 PM - 7:00 PM" in the caller's timezone.
function fmtWhen(startIso: string, endIso: string, tz: string): string {
  try {
    const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
    const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
    const s = new Date(startIso);
    const e = new Date(endIso);
    const sameDay = dayFmt.format(s) === dayFmt.format(e);
    return sameDay
      ? `${dayFmt.format(s)}, ${timeFmt.format(s)} - ${timeFmt.format(e)}`
      : `${dayFmt.format(s)}, ${timeFmt.format(s)} - ${dayFmt.format(e)}, ${timeFmt.format(e)}`;
  } catch {
    return `${startIso} - ${endIso}`;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { prompt, managerId, userId, role, location, history, timeZone } = await req.json();

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

    // ----- Verified identity -----
    // Identity comes ONLY from the caller's Supabase session token.
    // Body fields (userId / managerId / role) are ignored on purpose:
    // they were client-claimed and anyone could spoof a manager.
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      return new Response(JSON.stringify({ error: "Please sign in again - your session token is missing." }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authData?.user) {
      return new Response(JSON.stringify({ error: "Your session has expired. Please sign in again." }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const effectiveUserId = authData.user.id;
    const { data: myProfileRow } = await supabase.from("profiles").select("role").eq("id", effectiveUserId).single();
    const dbRole = myProfileRow?.role || "employee";
    // Managers and admins both get the manager toolset.
    const effectiveRole = dbRole === "employee" ? "employee" : "manager";
    // Caller's timezone for human-readable shift labels (the server runs
    // in UTC, so raw timestamps would read back with the wrong times).
    let callerTz = "America/Toronto";
    if (typeof timeZone === "string" && timeZone) {
      try { new Intl.DateTimeFormat("en-US", { timeZone }); callerTz = timeZone; } catch { /* keep default */ }
    }

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
          const { data, error } = await supabase.from("time_exceptions").update({ status: args.status, reviewed_by: effectiveUserId }).in("id", args.exception_ids).select();
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
                assigned_by: effectiveUserId,
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
        } else if (fn === "get_schedule") {
          const nowMs = Date.now();
          let fromMs = weekStartMs(nowMs);
          let toMs = fromMs + 7 * 24 * 3600 * 1000;
          if (args.range === "today") {
            const d = new Date(nowMs); d.setHours(0, 0, 0, 0);
            fromMs = d.getTime(); toMs = fromMs + 24 * 3600 * 1000;
          } else if (args.range === "next_week") {
            fromMs = weekStartMs(nowMs) + 7 * 24 * 3600 * 1000;
            toMs = fromMs + 7 * 24 * 3600 * 1000;
          }
          const { data: rows, error } = await supabase
            .from("shifts")
            .select("id, user_id, worksite_id, start_time, end_time, status, claimed_by, notes")
            .gte("start_time", new Date(fromMs).toISOString())
            .lt("start_time", new Date(toMs).toISOString())
            .order("start_time", { ascending: true })
            .limit(60);
          if (error) {
            output = { error: error.message };
          } else {
            const { data: profs } = await supabase.from("profiles").select("id, full_name");
            const { data: sites } = await supabase.from("worksites").select("id, name");
            const nameMap = new Map((profs || []).map((p: any) => [p.id, p.full_name || "Unknown"]));
            const siteMap = new Map((sites || []).map((w: any) => [w.id, w.name]));
            let list = rows || [];
            if (effectiveRole !== "manager") {
              list = list.filter((s: any) => s.user_id === effectiveUserId || s.claimed_by === effectiveUserId);
            } else if (args.employee_name) {
              const m = matchByName(profs || [], (p: any) => p.full_name || "", args.employee_name);
              if (m.kind === "none") { output = { error: `No employee found matching "${args.employee_name}".` }; list = []; }
              else if (m.kind === "many") { output = { error: `Multiple employees match "${args.employee_name}": ${m.values.map((p: any) => p.full_name).join(", ")}. Ask which one.` }; list = []; }
              else list = list.filter((s: any) => s.user_id === m.value.id);
            }
            if (!output.error) {
              const mapped = list.map((s: any) => ({
                employee: s.user_id ? (nameMap.get(s.user_id) || "Unknown") : "OPEN SHIFT",
                when: fmtWhen(s.start_time, s.end_time, callerTz),
                worksite: s.worksite_id ? (siteMap.get(s.worksite_id) || "Unknown site") : "No worksite",
                start: s.start_time,
                end: s.end_time,
                status: s.status,
                notes: s.notes || undefined,
              }));
              output = mapped.length === 0 ? { message: "No shifts scheduled in that range." } : { shifts: mapped };
            }
          }
        } else if (fn === "get_open_shifts") {
          const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
          const { data: rows, error } = await supabase
            .from("shifts")
            .select("id, worksite_id, start_time, end_time, status, claimed_by, notes")
            .in("status", ["open", "claim_pending"])
            .gte("start_time", dayStart.toISOString())
            .order("start_time", { ascending: true })
            .limit(25);
          if (error) {
            output = { error: error.message };
          } else {
            const { data: profs } = await supabase.from("profiles").select("id, full_name");
            const { data: sites } = await supabase.from("worksites").select("id, name");
            const nameMap = new Map((profs || []).map((p: any) => [p.id, p.full_name || "Unknown"]));
            const siteMap = new Map((sites || []).map((w: any) => [w.id, w.name]));
            const shape = (s: any) => ({
              when: fmtWhen(s.start_time, s.end_time, callerTz),
              worksite: s.worksite_id ? (siteMap.get(s.worksite_id) || "Unknown site") : "No worksite",
              start: s.start_time,
              end: s.end_time,
              notes: s.notes || undefined,
            });
            const open = (rows || []).filter((s: any) => s.status === "open").map(shape);
            output = { open_shifts: open };
            if (effectiveRole === "manager") {
              output.pending_claims = (rows || [])
                .filter((s: any) => s.status === "claim_pending")
                .map((s: any) => ({ ...shape(s), claimed_by: s.claimed_by ? (nameMap.get(s.claimed_by) || "Unknown") : "Unknown" }));
            }
            if (open.length === 0 && (!output.pending_claims || output.pending_claims.length === 0)) {
              output = { message: "No open shifts right now." };
            }
          }
        } else if (fn === "get_overtime_status") {
          const startIso = new Date(weekStartMs(Date.now())).toISOString();
          const { data, error } = await supabase
            .from("time_logs")
            .select("user_id, clock_in, clock_out, profiles!time_logs_user_id_fkey(full_name)")
            .gte("clock_in", startIso);
          if (error) {
            output = { error: error.message };
          } else {
            const otRows = computeWeeklyOvertime((data || []).map((l: any) => ({
              user_id: l.user_id,
              full_name: l.profiles?.full_name,
              clock_in: l.clock_in,
              clock_out: l.clock_out,
            })), Date.now());
            output = otRows.length === 0
              ? { message: "Nobody has logged hours yet this week." }
              : {
                  overtime_threshold_hours: 44,
                  alert_hours: 40,
                  team: otRows.map((r: any) => ({ employee: r.name, hours: r.hours, status: r.status, overtime_hours: r.overtime_hours })),
                };
          }
        } else if (fn === "get_break_violations") {
          const sinceIso = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
          const { data: logs, error } = await supabase
            .from("time_logs")
            .select("id, user_id, clock_in, clock_out, profiles!time_logs_user_id_fkey(full_name)")
            .gte("clock_in", sinceIso);
          if (error) {
            output = { error: error.message };
          } else {
            const ids = (logs || []).map((l: any) => l.id);
            let brks: any[] = [];
            if (ids.length > 0) {
              const { data: b } = await supabase.from("time_breaks").select("time_log_id, start_time, end_time").in("time_log_id", ids);
              brks = b || [];
            }
            const flags = findMealBreakViolations((logs || []).map((l: any) => ({
              log_id: l.id,
              user_id: l.user_id,
              full_name: l.profiles?.full_name,
              clock_in: l.clock_in,
              clock_out: l.clock_out,
              breaks: brks.filter((b: any) => b.time_log_id === l.id).map((b: any) => ({ start_time: b.start_time, end_time: b.end_time })),
            })), Date.now());
            output = flags.length === 0
              ? { message: "No meal-break violations in the last 14 days - every shift had its 30-minute break." }
              : { total_violations: flags.length, violations: flags.slice(0, 10).map((f: any) => ({ employee: f.name, shift_started: f.clock_in, detail: f.message })) };
          }
        } else if (fn === "get_employee_profile") {
          const { data: profs, error: pErr } = await supabase
            .from("profiles")
            .select("id, full_name, role, phone, job_title, department, start_date, employment_type, employee_number, primary_worksite_id, emergency_contact_1_name, emergency_contact_1_relationship, emergency_contact_1_phone, emergency_contact_2_name, emergency_contact_2_relationship, emergency_contact_2_phone")
            .ilike("full_name", `%${args.employee_name}%`)
            .limit(5);
          if (pErr) {
            output = { error: pErr.message };
          } else {
            const match = matchByName(profs || [], (p: any) => p.full_name || "", args.employee_name);
            if (match.kind === "none") {
              output = { error: `No employee found matching "${args.employee_name}". Ask for the exact name.` };
            } else if (match.kind === "many") {
              output = { error: `Multiple employees match "${args.employee_name}": ${match.values.map((p: any) => p.full_name).join(", ")}. Ask which one.` };
            } else {
              const p: any = match.value;
              let siteName: string | undefined;
              if (p.primary_worksite_id) {
                const { data: ws } = await supabase.from("worksites").select("name").eq("id", p.primary_worksite_id).maybeSingle();
                siteName = ws?.name;
              }
              const contacts = [1, 2]
                .map((i: number) => ({
                  name: p[`emergency_contact_${i}_name`] || undefined,
                  relationship: p[`emergency_contact_${i}_relationship`] || undefined,
                  phone: p[`emergency_contact_${i}_phone`] || undefined,
                }))
                .filter((c: any) => c.name || c.phone);
              output = {
                name: p.full_name,
                role: p.role,
                job_title: p.job_title || undefined,
                department: p.department || undefined,
                start_date: p.start_date || undefined,
                employment_type: p.employment_type || undefined,
                employee_number: p.employee_number || undefined,
                primary_worksite: siteName,
                phone: p.phone || undefined,
                emergency_contacts: contacts,
              };
            }
          }
        } else if (fn === "get_my_profile") {
          const { data: p, error } = await supabase
            .from("profiles")
            .select("full_name, role, phone, job_title, department, start_date, employment_type, employee_number, primary_worksite_id, emergency_contact_1_name, emergency_contact_1_relationship, emergency_contact_1_phone, emergency_contact_2_name, emergency_contact_2_relationship, emergency_contact_2_phone")
            .eq("id", effectiveUserId)
            .single();
          if (error || !p) {
            output = { error: "Could not load your profile." };
          } else {
            const row: any = p;
            let siteName: string | undefined;
            if (row.primary_worksite_id) {
              const { data: ws } = await supabase.from("worksites").select("name").eq("id", row.primary_worksite_id).maybeSingle();
              siteName = ws?.name;
            }
            const contacts = [1, 2]
              .map((i: number) => ({
                name: row[`emergency_contact_${i}_name`] || undefined,
                relationship: row[`emergency_contact_${i}_relationship`] || undefined,
                phone: row[`emergency_contact_${i}_phone`] || undefined,
              }))
              .filter((c: any) => c.name || c.phone);
            const missing: string[] = [];
            if (!row.phone) missing.push("phone number");
            if (!row.emergency_contact_1_phone) missing.push("an emergency contact");
            output = {
              name: row.full_name,
              role: row.role,
              job_title: row.job_title || undefined,
              department: row.department || undefined,
              start_date: row.start_date || undefined,
              employment_type: row.employment_type || undefined,
              employee_number: row.employee_number || undefined,
              primary_worksite: siteName,
              phone: row.phone || undefined,
              emergency_contacts: contacts,
              missing_from_profile: missing,
            };
          }
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
