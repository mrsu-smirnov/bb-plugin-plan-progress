// bb-plugin-plan-progress — frontend.
//
// One segment in the context row above a thread's composer: the current bar
// with its fill and count. Expanded, it lists every bar of the thread with its
// stages and steps. Bars come from server.ts over RPC and refetch on the
// "bars-changed" realtime signal.
import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  BARS_CHANGED,
  counts,
  type Bar,
  type BarState,
  type Stage,
  type Step,
  type StepStatus,
} from "./engine";
import { cn } from "@/lib/utils";

/** The thread's bars, kept current by the server's realtime signal. */
function useBars(threadId: string): Bar[] | null {
  const rpc = useRpc<typeof rpcContract>();
  const [bars, setBars] = useState<Bar[] | null>(null);
  const refetch = useCallback(() => {
    rpc.call("bars_get", { threadId }).then(
      (result) => setBars(result.bars),
      () => setBars((current) => current ?? []),
    );
  }, [rpc, threadId]);
  useEffect(() => {
    setBars(null);
    refetch();
  }, [refetch]);
  useRealtime(BARS_CHANGED, (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId) refetch();
  });
  return bars;
}

/** Ticks once a second while `running`, for elapsed times. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const STATE_FILL: Record<BarState, string> = {
  working: "bg-primary",
  needs_input: "bg-amber-500",
  failed: "bg-destructive",
  done: "bg-emerald-500",
};

const STATE_TEXT: Record<BarState, string> = {
  working: "text-primary",
  needs_input: "text-amber-600 dark:text-amber-400",
  failed: "text-destructive",
  done: "text-emerald-600 dark:text-emerald-400",
};

const STATE_LABEL: Record<BarState, string> = {
  working: "Working",
  needs_input: "Needs your answer",
  failed: "Error",
  done: "Done",
};

/** The bar the row shows: the latest unfinished one, else the latest. */
function currentBar(bars: readonly Bar[]): Bar | undefined {
  const byUpdate = [...bars].sort((a, b) => b.updatedAt - a.updatedAt);
  return byUpdate.find((bar) => bar.state !== "done") ?? byUpdate[0];
}

function StateGlyph({ state, className }: { state: BarState; className?: string }) {
  const common = cn("inline-block size-3.5 shrink-0", STATE_TEXT[state], className);
  if (state === "working") {
    return (
      <span className={cn(common, "relative")} aria-label={STATE_LABEL[state]} role="img">
        <span className="absolute inset-[3px] animate-ping rounded-full bg-current opacity-60" />
        <span className="absolute inset-[3px] rounded-full bg-current" />
      </span>
    );
  }
  const path =
    state === "done"
      ? "M3.5 8.5l3 3 6-7"
      : state === "failed"
        ? "M4.5 4.5l7 7M11.5 4.5l-7 7"
        : "M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4M8 11.7v.1";
  return (
    <svg viewBox="0 0 16 16" className={common} aria-label={STATE_LABEL[state]} role="img">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function stepFill(status: StepStatus, state: BarState): string {
  if (status === "done") return STATE_FILL[state === "done" ? "done" : "working"];
  if (status === "failed") return "bg-destructive";
  if (status === "active") return cn(STATE_FILL[state], "animate-pulse");
  return "bg-muted-foreground/20";
}

/** Stages as capsules, steps as segments inside them. */
function Track({ bar, className }: { bar: Bar; className?: string }) {
  return (
    <div className={cn("flex h-1.5 min-w-0 gap-[3px]", className)} aria-hidden>
      {bar.stages.map((stage, stageIndex) => (
        <div
          key={stageIndex}
          className="flex h-full min-w-0 gap-px overflow-hidden rounded-full"
          style={{ flexGrow: stage.steps.length, flexBasis: 0 }}
        >
          {stage.steps.map((step, stepIndex) => (
            <div
              key={stepIndex}
              className={cn("h-full min-w-0 flex-1", stepFill(step.status, bar.state))}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function percent(bar: Bar): number {
  const { done, total } = counts(bar);
  return total === 0 ? 0 : Math.round((done / total) * 100);
}

function Summary(props: ExperimentalThreadContextSegmentProps) {
  const bars = useBars(props.threadId) ?? [];
  const bar = currentBar(bars);
  if (bar === undefined) return null;
  const { done, total } = counts(bar);
  const others = bars.length - 1;
  return (
    <button
      type="button"
      onClick={props.onToggle}
      aria-expanded={props.isExpanded}
      title={`${bar.title}: ${STATE_LABEL[bar.state]}, ${done} of ${total}`}
      className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <StateGlyph state={bar.state} />
      <span className="max-w-[12rem] truncate font-medium text-foreground">{bar.title}</span>
      <Track bar={bar} className="w-20 sm:w-28" />
      <span className="tabular-nums">
        {done}/{total}
      </span>
      {others > 0 ? <span className="tabular-nums">+{others}</span> : null}
    </button>
  );
}

function StepRow({ step, state, now }: { step: Step; state: BarState; now: number }) {
  const time =
    step.startedAt === undefined
      ? null
      : formatDuration((step.endedAt ?? now) - step.startedAt);
  return (
    <li className="flex items-center gap-2 py-0.5">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          step.status === "pending" ? "bg-muted-foreground/30" : stepFill(step.status, state),
        )}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          step.status === "active" && "font-medium text-foreground",
          step.status === "done" && "text-muted-foreground",
          step.status === "failed" && "text-destructive",
        )}
      >
        {step.title}
      </span>
      {time === null || step.status === "pending" ? null : (
        <span className="shrink-0 tabular-nums text-muted-foreground">{time}</span>
      )}
    </li>
  );
}

function StageBlock({ stage, state, now }: { stage: Stage; state: BarState; now: number }) {
  const finished = stage.steps.every((step) => step.status === "done");
  return (
    <div>
      {stage.name === "" ? null : (
        <div
          className={cn(
            "mb-0.5 text-[11px] font-medium uppercase tracking-wide",
            finished ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {stage.name}
        </div>
      )}
      <ul>
        {stage.steps.map((step, index) => (
          <StepRow key={index} step={step} state={state} now={now} />
        ))}
      </ul>
    </div>
  );
}

function BarCard({
  bar,
  now,
  onDismiss,
}: {
  bar: Bar;
  now: number;
  onDismiss: () => void;
}) {
  const elapsed = formatDuration((bar.endedAt ?? now) - bar.createdAt);
  return (
    <div className="rounded-lg border border-border bg-card p-2.5">
      <div className="flex items-center gap-2">
        <StateGlyph state={bar.state} />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{bar.title}</span>
        <span className={cn("shrink-0", STATE_TEXT[bar.state])}>{STATE_LABEL[bar.state]}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {percent(bar)}% · {elapsed}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Close "${bar.title}"`}
          title="Close"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
            <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <Track bar={bar} className="mt-2" />
      {bar.note === undefined ? null : (
        <p className={cn("mt-2", STATE_TEXT[bar.state])}>{bar.note}</p>
      )}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {bar.stages.map((stage, index) => (
          <StageBlock key={index} stage={stage} state={bar.state} now={now} />
        ))}
      </div>
    </div>
  );
}

function Details(props: ExperimentalThreadContextSegmentProps) {
  const rpc = useRpc<typeof rpcContract>();
  const bars = useBars(props.threadId) ?? [];
  const now = useNow(props.isExpanded && bars.some((bar) => bar.state !== "done"));
  if (!props.isExpanded || bars.length === 0) return null;
  const ordered = [...bars].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto px-1 pb-1 text-xs">
      {ordered.map((bar) => (
        <BarCard
          key={bar.id}
          bar={bar}
          now={now}
          onDismiss={() => {
            void rpc.call("bars_dismiss", { threadId: props.threadId, id: bar.id });
          }}
        />
      ))}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadContextSegment({
    id: "plan-progress",
    title: "Plan progress",
    // Between bb's parent thread ("1_thread") and changed files ("3_git").
    group: "2_planProgress",
    summary: Summary,
    details: Details,
    useVisible: ({ threadId }) => (useBars(threadId)?.length ?? 0) > 0,
  });
});
