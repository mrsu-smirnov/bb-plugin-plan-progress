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
- `{id, next:true}` — active step done, next one active (past the last step, the first one left open)
- `{id, done:["A"], active:"B"}` — mark done, pick current; steps before B count as done
- `{id, failed:"B", note}` — error
- `{id, state:"needs_input", note}` — before asking the user
- `{id, state:"done"}` — finish

Moving forward (`next`, `done`, `active`) after a question or an error puts
the bar back to working.

The plan changed: resend `stages` under the same `id` and `title`. Steps sent
without a status keep their done by title. A finished bar, or another title
under the same `id`, starts from zero.

A title the bar does not have is refused with the bar's step list. A title
used twice means the one still open.

The result says `done/total, state, active step`; no need to check the bar.

## Where the user sees it

A card above the thread's message box, one row per bar: state, title, the
track with a pill naming the stage and step (the elapsed time on hover),
percent, a fold button for the step list, and close. On a question or an
error the pill shows the `note`. Settings (effects, auto-close, sounds) are in
bb's plugin settings. A thread keeps at most 12 bars; finished ones leave
first.

## Command

Inside a thread (or with `--thread <id>`):

| Command | Effect |
| --- | --- |
| `bb plan-progress show [--json]` | List the thread's bars |
| `bb plan-progress op '<json>'` | Apply one op, same as the tool |
| `bb plan-progress clear` | Remove every bar of the thread |
