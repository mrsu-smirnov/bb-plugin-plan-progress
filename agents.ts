// Subagent strips: what bb's timeline says about the agents the main agent
// started (its "delegation" rows), reduced to one line each. Pure, so tests
// can feed it timeline rows directly.

/** Realtime channel: payload `{ threadId, agents }` when a thread's agents change. */
export const AGENTS_CHANGED = "agents-changed";

export type AgentState = "running" | "done" | "error" | "unknown";

export interface Agent {
  id: string;
  name: string;
  /** The kind of agent, e.g. "Explore agent"; null when bb does not say. */
  kind: string | null;
  model: string | null;
  state: AgentState;
  /** The tool the agent is in right now, while it runs. */
  tool: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Set for a child thread (it has a thread of its own to open); absent for an agent of the turn. */
  threadId?: string;
}

interface Row {
  kind?: unknown;
  workKind?: unknown;
  toolName?: unknown;
  status?: unknown;
  callId?: unknown;
  id?: unknown;
  description?: unknown;
  subagentType?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  childRows?: unknown;
  background?: unknown;
  taskType?: unknown;
  taskStatus?: unknown;
  childRef?: unknown;
  itemId?: unknown;
  presentation?: { title?: unknown; detail?: unknown } | null;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const time = (value: unknown): number | null => (typeof value === "number" ? value : null);

const TOOL_WORDS: Record<string, string> = {
  command: "Bash",
  "file-read": "Read",
  "file-edit": "Edit",
  "file-write": "Write",
  "file-change": "Edit",
  search: "Search",
  "web-search": "WebSearch",
  "web-fetch": "WebFetch",
  delegation: "Agent",
};

/** The word for what a child row does: Bash for a command, the tool's own name otherwise. */
export function toolWord(row: Row): string | null {
  const name = text(row.toolName);
  if (row.workKind === "tool" && name !== null) return name;
  const kind = text(row.workKind);
  if (kind === null) return name;
  return TOOL_WORDS[kind] ?? name ?? kind;
}

/** "Explore agent · model haiku · effort medium" → kind, and "haiku · medium" for the model. */
function parseDetail(detail: string | null): { kind: string | null; model: string | null } {
  let kind: string | null = null;
  const model: string[] = [];
  for (const part of (detail ?? "").split("·").map((piece) => piece.trim())) {
    if (part === "") continue;
    if (/^(model|effort|reasoning)\s+/i.test(part)) model.push(part.replace(/^\S+\s+/, ""));
    else if (kind === null) kind = part;
    else model.push(part);
  }
  return { kind, model: model.length === 0 ? null : model.join(" · ") };
}

function stateOf(status: unknown): AgentState {
  if (status === "pending") return "running";
  if (status === "completed") return "done";
  return "error";
}

/** The tool the agent is in: its last pending child row, else its last one. */
function currentTool(row: Row): string | null {
  if (!Array.isArray(row.childRows)) return null;
  const children = row.childRows as Row[];
  const current = [...children].reverse().find((child) => child.status === "pending") ?? children.at(-1);
  return current === undefined ? null : toolWord(current);
}

/** When an agent's own work last ended: its last child row, for a background agent. */
function lastActivity(row: Row): number | null {
  if (!Array.isArray(row.childRows)) return null;
  const ends = (row.childRows as Row[]).map((child) => time(child.completedAt) ?? time(child.startedAt) ?? 0);
  return ends.length === 0 ? null : Math.max(...ends);
}

/**
 * A delegation row. A background one closes as soon as the agent is launched;
 * whether it still works is in `running` (bb's active background tasks, by
 * description), and its end is its last child row.
 */
function toAgent(row: Row, running: Map<string, number>): Agent | null {
  const id = text(row.callId) ?? text(row.id);
  const startedAt = time(row.startedAt);
  if (id === null || startedAt === null) return null;
  const { kind, model } = parseDetail(text(row.presentation?.detail));
  const name = text(row.description) ?? text(row.presentation?.title) ?? "Agent";
  let state = stateOf(row.status);
  let endedAt = state === "running" ? null : time(row.completedAt);
  if (row.background === true) {
    const key = text(row.childRef) ?? id;
    const left = running.get(key) ?? 0;
    if (left > 0) {
      running.set(key, left - 1);
      state = "running";
      endedAt = null;
    } else if (state === "done") {
      state = "unknown";
      endedAt = null;
    }
  }
  return {
    id,
    name,
    kind: text(row.subagentType) ?? kind,
    model,
    state,
    tool: state === "running" ? currentTool(row) : null,
    startedAt,
    endedAt,
  };
}

/**
 * Every delegation among the rows, oldest first. `active` is bb's list of
 * background work still going (the timeline's `activeBackgroundCommands`);
 * an agent there with no delegation row in sight gets a strip of its own.
 */
export function agentsFromRows(rows: readonly unknown[], active: readonly unknown[] = []): Agent[] {
  const running = new Map<string, number>();
  const orphans: Row[] = [];
  for (const item of [...active, ...rows.filter(value => value !== null && typeof value === "object" && (value as Row).kind === "work" && (value as Row).workKind === "workflow")]) {
    if (item === null || typeof item !== "object") continue;
    const task = item as Row;
    const description = text(task.description) ?? text(task.presentation?.title);
    if (task.taskType !== "local_agent" || description === null || (task.taskStatus !== "running" && task.taskStatus !== "pending" && task.taskStatus !== undefined)) continue;
    const id = text(task.itemId) ?? text(task.id);
    if (id !== null) running.set(id, (running.get(id) ?? 0) + 1);
    orphans.push(task);
  }
  const found: Agent[] = [];
  for (const item of rows) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Row;
    if (row.kind !== "work" || row.workKind !== "delegation") continue;
    const agent = toAgent(row, running);
    if (agent !== null) found.push(agent);
  }
  for (const value of rows) {
    if (!value || typeof value !== "object") continue;
    const task = value as Row;
    if (task.kind !== "work" || task.workKind !== "workflow" || task.taskType !== "local_agent") continue;
    const itemId = text(task.itemId);
    if (!itemId) continue;
    const launch = rows.find(value => value && typeof value === "object" && (value as Row).workKind === "delegation" && (value as Row).childRef === itemId) as Row | undefined;
    const existing = found.find(agent => agent.id === (text(launch?.callId) ?? text(launch?.id)));
    const state: AgentState = task.taskStatus === "failed" ? "error" : task.taskStatus === "completed" ? "done" : task.taskStatus === "running" || task.taskStatus === "pending" ? "running" : "unknown";
    if (existing) { existing.state = state; existing.endedAt = state === "running" ? null : time(task.completedAt); if (state !== "running") existing.tool = null; }
    else found.push({ id: itemId, name: text(task.description) ?? "Background agent", kind: "background agent", model: null, state, tool: null, startedAt: time(task.startedAt) ?? 0, endedAt: state === "running" ? null : time(task.completedAt) });
    running.set(itemId, 0);
  }
  for (const task of orphans) {
    const description = text(task.description) ?? text(task.presentation?.title)!;
    const key = text(task.itemId) ?? text(task.id);
    const left = key === null ? 1 : (running.get(key) ?? 0);
    const startedAt = time(task.startedAt);
    if (left === 0 || startedAt === null) continue;
    if (key !== null) running.set(key, left - 1);
    found.push({
      id: text(task.itemId) ?? text(task.id) ?? description,
      name: description,
      kind: "background agent",
      model: null,
      state: "running",
      tool: null,
      startedAt,
      endedAt: null,
    });
  }
  return found.sort((a, b) => a.startedAt - b.startedAt);
}

/** The agents worth a strip: running ones, and finished ones for `keepMs` after they ended (an error 24 times that). */
export function visibleAgents(agents: readonly Agent[], now: number, keepMs: number): Agent[] {
  return agents.filter((agent) => {
    if (agent.state === "running" || agent.state === "error" || agent.state === "unknown") return true;
    const keep = keepMs;
    return now - (agent.endedAt ?? agent.startedAt) < keep;
  });
}

const PROVIDERS: Record<string, string> = { "claude-code": "Claude", codex: "Codex", pi: "Pi" };

/** What bb says of a child thread (`bb thread spawn --parent-self`), and the model it was started with. */
export interface ChildThread {
  id: string;
  title: string | null;
  titleFallback?: string | null;
  providerId: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

/** A child thread as a strip: "Codex · gpt-6.1-terra · medium" in place of a bare model, state from the thread's status. */
export function agentFromChild(thread: ChildThread, execution: { model?: unknown; reasoningLevel?: unknown } | null): Agent {
  const provider = PROVIDERS[thread.providerId] ?? thread.providerId;
  // "openrouter/anthropic/claude-haiku-5.5" is long for a strip: keep the model's own name
  const model = text(execution?.model)?.split("/").pop() ?? null;
  const parts = [model, text(execution?.reasoningLevel)];
  const state: AgentState =
    thread.status === "error" ? "error" : thread.status === "idle" ? "unknown" : "running";
  return {
    id: thread.id,
    name: text(thread.title) ?? text(thread.titleFallback) ?? "Thread",
    kind: provider,
    model: parts.filter((part): part is string => part !== null).join(" · ") || null,
    state,
    tool: null,
    startedAt: thread.createdAt,
    endedAt: state === "running" ? null : thread.updatedAt,
    threadId: thread.id,
  };
}
