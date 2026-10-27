export const DIAGNOSTICS_CHANGED = "diagnostics-changed";
export type ProgressSource = "bb" | "claude-original" | null;
export interface ProgressDiagnostic {
  source: ProgressSource;
  lastCallSeq: number;
  warning: string | null;
}
export const NO_DIAGNOSTIC: ProgressDiagnostic = { source: null, lastCallSeq: 0, warning: null };

// Only main-agent completed tool calls count. Subagents have their own progress.
export function progressSource(event: unknown): ProgressSource {
  const row = event as { type?: string; data?: { parentToolCallId?: unknown; item?: {
    type?: string; tool?: string; server?: string; result?: unknown; parentToolCallId?: unknown;
  } } } | null;
  if (row?.type !== "item/completed" || row.data?.parentToolCallId) return null;
  const item = row.data?.item;
  if (item?.type !== "toolCall" || item.parentToolCallId) return null;
  if (item.tool === "mcp__plan-progress__plan_progress" ||
    (item.tool === "plan_progress" && item.server === "plan-progress")) return "claude-original";
  if (item.tool === "mcp__bb-bridge__plan_progress" ||
    (item.tool === "plan_progress" && typeof item.result === "string" && item.result.startsWith("BB/")) ||
    (item.tool === "plan_progress" && (item.server === "bb-bridge" || item.server === "bb"))) return "bb";
  return null;
}

export function advanceDiagnostic(previous: ProgressDiagnostic, events: unknown[]): ProgressDiagnostic {
  let next = previous;
  for (const event of events) {
    const seq = (event as { seq?: number }).seq;
    const source = progressSource(event);
    if (!source || typeof seq !== "number" || seq <= next.lastCallSeq) continue;
    next = {
      source, lastCallSeq: seq,
      warning: source === "claude-original"
        ? "The agent sent its plan to the Claude Code plugin. Use the BB progress tool to show it here."
        : null,
    };
  }
  return next;
}
