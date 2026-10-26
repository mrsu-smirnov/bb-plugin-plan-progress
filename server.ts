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
import { AGENTS_CHANGED, agentsFromRows, type Agent } from "./agents";

export type { Bar } from "./engine";
export type { Agent } from "./agents";

export const rpcContract = defineRpcContract({
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

const INSTRUCTIONS = `Show progress on multi-step work with the plan_progress tool; the user sees it as a bar above the message box.
- A task of 3+ steps: before starting, create a bar once: {id, title, stages:[{name, steps:[{title}]}]}. 2-7 stages, titles of at most 4 words, in the user's language.
- Then move it with short ops only: {id, next:true} after each step; {id, done:["A"], active:"B"} to jump.
- Before asking the user a question: {id, state:"needs_input", note}; the user's answer clears it. On an error: {id, failed:"<step>", note}; the next {id, next:true} closes that step.
- When the task is finished: {id, state:"done"}. Any call without a state works the state out again.
- The plan changed: resend stages under the same id and title; finished steps keep their done by title.
- The result already says done/total, state and the active step; do not call it just to check.
Skip it for one-step answers and conversation.`;

const barsKey = (threadId: string) => `bars:${threadId}`;

export default async function plugin(bb: BbPluginApi) {
  // Read by app.tsx through useSettings(); the server itself uses none of them.
  bb.settings.define({
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
    sounds: {
      type: "boolean",
      label: "Sounds",
      description: "A chime on a question, an error and the finish, in an open bb window.",
      default: false,
    },
  });

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
      return { ok: true, text: describe(result.bar) };
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
    return agentsFromRows(timeline.rows, timeline.activeBackgroundCommands);
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
  bb.events.on("experimental_thread.events", ({ thread }) => void refreshAgents(thread.id));
  bb.events.on("thread.idle", ({ thread }) => void refreshAgents(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => {
    agentsByThread.delete(thread.id);
    void serial(thread.id, () => writeBars(thread.id, []));
  });
  // the person answered: a bar waiting on them goes back to work, without a model call
  bb.events.on("thread.active", ({ thread }) =>
    serial(thread.id, async () => {
      const bars = answered(await readBars(thread.id), Date.now());
      if (bars !== null) await writeBars(thread.id, bars);
    }),
  );

  bb.agents.registerTool({
    name: "plan_progress",
    description:
      "Create or move a live progress bar for the current task, shown above the user's message box. " +
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
    "  bb plan-progress clear              Remove every bar of the thread",
  ].join("\n");

  bb.cli.register({
    name: "plan-progress",
    summary: "Show, move, or clear the progress bars of a thread",
    commands: [
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
