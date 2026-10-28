// bb-plugin-plan-progress — backend.
//
// Registers the plan_progress agent tool. Bars live in this plugin's kv
// storage, one list per thread; every write publishes a realtime signal so
// the bar above the thread's composer (app.tsx) refetches.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  allSteps,
  answered,
  applyOp,
  BARS_CHANGED,
  describe,
  STATE_NAMES,
  stateOf,
  STEP_NAMES,
  type Bar,
  type Op,
} from "./engine";
import { AGENTS_CHANGED, agentFromChild, agentsFromRows, type Agent, type ChildThread } from "./agents";
import { hostContract } from "./host-contract";
import { advanceDiagnostic, DIAGNOSTICS_CHANGED, NO_DIAGNOSTIC, type ProgressDiagnostic } from "./diagnostics";
import { newReminderState, observeWork, type ReminderState } from "./reminders";

export type { Bar } from "./engine";
export type { Agent } from "./agents";

export const rpcContract = defineRpcContract({
  diagnostics_get: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ diagnostic: z.custom<ProgressDiagnostic>() }),
  },
  bars_get: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ bars: z.array(z.custom<Bar>()) }),
  },
  agents_get: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ agents: z.array(z.custom<Agent>()) }),
  },
  bars_dismiss: {
    input: z.object({ threadId: z.string().min(1), id: z.string().min(1) }),
    output: z.object({ removed: z.boolean() }),
  },
});

const stepSchema = z.object({
  title: z.string().min(1),
  status: z.enum(STEP_NAMES).optional(),
});

const opSchema = z.object({
  id: z.string().min(1).describe('One id per task, e.g. "auth".'),
  title: z
    .string()
    .optional()
    .describe("Bar title, at most 4 words, in the user's language. Required on create."),
  kind: z.enum(["plan", "todo"]).optional(),
  stages: z
    .array(z.object({ name: z.string(), steps: z.array(stepSchema) }))
    .optional()
    .describe("The whole plan: 2-7 stages of short steps. Resend to change the plan."),
  steps: z.array(stepSchema).optional().describe("A flat list instead of stages."),
  next: z.boolean().optional().describe("Active step done, next one active."),
  done: z.array(z.string()).optional().describe("Step titles to mark done."),
  active: z
    .string()
    .optional()
    .describe("Step title to make current; earlier steps count as done."),
  failed: z.string().optional().describe("Step title that failed; add a note."),
  note: z.string().optional(),
  state: z.enum(STATE_NAMES).optional().describe('"needs_input" before asking the user; "done" when finished.'),
});

const INSTRUCTIONS = `Show progress on multi-step work with BB's plan_progress tool; the user sees it as a bar above the message box.
- REQUIRED: for 3 or more requested actions, create the BB bar BEFORE the first work tool call. Read-only work counts. Reading three files counts. A task finished in one turn still counts. "No subagents" does not forbid a progress bar: the bar is UI bookkeeping, not a subagent or a workspace edit. Do not reinterpret three explicit steps as a one-step answer.
- In Claude Code, discover and use mcp__bb-bridge__plan_progress (ToolSearch: select:mcp__bb-bridge__plan_progress). Never use mcp__plan-progress__plan_progress: it belongs to the Claude Desktop plugin and cannot display a bar in BB. Other providers use their advertised BB plan_progress tool.
- If the BB tool is missing or fails, use the same operation with bb plan-progress op '<json>' in the current thread. If that also fails, report the failure; do not silently use the Desktop plugin.
- A task of 3+ steps: before starting, create a bar once: {id, title, stages:[{name, steps:[{title}]}]}. 2-7 stages, titles of at most 4 words, in the user's language.
- Then move it with short ops only: {id, next:true} after each step; {id, done:["A"], active:"B"} to jump.
- Before asking the user a question: {id, state:"needs_input", note}; the user's answer clears it. On an error: {id, failed:"<step>", note}; the next {id, next:true} closes that step.
- When the task is finished, mark the completed step titles with done, then state:"done" (these may be one op). state:"done" alone closes the bar but does not mark unfinished steps done; do not leave a completed task at 2/3. Any call without a state works the state out again.
- The plan changed: resend stages under the same id and title; finished steps keep their done by title.
- The result already says done/total, state and the active step; do not call it just to check.
Skip it for one-step answers and conversation.`;

const barsKey = (threadId: string) => `bars:${threadId}`;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    automaticReminders: {
      type: "boolean", label: "Automatic progress reminders",
      description: "At most one reminder per active turn after 3 work calls without a bar or 6 without an update. Never starts a new turn.",
      default: true,
    },
    isolateClaude: {
      type: "boolean", label: "Isolate Claude Desktop progress",
      description: "Disable the original zycck progress plugin only in BB's Claude processes. Desktop settings stay unchanged. Applies to new sessions.",
      default: true,
    },
    claudeExecutable: {
      type: "string", label: "Claude executable",
      description: "Optional absolute path on the agent's machine; otherwise use the native Claude executable on PATH.",
      default: "",
    },
    effects: {
      type: "boolean",
      label: "Effects",
      description: "Twinkling dots in the bar.",
      default: true,
    },
    autoClose: {
      type: "boolean",
      label: "Auto-close",
      description: "A finished bar leaves on its own.",
      default: false,
    },
    autoCloseSeconds: {
      type: "select",
      label: "Stays for",
      description: "How long a finished bar stays when auto-close is on.",
      options: ["10", "30", "60"],
      experimental_optionLabels: { "10": "10 s", "30": "30 s", "60": "60 s" },
      default: "30",
    },
    speed: {
      type: "boolean",
      label: "Answer speed",
      description: "≈ tok/s in the message box, bright while the agent writes: estimated from the text it writes, exact after the turn when bb reports the tokens.",
      default: true,
    },
    sounds: {
      type: "boolean",
      label: "Sounds",
      description: "A chime on a question, an error and the finish, in an open bb window.",
      default: false,
    },
  });

  const host = bb.hosts.experimental_client({ contract: hostContract });
  bb.providers.experimental_contributeEnv("claude-code", async ({ hostId, threadId }) => {
    const config = await settings.get();
    if (!threadId || !config.isolateClaude) return [];
    const { launcher } = await host.call("prepareClaude", { executable: config.claudeExecutable }, { hostId });
    return [{ name: "BB_CLAUDE_CODE_EXECUTABLE", value: launcher,
      reason: "Isolate zycck progress in this BB process; preserve Claude Desktop settings" }];
  });

  const diagnostics = new Map<string, ProgressDiagnostic>();
  const diagnosticCursors = new Map<string, number>();
  const diagnosticPulls = new Map<string, Promise<void>>();
  const reminderStates = new Map<string, ReminderState>();
  async function refreshDiagnostic(threadId: string): Promise<void> {
    const busy = diagnosticPulls.get(threadId);
    if (busy) return busy;
    const run = (async () => {
      let cursor = diagnosticCursors.get(threadId);
      let previous = diagnostics.get(threadId) ?? NO_DIAGNOSTIC;
      for (let page = 0; page < 5; page++) {
        const events = await bb.sdk.threads.events.list({ threadId, types: ["item/completed"], limit: "100",
          ...(cursor === undefined ? { order: "desc" as const } : { afterSeq: String(cursor) }) });
        const ordered = cursor === undefined ? [...events].reverse() : events;
        const reminder = reminderStates.get(threadId);
        if (reminder && observeWork(reminder, ordered) && (await settings.get()).automaticReminders) {
          // Set before awaiting: never send twice, even on failure. Strict `steer`
          // rejects an idle target instead of creating a follow-up turn.
          reminder.sent = true;
          const bars = await readBars(threadId);
          const updatedThisTurn = bars.some(bar => bar.updatedAt >= reminder.since);
          if (!updatedThisTurn || bars.some(bar => bar.state === "running")) {
            await bb.sdk.threads.send({ threadId, mode: "steer", input: [{ type: "text", visibility: "agent-only", mentions: [],
              text: "BB plan-progress automatic reminder: several work calls have run. Create or update BB's plan_progress bar now for the remaining work (Claude: mcp__bb-bridge__plan_progress). A bar is UI bookkeeping, not a subagent or file edit. If the task is already finished, do not invent a plan retroactively. Do not repeat completed work. If the tool is unavailable, report that once." }],
            }).catch(() => undefined);
          }
        }
        const next = advanceDiagnostic(previous, ordered);
        if (next !== previous) {
          diagnostics.set(threadId, next);
          if (next.warning && previous.source !== next.source) bb.log.warn(`Progress tool collision in ${threadId}`);
          previous = next;
          bb.realtime.publish(DIAGNOSTICS_CHANGED, { threadId });
        }
        const initial = cursor === undefined;
        cursor = Math.max(cursor ?? 0, ...events.map(event => event.seq));
        diagnosticCursors.set(threadId, cursor);
        if (initial || events.length < 100) break;
      }
    })().catch(error => bb.log.warn(`Progress diagnostics failed for ${threadId}: ${String(error)}`));
    diagnosticPulls.set(threadId, run);
    try { await run; } finally { diagnosticPulls.delete(threadId); }
  }

  async function readBars(threadId: string): Promise<Bar[]> {
    const bars = (await bb.storage.kv.get<Bar[]>(barsKey(threadId))) ?? [];
    // bars stored by 0.1 used "working" and "failed"
    for (const bar of bars) {
      bar.state = stateOf(bar.state) ?? "running";
      for (const step of allSteps(bar)) if ((step.status as string) === "failed") step.status = "error";
    }
    return bars;
  }
  async function writeBars(threadId: string, bars: Bar[]): Promise<void> {
    if (bars.length === 0) await bb.storage.kv.delete(barsKey(threadId));
    else await bb.storage.kv.set(barsKey(threadId), bars);
    bb.realtime.publish(BARS_CHANGED, { threadId });
  }

  // One write at a time per thread, so quick successive calls never lose an op.
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const run = (queues.get(threadId) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => undefined);
    queues.set(threadId, tail);
    void tail.then(() => {
      if (queues.get(threadId) === tail) queues.delete(threadId);
    });
    return run;
  }

  async function apply(threadId: string, op: Op): Promise<{ ok: boolean; text: string }> {
    return serial(threadId, async () => {
      const result = applyOp(await readBars(threadId), op, Date.now());
      if (!result.ok) return { ok: false, text: result.error };
      await writeBars(threadId, result.bars);
      diagnostics.set(threadId, { source: "bb", lastCallSeq: diagnostics.get(threadId)?.lastCallSeq ?? 0, warning: null });
      const reminder = reminderStates.get(threadId);
      if (reminder) { reminder.hasPlan = true; reminder.sinceUpdate = 0; }
      bb.realtime.publish(DIAGNOSTICS_CHANGED, { threadId });
      return { ok: true, text: `BB/${threadId}: ${describe(result.bar)}` };
    });
  }

  // Subagent strips. bb says a thread's events moved (at most once a second);
  // for a thread with bars, read its latest timeline segment and pass the
  // delegations on when they changed. Nothing is stored.
  const agentsByThread = new Map<string, Agent[]>();
  const refreshing = new Map<string, boolean>();
  async function readAgents(threadId: string): Promise<Agent[]> {
    const timeline = await bb.sdk.threads.timeline({
      threadId,
      includeNestedRows: "true",
      segmentLimit: "1",
    });
    const own = agentsFromRows(timeline.rows, timeline.activeBackgroundCommands);
    return [...own, ...(await readChildren(threadId))].sort((a, b) => a.startedAt - b.startedAt);
  }
  // Threads this one started on other providers (`bb thread spawn --parent-self`).
  // The model is in the child's first request; it never changes, so keep it.
  const childModels = new Map<string, { model?: unknown; reasoningLevel?: unknown } | null>();
  async function readChildren(threadId: string): Promise<Agent[]> {
    const children = (await bb.sdk.threads.list({ parentThreadId: threadId })) as unknown as ChildThread[];
    return Promise.all(
      children.map(async (child) => {
        if (!childModels.has(child.id)) {
          const [first] = await bb.sdk.threads.events.list({
            threadId: child.id, types: ["client/turn/requested"], limit: "1", order: "asc" as const,
          });
          const data = first as unknown as { data?: { execution?: { model?: unknown; reasoningLevel?: unknown } } } | undefined;
          childModels.set(child.id, data?.data?.execution ?? null);
        }
        return agentFromChild(child, childModels.get(child.id) ?? null);
      }),
    );
  }
  async function refreshAgents(threadId: string): Promise<void> {
    if (refreshing.has(threadId)) {
      refreshing.set(threadId, true); // run once more when this pass ends
      return;
    }
    refreshing.set(threadId, false);
    try {
      do {
        refreshing.set(threadId, false);
        const known = agentsByThread.get(threadId);
        if (known === undefined && (await readBars(threadId)).length === 0) return;
        const agents = await readAgents(threadId);
        if (JSON.stringify(agents) === JSON.stringify(known ?? [])) continue;
        if (agents.length === 0) agentsByThread.delete(threadId);
        else agentsByThread.set(threadId, agents);
        bb.realtime.publish(AGENTS_CHANGED, { threadId, agents });
      } while (refreshing.get(threadId) === true);
    } catch (error) {
      bb.log.warn(`agents refresh failed for ${threadId}: ${String(error)}`);
    } finally {
      refreshing.delete(threadId);
    }
  }
  bb.events.on("experimental_thread.events", ({ thread }) => {
    void refreshAgents(thread.id);
    if (thread.parentThreadId) void refreshAgents(thread.parentThreadId);
  });
  bb.events.on("experimental_thread.events", ({ thread }) => void refreshDiagnostic(thread.id));
  bb.events.on("thread.idle", ({ thread }) => void refreshDiagnostic(thread.id));
  bb.events.on("thread.idle", ({ thread }) => { reminderStates.delete(thread.id); });
  bb.events.on("thread.failed", ({ thread }) => { reminderStates.delete(thread.id); });
  bb.events.on("thread.idle", ({ thread }) => {
    void refreshAgents(thread.id);
    if (thread.parentThreadId) void refreshAgents(thread.parentThreadId);
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    agentsByThread.delete(thread.id);
    diagnostics.delete(thread.id);
    diagnosticCursors.delete(thread.id);
    reminderStates.delete(thread.id);
    void serial(thread.id, () => writeBars(thread.id, []));
  });
  // the person answered: a bar waiting on them goes back to work, without a model call
  bb.events.on("thread.active", ({ thread }) => {
    reminderStates.set(thread.id, newReminderState(Date.now()));
    return serial(thread.id, async () => {
      const bars = answered(await readBars(thread.id), Date.now());
      if (bars !== null) await writeBars(thread.id, bars);
    });
  });

  bb.agents.registerTool({
    name: "plan_progress",
    description:
      "BB progress bar above the BB message box (Claude: mcp__bb-bridge__plan_progress). " +
      "Separate from the Claude Desktop plan-progress tool. " +
      "Create once with the whole plan, then send short ops.",
    instructions: INSTRUCTIONS,
    presentation: {
      label: { pending: "Updating progress", completed: "Updated progress" },
      icon: { glyph: "ListTodo" },
      suppress: true,
    },
    parameters: opSchema,
    async execute(op, { threadId }) {
      const result = await apply(threadId, op);
      return result.ok
        ? result.text
        : { content: [{ type: "text", text: result.text }], isError: true };
    },
  });

  bb.rpc.register(rpcContract, {
    diagnostics_get: async ({ threadId }) => {
      await refreshDiagnostic(threadId);
      return { diagnostic: diagnostics.get(threadId) ?? NO_DIAGNOSTIC };
    },
    bars_get: async ({ threadId }) => ({ bars: await readBars(threadId) }),
    agents_get: async ({ threadId }) => ({
      agents: agentsByThread.get(threadId) ?? (await readAgents(threadId).catch(() => [])),
    }),
    bars_dismiss: ({ threadId, id }) =>
      serial(threadId, async () => {
        const bars = await readBars(threadId);
        const remaining = bars.filter((bar) => bar.id !== id);
        if (remaining.length === bars.length) return { removed: false };
        await writeBars(threadId, remaining);
        return { removed: true };
      }),
  });

  const usage = [
    "Usage (inside a thread, or with --thread <id>):",
    "  bb plan-progress show [--json]      List this thread's bars",
    "  bb plan-progress op '<json>'        Apply one plan_progress op",
    "  bb plan-progress agents [--json]    List the subagents of the latest turn",
    "  bb plan-progress diagnose [--json]  Check progress routing and isolation",
    "  bb plan-progress clear              Remove every bar of the thread",
  ].join("\n");

  bb.cli.register({
    name: "plan-progress",
    summary: "Show, move, or clear the progress bars of a thread",
    commands: [
      { name: "diagnose", summary: "Check progress routing and isolation",
        usage: "bb plan-progress diagnose [--json] [--thread <id>]" },
      {
        name: "show",
        summary: "List the thread's bars",
        usage: "bb plan-progress show [--json] [--thread <id>]",
      },
      {
        name: "op",
        summary: "Apply one plan_progress op",
        usage: "bb plan-progress op '<json>' [--thread <id>]",
      },
      {
        name: "agents",
        summary: "List the subagents of the latest turn",
        usage: "bb plan-progress agents [--json] [--thread <id>]",
      },
      {
        name: "clear",
        summary: "Remove the thread's bars",
        usage: "bb plan-progress clear [--thread <id>]",
      },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const flag = argv.indexOf("--thread");
      const value = flag === -1 ? undefined : argv[flag + 1];
      if (flag !== -1 && (value === undefined || value.startsWith("--"))) {
        return { exitCode: 1, stderr: "--thread needs a thread id: --thread <id>." };
      }
      const threadId = flag === -1 ? ctx.threadId : value;
      const rest = argv.filter(
        (arg, index) => arg !== "--json" && (flag === -1 || (index !== flag && index !== flag + 1)),
      );
      const [command, ...params] = rest;
      if (command === undefined || command === "help" || command === "--help") {
        return { exitCode: 0, stdout: usage };
      }
      if (threadId === undefined || threadId === "") {
        return { exitCode: 1, stderr: "No thread: run it inside a thread or pass --thread <id>." };
      }
      switch (command) {
        case "diagnose": {
          await refreshDiagnostic(threadId);
          const config = await settings.get();
          const diagnostic = diagnostics.get(threadId) ?? NO_DIAGNOSTIC;
          const report = { threadId, isolateClaude: config.isolateClaude,
            bars: (await readBars(threadId)).length, ...diagnostic };
          return { exitCode: 0, stdout: json ? JSON.stringify(report) :
            `BB/${threadId}: ${report.bars} bars; last source: ${report.source ?? "no recognized call"}; Claude isolation requested: ${report.isolateClaude}.\n${report.warning ?? "No detected tool collision."}` };
        }
        case "show": {
          const bars = await readBars(threadId);
          if (json) return { exitCode: 0, stdout: JSON.stringify(bars) };
          return {
            exitCode: 0,
            stdout: bars.length === 0 ? "No bars." : bars.map(describe).join("\n"),
          };
        }
        case "op": {
          let parsed: unknown;
          try {
            parsed = JSON.parse(params.join(" "));
          } catch {
            return { exitCode: 1, stderr: "The op must be one JSON object." };
          }
          const op = opSchema.safeParse(parsed);
          if (!op.success) return { exitCode: 1, stderr: z.prettifyError(op.error) };
          const result = await apply(threadId, op.data);
          return result.ok
            ? { exitCode: 0, stdout: result.text }
            : { exitCode: 1, stderr: result.text };
        }
        case "raw": {
          // debugging aid, not in help: the latest timeline segment as bb hands it over
          const timeline = await bb.sdk.threads.timeline({ threadId, includeNestedRows: "true", segmentLimit: "1" });
          return { exitCode: 0, stdout: JSON.stringify(timeline).slice(0, 400_000) };
        }
        case "agents": {
          const agents = await readAgents(threadId);
          if (json) return { exitCode: 0, stdout: JSON.stringify(agents) };
          return {
            exitCode: 0,
            stdout:
              agents.length === 0
                ? "No agents in the latest turn."
                : agents
                    .map((agent) =>
                      [agent.state, agent.name, agent.kind, agent.model, agent.tool]
                        .filter((part) => part !== null)
                        .join(" · "),
                    )
                    .join("\n"),
          };
        }
        case "clear":
          await serial(threadId, () => writeBars(threadId, []));
          return { exitCode: 0, stdout: "Cleared." };
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
