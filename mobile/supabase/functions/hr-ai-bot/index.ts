import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { computeTodayHours, matchByName, findNearestWorksite, getTeamStatus, computeWeeklyOvertime, findMealBreakViolations, weekStartMs, validateShiftInput, shiftsOverlap, countBusinessDays, dateRangesOverlap, vacationBalance, zonedTimeToUtc } from "./logic.ts";

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
  },
  {
    type: "function",
    function: {
      name: "create_shift",
      description: "Creates a scheduled shift. Use for 'schedule Asha on Friday 9 to 5', 'add an open shift Saturday 10-2'. employee_name may be omitted (or open_shift true) for an open shift anyone can claim.",
      parameters: {
        type: "object",
        properties: {
          employee_name: { type: "string", description: "Who the shift is for. Omit for an open shift." },
          open_shift: { type: "boolean", description: "True to create an open (unassigned) shift." },
          date: { type: "string", description: "Shift date, YYYY-MM-DD." },
          start_time: { type: "string", description: "Start time, HH:MM 24-hour local time." },
          end_time: { type: "string", description: "End time, HH:MM 24-hour local time. Earlier than start means it ends the next day." },
          worksite_name: { type: "string", description: "Optional worksite name." },
          notes: { type: "string", description: "Optional note for the shift." },
        },
        required: ["date", "start_time", "end_time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "review_shift_claim",
      description: "Approves or denies an employee's pending claim on an open shift. Use for 'approve Ben's claim', 'deny Asha's claim on the Friday shift'.",
      parameters: {
        type: "object",
        properties: {
          employee_name: { type: "string", description: "The employee who claimed the shift." },
          decision: { type: "string", enum: ["approved", "denied"] },
          date: { type: "string", description: "Optional shift date YYYY-MM-DD to disambiguate when the employee has several pending claims." },
        },
        required: ["employee_name", "decision"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "review_time_off",
      description: "Approves or denies a pending time-off request. Use for 'approve Sara's vacation', 'deny Ben's time off'.",
      parameters: {
        type: "object",
        properties: {
          employee_name: { type: "string", description: "The employee who requested the time off." },
          decision: { type: "string", enum: ["approved", "denied"] },
          date: { type: "string", description: "Optional request start date YYYY-MM-DD to disambiguate." },
        },
        required: ["employee_name", "decision"],
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
  },
  {
    type: "function",
    function: {
      name: "claim_open_shift",
      description: "Claims an open shift for the employee (goes to the manager for approval). Use for 'I'll take the open shift on Friday', 'claim the Saturday open shift'.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "The open shift's date, YYYY-MM-DD." },
          start_time: { type: "string", description: "Optional start time HH:MM to pick between several open shifts that day." },
        },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_time_off",
      description: "Submits a time-off request for the employee (pending manager approval). Use for 'request vacation Nov 2 to 4', 'book a sick day tomorrow'.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["Vacation", "Sick", "Personal", "Unpaid"] },
          start_date: { type: "string", description: "First day off, YYYY-MM-DD." },
          end_date: { type: "string", description: "Last day off, YYYY-MM-DD." },
          half_day: { type: "boolean", description: "True only for a half day (start and end the same day)." },
          reason: { type: "string", description: "Optional reason." },
        },
        required: ["type", "start_date", "end_date"],
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
- "who's working", "who's online", "who's on break" → get_team_status. Answer as one short list, no extra commentary. Name the people - never answer with counts only.

TASK DELEGATION:
- You can assign tasks ("assign fridge restock to Ahmed due Friday"), list them ("show pending tasks", "what is Ahmed working on"), and update them ("mark the fridge task done").
- When assigning, if the employee name is ambiguous or you cannot find them, ask the manager to clarify before creating the task.
- Confirm each delegation back in one short sentence: who, what, and due date if given.

SCHEDULE:
- Rota questions ("who's scheduled Saturday", "shifts this week") → get_schedule; pick the range from the wording (today / this_week / next_week).
- Open shifts and pending claims → get_open_shifts. To approve or deny a claim, use review_shift_claim.
- Shift results include a ready-made "when" label in the team's local time — use it word-for-word for the date and times instead of converting timestamps yourself.

OVERTIME & COMPLIANCE:
- "who's close to overtime" → get_overtime_status. "any break violations" → get_break_violations.
- Quote the returned numbers exactly — never estimate hours yourself. Ontario overtime starts past 44 hours in a week (Mon-Sun); the warning level is 40.

PROFILES:
- Job title, department, start date, phone, or emergency contact questions → get_employee_profile.
- You never receive home addresses or dates of birth — if asked for those, say they are not available in chat.

WRITE ACTIONS - you can change data, not just read it:
- Create a shift → create_shift. You need the employee (or an open shift), the date as YYYY-MM-DD, and start/end times in 24-hour HH:MM form.
- Approve or deny a shift claim → review_shift_claim with the claimant's name.
- Approve or deny time off → review_time_off with the employee's name.
- If a write tool returns an error or a list to choose from, relay it and ask - never invent a person, worksite, date, or time.
- After any successful write, say plainly what changed: who, what, and when, using the tool's own result. Then stop — call no further tools.
- NEVER say a shift was created or a request approved/denied unless the write tool returned success. If it returned success: false, relay the error plainly and do not soften it.`;

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
- Team status: if they ask who's online, who's working, or who's on break, use get_team_status and name the people - never answer with counts only.
- Geo-fence exception: if they need one, make sure you have their reason first (ask if missing), then call submit_exception_request with the reason. Their GPS is already in your context.
- Blocker/issue report: call report_blocker with what they described, then confirm it is logged for their manager.
- Schedule questions ("my shifts this week", "am I working Saturday") → get_schedule. Open shifts they could pick up → get_open_shifts.
- To claim an open shift for them → claim_open_shift with the date. A claim is pending until a manager approves it - say that, never say the shift is confirmed as theirs. If claim_open_shift returns success, say the claim is in and pending manager approval, and call no further tools — do not re-check open shifts afterwards.
- To request time off for them → you MUST call request_time_off with the type and dates; the request exists only if the tool returns success. If the tool says the dates clash with an existing request or exceed their vacation balance, relay the numbers and ask how they want to adjust.
- Never tell the employee a claim or request went through unless the tool returned success: true. If a tool returns success: false, say plainly that it did not work and why.
- Shift results include a ready-made "when" label in local time — use it word-for-word for the date and times instead of converting timestamps yourself. When you list open shifts, introduce them as open shifts the employee can claim (for example: "There is 1 open shift you can claim:") - never show a bare list of times with no explanation.
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
    const { data: myProfileRow } = await supabase.from("profiles").select("role, full_name, business_id").eq("id", effectiveUserId).single();
    const dbRole = myProfileRow?.role || "employee";
    // Managers and admins both get the manager toolset.
    const effectiveRole = dbRole === "employee" ? "employee" : "manager";
    // Caller's timezone for human-readable shift labels (the server runs
    // in UTC, so raw timestamps would read back with the wrong times).
    let callerTz = "America/Toronto";
    if (typeof timeZone === "string" && timeZone) {
      try { new Intl.DateTimeFormat("en-US", { timeZone }); callerTz = timeZone; } catch { /* keep default */ }
    }

    const callerName = (myProfileRow as any)?.full_name || "the user";
    const callerBusinessId = (myProfileRow as any)?.business_id || null;
    const todayInTz = new Intl.DateTimeFormat("en-US", { timeZone: callerTz, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date());
    const contextNote = `\n\nCONTEXT: Today is ${todayInTz} in the team's timezone (${callerTz}). You are talking to ${callerName} (${effectiveRole}). Convert relative dates like "Friday" or "next Monday" into YYYY-MM-DD dates using today as the anchor. Times the user gives are local wall-clock times in ${callerTz}; pass them to tools as HH:MM in 24-hour form.`;

    const tools = effectiveRole === "manager" ? managerTools : employeeTools;
    const systemPrompt = effectiveRole === "manager" ? managerSystemPrompt : employeeSystemPrompt(location);

    let messages = [
      { role: "system", content: systemPrompt + contextNote },
      ...cleanHistory,
      { role: "user", content: prompt },
    ];

    // Provider switch: AI_PROVIDER=together uses Together AI with the
    // TOGETHER_API_KEY secret; anything else keeps Groq. Same model id
    // ("openai/gpt-oss-120b") works on both, and Together is OpenAI-
    // compatible including function calling, so no tool code changes.
    const aiProvider = Deno.env.get("AI_PROVIDER") || "groq";
    const aiApiUrl = aiProvider === "together"
      ? "https://api.together.xyz/v1/chat/completions"
      : "https://api.groq.com/openai/v1/chat/completions";
    const aiApiKey = aiProvider === "together" ? (Deno.env.get("TOGETHER_API_KEY") || "") : GROQ_API_KEY;
    const aiModel = Deno.env.get("AI_MODEL") || "openai/gpt-oss-120b";

    let iterations = 0;
    while (iterations < 4) {
      iterations++;

      // Together (like most hosted inference) can return transient 5xx
      // "Internal server error" responses. Retry those inside the
      // function instead of failing the whole chat turn on one bad call.
      let result: any = null;
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(aiApiUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${aiApiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: aiModel,
            messages,
            tools,
            tool_choice: "auto",
            // Together's gpt-oss reasoning trace shares the completion
            // budget with the answer: with no cap set, the model hit its
            // thought limit on the claim turn and returned a summary
            // instead of calling the tool. Give it headroom, and keep
            // reasoning shallow for these routine turns.
            max_tokens: 8192,
            ...(aiProvider === "together" ? { reasoning_effort: "low" } : {}),
          }),
        });
        result = await response.json();
        if (!result.error) break;
        const msg = result.error.message || JSON.stringify(result.error);
        const retryable = response.status >= 500 || /internal server error|server error|temporarily|overloaded|502|503|504/i.test(msg);
        if (!retryable || attempt >= 2) throw new Error(`AI provider error (${aiProvider}): ${msg}`);
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }

      let choice = result.choices[0].message;

      if (!choice.tool_calls) {
        return new Response(JSON.stringify({ reply: choice.content }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      messages.push(choice);

      const writeReplies: string[] = [];
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
        } else if (fn === "create_shift") {
          if (effectiveRole !== "manager") {
            output = { success: false, error: "Only managers can create shifts." };
          } else {
            const empName = (args.employee_name || "").trim();
            const isOpen = !!args.open_shift || !empName;
            let targetId: string | null = null;
            let targetName = "Open shift";
            let failure: string | null = null;
            if (!isOpen) {
              const { data: emps } = await supabase.from("profiles").select("id, full_name");
              const m = matchByName(emps || [], (p: any) => p.full_name || "", empName);
              if (m.kind === "none") failure = `No team member matches "${empName}".`;
              else if (m.kind === "many") failure = `More than one team member matches "${empName}": ${m.values.map((p: any) => p.full_name).join(", ")}. Use the full name.`;
              else { targetId = m.value.id; targetName = m.value.full_name; }
            }
            const startMs = zonedTimeToUtc(args.date || "", args.start_time || "", callerTz);
            let endMs = zonedTimeToUtc(args.date || "", args.end_time || "", callerTz);
            if (!failure && (Number.isNaN(startMs) || Number.isNaN(endMs))) failure = "I could not read that date or time. Use a date like 2026-10-23 and 24-hour times like 09:00.";
            if (!failure && endMs <= startMs) endMs += 24 * 3600 * 1000; // overnight
            let worksiteId: string | null = null;
            let worksiteName = "No worksite";
            if (!failure && args.worksite_name) {
              const { data: sites } = await supabase.from("worksites").select("id, name");
              const sm = (sites || []).find((s: any) => (s.name || "").toLowerCase().includes(String(args.worksite_name).toLowerCase()));
              if (!sm) failure = `No worksite matches "${args.worksite_name}". Sites on file: ${(sites || []).map((s: any) => s.name).join(", ") || "none"}.`;
              else { worksiteId = sm.id; worksiteName = sm.name; }
            }
            if (!failure) {
              const vErr = validateShiftInput(new Date(startMs).toISOString(), new Date(endMs).toISOString());
              if (vErr) failure = vErr;
            }
            if (!failure && targetId) {
              const { data: existing } = await supabase.from("shifts")
                .select("start_time, end_time")
                .eq("user_id", targetId)
                .lt("start_time", new Date(endMs).toISOString())
                .gt("end_time", new Date(startMs).toISOString());
              const conflict = (existing || []).find((s: any) => shiftsOverlap(startMs, endMs, Date.parse(s.start_time), Date.parse(s.end_time)));
              if (conflict) failure = `${targetName} already has a shift then (${fmtWhen(conflict.start_time, conflict.end_time, callerTz)}). Pick a different time or delete that shift first.`;
            }
            if (failure) {
              output = { success: false, error: failure };
            } else {
              const startIso = new Date(startMs).toISOString();
              const endIso = new Date(endMs).toISOString();
              const { error: insErr } = await supabase.from("shifts").insert([{
                business_id: callerBusinessId,
                user_id: targetId,
                worksite_id: worksiteId,
                start_time: startIso,
                end_time: endIso,
                status: isOpen ? "open" : "assigned",
                notes: args.notes || null,
                created_by: effectiveUserId,
              }]);
              output = insErr
                ? { success: false, error: "Could not create the shift: " + insErr.message }
                : { success: true, created: { employee: targetName, when: fmtWhen(startIso, endIso, callerTz), worksite: worksiteName } };
            }
          }
        } else if (fn === "review_shift_claim") {
          if (effectiveRole !== "manager") {
            output = { success: false, error: "Only managers can review claims." };
          } else {
            const decision = args.decision === "denied" ? "denied" : "approved";
            const { data: emps } = await supabase.from("profiles").select("id, full_name");
            const m = matchByName(emps || [], (p: any) => p.full_name || "", (args.employee_name || "").trim());
            if (m.kind !== "one") {
              output = { success: false, error: m.kind === "many" ? `More than one team member matches "${args.employee_name}": ${m.values.map((p: any) => p.full_name).join(", ")}. Use the full name.` : `No team member matches "${args.employee_name}".` };
            } else {
              const target = m.value;
              const { data: claims } = await supabase.from("shifts")
                .select("id, claimed_by, start_time, end_time")
                .eq("status", "claim_pending")
                .eq("claimed_by", target.id);
              let matches = claims || [];
              if (args.date) {
                const dayInTz = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: callerTz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
                matches = matches.filter((c: any) => dayInTz(c.start_time) === args.date);
              }
              if (matches.length === 0) {
                output = { success: false, error: `${target.full_name} has no pending shift claim${args.date ? " on that date" : ""}.` };
              } else if (matches.length > 1) {
                output = { success: false, needs_choice: true, claims: matches.map((c: any) => fmtWhen(c.start_time, c.end_time, callerTz)), error: `${target.full_name} has ${matches.length} pending claims. Ask which date, then call again with the date.` };
              } else {
                const c: any = matches[0];
                const patch = decision === "approved"
                  ? { status: "assigned", user_id: c.claimed_by, claimed_by: null }
                  : { status: "open", claimed_by: null };
                const { error: upErr } = await supabase.from("shifts").update(patch).eq("id", c.id);
                output = upErr
                  ? { success: false, error: "Could not update the claim: " + upErr.message }
                  : { success: true, claim: { employee: target.full_name, when: fmtWhen(c.start_time, c.end_time, callerTz), decision } };
              }
            }
          }
        } else if (fn === "review_time_off") {
          if (effectiveRole !== "manager") {
            output = { success: false, error: "Only managers can review time off." };
          } else {
            const decision = args.decision === "denied" ? "denied" : "approved";
            const { data: emps } = await supabase.from("profiles").select("id, full_name");
            const m = matchByName(emps || [], (p: any) => p.full_name || "", (args.employee_name || "").trim());
            if (m.kind !== "one") {
              output = { success: false, error: m.kind === "many" ? `More than one team member matches "${args.employee_name}": ${m.values.map((p: any) => p.full_name).join(", ")}. Use the full name.` : `No team member matches "${args.employee_name}".` };
            } else {
              const target = m.value;
              const { data: reqs } = await supabase.from("time_off_requests")
                .select("id, type, start_date, end_date, half_day")
                .eq("status", "pending")
                .eq("user_id", target.id)
                .order("start_date", { ascending: true });
              let matches = reqs || [];
              if (args.date) matches = matches.filter((r: any) => r.start_date === args.date);
              if (matches.length === 0) {
                output = { success: false, error: `${target.full_name} has no pending time-off request${args.date ? " starting on that date" : ""}.` };
              } else if (matches.length > 1) {
                output = { success: false, needs_choice: true, requests: matches.map((r: any) => `${r.type} ${r.start_date} to ${r.end_date}`), error: `${target.full_name} has ${matches.length} pending requests. Ask which one (by start date), then call again with the date.` };
              } else {
                const r: any = matches[0];
                const { error: upErr } = await supabase.from("time_off_requests")
                  .update({ status: decision, reviewed_by: effectiveUserId })
                  .eq("id", r.id);
                output = upErr
                  ? { success: false, error: "Could not update the request: " + upErr.message }
                  : { success: true, time_off: { employee: target.full_name, type: r.type, dates: `${r.start_date} to ${r.end_date}`, days: countBusinessDays(r.start_date, r.end_date, !!r.half_day), decision } };
              }
            }
          }
        } else if (fn === "claim_open_shift") {
          const dayStart = zonedTimeToUtc(args.date || "", "00:00", callerTz);
          if (Number.isNaN(dayStart)) {
            output = { success: false, error: "I could not read that date. Use YYYY-MM-DD." };
          } else {
            const { data: opens } = await supabase.from("shifts")
              .select("id, start_time, end_time, worksite_id")
              .eq("status", "open")
              .gte("start_time", new Date(dayStart).toISOString())
              .lt("start_time", new Date(dayStart + 24 * 3600 * 1000).toISOString())
              .order("start_time", { ascending: true });
            let matches = opens || [];
            if (args.start_time && matches.length > 1) {
              const timeInTz = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: callerTz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
              matches = matches.filter((s: any) => timeInTz(s.start_time) === args.start_time);
            }
            if (matches.length === 0) {
              output = { success: false, error: `There are no open shifts on ${args.date}.` };
            } else if (matches.length > 1) {
              output = { success: false, needs_choice: true, open_shifts: matches.map((s: any) => fmtWhen(s.start_time, s.end_time, callerTz)), error: "More than one open shift that day. Ask which start time, then call again with start_time." };
            } else {
              const s: any = matches[0];
              const { error: upErr } = await supabase.from("shifts")
                .update({ status: "claim_pending", claimed_by: effectiveUserId })
                .eq("id", s.id)
                .eq("status", "open");
              output = upErr
                ? { success: false, error: "Could not claim that shift: " + upErr.message }
                : { success: true, claimed: { when: fmtWhen(s.start_time, s.end_time, callerTz), status: "pending manager approval" } };
            }
          }
        } else if (fn === "request_time_off") {
          const TYPES = ["Vacation", "Sick", "Personal", "Unpaid"];
          const type = TYPES.includes(args.type) ? args.type : "Vacation";
          const start = args.start_date || "";
          const end = args.end_date || start;
          const half = !!args.half_day && start === end;
          const days = countBusinessDays(start, end, half);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
            output = { success: false, error: "Dates must be YYYY-MM-DD with the end on or after the start." };
          } else if (days <= 0) {
            output = { success: false, error: "That range has no business days (Mon-Fri). Pick weekdays." };
          } else {
            const { data: myReqs } = await supabase.from("time_off_requests")
              .select("type, start_date, end_date, half_day, status")
              .eq("user_id", effectiveUserId)
              .in("status", ["pending", "approved"]);
            const clash = (myReqs || []).find((r: any) => dateRangesOverlap(r, { start_date: start, end_date: end }));
            if (clash) {
              output = { success: false, error: `Those dates overlap your ${String(clash.type).toLowerCase()} request (${clash.start_date} to ${clash.end_date}, ${clash.status}).` };
            } else {
              let remainingAfter: number | undefined;
              let failure: string | null = null;
              if (type === "Vacation") {
                const { data: prof } = await supabase.from("profiles").select("vacation_days_entitlement").eq("id", effectiveUserId).single();
                const entitlement = prof?.vacation_days_entitlement != null ? Number(prof.vacation_days_entitlement) : 10;
                const bal = vacationBalance(entitlement, myReqs || [], Number(start.slice(0, 4)));
                if (days > bal.remaining) failure = `This request is ${days} vacation days but only ${bal.remaining} of ${bal.entitlement} remain this year. Ask for fewer days or a different type.`;
                else remainingAfter = +(bal.remaining - days).toFixed(1);
              }
              if (failure) {
                output = { success: false, error: failure };
              } else {
                const { error: insErr } = await supabase.from("time_off_requests").insert([{
                  business_id: callerBusinessId,
                  user_id: effectiveUserId,
                  type, start_date: start, end_date: end,
                  half_day: half,
                  reason: args.reason || null,
                  status: "pending",
                }]);
                output = insErr
                  ? { success: false, error: "Could not submit the request: " + insErr.message }
                  : { success: true, requested: { type, dates: `${start} to ${end}`, days, status: "pending manager approval", ...(remainingAfter !== undefined ? { vacation_days_remaining_after: remainingAfter } : {}) } };
              }
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

        // Deterministic write confirmations: the model has now
        // contradicted successful writes three runs in a row (it
        // re-checks after the write, finds the pending item gone,
        // and reports that instead). A successful write is confirmed
        // from the tool's own result, never re-paraphrased by the model.
        if (output && output.success === true) {
          if (fn === "create_shift" && output.created) writeReplies.push(`Shift created: ${output.created.employee}, ${output.created.when}.`);
          else if (fn === "claim_open_shift" && output.claimed) writeReplies.push(`Your claim is in and pending manager approval for ${output.claimed.when}.`);
          else if (fn === "review_shift_claim" && output.claim) writeReplies.push(`${output.claim.decision === "denied" ? "Denied" : "Approved"} the shift claim for ${output.claim.employee}, ${output.claim.when}.`);
          else if (fn === "request_time_off" && output.requested) writeReplies.push(`Your ${output.requested.type} request for ${output.requested.dates} is pending manager approval.`);
          else if (fn === "review_time_off" && output.time_off) writeReplies.push(`${output.time_off.decision === "denied" ? "Denied" : "Approved"} ${output.time_off.employee}'s ${output.time_off.type} request for ${output.time_off.dates}.`);
        }
      }
      if (writeReplies.length > 0) {
        return new Response(JSON.stringify({ reply: writeReplies.join(" ") }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    return new Response(JSON.stringify({ reply: "I processed the tasks, but reached my thought limit before I could summarize." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
