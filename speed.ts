// The answer speed, tok/s, from a thread's event log.
//
// The original reads Claude Code's stream piece by piece and gets each
// response's exact output_tokens. A bb plugin sees less: the main run's text,
// thinking and tool calls as they land in the log (Claude Code hands them over
// in bursts, a block at a time), and the exact output tokens once, at the end
// of the main run, and not on every turn. So the live figure is an estimate,
// the way the original's live figure is too: characters written, at a
// tokens-per-character ratio the exact counts taught, over the time the model
// spent writing them.
//
// The model writes from the turn's start, or from a tool's result, until its
// last piece; the time a tool runs is not writing. A block landing at once
// after a silence was written during that silence, so a stretch runs from
// where the model started to its latest piece. The figure is the average over
// the latest minute of writing: all its tokens over all its time.

/** One stored thread event, as `threads.events.list` returns it. */
export type SpeedEvent = {
  seq: number;
  type: string;
  createdAt: number;
  data?: unknown;
};

/** The event types the meter reads. */
export const SPEED_EVENT_TYPES = [
  "turn/started",
  "turn/completed",
  "turn/mainRun/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "thread/tokenUsage/updated",
] as const;

export type Speed = {
  /** Tokens per second, or null before a second of writing. */
  rate: number | null;
  /** The figure stands on the exact output tokens, not on the estimate. */
  exact: boolean;
};

const HISTORY_MS = 60_000;
/** Before any exact count: Russian text, tool calls and JSON came to ~0.4–0.6 tokens a character in bb. */
const DEFAULT_TOKENS_PER_CHAR = 0.4;
const MAX_RATIOS = 12;

/** Items that are the model's own writing; every other item is a tool it called. */
const WRITING = new Set(["agentMessage", "reasoning"]);
/** Items bb adds for work going on elsewhere (a background agent), not a call of the model's. */
const ASIDE = new Set(["backgroundTask"]);
/** Fields of a tool item the model did not write. */
const NOT_WRITTEN = new Set([
  "id",
  "type",
  "status",
  "presentation",
  "approvalStatus",
  "cwd",
  "aggregatedOutput",
  "result",
  "summary",
  "output",
  "exitCode",
  "durationMs",
  "childRef",
  "background",
]);

type Item = { type?: unknown; id?: unknown; text?: unknown; content?: unknown; summary?: unknown };
type Stretch = { chars: number; ms: number; turn: number };
type Done = { tokens: number; ms: number };

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** What a tool call's arguments come to, in characters: the part of it the model wrote. */
export function toolChars(item: Record<string, unknown>): number {
  const written: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) if (!NOT_WRITTEN.has(key)) written[key] = value;
  return JSON.stringify(written).length;
}

const textChars = (item: Item): number => {
  const parts = [item.text, ...(Array.isArray(item.content) ? item.content : []), ...(Array.isArray(item.summary) ? item.summary : [])];
  return parts.reduce<number>((sum, part) => sum + (typeof part === "string" ? part.length : 0), 0);
};

export class SpeedMeter {
  /** Finished turns with an exact count, newest last. */
  private done: Done[] = [];
  /** Stretches of turns without an exact count yet (the running one included). */
  private stretches: Stretch[] = [];
  private turn = 0;
  /** Where the model started writing the current stretch; null while a tool runs or before the turn. */
  private from: number | null = null;
  private chars = 0;
  private last = 0;
  private tools = new Set<string>();
  /** Characters of an item already counted from its deltas. */
  private seen = new Map<string, number>();
  private ratios: number[];
  /** The latest exact turn is the newest thing in the window. */
  private isExact = false;

  constructor(ratios: number[] = []) {
    this.ratios = ratios.filter((r) => r >= 0.1 && r <= 1.5).slice(-MAX_RATIOS);
  }

  /** The tokens-per-character ratios learned so far, to keep between sessions. */
  learned(): number[] {
    return [...this.ratios];
  }

  private perChar(): number {
    if (this.ratios.length === 0) return DEFAULT_TOKENS_PER_CHAR;
    const sorted = [...this.ratios].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)]!;
  }

  private startTurn(t: number) {
    this.closeStretch();
    this.turn += 1;
    this.from = t;
    this.tools.clear();
    this.seen.clear();
  }

  /** The current stretch ends at its latest piece. */
  private closeStretch(at = this.last) {
    if (this.from !== null && this.chars > 0 && at > this.from) {
      this.stretches.push({ chars: this.chars, ms: at - this.from, turn: this.turn });
    }
    this.from = null;
    this.chars = 0;
  }

  private write(chars: number, t: number) {
    if (chars <= 0) return;
    if (this.from === null) this.from = t;
    this.chars += chars;
    this.last = t;
    this.isExact = false;
  }

  feed(event: SpeedEvent): void {
    const data = record(event.data);
    // a subagent's work streams on its own model: the figure is the main conversation's, as in the original
    if (typeof data.parentToolCallId === "string") return;
    const t = event.createdAt;
    if (this.turn === 0 && event.type !== "turn/started") this.startTurn(t);
    switch (event.type) {
      case "turn/started":
        this.startTurn(t);
        return;
      case "item/agentMessage/delta":
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const delta = typeof data.delta === "string" ? data.delta : "";
        const id = String(data.itemId ?? "");
        this.seen.set(id, (this.seen.get(id) ?? 0) + delta.length);
        this.write(delta.length, t);
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = record(data.item) as Item & Record<string, unknown>;
        const kind = String(item.type ?? "");
        const id = String(item.id ?? "");
        if (ASIDE.has(kind)) return;
        if (WRITING.has(kind)) {
          // whatever of the block its deltas did not bring
          if (event.type === "item/completed") this.write(textChars(item) - (this.seen.get(id) ?? 0), t);
          return;
        }
        if (event.type === "item/started") {
          // the model wrote the call, then waits for its result
          this.write(toolChars(item), t);
          this.closeStretch(t);
          this.tools.add(id);
        } else if (this.tools.delete(id) && this.tools.size === 0) {
          this.from = t;
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = record(record(data.tokenUsage).last);
        const tokens = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
        this.closeStretch();
        this.settle(tokens);
        return;
      }
      case "turn/mainRun/updated":
        if (data.state === "idle") this.closeStretch();
        return;
      case "turn/completed":
        this.closeStretch();
        return;
    }
  }

  /** The turn's exact output tokens: they replace its estimate, and teach the ratio. */
  private settle(tokens: number) {
    const own = this.stretches.filter((s) => s.turn === this.turn);
    const chars = own.reduce((sum, s) => sum + s.chars, 0);
    const ms = own.reduce((sum, s) => sum + s.ms, 0);
    if (tokens < 20 || ms < 1000) return;
    if (chars >= 200) {
      const ratio = tokens / chars;
      if (ratio >= 0.1 && ratio <= 1.5) {
        this.ratios.push(ratio);
        if (this.ratios.length > MAX_RATIOS) this.ratios.shift();
      }
    }
    // the exact count covers this turn and any earlier one still waiting for its own
    const older = this.stretches.filter((s) => s.turn < this.turn);
    const olderMs = older.reduce((sum, s) => sum + s.ms, 0);
    const olderTokens = older.reduce((sum, s) => sum + s.chars, 0) * this.perChar();
    if (olderMs > 0) this.done.push({ tokens: olderTokens, ms: olderMs });
    this.done.push({ tokens, ms });
    this.stretches = [];
    this.isExact = true;
    let total = this.done.reduce((sum, d) => sum + d.ms, 0);
    while (this.done.length > 1 && total - this.done[0]!.ms >= HISTORY_MS) total -= this.done.shift()!.ms;
  }

  /** The average over the latest minute of writing, the stretch under way included up to its latest piece. */
  speed(): Speed {
    const k = this.perChar();
    const live: Done[] = this.stretches.map((s) => ({ tokens: s.chars * k, ms: s.ms }));
    if (this.from !== null && this.chars > 0 && this.last > this.from) {
      live.push({ tokens: this.chars * k, ms: this.last - this.from });
    }
    // newest first, until a minute of writing is in
    const window: Done[] = [];
    let ms = 0;
    for (const part of [...this.done, ...live].reverse()) {
      if (ms >= HISTORY_MS) break;
      window.push(part);
      ms += part.ms;
    }
    const tokens = window.reduce((sum, part) => sum + part.tokens, 0);
    return { rate: ms >= 1000 ? tokens / (ms / 1000) : null, exact: this.isExact && live.length === 0 };
  }
}

/** "⚡ ≈ 42 tok/s": one decimal under ten, as in the original. */
export function speedLabel(speed: Speed): string {
  const value = speed.rate === null ? "–" : speed.rate < 10 ? speed.rate.toFixed(1) : String(Math.round(speed.rate));
  return `⚡ ${speed.exact || speed.rate === null ? "" : "≈ "}${value} tok/s`;
}
