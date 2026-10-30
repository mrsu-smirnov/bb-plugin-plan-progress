# Plan Progress for BB

Live progress bars above a thread's message box in [BB](https://getbb.app).
The agent splits a task into stages and steps with the `plan_progress` tool,
and the bar fills as it works: working, needs your answer, error, done.

![A bar on the Review stage with three background subagents under it: model, current tool, time](media/agents.png)

| The step list, with the time of each step | Waiting on the user: the agent's question on the bar |
| --- | --- |
| ![The expanded step list](media/steps.png) | ![The bar waiting on the user](media/question.png) |

A port of the idea and protocol of
[plan-progress](https://github.com/zycck/claude-mods) by zycck, a mod for
Claude Code (MIT). The original draws inside Claude Code's own window, which
BB does not show; this plugin draws the bar in BB instead, and registers the
tool for BB agents rather than for Claude Code alone.

## Install

```bash
bb plugin install https://github.com/mrsu-smirnov/bb-plugin-plan-progress.git
```

Agent tools reach a thread when its session starts: start a new thread, or
restart the agent in an open one, after installing.

## Use

Ask the agent for any task of several steps. It creates a bar, moves it after
each step, marks it before asking you something, and finishes it. Click the
bar to see every bar of the thread.

The same ops work from a terminal inside a thread:

```bash
bb plan-progress show
bb plan-progress op '{"id":"demo","title":"Demo","steps":[{"title":"One"},{"title":"Two"}]}'
bb plan-progress op '{"id":"demo","next":true}'
bb plan-progress clear
```

The protocol is in [skills/plan-progress/SKILL.md](skills/plan-progress/SKILL.md).

### Claude Desktop and BB together

The original zycck mod may stay enabled in Claude Desktop. By default this
plugin gives only BB's Claude thread processes a session-only settings override
that disables `plan-progress@zycck-mods`. It does not change Claude settings
files, uninstall the mod, or patch BB's built-in provider. The launcher is
prepared automatically on the selected enrolled machine. Start a new thread
after an update; existing sessions may retain old instructions and tools.

For Claude the correct tool is `mcp__bb-bridge__plan_progress`, not
`mcp__plan-progress__plan_progress`. Codex and Pi use BB's tool under their
provider's advertised name. Successful calls return `BB/<threadId>`.

`bb plan-progress diagnose --json` reports the last recognized tool route and
whether isolation is requested. A detected original-tool call shows a warning
above the composer, even when BB has no bars. Isolation being requested is not
proof that an existing provider session was restarted with it.

The agent receives an explicit rule for tasks with three or more actions,
including read-only work. The plugin can send at most one automatic reminder
per active turn after three work calls without a bar or six without an update.
It uses strict steering and does not start another turn. Model compliance still
cannot be guaranteed; this is not a universal gate before every work tool.
The original tool is isolated only for the known `plan-progress@zycck-mods` id.
An installation under another marketplace id requires separate configuration.

Validated on Linux with Claude Code, Codex, and Pi. The Windows launcher follows
the Claude SDK's JavaScript executable contract, but has not been tested on a
Windows host. Claude Desktop's GUI was not driven in these checks: the native
plugin list confirms enabled in an ordinary launch, disabled in the BB launch,
with the settings file unchanged.

### Answer speed

`⚡ ≈ 42 tok/s` stands in the message box before the voice and send buttons,
as in the original: bright while the model writes, dimmed with the last
figure while a tool runs and between turns. It is the average over the latest
minute of writing; the time a tool runs does not count, and subagents do not
count.

It is an estimate, as the original's live figure is: BB tells a plugin the
exact output tokens only at the end of the agent's run, and Claude Code hands
its text over a block at a time. So the plugin counts the characters the
agent writes (text, thinking, tool calls) at a tokens-per-character ratio
learned from the exact counts, which this browser keeps. When BB reports the
exact count, the figure loses its `≈`. The box hides it in its compact,
one-line layout.

## Compact plans (0.4.0)

![Nine plans shown compactly, with questions and errors first](media/compact-desktop.jpg)

[See the narrow-screen layout](media/compact-mobile.jpg).

Click **Progress · N** to fold or show the entire block. The choice is remembered
for this thread in this browser and is not reset by new plans or updates.
The summary still shows how many plans need your answer or have errors.

Three plans are shown at a time, with questions and errors first. **Show all**
opens the full list. On narrow screens the title and track have separate lines.
Use a plan's **… → Hide plan** menu to hide it; **Hidden plans → Restore** brings
it back. Hidden plans keep receiving agent updates. A new question or error
brings a hidden plan back to attention. Hiding never stops an agent or removes
a thread or its files.

Finished plans hide after 30 seconds by default, once the thread's tracked
agents have finished. They remain in Hidden plans. Restoring a finished plan
keeps that completion visible. Existing saved auto-close preferences are kept.

Plans are no longer silently discarded when the list grows beyond twelve.
A thread retains up to 100 plans, within a 240 KB storage budget. At the safety
limit a new operation is refused without removing existing plans. Start a new
thread or deliberately use `bb plan-progress clear` to remove all its plans;
that explicit clear command is permanent. Plans removed by older versions
cannot be recovered by this update.

## Coverage against the original (audit: 2026-10-30)

This is a partial port, not feature parity. Compared BB 0.4.0
(`d3d3a133e5ba39da5cb5908cf2d254205a315fd7`) against a fresh Git clone of
[zycck/claude-mods at b77335e](https://github.com/zycck/claude-mods/tree/b77335ee560c609d67ae85c7321f886719361426/plugins/plan-progress).
That is still upstream main and is identical to our recorded original baseline.
This audit reads the implementation, types, settings, skill and regression
scenarios; it does not claim live equivalence across platforms or providers.

| Capability | BB 0.4.0 compared with upstream |
| --- | --- |
| Plans, stages, steps, short updates, replanning, restart under the same id | Ported at the protocol level; not identical in every rendering edge case |
| Four plan states, progress marks, timings and effects | Present; drawing uses React/CSS rather than SVG and terminal raster frames |
| Reduced-motion preference | Present for track animations |
| Answer speed | Present; estimated from BB events and corrected with BB's final token counts, rather than direct per-response streaming access |
| Sounds | Present as browser-synthesised tones; upstream uses WAV assets through the Claude host |
| Persistence | Present per BB thread in KV; upstream has its own last-20-session save/restore mechanism |
| Hide all plans | Present in 0.4.0 with a persistent Progress button. Upstream uses `/progress`; a new plan reopens its block |
| Completed-plan auto-close | Present. **Upstream defaults to off**; BB 0.4.0 defaults to on. Both use 30 seconds initially and respect saved preferences |
| Plan-list length | BB shows three and retains hidden plans. Upstream retains at most three and evicts older plans |
| Individual hide/restore | BB addition. Upstream's cross removes the plan; it has no hidden-plan restore list |
| Limit the number of agent strips | **Missing.** Upstream budgets 3/4/5 rows according to the number of bars, prioritises unfinished agents and adds a `+N more · K done` row. Our current AgentStrips maps every visible agent |
| Fold agent strips | Partial: each BB host row can fold them locally; upstream stores the choice on the plan and has `/progress-agents` for all plans |
| Readable model/tool labels in narrow strips | Partial. Upstream shortens Claude model names and MCP tool prefixes, drops tool/time before the task name in a narrow strip, and marks nested agents. BB mostly truncates the combined title/model; child-thread tools are absent |
| Automatic Agents bar without a task plan | **Missing.** Upstream creates `agents:auto`, counts finished/total agents and needs no model call. BB renders strips only when a plan row is rendered |
| Bind agents to their own plan | **Missing equivalent.** Upstream stores each agent's home plan and parent/depth; BB attaches the current aggregate to the latest unfinished plan |
| Waiting for approval | **Missing agent state.** Upstream turns a strip amber while a real permission dialog is open. BB AgentState is running/done/error |
| Resumed agents and teammates | Partial. BB rereads timeline/thread status. Upstream additionally tracks resting teammates, wakes an ended strip, recovers missing finish events, and hands an unfinished subagent-owned plan back to the lead |
| Keep failed agent strips visible | Different: upstream keeps failed strips with the bar until it closes; BB filters errors out after two minutes |
| Parse an approved Plan Mode plan into a bar | **Missing.** Upstream handles ExitPlanMode and builds/updates the `plan` bar from Markdown; BB currently relies on the agent to call the progress tool |
| Detect a question automatically | Partial. Upstream intercepts AskUserQuestion and can recognise a final question at Stop; BB relies on explicit needs_input. BB clears waiting plans on thread.active, an approximation of a human reply |
| Remind the agent of existing plans at a new human prompt | **Missing equivalent.** Upstream adds a short list of open plan ids and positions to prompt context |
| Enforce a plan before repeated edits | **Missing equivalent.** Upstream refuses the fourth edit once if no plan exists, exempting shell calls and plan-file writes; BB sends a bounded reminder after work calls instead |
| Remind repeatedly about stale plans | Different: upstream can nudge every six successful edits with an open plan; BB sends at most one reminder per active turn and counts reads/commands too |
| Check open plans before ending the answer | **Missing.** Upstream's Stop hook can block one unexplained finish, while allowing questions/background waits. BB does not block a completed turn |
| Settings shortcut next to speed | **Missing.** Upstream has a gear and `/plan-progress-settings`; BB settings are reached through host plugin settings |
| Localised settings and update UI | **Missing.** Upstream contains 35 language tables and chooses language from Claude/app/system settings. Our plugin labels are English |
| Plugin-specific update check and notice | Upstream has a six-hour check, a gear badge, and an Update action. BB uses host plugin management; a duplicate updater is not required for parity of the user outcome |
| Arbitrary auto-close delay | Different: upstream config accepts positive seconds; BB offers 10/30/60 |
| Theme-specific terminal drawing, Omarchy and OS appearance probes | Not applicable as-is to a BB web banner. BB follows host classes, but fixed track/agent colours need a separate light-theme contrast audit |
| Missing-tool warning | Different: upstream checks whether the loopback MCP tool reached the session and warns once. BB diagnoses original-vs-BB tool collisions and isolates the Desktop mod; it has no equivalent preflight for a missing BB tool |
| Substeps | Not an omitted working UI: upstream types/Markdown parser retain them, but the public step schema deliberately omits them, drawing does not display them, and short ops cannot address them |

Additional rendering differences found by source inspection:

- Upstream caps an unfinished plan's displayed percent at 99. BB can show 100
  while state is needs_input or error.
- BB's numeric percent counts skipped steps as finished, but its track fill's
  head helper currently counts only done. A skipped step can make the fill and
  numeric percent disagree.
- Upstream positions the pill's stage/step by the completed share of the track;
  BB uses the active/error step. Completing steps out of order can therefore
  produce different pill labels.
- These are code-level findings; focused visual reproductions are still needed.

Corrections to earlier comparisons: upstream auto-close is **off**, and its
whole-block toggle is the `/progress` command, not a Progress-count button.
The earlier comparison did not inspect the complete pinned source. A fresh
clone at the pinned commit is the evidence for this table.
A claim of complete parity must be backed by this inventory and scenario
checks, not by the number of passing tests in the port alone.

Suggested order: compact and readable agent strips; automatic agent bar and
accurate agent states/ownership; Plan Mode and question lifecycle; then decide
whether enforcement hooks are desirable and supported by the public BB SDK.
No SDK limitation is assumed proven solely because this port lacks a feature.

## Develop

```bash
npm install
npm test          # the bar engine
npm run test:integration # build and exercise the backend and host launcher
npm run typecheck
npm run test:ui    # real banner through the public SDK UI harness
bb plugin install .
bb plugin dev     # rebuild and reload on save
```

The bars are a composer banner and the speed a composer action
(`app.composer.customize`).

## Settings

In bb: Settings → Plugins → Plan Progress → the gear at the top right →
Configuration. Or from a terminal: `bb plugin config plan-progress set <key> <value>`.

| Setting | Key | Default |
| --- | --- | --- |
| Effects: twinkling dots in the bar | `effects` | on |
| Session-only isolation of the original Claude mod | `isolateClaude` | on |
| Optional absolute native Claude executable path on the host | `claudeExecutable` | empty: find on PATH |
| One automatic progress reminder per active turn | `automaticReminders` | on |
| Auto-close: hide finished plans; restore from Hidden plans | `autoClose` | on |
| Stays for: 10, 30 or 60 s before it leaves | `autoCloseSeconds` | 30 |
| Answer speed: ≈ tok/s in the message box | `speed` | on |
| Sounds: a chime on a question, an error and the finish | `sounds` | off |

## License

MIT. See [LICENSE](LICENSE).
