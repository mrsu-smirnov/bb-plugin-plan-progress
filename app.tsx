// bb-plugin-plan-progress — frontend.
//
// A banner above a thread's composer with one row per bar: state dot, title,
// the track, percent, a fold button for the step list, and close. The track
// follows zycck's plan-progress drawing: a grey pill, a fill tinted with the
// state colour that streams with dots, stage capsules and step dots, and a
// solid pill at the head naming the stage and step (the elapsed time while the
// pointer is on the track). Bars come from server.ts over RPC and refetch on
// the "bars-changed" realtime signal.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  definePluginApp,
  useComposer,
  useRealtime,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  BARS_CHANGED,
  allSteps,
  counts,
  type Bar,
  type BarState,
  type Stage,
  type Step,
} from "./engine";
import { cn } from "@/lib/utils";

// ---------- data ----------

/** The thread's bars, kept current by the server's realtime signal. */
function useBars(threadId: string | null): Bar[] {
  const rpc = useRpc<typeof rpcContract>();
  const [bars, setBars] = useState<Bar[]>([]);
  const refetch = useCallback(() => {
    if (threadId === null) return;
    rpc.call("bars_get", { threadId }).then(
      (result) => setBars(result.bars),
      () => undefined,
    );
  }, [rpc, threadId]);
  useEffect(() => {
    setBars([]);
    refetch();
  }, [refetch]);
  useRealtime(BARS_CHANGED, (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId) refetch();
  });
  return bars;
}

interface Options {
  effects: boolean;
  autoClose: boolean;
  autoCloseSeconds: number;
  sounds: boolean;
}

function useOptions(): Options {
  const { values } = useSettings();
  return {
    effects: values?.effects !== false,
    autoClose: values?.autoClose === true,
    autoCloseSeconds: Number(values?.autoCloseSeconds ?? 30) || 30,
    sounds: values?.sounds === true,
  };
}

/** Ticks once a second while `running`. */
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

function elapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  return sec < 3600
    ? `${Math.floor(sec / 60)}m ${sec % 60}s`
    : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

// ---------- colours (the original's) ----------

const STATE_COLOR: Record<BarState, string> = {
  working: "#7858CA",
  needs_input: "#AD6400",
  failed: "#C5353E",
  done: "#18883A",
};

const STATE_LABEL: Record<BarState, string> = {
  working: "Working",
  needs_input: "Needs your answer",
  failed: "Error",
  done: "Done",
};

type Rgb = [number, number, number];
const hex = (color: string): Rgb => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) as Rgb;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((v, i) => Math.round(v + (b[i]! - v) * t)) as Rgb;
const rgb = (c: Rgb, alpha = 1) => `rgba(${c.join(",")},${alpha})`;
const WHITE: Rgb = [255, 255, 255];

// ---------- the stream: dots, a slow wave, a twinkle ----------

const COLS = 233; // the wave's length in 3 px columns, prime so its loop does not show
const SPEED = 20; // columns a second; a bar at rest streams at half that

/** Deterministic noise in [0, 1). */
function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a + 1, 374761393) ^ Math.imul(b + 7, 668265263) ^ Math.imul(c + 13, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const svgUrl = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

const DOTS = svgUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"><rect width="2" height="2" fill="#fff"/></svg>`,
);

/** Noise smoothed into blobs a few columns wide: where the wave lets dots show. */
const WAVE = (() => {
  const raw = Array.from({ length: COLS }, (_, i) => hash(i, 0, 5));
  const runs: string[] = [];
  for (let i = 0; i < COLS; i++) {
    let sum = 0;
    for (let d = -3; d <= 3; d++) sum += raw[(i + d + COLS) % COLS]!;
    const level = sum / 7;
    if (level > 0.5) runs.push(`<rect x="${i * 3}" width="3" height="22" fill="#fff" fill-opacity="${Math.min(1, (level - 0.5) * 5).toFixed(2)}"/>`);
  }
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${COLS * 3}" height="22">${runs.join("")}</svg>`);
})();

/** Four sparse dot tiles that blink on their own beats. */
const FLICKER = [0, 1, 2, 3].map((k) => {
  const cells: string[] = [];
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 7; y++) {
      if (hash(x, y, 20 + k) < 0.09) cells.push(`<rect x="${x * 3}" y="${y * 3}" width="2" height="2" fill="#fff"/>`);
    }
  }
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="21">${cells.join("")}</svg>`);
});

const STYLE = `
@keyframes pp-wave { from { mask-position: 0 0; -webkit-mask-position: 0 0 } to { mask-position: -${COLS * 3}px 0; -webkit-mask-position: -${COLS * 3}px 0 } }
@keyframes pp-blink { 0%, 100% { opacity: 0 } 20% { opacity: .35 } 45% { opacity: .9 } 60% { opacity: .2 } 80% { opacity: .65 } }
.pp-glide { transition: width .3s cubic-bezier(.2,.8,.2,1), left .3s cubic-bezier(.2,.8,.2,1), transform .3s cubic-bezier(.2,.8,.2,1), background-color .4s; }
.pp-wave { animation: pp-wave var(--pp-wave-dur) steps(${COLS}) infinite; }
.pp-blink { animation: pp-blink var(--pp-blink-dur) step-end infinite; animation-delay: var(--pp-blink-delay); opacity: 0; }
.pp-track .pp-clock { display: none; }
.pp-track:hover .pp-clock { display: inline; }
.pp-track:hover .pp-label { display: none; }
.pp-mark .pp-tip { opacity: 0; transition: opacity .12s; pointer-events: none; }
.pp-mark:hover .pp-tip { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .pp-wave, .pp-blink { animation: none; } .pp-glide { transition: none; } }
`;

function mask(image: string, extra: CSSProperties = {}): CSSProperties {
  return { maskImage: image, WebkitMaskImage: image, ...extra } as CSSProperties;
}

function Stream({ bar, light, effects }: { bar: Bar; light: Rgb; effects: boolean }) {
  const speed = bar.state === "working" ? SPEED : SPEED / 2;
  const dots: CSSProperties = {
    position: "absolute",
    inset: 0,
    top: 1,
    backgroundColor: rgb(light),
    ...mask(DOTS, { maskSize: "3px 3px", WebkitMaskSize: "3px 3px" } as CSSProperties),
  };
  return (
    <>
      {/* the wave: dots where its blobs pass, fading in along the fill */}
      <div className="absolute inset-0" style={mask("linear-gradient(90deg, transparent 0, #000 67%)")}>
        <div
          className={cn("absolute inset-0", effects && "pp-wave")}
          style={{
            ...mask(WAVE, { maskSize: `${COLS * 3}px 22px`, WebkitMaskSize: `${COLS * 3}px 22px`, maskRepeat: "repeat-x" } as CSSProperties),
            ["--pp-wave-dur" as string]: `${(COLS / speed).toFixed(1)}s`,
          }}
        >
          <div style={dots} />
        </div>
      </div>
      {/* the twinkle: sparse dots blinking towards the head */}
      {effects ? (
        <div
          className="absolute inset-0"
          style={mask("linear-gradient(90deg, transparent 0, transparent 15%, rgba(0,0,0,.45) 50%, rgba(0,0,0,.9) 80%, #000)")}
        >
          {FLICKER.map((tile, k) => (
            <div
              key={k}
              className="pp-blink absolute inset-0"
              style={{
                top: 1,
                backgroundColor: rgb(light),
                ...mask(tile, { maskSize: "48px 21px", WebkitMaskSize: "48px 21px" } as CSSProperties),
                ["--pp-blink-dur" as string]: `${[2.2, 2.8, 1.9, 3.3][k]! * (bar.state === "done" ? 1.5 : 1)}s`,
                ["--pp-blink-delay" as string]: `-${[0, 0.7, 1.3, 0.4][k]}s`,
              }}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

// ---------- the track ----------

const ICON_PATH: Partial<Record<BarState, string>> = {
  needs_input: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01",
  failed: "M18 6 6 18M6 6l12 12",
  done: "M20 6 9 17l-5-5",
};

/** Where the head is: how many steps are behind it, and the stage and step it stands on. */
function head(bar: Bar) {
  const steps = allSteps(bar);
  const total = steps.length;
  const done = steps.filter((step) => step.status === "done").length;
  let index = steps.findIndex((step) => step.status === "active" || step.status === "failed");
  if (index === -1) index = steps.findIndex((step) => step.status === "pending");
  let start = 0;
  let stage = bar.stages.length - 1;
  for (let i = 0; i < bar.stages.length; i++) {
    const size = bar.stages[i]!.steps.length;
    if (index < start + size) {
      stage = i;
      break;
    }
    start += size;
  }
  return { total, done, stage, first: index === start, step: index === -1 ? undefined : steps[index] };
}

interface MarkInfo {
  at: number;
  isStage: boolean;
  passed: boolean;
  label: string;
}

/** A mark sits between steps: a capsule at a stage boundary, a dot between steps. */
function marks(bar: Bar, fill: number): MarkInfo[] {
  const total = allSteps(bar).length;
  const list: MarkInfo[] = [];
  let k = 0;
  bar.stages.forEach((stage, i) => {
    stage.steps.forEach((step, j) => {
      if (k > 0) {
        const at = k / total;
        const isStage = j === 0;
        const passed = at < fill - 0.001;
        const before = isStage ? bar.stages[i - 1] : stage;
        const ended: Step | undefined = isStage ? before?.steps.at(-1) : stage.steps[j - 1];
        // a passed mark names what ended there and how long it took; one ahead names what starts there
        let label = passed ? (isStage ? (before?.name ?? "") : (ended?.title ?? "")) : isStage ? stage.name : step.title;
        if (passed && ended?.startedAt !== undefined && ended.endedAt !== undefined) {
          label += ` · ${elapsed(ended.endedAt - ended.startedAt)}`;
        }
        list.push({ at, isStage, passed, label: label || step.title });
      }
      k++;
    });
  });
  return list;
}

function Track({ bar, now, effects }: { bar: Bar; now: number; effects: boolean }) {
  const acc = hex(STATE_COLOR[bar.state]);
  const light = mix(acc, WHITE, 0.32);
  const where = head(bar);
  const fill = bar.state === "done" ? 1 : where.total === 0 ? 0 : where.done / where.total;
  const pct = `${(fill * 100).toFixed(2)}%`;
  const icon = ICON_PATH[bar.state];
  const single = bar.stages.length === 1;
  const stageName = bar.stages[where.stage]?.name ?? "";
  const name =
    bar.state === "done"
      ? elapsed((bar.endedAt ?? now) - bar.createdAt)
      : single
        ? stageName || where.step?.title || ""
        : stageName;
  const asks = (bar.state === "needs_input" || bar.state === "failed") && bar.note !== undefined;
  const step = asks || bar.state === "done" || (single && stageName === "") ? undefined : where.step?.title;
  const label = asks ? bar.note! : name;
  const markList = useMemo(() => marks(bar, fill), [bar, fill]);
  const passedMark = rgb(mix(light, WHITE, 0.45), 0.9);

  return (
    <div className="pp-track relative h-[22px] min-w-0 flex-1">
      <div className="absolute inset-0 overflow-hidden rounded-full" style={{ backgroundColor: "rgba(128,128,128,.16)" }}>
        <div
          className="pp-glide absolute inset-y-0 left-0 overflow-hidden"
          style={{ width: pct, background: `linear-gradient(90deg, ${rgb(acc, 0.05)}, ${rgb(acc, 0.33)})` }}
        >
          <Stream bar={bar} light={light} effects={effects} />
        </div>
      </div>
      {markList.map((mark, index) => (
        <div
          key={index}
          className="pp-mark absolute inset-y-0 flex w-2.5 -translate-x-1/2 items-center justify-center"
          style={{ left: `${(mark.at * 100).toFixed(2)}%` }}
        >
          <span
            className={mark.isStage ? "h-2.5 w-[3px] rounded-full" : "size-[3px] rounded-full"}
            style={{ backgroundColor: mark.passed ? passedMark : "rgba(168,166,158,.85)" }}
          />
          <span className="pp-tip absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-full bg-popover px-2 py-0.5 text-[11px] text-popover-foreground shadow-md ring-1 ring-border">
            {mark.label}
          </span>
        </div>
      ))}
      {/* the head: a solid pill with the stage and step, kept inside the track */}
      <div
        className="pp-glide absolute inset-y-0 flex max-w-[55%] items-center gap-1.5 rounded-full px-2.5 text-white"
        style={{ left: pct, transform: `translateX(-${pct})`, backgroundColor: STATE_COLOR[bar.state] }}
      >
        {icon === undefined ? null : (
          <svg viewBox="0 0 24 24" className="size-3 shrink-0" aria-hidden>
            <path d={icon} fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        <span className="pp-label flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          <span className="truncate text-xs font-medium">{label}</span>
          {step === undefined || step === label ? null : (
            <>
              <span
                className={cn(
                  "shrink-0 rounded-full",
                  where.first ? "h-2.5 w-0.5 bg-white/70" : "size-[3px] bg-white/80",
                )}
              />
              <span className="min-w-0 truncate text-[11px] opacity-95">{step}</span>
            </>
          )}
        </span>
        <span className="pp-clock whitespace-nowrap text-xs font-medium tabular-nums">
          {elapsed((bar.endedAt ?? now) - bar.createdAt)}
        </span>
      </div>
    </div>
  );
}

// ---------- the step list ----------

function StepRow({ step, color, now }: { step: Step; color: string; now: number }) {
  const time =
    step.startedAt === undefined || step.status === "pending"
      ? null
      : elapsed((step.endedAt ?? now) - step.startedAt);
  const dot =
    step.status === "done"
      ? color
      : step.status === "failed"
        ? STATE_COLOR.failed
        : step.status === "active"
          ? color
          : "rgba(168,166,158,.5)";
  return (
    <li className="flex items-center gap-2 py-0.5">
      <span
        className={cn("size-1.5 shrink-0 rounded-full", step.status === "active" && "animate-pulse")}
        style={{ backgroundColor: dot }}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          step.status === "active" && "font-medium text-foreground",
          step.status !== "active" && "text-muted-foreground",
          step.status === "failed" && "text-destructive",
        )}
      >
        {step.title}
      </span>
      {time === null ? null : <span className="shrink-0 tabular-nums text-muted-foreground">{time}</span>}
    </li>
  );
}

function Steps({ bar, now }: { bar: Bar; now: number }) {
  const color = STATE_COLOR[bar.state === "done" ? "done" : "working"];
  return (
    <div className="mt-2 grid gap-x-6 gap-y-2 pl-4 text-xs sm:grid-cols-2">
      {bar.note === undefined ? null : (
        <p className="sm:col-span-2" style={{ color: STATE_COLOR[bar.state] }}>
          {bar.note}
        </p>
      )}
      {bar.stages.map((stage: Stage, index) => (
        <div key={index}>
          {stage.name === "" ? null : (
            <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {stage.name}
            </div>
          )}
          <ul>
            {stage.steps.map((step, stepIndex) => (
              <StepRow key={stepIndex} step={step} color={color} now={now} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ---------- a row and the banner ----------

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

function RowGlyph({ state }: { state: BarState }) {
  const icon = ICON_PATH[state];
  if (icon === undefined) {
    return (
      <span
        className="mx-0.5 size-2 shrink-0 rounded-full"
        style={{ backgroundColor: STATE_COLOR[state] }}
        role="img"
        aria-label={STATE_LABEL[state]}
      />
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 shrink-0" role="img" aria-label={STATE_LABEL[state]}>
      <path d={icon} fill="none" stroke={STATE_COLOR[state]} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BarRow({
  bar,
  now,
  effects,
  onClose,
}: {
  bar: Bar;
  now: number;
  effects: boolean;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { done, total } = counts(bar);
  const percent = bar.state === "done" ? 100 : total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-3">
        <RowGlyph state={bar.state} />
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={`${bar.title} · ${STATE_LABEL[bar.state]}`}
          className="w-[24%] min-w-0 max-w-[16rem] shrink-0 truncate text-left text-sm text-foreground hover:underline"
        >
          {bar.title}
        </button>
        <Track bar={bar} now={now} effects={effects} />
        <span className="w-9 shrink-0 text-right text-sm tabular-nums text-muted-foreground">{percent}%</span>
        <IconButton label={open ? "Hide steps" : "Show steps"} onClick={() => setOpen(!open)}>
          <path d={open ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />
        </IconButton>
        <IconButton label={`Close "${bar.title}"`} onClick={onClose}>
          <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
        </IconButton>
      </div>
      {open ? <Steps bar={bar} now={now} /> : null}
    </div>
  );
}

/** A short chime per state, synthesised so the plugin ships no audio files. */
function chime(state: BarState): void {
  const notes: Partial<Record<BarState, number[]>> = {
    needs_input: [660, 880],
    failed: [440, 330],
    done: [523, 659, 784],
  };
  const tones = notes[state];
  if (tones === undefined) return;
  try {
    const audio = new AudioContext();
    tones.forEach((frequency, index) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const at = audio.currentTime + index * 0.12;
      osc.frequency.value = frequency;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + 0.4);
    });
    setTimeout(() => void audio.close(), 1500);
  } catch {
    // no audio in this browser
  }
}

function Banner() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  const rpc = useRpc<typeof rpcContract>();
  const bars = useBars(threadId);
  const options = useOptions();
  const now = useNow(bars.some((bar) => bar.state !== "done") || (options.autoClose && bars.length > 0));

  const close = useCallback(
    (id: string) => {
      if (threadId !== null) void rpc.call("bars_dismiss", { threadId, id });
    },
    [rpc, threadId],
  );

  // auto-close: a finished bar leaves after the chosen seconds
  useEffect(() => {
    if (!options.autoClose) return;
    for (const bar of bars) {
      if (bar.state === "done" && bar.endedAt !== undefined && now - bar.endedAt >= options.autoCloseSeconds * 1000) {
        close(bar.id);
      }
    }
  }, [bars, now, options.autoClose, options.autoCloseSeconds, close]);

  // sounds: on a change of state seen live, not on load
  const seen = useRef<Map<string, BarState> | null>(null);
  useEffect(() => {
    const previous = seen.current;
    seen.current = new Map(bars.map((bar) => [`${bar.id}:${bar.createdAt}`, bar.state]));
    if (previous === null || !options.sounds) return;
    const changed = bars.find((bar) => {
      const was = previous.get(`${bar.id}:${bar.createdAt}`);
      return was !== undefined && was !== bar.state;
    });
    if (changed !== undefined) chime(changed.state);
  }, [bars, options.sounds]);

  if (threadId === null || bars.length === 0) return null;
  const ordered = [...bars].sort((a, b) => a.createdAt - b.createdAt);
  return (
    <div className="divide-y divide-border/60 rounded-2xl bg-muted/60 py-0.5">
      <style>{STYLE}</style>
      {ordered.map((bar) => (
        <BarRow key={bar.id} bar={bar} now={now} effects={options.effects} onClose={() => close(bar.id)} />
      ))}
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "plan-progress",
    scopes: ["thread"],
    banners: [{ id: "bars", chrome: "bare", component: Banner }],
  });
});
