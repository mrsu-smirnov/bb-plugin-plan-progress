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
  /** the reminder may go out now: in "on-start" mode a main work call began
   * after armedSeq; in "between-calls" mode one completed after it with no
   * call left open */
  continued?: boolean;
  /** ids of main-agent tool calls started and not yet completed in this root turn. Absent before 0.6.2 ACP mode. */
  open?: string[];
  /** open is complete: every start of this root turn was seen. Absent (old state) counts as false. */
  openKnown?: boolean;
}
export function newReminderState(now: number): ReminderState {
  return { since: now, lastSeq: 0, work: 0, sinceUpdate: 0, hasPlan: false, sent: false,
    turnId: null, finished: false, rootConfirmed: false, delivery: "not-attempted", attemptedAt: null, armedSeq: null, continued: false,
    open: [], openKnown: true };
}

/** When an armed reminder may go out. A steer message does not interrupt a
 * running call for these providers (probes 25.11), so it can be sent as soon
 * as the next call begins. Any other provider (ACP, Pi, unknown) gets it only
 * between calls: a Kimi ACP probe saw it interrupt a running command. */
export const START_RELEASE_PROVIDERS: readonly string[] = ["claude-code", "codex", "opencode2"];
export type ReleaseMode = "on-start" | "between-calls";
export function releaseModeFor(providerId: string | null | undefined): ReleaseMode {
  return typeof providerId === "string" && START_RELEASE_PROVIDERS.includes(providerId) ? "on-start" : "between-calls";
}

const WORK_TYPES = ["fileRead", "fileChange", "commandExecution", "toolCall", "mcpToolCall"];
// Everything a steer message could cut short. Reasoning and messages are not
// calls (in ACP a reasoning item may never complete), background tasks run
// detached from the turn.
const CALL_TYPES = [...WORK_TYPES, "webSearch", "webFetch", "search", "imageView", "imageGeneration", "delegation"];
const MAX_OPEN = 200;
type Row = { seq: number; createdAt: number; type: string;
  scope?: {kind?: string; turnId?: string};
  data?: { item?: { id?: unknown; type?: string; tool?: string; status?: string; result?: {isError?: boolean} } } };
/** A main-agent tool call began: the reminder must not be sent "between calls" now. */
export function isCallStart(event: unknown): boolean {
  const row = event as Row | null;
  return !!row && row.type === "item/started" && isMainEvent(row) && CALL_TYPES.includes(row.data?.item?.type ?? "");
}
const thresholdMet = (s: ReminderState) => (!s.hasPlan && s.work >= 3) || (s.hasPlan && s.sinceUpdate >= 6);
// Arm when the threshold is first reached; disarm when it is no longer met.
function arm(state: ReminderState, seq: number) {
  if (!thresholdMet(state)) { state.armedSeq = null; state.continued = false; }
  else if (state.armedSeq == null) { state.armedSeq = seq; state.continued = false; }
}

/** `gap`: events between the saved state and this batch may be missing, so
 * calls started there are unknown; "between-calls" stays silent until the
 * next observed root start. The default mode is the safe one. */
export function observeWork(state: ReminderState, events: unknown[], mode: ReleaseMode = "between-calls",
    options: {gap?: boolean} = {}): boolean {
  arm(state, state.lastSeq); // saved state from before 0.6.2 carries no armedSeq
  if (!Array.isArray(state.open)) state.open = [];
  if (options.gap) state.openKnown = false;
  for (const event of events) {
    const row = event as Row;
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
    const call = row.data?.item;
    if (row.type === "item/started") {
      if (isCallStart(row)) {
        // A provider may report one call's start several times.
        if (typeof call?.id !== "string" || state.open!.length >= MAX_OPEN) { state.openKnown = false; state.open = []; }
        else if (!state.open!.includes(call.id)) state.open!.push(call.id);
        // Between calls: wait for this call (and any other) to complete.
        if (mode === "between-calls") state.continued = false;
      }
      // The reminder is only worth sending when the work goes on: a provider
      // hands it to the agent at the next boundary, after a final answer
      // otherwise. A call that began before the threshold does not count.
      if (mode === "on-start" && state.armedSeq != null && row.seq > state.armedSeq && call &&
          call.tool !== "ToolSearch" && startedProgressSource(row) === null &&
          WORK_TYPES.includes(call.type ?? "")) state.continued = true;
      continue;
    }
    if (row.type === "item/completed" && CALL_TYPES.includes(call?.type ?? "")) {
      const at = typeof call?.id === "string" ? state.open!.indexOf(call.id) : -1;
      // A completion whose start was never seen: other starts may be missing too.
      if (at < 0) state.openKnown = false; else state.open!.splice(at, 1);
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
    // Between calls: the next work call after the threshold has completed and
    // nothing else is running, so a steer cannot cut a call short.
    if (mode === "between-calls" && state.armedSeq != null && row.seq > state.armedSeq &&
        state.openKnown === true && state.open!.length === 0) state.continued = true;
  }
  const quiet = mode === "on-start" || (state.openKnown === true && state.open!.length === 0);
  return (state.turnId === null || state.rootConfirmed) && !state.finished && !state.sent && thresholdMet(state) &&
    state.continued === true && quiet;
}
