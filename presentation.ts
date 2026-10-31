import type { Bar } from "./engine.ts";

export const VISIBLE_PLANS = 3;

/** Questions and errors first, then the most recently updated work. */
export function orderedPlans(bars: readonly Bar[]): Bar[] {
  const rank = { needs_input: 0, error: 1, running: 2, done: 3 };
  return [...bars].sort((a, b) => rank[a.state] - rank[b.state] || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export type VisibilityReason = "hidden-manually" | "hidden-automatically" | "needs-input" | "error" |
  "plan-open" | "auto-close-off" | "finish-time-unknown" | "restored-finish" |
  "waiting-for-agents" | "waiting-for-delay" | "eligible-to-hide";

/** Conditions from one snapshot, not proof a browser has already hidden a row. */
export function visibilityReason(bar: Bar, now: number, seconds: number, hasRunningAgents: boolean | null, autoClose = true): VisibilityReason | "agents-unknown" {
  if (bar.hidden !== undefined) return bar.hidden === "manual" ? "hidden-manually" : "hidden-automatically";
  if (bar.state === "needs_input") return "needs-input";
  if (bar.state === "error") return "error";
  if (bar.state !== "done") return "plan-open";
  if (!autoClose) return "auto-close-off";
  if (bar.endedAt === undefined) return "finish-time-unknown";
  if (bar.autoCloseHandledAt === bar.endedAt) return "restored-finish";
  if (hasRunningAgents === null) return "agents-unknown";
  if (hasRunningAgents) return "waiting-for-agents";
  if (now - bar.endedAt < seconds * 1000) return "waiting-for-delay";
  return "eligible-to-hide";
}

export function dueToHide(bar: Bar, now: number, seconds: number, hasRunningAgents: boolean): boolean {
  return visibilityReason(bar, now, seconds, hasRunningAgents) === "eligible-to-hide";
}
