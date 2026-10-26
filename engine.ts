// The bar model and the plan_progress protocol, free of any BB API so tests
// can run it directly. A port of the op semantics of zycck's plan-progress mod
// for Claude Code (https://github.com/zycck/claude-mods, MIT; applyOps,
// normalize, carryDone, pointAt, isNextTask and placeBar in its register.tsx),
// so an agent that knows the original's rules gets the same bar here.

/** Realtime channel: payload `{ threadId }` after any change to that thread's bars. */
export const BARS_CHANGED = "bars-changed";

export type StepStatus = "pending" | "active" | "done" | "error" | "skipped";
export type BarState = "running" | "needs_input" | "error" | "done";

export interface Step {
  title: string;
  status: StepStatus;
  startedAt?: number;
  endedAt?: number;
}

export interface Stage {
  name: string;
  steps: Step[];
}

export interface Bar {
  id: string;
  title: string;
  kind: "plan" | "todo";
  state: BarState;
  note?: string;
  stages: Stage[];
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
}

export interface StepInput {
  title: string;
  status?: string;
}

export interface StageInput {
  name: string;
  steps: StepInput[];
}

export interface Op {
  id: string;
  title?: string;
  kind?: "plan" | "todo";
  stages?: StageInput[];
  /** A flat list: shorthand for one unnamed stage (kind "todo"). */
  steps?: StepInput[];
  next?: boolean;
  done?: string[];
  active?: string;
  failed?: string;
  note?: string;
  state?: string;
}

export type ApplyResult =
  | { ok: true; bars: Bar[]; bar: Bar }
  | { ok: false; error: string };

export const LIMITS = {
  barsPerThread: 12,
  stages: 12,
  stepsPerStage: 30,
  title: 80,
  step: 120,
  note: 500,
};

/** Names the original uses, and the ones this port used before, both accepted. */
export const STATE_NAMES = ["running", "needs_input", "error", "done", "working", "failed"] as const;
export const STEP_NAMES = ["pending", "active", "done", "error", "skipped", "failed"] as const;

export function stateOf(name: string | undefined): BarState | undefined {
  if (name === "working") return "running";
  if (name === "failed") return "error";
  return name === "running" || name === "needs_input" || name === "error" || name === "done"
    ? name
    : undefined;
}

function stepStatusOf(name: string | undefined): StepStatus {
  if (name === "failed") return "error";
  return name === "active" || name === "done" || name === "error" || name === "skipped" ? name : "pending";
}

/** Whitespace folded, control characters dropped, cut to `max`. */
function clip(value: string | undefined, max: number): string {
  return (value ?? "")
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001F\u007F-\u009F￾￿]/g, "")
    .trim()
    .slice(0, max)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd();
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const key = (title: string) => title.trim().toLowerCase();
export const isFinished = (status: StepStatus) => status === "done" || status === "skipped";

export function allSteps(bar: Pick<Bar, "stages">): Step[] {
  return bar.stages.flatMap((stage) => stage.steps);
}

export function counts(bar: Bar): { done: number; total: number } {
  const steps = allSteps(bar);
  return { done: steps.filter((step) => isFinished(step.status)).length, total: steps.length };
}

export function activeStep(bar: Bar): Step | undefined {
  return allSteps(bar).find((step) => step.status === "active");
}

/** The one-line answer the agent gets after every call. */
export function describe(bar: Bar): string {
  const { done, total } = counts(bar);
  const active = activeStep(bar);
  const parts = [`${bar.id} "${bar.title}": ${done}/${total} done`, bar.state];
  if (active !== undefined) parts.push(`active: ${active.title}`);
  return parts.join(", ");
}

const copyStages = (stages: readonly Stage[]): Stage[] =>
  stages.map((stage) => ({ ...stage, steps: stage.steps.map((step) => ({ ...step })) }));

/** Short ops against the plan: next, done, active, failed. Titles not found come back in `missing`. */
function applyOps(base: readonly Stage[], op: Op, now: number): { stages: Stage[]; missing: string[] } {
  const stages = copyStages(base);
  const steps = stages.flatMap((stage) => stage.steps);
  const missing: string[] = [];
  const finish = (step: Step) => {
    if (isFinished(step.status)) return;
    step.status = "done";
    step.startedAt ??= now;
    step.endedAt = now;
  };
  const reopen = (step: Step, to: StepStatus) => {
    step.status = to;
    delete step.endedAt;
    if (to === "active") step.startedAt = now;
  };
  const activate = (step: Step) => reopen(step, "active");
  // a title used twice means the one still open
  const find = (title: string) => {
    const found =
      steps.find((step) => same(step.title, title) && !isFinished(step.status)) ??
      steps.find((step) => same(step.title, title));
    if (found === undefined) missing.push(title);
    return found;
  };
  const named = typeof op.active === "string";

  if (op.next === true) {
    let at = steps.findIndex((step) => step.status === "active");
    if (at === -1) at = steps.findIndex((step) => !isFinished(step.status));
    const current = steps[at];
    if (current !== undefined) finish(current);
    // past the last step, work goes back to one left open earlier; a call that names the new step picks it itself
    const following =
      steps.slice(at + 1).find((step) => step.status === "pending") ??
      steps.find((step) => step.status === "pending");
    if (following !== undefined && !named) activate(following);
  }

  let lastDone = -1;
  for (const title of op.done ?? []) {
    const step = find(title);
    if (step?.status === "active") lastDone = steps.indexOf(step);
    if (step !== undefined) finish(step);
  }
  // finishing the step in progress moves on, as next does, unless the call names the new one
  if (lastDone >= 0 && !named && !steps.some((step) => step.status === "active")) {
    const following =
      steps.slice(lastDone + 1).find((step) => step.status === "pending") ??
      steps.find((step) => step.status === "pending");
    if (following !== undefined) activate(following);
  }

  if (named) {
    const target = find(op.active!);
    if (target !== undefined) {
      const at = steps.indexOf(target);
      // steps active before it count as done; pending and error ones stay as they were
      steps.forEach((step, index) => {
        if (step.status !== "active" || index === at) return;
        if (index < at) finish(step);
        else step.status = "pending";
      });
      activate(target);
    }
  }

  if (typeof op.failed === "string") {
    const step = find(op.failed);
    if (step !== undefined) reopen(step, "error");
  }

  return { stages, missing };
}

/** A resent plan keeps what was finished, matched by title. */
function carryDone(stages: Stage[], before: readonly Stage[]): Stage[] {
  const finished = new Map<string, Step[]>();
  for (const step of before.flatMap((stage) => stage.steps).filter((s) => isFinished(s.status))) {
    finished.set(key(step.title), [...(finished.get(key(step.title)) ?? []), step]);
  }
  return stages.map((stage) => ({
    ...stage,
    steps: stage.steps.map((step) => {
      const queue = finished.get(key(step.title));
      const was = queue?.[0];
      if (queue === undefined || was === undefined || !(step.status === "pending" || step.status === was.status)) {
        return step;
      }
      queue.shift();
      return { ...step, status: was.status, startedAt: was.startedAt, endedAt: was.endedAt };
    }),
  }));
}

/** With nothing in progress, the first open step is the current one. */
function pointAt(stages: Stage[], now: number): Stage[] {
  const steps = stages.flatMap((stage) => stage.steps);
  if (steps.some((step) => step.status === "active" || step.status === "error")) return stages;
  const first = steps.find((step) => step.status === "pending");
  return stages.map((stage) => ({
    ...stage,
    steps: stage.steps.map((step) => (step === first ? { ...step, status: "active" as const, startedAt: now } : step)),
  }));
}

/**
 * A whole plan sent to a finished bar: another task when it has another
 * title or leaves out a step the last one finished. One keeping the title and
 * every finished step is the plan grown after it finished, and carries over.
 * The same plan again with no statuses (at most its first step active) and no
 * new step is a new run of it.
 */
function isNextTask(prev: Bar, title: string, stages: Stage[]): boolean {
  if (prev.state !== "done") return false;
  if (title !== "" && !same(title, prev.title)) return true;
  const steps = stages.flatMap((stage) => stage.steps);
  const sent = new Set(steps.map((step) => key(step.title)));
  const finished = allSteps(prev).filter((step) => isFinished(step.status));
  if (finished.length === 0 || finished.some((step) => !sent.has(key(step.title)))) return true;
  const left = new Map<string, number>();
  for (const step of allSteps(prev)) left.set(key(step.title), (left.get(key(step.title)) ?? 0) + 1);
  const isGrown = steps.some((step) => {
    const n = left.get(key(step.title)) ?? 0;
    left.set(key(step.title), n - 1);
    return n <= 0;
  });
  return (
    !isGrown &&
    steps.length > 0 &&
    steps.every((step, index) => step.status === "pending" || (step.status === "active" && index === 0))
  );
}

function buildStages(op: Op): Stage[] | string {
  const input: StageInput[] =
    op.stages ?? (op.steps === undefined ? [] : [{ name: "", steps: op.steps }]);
  if (input.length > LIMITS.stages) return `At most ${LIMITS.stages} stages.`;
  const stages: Stage[] = [];
  for (const stage of input) {
    if (stage.steps.length > LIMITS.stepsPerStage) {
      return `Stage "${clip(stage.name, 60)}" has more than ${LIMITS.stepsPerStage} steps.`;
    }
    if (stage.steps.length === 0) continue;
    stages.push({
      name: op.stages === undefined ? "" : clip(stage.name, LIMITS.title) || "Stage",
      steps: stage.steps.map((step) => ({
        title: clip(step.title, LIMITS.step) || "Step",
        status: stepStatusOf(step.status),
      })),
    });
  }
  return stages;
}

/** Adds or replaces one bar; past the cap, finished bars go first, then running ones; a question or an error stays. */
function placeBar(list: readonly Bar[], next: Bar): Bar[] {
  const rest = list.some((bar) => bar.id === next.id)
    ? list.map((bar) => (bar.id === next.id ? next : bar))
    : [...list, next];
  const pick = (ok: (bar: Bar) => boolean) => rest.findIndex((bar) => bar.id !== next.id && ok(bar));
  while (rest.length > LIMITS.barsPerThread) {
    const at =
      [pick((bar) => bar.state === "done"), pick((bar) => bar.state === "running"), pick(() => true)].find(
        (index) => index >= 0,
      ) ?? 0;
    rest.splice(at, 1);
  }
  return rest;
}

export function applyOp(bars: readonly Bar[], op: Op, now: number): ApplyResult {
  const id = clip(op.id, 64);
  if (id === "") return { ok: false, error: "id is required." };
  const prev = bars.find((bar) => bar.id === id) ?? null;

  const sent = buildStages(op);
  if (typeof sent === "string") return { ok: false, error: sent };
  const isPartial = sent.length === 0 && prev !== null;
  if (sent.length === 0 && prev === null) {
    const known = bars.map((bar) => `"${bar.id}"`).join(", ");
    return {
      ok: false,
      error:
        `No bar "${id}". Create it first with {id, title, stages:[{name, steps:[{title}]}]}.` +
        (known === "" ? "" : ` Bars in this thread: ${known}.`),
    };
  }
  const sentTitle = clip(op.title, LIMITS.title);
  // the next task under a finished bar's id carries nothing over; the same plan grown by a step does
  const was = prev !== null && !isPartial && isNextTask(prev, sentTitle, sent) ? null : prev;
  const base = isPartial ? prev!.stages : pointAt(was !== null ? carryDone(sent, was.stages) : sent, now);
  const { stages, missing } = applyOps(base, op, now);
  if (missing.length > 0) {
    const titles = allSteps({ stages })
      .map((step) => `"${step.title}"`)
      .join(", ");
    return {
      ok: false,
      error: `Bar "${id}" has no step ${missing.map((title) => `"${clip(title, 60)}"`).join(", ")}. Its steps: ${titles}`,
    };
  }

  const steps = allSteps({ stages });
  const isAllDone = steps.length > 0 && steps.every((step) => isFinished(step.status));
  // an op without a state works it out again: a question or an error clears with the next call
  const state: BarState =
    stateOf(op.state) ?? (isAllDone ? "done" : typeof op.failed === "string" ? "error" : "running");
  if (state === "done") {
    for (const step of steps) {
      if (step.status === "active" || step.status === "pending") {
        step.status = "done";
        step.startedAt ??= now;
        step.endedAt = now;
      }
    }
  }
  const note = clip(op.note, LIMITS.note);
  const bar: Bar = {
    id,
    title: sentTitle || prev?.title || "Plan",
    kind: op.kind ?? (isPartial ? prev!.kind : op.stages === undefined ? "todo" : "plan"),
    state,
    stages,
    createdAt: was?.createdAt ?? now,
    updatedAt: now,
  };
  if (note !== "") bar.note = note;
  if (state === "done") bar.endedAt = was?.state === "done" ? (was.endedAt ?? now) : now;

  return { ok: true, bars: placeBar(bars, bar), bar };
}

/** The person answered: a bar waiting on them goes back to work (or done, when nothing is left). */
export function answered(bars: readonly Bar[], now: number): Bar[] | null {
  if (!bars.some((bar) => bar.state === "needs_input")) return null;
  return bars.map((bar) => {
    if (bar.state !== "needs_input") return bar;
    const steps = allSteps(bar);
    const isAllDone = steps.length > 0 && steps.every((step) => isFinished(step.status));
    const next: Bar = { ...bar, state: isAllDone ? "done" : "running", updatedAt: now };
    delete next.note;
    if (isAllDone) next.endedAt = now;
    return next;
  });
}
