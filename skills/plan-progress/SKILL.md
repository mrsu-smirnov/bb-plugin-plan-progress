---
name: plan-progress
description: Reference for the plan_progress bars (tool ops, the bb plan-progress command). The working rules are already in the thread instructions; load only when the user asks about the bars or a call was refused.
---

# plan_progress

Create once with the whole plan, then move it with short ops.

Create: `{id, title, stages:[{name, steps:[{title}]}]}`; `steps:[{title}]`
instead of `stages` for one flat list. 2-7 stages, titles of at most 4 words,
in the user's language, one `id` per task. A step's `status` defaults to
`pending`; the first open step becomes active.

Ops:
- `{id, next:true}` — active step done, next one active (past the last step, the first one left open; with no active step, the first unfinished one, an error included, is the one closed)
- `{id, done:["A"], active:"B"}` — mark done, pick current; steps *active* before B count as done, pending and error ones stay
- `{id, done:["A"]}` on the active step moves on to the step after it, as `next` does
- `{id, failed:"B", note}` — the step gets an error and the bar turns red; the next `next` closes it
- `{id, state:"needs_input", note}` — before asking the user; the user's answer turns it back to running
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

A thread keeps at most 12 bars: finished ones leave first, then running ones;
a bar waiting on the user or showing an error stays.

## Where the user sees it

A card above the thread's message box, one row per bar: state, title, the
track with a pill naming the stage and step (the elapsed time on hover),
percent, a fold button for the step list, and close. On a question or an
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
| `bb plan-progress clear` | Remove every bar of the thread |

## Subagent strips

Under the bar being worked on, one strip per subagent the main agent started:
its description, model, the tool it is in, and its time. They come from bb's
timeline, cost no tokens, and fold away 5 s after the agent ends (2 min after an error).
