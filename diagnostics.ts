export const DIAGNOSTICS_CHANGED = "diagnostics-changed";
export type ProgressSource = "bb" | "claude-original" | null;
export interface ProgressDiagnostic {
  source: ProgressSource;
  lastCallSeq: number;
  warning: string | null;
  lastOutcome?: "completed" | "failed" | "unknown";
  lastCallAt?: number | null;
}
export const NO_DIAGNOSTIC: ProgressDiagnostic = { source: null, lastCallSeq: 0, warning: null };

/** Native helper events can have an agent scope without parentToolCallId. */
export function isMainEvent(event: unknown): boolean {
  const row = event as { scope?: { kind?: string }; data?: { parentToolCallId?: unknown; item?: {parentToolCallId?: unknown} } } | null;
  return !!row && (!row.scope || row.scope.kind === "turn") &&
    !row.data?.parentToolCallId && !row.data?.item?.parentToolCallId;
}

// Only main-agent completed tool calls count. Subagents have their own progress.
export function progressSource(event: unknown): ProgressSource {
  const row = event as { type?: string; data?: { item?: {
    type?: string; tool?: string; server?: string; result?: unknown;
    presentation?: {icon?: {glyph?: string}};
  } } } | null;
  if (row?.type !== "item/completed" || !isMainEvent(row)) return null;
  const item = row.data?.item;
  if (item?.type !== "toolCall") return null;
  if (item.tool === "mcp__plan-progress__plan_progress" ||
    (item.tool === "plan_progress" && item.server === "plan-progress")) return "claude-original";
  if (item.tool === "mcp__bb-bridge__plan_progress" ||
    (item.tool === "plan_progress" && typeof item.result === "string" && item.result.startsWith("BB/")) ||
    (item.tool === "plan_progress" && (item.server === "bb-bridge" || item.server === "bb" ||
      item.presentation?.icon?.glyph === "ListTodo"))) return "bb";
  return null;
}

export function advanceDiagnostic(previous: ProgressDiagnostic, events: unknown[]): ProgressDiagnostic {
  let next = previous;
  for (const event of events) {
    const row = event as { seq?: number; createdAt?: number; data?: {item?: {status?: string; result?: {isError?: boolean}}} };
    const source = progressSource(event);
    if (!source || typeof row.seq !== "number" || row.seq <= next.lastCallSeq) continue;
    const item = row.data?.item;
    next = {
      source, lastCallSeq: row.seq,
      lastOutcome: item?.status === "failed" || item?.result?.isError === true ? "failed" :
        item?.status === "completed" ? "completed" : "unknown",
      lastCallAt: typeof row.createdAt === "number" ? row.createdAt : null,
      warning: source === "claude-original"
        ? "The agent sent its plan to the Claude Code plugin. Use the BB progress tool to show it here."
        : null,
    };
  }
  return next;
}
