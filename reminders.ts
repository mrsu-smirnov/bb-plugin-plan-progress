import { isMainEvent, progressSource, startedProgressSource, progressOutcome } from "./diagnostics.ts";

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
  /** seq at which the threshold was reached; null while below it. Absent in saved state from before 0.6.2. */
  armedSeq?: number | null;
  /** a main-thread work call began after armedSeq, so the turn is still going */
  continued?: boolean;
}
export function newReminderState(now: number): ReminderState {
  return { since: now, lastSeq: 0, work: 0, sinceUpdate: 0, hasPlan: false, sent: false,
    turnId: null, finished: false, rootConfirmed: false, delivery: "not-attempted", attemptedAt: null, armedSeq: null, continued: false };
}

const WORK_TYPES = ["fileRead", "fileChange", "commandExecution", "toolCall", "mcpToolCall"];
const thresholdMet = (s: ReminderState) => (!s.hasPlan && s.work >= 3) || (s.hasPlan && s.sinceUpdate >= 6);
// Arm when the threshold is first reached; disarm when it is no longer met.
function arm(state: ReminderState, seq: number) {
  if (!thresholdMet(state)) { state.armedSeq = null; state.continued = false; }
  else if (state.armedSeq == null) { state.armedSeq = seq; state.continued = false; }
}

export function observeWork(state: ReminderState, events: unknown[]): boolean {
  arm(state, state.lastSeq); // saved state from before 0.6.2 carries no armedSeq
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
    if (row.type === "item/started") {
      // The reminder is only worth sending when the work goes on: a provider
      // hands it to the agent at the next boundary, after a final answer
      // otherwise. A call that began before the threshold does not count.
      const started = row.data?.item;
      if (state.armedSeq != null && row.seq > state.armedSeq && started &&
          started.tool !== "ToolSearch" && startedProgressSource(row) === null &&
          WORK_TYPES.includes(started.type ?? "")) state.continued = true;
      continue;
    }
    const source = progressSource(row);
    if (source === "bb") {
      if (progressOutcome(row) === "completed") {
        state.hasPlan = true; state.sinceUpdate = 0;
        arm(state, row.seq);
      }
      continue;
    }
    if (row.type !== "item/completed") continue;
    const item = row.data?.item;
    if (!item || item.tool === "ToolSearch" || source === "claude-original") continue;
    if (!WORK_TYPES.includes(item.type ?? "")) continue;
    state.work++;
    // with a bar already there, reading is not work the bar has fallen behind on
    if (!(state.hasPlan && item.type === "fileRead")) state.sinceUpdate++;
    arm(state, row.seq);
  }
  return (state.turnId === null || state.rootConfirmed) && !state.finished && !state.sent && thresholdMet(state) && state.continued === true;
}
