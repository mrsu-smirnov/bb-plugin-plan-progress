// The bar model and the plan_progress protocol, free of any BB API so tests
// can run it directly. The protocol follows zycck's plan-progress mod for
// Claude Code (https://github.com/zycck/claude-mods, MIT): send the whole plan
// once, then move it with short ops.

/** Realtime channel: payload `{ threadId }` after any change to that thread's bars. */
export const BARS_CHANGED = "bars-changed";

export type StepStatus = "pending" | "active" | "done" | "failed";
export type BarState = "working" | "needs_input" | "failed" | "done";

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
  status?: StepStatus;
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
  state?: BarState;
}

export type ApplyResult =
  | { ok: true; bars: Bar[]; bar: Bar }
  | { ok: false; error: string };

export const LIMITS = {
  barsPerThread: 12,
  stages: 12,
  stepsPerStage: 30,
  text: 120,
  note: 500,
};

const clip = (text: string, max: number) => text.trim().slice(0, max);
const key = (title: string) => title.trim().toLowerCase();

export function allSteps(bar: Bar): Step[] {
  return bar.stages.flatMap((stage) => stage.steps);
}

export function counts(bar: Bar): { done: number; total: number } {
  const steps = allSteps(bar);
  return {
    done: steps.filter((step) => step.status === "done").length,
    total: steps.length,
  };
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

function stepList(bar: Bar): string {
  return bar.stages
    .map((stage) => {
      const steps = stage.steps.map((step) => `"${step.title}"`).join(", ");
      return stage.name === "" ? steps : `${stage.name}: ${steps}`;
    })
    .join("; ");
}

/** A title the bar does not have is refused; a title used twice means the open one. */
function findStep(bar: Bar, title: string): Step | string {
  const matches = allSteps(bar).filter((step) => key(step.title) === key(title));
  if (matches.length === 0) {
    return `Bar "${bar.id}" has no step "${title}". Its steps: ${stepList(bar)}`;
  }
  return matches.find((step) => step.status !== "done") ?? matches[0]!;
}

function buildStages(op: Op): Stage[] | string {
  const input: StageInput[] =
    op.stages ?? (op.steps === undefined ? [] : [{ name: "", steps: op.steps }]);
  if (input.length === 0) return "A plan needs at least one step.";
  if (input.length > LIMITS.stages) return `At most ${LIMITS.stages} stages.`;
  const stages: Stage[] = [];
  for (const stage of input) {
    if (stage.steps.length === 0) return `Stage "${stage.name}" has no steps.`;
    if (stage.steps.length > LIMITS.stepsPerStage) {
      return `Stage "${stage.name}" has more than ${LIMITS.stepsPerStage} steps.`;
    }
    stages.push({
      name: clip(stage.name, LIMITS.text),
      steps: stage.steps.map((step) => ({
        title: clip(step.title, LIMITS.text),
        status: step.status ?? "pending",
      })),
    });
  }
  return stages;
}

function activate(step: Step, now: number): void {
  step.status = "active";
  step.startedAt = now;
  delete step.endedAt;
}

function finish(step: Step, status: "done" | "failed", now: number): void {
  if (step.status === status) return;
  step.status = status;
  step.startedAt ??= now;
  step.endedAt = now;
}

/** Exactly one active step while the bar has open ones: the first open step. */
function settleActive(bar: Bar, now: number): void {
  const steps = allSteps(bar);
  let seen = false;
  for (const step of steps) {
    if (step.status !== "active") continue;
    if (seen) step.status = "pending";
    seen = true;
    step.startedAt ??= now;
  }
  if (!seen && bar.state !== "done") {
    const first = steps.find((step) => step.status === "pending");
    if (first !== undefined) activate(first, now);
  }
}

/** Resend `stages` under the same id: steps without a status keep done by title. */
function replan(existing: Bar | undefined, op: Op, stages: Stage[], now: number): Bar | string {
  const title = op.title === undefined ? existing?.title : clip(op.title, LIMITS.text);
  if (title === undefined || title === "") return "A new bar needs a title.";
  const kind = op.kind ?? (op.stages === undefined ? "todo" : "plan");
  // A finished bar, or another title under the same id, is the next task.
  const fresh =
    existing === undefined || existing.state === "done" || existing.title !== title;
  if (!fresh) {
    const previous = new Map(allSteps(existing).map((step) => [key(step.title), step]));
    for (const step of stages.flatMap((stage) => stage.steps)) {
      const old = previous.get(key(step.title));
      if (old === undefined) continue;
      if (step.status === "pending" && (old.status === "done" || old.status === "active")) {
        step.status = old.status;
        step.startedAt = old.startedAt;
        step.endedAt = old.endedAt;
      }
    }
  }
  for (const step of stages.flatMap((stage) => stage.steps)) {
    if (step.status === "done" || step.status === "failed") {
      step.startedAt ??= now;
      step.endedAt ??= now;
    }
  }
  const bar: Bar = {
    id: op.id,
    title,
    kind,
    state: "working",
    stages,
    createdAt: fresh ? now : existing.createdAt,
    updatedAt: now,
  };
  settleActive(bar, now);
  return bar;
}

function copyBar(bar: Bar): Bar {
  return structuredClone(bar);
}

export function applyOp(bars: readonly Bar[], op: Op, now: number): ApplyResult {
  const id = clip(op.id, 64);
  if (id === "") return { ok: false, error: "id is required." };
  op = { ...op, id };
  const index = bars.findIndex((bar) => bar.id === id);
  const existing = index === -1 ? undefined : bars[index];

  let bar: Bar;
  if (op.stages !== undefined || op.steps !== undefined) {
    const stages = buildStages(op);
    if (typeof stages === "string") return { ok: false, error: stages };
    const planned = replan(existing, op, stages, now);
    if (typeof planned === "string") return { ok: false, error: planned };
    bar = planned;
  } else if (existing === undefined) {
    const known = bars.map((candidate) => `"${candidate.id}"`).join(", ");
    return {
      ok: false,
      error:
        `No bar "${id}". Create it first with {id, title, stages:[{name, steps:[{title}]}]}.` +
        (known === "" ? "" : ` Bars in this thread: ${known}.`),
    };
  } else {
    bar = copyBar(existing);
  }

  const progressed =
    op.next === true || (op.done?.length ?? 0) > 0 || op.active !== undefined;

  for (const title of op.done ?? []) {
    const step = findStep(bar, title);
    if (typeof step === "string") return { ok: false, error: step };
    finish(step, "done", now);
  }

  if (op.active !== undefined) {
    const target = findStep(bar, op.active);
    if (typeof target === "string") return { ok: false, error: target };
    let before = true;
    for (const step of allSteps(bar)) {
      if (step === target) {
        before = false;
        activate(step, now);
      } else if (before && step.status !== "done") {
        finish(step, "done", now);
      } else if (!before && step.status === "active") {
        step.status = "pending";
      }
    }
  }

  if (op.next === true) {
    const steps = allSteps(bar);
    const at = steps.findIndex((step) => step.status === "active");
    if (at !== -1) finish(steps[at]!, "done", now);
    const following = steps.slice(at + 1).find((step) => step.status === "pending");
    const first = following ?? steps.find((step) => step.status === "pending");
    if (first !== undefined) activate(first, now);
  }

  if (op.failed !== undefined) {
    const step = findStep(bar, op.failed);
    if (typeof step === "string") return { ok: false, error: step };
    finish(step, "failed", now);
  }

  // Moving forward clears a question or an error; an explicit state wins.
  if (op.failed !== undefined) bar.state = "failed";
  else if (progressed && bar.state !== "done") bar.state = "working";
  if (op.state !== undefined) bar.state = op.state;

  if (op.note !== undefined) bar.note = clip(op.note, LIMITS.note);
  else if (bar.state === "working") delete bar.note;

  if (bar.state === "done") {
    for (const step of allSteps(bar)) {
      if (step.status === "active" || step.status === "pending") finish(step, "done", now);
    }
  } else {
    settleActive(bar, now);
    const steps = allSteps(bar);
    if (steps.every((step) => step.status === "done") && bar.state === "working") {
      bar.state = "done";
    }
  }

  if (bar.state === "done") bar.endedAt ??= now;
  else delete bar.endedAt;
  bar.updatedAt = now;

  const next = bars.filter((candidate) => candidate.id !== id);
  next.splice(index === -1 ? next.length : index, 0, bar);
  // Keep the newest bars; finished ones leave first, never the one just moved.
  while (next.length > LIMITS.barsPerThread) {
    const finished = next.findIndex(
      (candidate) => candidate.state === "done" && candidate.id !== id,
    );
    const oldest = next.findIndex((candidate) => candidate.id !== id);
    next.splice(finished === -1 ? oldest : finished, 1);
  }
  return { ok: true, bars: next, bar };
}
