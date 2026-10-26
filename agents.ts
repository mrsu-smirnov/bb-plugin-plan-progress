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

/** "Explore agent · model haiku" → kind and model. */
function parseDetail(detail: string | null): { kind: string | null; model: string | null } {
  let kind: string | null = null;
  let model: string | null = null;
  for (const part of (detail ?? "").split("·").map((piece) => piece.trim())) {
    if (part === "") continue;
    if (/^model\s+/i.test(part)) model = part.replace(/^model\s+/i, "");
    else kind ??= part;
  }
  return { kind, model };
}

function stateOf(status: unknown): AgentState {
  if (status === "pending") return "running";
  if (status === "completed") return "done";
  return "error";
}

function toAgent(row: Row): Agent | null {
  const id = text(row.callId) ?? text(row.id);
  const startedAt = time(row.startedAt);
  if (id === null || startedAt === null) return null;
  const { kind, model } = parseDetail(text(row.presentation?.detail));
  const state = stateOf(row.status);
  let tool: string | null = null;
  if (state === "running" && Array.isArray(row.childRows)) {
    const children = row.childRows as Row[];
    const current = [...children].reverse().find((child) => child.status === "pending") ?? children.at(-1);
    tool = current === undefined ? null : toolWord(current);
  }
  return {
    id,
    name: text(row.description) ?? text(row.presentation?.title) ?? "Agent",
    kind: text(row.subagentType) ?? kind,
    model,
    state,
    tool,
    startedAt,
    endedAt: state === "running" ? null : time(row.completedAt),
  };
}

/** Every delegation among the rows (nested ones included), oldest first. */
export function agentsFromRows(rows: readonly unknown[]): Agent[] {
  const found: Agent[] = [];
  const walk = (list: readonly unknown[]) => {
    for (const item of list) {
      if (item === null || typeof item !== "object") continue;
      const row = item as Row;
      if (row.kind === "work" && row.workKind === "delegation") {
        const agent = toAgent(row);
        if (agent !== null) found.push(agent);
      }
    }
  };
  walk(rows);
  return found.sort((a, b) => a.startedAt - b.startedAt);
}

/** The agents worth a strip: running ones, and finished ones for `keepMs` after they ended (an error four times that). */
export function visibleAgents(agents: readonly Agent[], now: number, keepMs: number): Agent[] {
  return agents.filter((agent) => {
    if (agent.state === "running") return true;
    const keep = agent.state === "error" ? keepMs * 4 : keepMs;
    return now - (agent.endedAt ?? agent.startedAt) < keep;
  });
}
