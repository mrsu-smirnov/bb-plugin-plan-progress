import { isMainEvent, progressSource } from "./diagnostics.ts";

export interface ReminderState {
  since: number;
  lastSeq: number;
  work: number;
  sinceUpdate: number;
  hasPlan: boolean;
  sent: boolean;
  turnId: string | null;
  finished: boolean;
  rootConfirmed: boolean;
  delivery: "not-attempted" | "unknown" | "sent" | "send-error" | "skipped";
  attemptedAt: number | null;
}
export function newReminderState(now: number): ReminderState {
  return { since: now, lastSeq: 0, work: 0, sinceUpdate: 0, hasPlan: false, sent: false,
    turnId: null, finished: false, rootConfirmed: false, delivery: "not-attempted", attemptedAt: null };
}

export function observeWork(state: ReminderState, events: unknown[]): boolean {
  for (const event of events) {
    const row = event as { seq: number; createdAt: number; type: string;
      scope?: {kind?: string; turnId?: string};
      data?: { item?: { type?: string; tool?: string; status?: string; result?: {isError?: boolean} } } };
    if (row.seq <= state.lastSeq || !isMainEvent(row)) continue;
    // Only a proven new root start resets the budget. Late items from an
    // older turn must never rearm a reminder for that turn.
    if (row.type === "turn/started" && row.scope?.kind === "turn" &&
        typeof row.scope.turnId === "string" && row.scope.turnId !== state.turnId) {
      if (row.createdAt < state.since) continue;
      Object.assign(state, newReminderState(row.createdAt), {turnId: row.scope.turnId, lastSeq: state.lastSeq, rootConfirmed: true});
    }
    if (row.scope?.kind === "turn" && row.scope.turnId !== state.turnId) {
      // An old saved root is not proof of the currently active root when a
      // bounded window contains another turn without its start. Stay cautious
      // until a proven new start, even if more old items arrive afterwards.
      state.rootConfirmed = false;
      continue;
    }
    if (row.createdAt < state.since) continue;
    state.lastSeq = row.seq;
    if (row.type === "turn/completed") { state.finished = true; continue; }
    const source = progressSource(row);
    if (source === "bb") {
      const item = row.data?.item;
      if (item?.status !== "failed" && item?.result?.isError !== true) {
        state.hasPlan = true; state.sinceUpdate = 0;
      }
      continue;
    }
    if (row.type !== "item/completed") continue;
    const item = row.data?.item;
    if (!item || item.tool === "ToolSearch" || source === "claude-original") continue;
    if (!["fileRead", "fileChange", "commandExecution", "toolCall", "mcpToolCall"].includes(item.type ?? "")) continue;
    state.work++;
    state.sinceUpdate++;
  }
  return (state.turnId === null || state.rootConfirmed) && !state.finished && !state.sent && ((!state.hasPlan && state.work >= 3) || (state.hasPlan && state.sinceUpdate >= 6));
}
