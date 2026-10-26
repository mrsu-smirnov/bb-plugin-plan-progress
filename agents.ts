// Subagent strips: what bb's timeline says about the agents the main agent
// started (its "delegation" rows), reduced to one line each. Pure, so tests
// can feed it timeline rows directly.

/** Realtime channel: payload `{ threadId, agents }` when a thread's agents change. */
export const AGENTS_CHANGED = "agents-changed";

export type AgentState = "running" | "done" | "error";

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
    const left = running.get(name) ?? 0;
    if (left > 0) {
      running.set(name, left - 1);
      state = "running";
      endedAt = null;
    } else if (state === "done") {
      endedAt = lastActivity(row) ?? endedAt;
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
  for (const item of active) {
    if (item === null || typeof item !== "object") continue;
    const task = item as Row;
    const description = text(task.description) ?? text(task.presentation?.title);
    if (task.taskType !== "local_agent" || description === null) continue;
    running.set(description, (running.get(description) ?? 0) + 1);
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
  for (const task of orphans) {
    const description = text(task.description) ?? text(task.presentation?.title)!;
    const left = running.get(description) ?? 0;
    const startedAt = time(task.startedAt);
    if (left === 0 || startedAt === null) continue;
    running.set(description, left - 1);
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
    if (agent.state === "running") return true;
    const keep = agent.state === "error" ? keepMs * 24 : keepMs;
    return now - (agent.endedAt ?? agent.startedAt) < keep;
  });
}
