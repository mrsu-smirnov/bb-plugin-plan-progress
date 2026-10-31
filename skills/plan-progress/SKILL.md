---
name: plan-progress
description: Reference for the plan_progress bars (tool ops, the bb plan-progress command). The working rules are already in the thread instructions; load only when the user asks about the bars or a call was refused.
---

# plan_progress

Create once with the whole plan, then move it with short ops.

Use BB's tool. In Claude Code discover `mcp__bb-bridge__plan_progress`,
never `mcp__plan-progress__plan_progress` (the latter draws in Claude Desktop).
Other providers use their advertised BB tool. Read-only tasks with three
actions count too, even in one turn and with subagents forbidden.
If unavailable, try `bb plan-progress op '<json>'` in the current thread;
report failure if neither route works. Do not silently switch to the Desktop mod.
Never invent tool names. If a result is lost, do not blindly repeat next:true:
it advances again. Inspect `bb plan-progress show --json` once, then update
uniquely named steps with done/active. There is no automatic op deduplication.
Before closing, mark completed step titles done: `state:"done"` alone
does not change unfinished step statuses.

Create: `{id, title, stages:[{name, steps:[{title}]}]}`; `steps:[{title}]`
instead of `stages` for one flat list. 2-7 stages, titles of at most 4 words,
in the user's language, one `id` per task. A step's `status` defaults to
`pending`; the first open step becomes active.

Ops:
- `{id, next:true}` — active step done, next one active (past the last step, the first one left open; with no active step, the first unfinished one, an error included, is the one closed)
- `{id, done:["A"], active:"B"}` — mark done, pick current; steps *active* before B count as done, pending and error ones stay
- `{id, done:["A"]}` on the active step moves on to the step after it, as `next` does
- `{id, failed:"B", note}` — the step gets an error and the bar turns red; the next `next` closes it
- `{id, state:"needs_input", note}` — before asking the user; a confirmed visible human reply or explicit op resumes it
- `{id, state:"done"}` — finish

States are those of the original: `running`, `needs_input`, `error`, `done`
(`working` and `failed` are accepted too). Step statuses: `pending`, `active`,
`done`, `error`, `skipped`. A call without a `state` works it out again: all
steps finished → done, a `failed` in the call → error, else running; the note
lasts one call.

The plan changed: resend `stages` under the same `id` and `title`. Steps sent
without a status keep their done by title. To a finished bar, the same plan
sent again with no statuses (or only its first step active) starts a new run;
the plan grown by a step keeps what was done; one under another title, or
without a step it finished, is the next task and starts from zero.

A title the bar does not have is refused with the bar's step list. A title
used twice means the one still open. Titles compare without case.

The result says `done/total, state, active step`; no need to check the bar.

Hidden bars remain stored and accept the same short ops. A new question or
error resurfaces a hidden bar. The display shows three plans by default; this
is not a storage limit. Up to 100 plans and 240 KB are retained per thread;
exceeding that safety budget refuses the op without evicting old plans. Use
a new thread at capacity; only clear old plans when the user requests it.

## Where the user sees it

A card above the thread's message box, one row per bar: state, title, the
track with a pill naming the stage and step (the elapsed time on hover),
percent, a fold button for the step list, and a … menu with Hide plan.
Progress · N folds the whole block (remembered per browser and thread).
Show all expands the short list. Hidden plans → Restore returns a hidden plan.
Completed plans auto-hide after 30 seconds by default; saved settings are kept.
Restoring a completed plan keeps that finish visible. On a question or an
error the pill shows the `note`. Settings (effects, auto-close and its seconds,
sounds): bb Settings → Plugins → Plan Progress → the gear at the top right, or
`bb plugin config plan-progress set <key> <value>` with keys `effects`,
`autoClose`, `autoCloseSeconds` (10, 30, 60), `sounds`. 

## Command

Inside a thread (or with `--thread <id>`):

| Command | Effect |
| --- | --- |
| `bb plan-progress show [--json]` | List the thread's bars |
| `bb plan-progress op '<json>'` | Apply one op, same as the tool |
| `bb plan-progress agents [--json]` | List the subagents of the latest turn |
| `bb plan-progress diagnose [--json]` | Observe routing/outcomes, reminder delivery, bounded coverage and auto-hide conditions; never sends a reminder |
| `bb plan-progress clear` | Remove every bar of the thread |

## Subagent strips

The separate Thread agents block shows observed latest-segment delegations and
direct child threads, even without a plan. Three rows are shown by default;
expansion is saved per browser and thread. Confirmed errors and unknown outcomes
remain visible while present in the source. Open approvals in the current
thread and its direct children are counted without assigning them to an agent.
Fresh Claude and Pi-helper lifecycle coverage remains incomplete; see the
candidate verification table for the later Pi basic-flow checks.

## Coexistence with Claude Desktop

The original mod stays installed and enabled for ordinary Claude/Desktop
launches. BB's Claude threads get a process-only override via a generated
launcher; user and project settings files are never rewritten. `isolateClaude`
defaults to true. For a custom native executable, set `claudeExecutable` to its
absolute path on the host. Start a new thread to receive changed instructions.
Windows has not yet been validated on a real host.

`automaticReminders` defaults to true: one attempted strict steer per observed
root turn after 3 work calls without a bar or 6 without an update. The attempt
survives plugin reload. A missing start or unexpected scope can suppress it;
legacy unscoped data uses a fallback without root identity. Diagnose distinguishes
not-attempted, unknown, sent, send-error and skipped; sent is not proof the model
followed it. It never starts a follow-up turn. This improves compliance rather
than guaranteeing it.

The appearance rule is explained in the README and settings, including before
the first bar. Keep the progress banner compact, without a help section.
An idle thread need not have a completed plan. Auto-hide conditions from diagnose describe server observations,
not the actual state of every browser. A visible accepted new human message can
resume several waiting plans; it does not prove each question was answered.

Fresh candidate checks cover Codex, OpenCode v2 and ACP/Go Claude Haiku, and
Pi 1.4.0/OpenRouter Haiku 5.5 plus Luna. Pi/Ollama Cloud and fresh Claude Code
remain unverified. ACP can wrap several native calls into one code record:
diagnose uses the last matching inner outcome; truncated metadata remains
unknown. Do not infer all-model support from these successful runs.
