import { progressSource } from "./diagnostics.ts";

export interface ReminderState {
  since: number;
  lastSeq: number;
  work: number;
  sinceUpdate: number;
  hasPlan: boolean;
  sent: boolean;
}
export function newReminderState(now: number): ReminderState {
  return { since: now, lastSeq: 0, work: 0, sinceUpdate: 0, hasPlan: false, sent: false };
}

export function observeWork(state: ReminderState, events: unknown[]): boolean {
  for (const event of events) {
    const row = event as { seq: number; createdAt: number; type: string;
      data?: { parentToolCallId?: unknown; item?: { type?: string; tool?: string; parentToolCallId?: unknown } } };
    if (row.seq <= state.lastSeq || row.createdAt < state.since) continue;
    state.lastSeq = row.seq;
    const source = progressSource(row);
    if (source === "bb") { state.hasPlan = true; state.sinceUpdate = 0; continue; }
    if (row.type !== "item/completed" || row.data?.parentToolCallId || row.data?.item?.parentToolCallId) continue;
    const item = row.data?.item;
    if (!item || item.tool === "ToolSearch" || source === "claude-original") continue;
    if (!["fileRead", "fileChange", "commandExecution", "toolCall", "mcpToolCall"].includes(item.type ?? "")) continue;
    state.work++;
    state.sinceUpdate++;
  }
  return !state.sent && ((!state.hasPlan && state.work >= 3) || (state.hasPlan && state.sinceUpdate >= 6));
}
