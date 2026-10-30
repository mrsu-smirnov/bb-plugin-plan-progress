import type { Bar } from "./engine.ts";

export const VISIBLE_PLANS = 3;

/** Questions and errors first, then the most recently updated work. */
export function orderedPlans(bars: readonly Bar[]): Bar[] {
  const rank = { needs_input: 0, error: 1, running: 2, done: 3 };
  return [...bars].sort((a, b) => rank[a.state] - rank[b.state] || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function dueToHide(bar: Bar, now: number, seconds: number, hasRunningAgents: boolean): boolean {
  return bar.hidden === undefined && bar.state === "done" && bar.endedAt !== undefined &&
    bar.autoCloseHandledAt !== bar.endedAt && !hasRunningAgents && now - bar.endedAt >= seconds * 1000;
}
