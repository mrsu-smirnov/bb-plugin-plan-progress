# Upstream coverage and verification

The detailed baseline inventory below describes **released BB 0.4.0**, not an
assertion that every difference is still present in 0.5.0. Keep this inventory
available as a current document instead of relying on old Git history.

## 0.6 candidate (not a published release)

The candidate adds scope-aware routing/reminders, observed failure outcomes,
durable root-turn reminder attempts, bounded evidence and native/CLI observations
in diagnose, common auto-hide conditions, and a tap/click explanation in the UI.
No Plan Mode import, blocking hooks or invocation deduplication is claimed.

Independent review reproduced and closed late-turn reminder rearming and
post-delete send persistence. Additional checks cover reload during send,
intermediate pagination, unknown root coverage, read failures and observer-only
diagnose. A completed send can still be unknown across reload; a late foreign
turn can suppress a reminder until another proven start. Legacy unscoped events
keep a fallback without proof of root identity. Diagnose is not an atomic
snapshot. Server auto-hide eligibility is not proof of any browser's visibility.

| Connection | Candidate live evidence | Limits |
| --- | --- | --- |
| Codex / gpt-6.1-sol, medium | Three independent ordinary read-only tasks created and completed native plans without a progress request | Existing connection, one model; no inference about all accounts/models |
| OpenCode v2 / opencode-go/claude-haiku-5-5 | Three independent ordinary read-only tasks created and completed native plans | A run attempted an unavailable invented tool and recovered; model compliance is separate from engine execution |
| Pi / Ollama Cloud | Not run | Provider unavailable on the test host; tester's exact model unknown |
| Pi / OpenRouter | Not run | Provider unavailable on the test host; tester's exact model unknown |
| Claude Code | Not freshly run | Provider unavailable on this host; old evidence does not validate this candidate |
| ACP OpenCode | Not run | Listing/installation does not validate a different bridge |

Candidate verification on 2026-10-31: 65 unit, 23 integration and 15 UI checks
passed, along with typecheck/build/diff checks. Independent Astra review found
no remaining blockers in the reviewed code after three narrow corrections.
Native invalid-step rejection, needs_input and continuation after a visible
browser-submitted reply were also exercised on both available connections;
the intermediate automatic running transition was not captured separately.
The tap-open explanation was inspected in actual BB, including 390 px; narrow
light/dark plan layouts were inspected. Existing auto-close=true/60s and other
saved settings remained intact. In existing test threads, changing Codex from
Sol to gpt-6-luna and OpenCode v2 from Go Claude Haiku to opencode-go/gpt-6-luna
preserved plans and allowed native calls. Both were forcibly stopped during a
controlled pause: the thread went idle while the plan correctly stayed running,
then an explicit follow-up completed it. This tests interruption/resumption,
not automatic provider retry. Fresh live approval grant/deny/cancel, automatic
provider retry and Pi/Claude coverage remain unverified; harness cases do not
substitute for those provider-level runs. A clean Git snapshot also built with
production dependencies only (npm ci --omit=dev --ignore-scripts, bb plugin build).

### External acceptance before claiming a connection is tested

Record BB/plugin/agent versions, provider ID, exact model, service and connection
method (subscription/OAuth/API, never keys), permission mode and saved settings.
A different model on the same service is a different observation.

1. In a new session, request three sequential read-only actions on harmless local
   files without asking for progress. Record whether a plan appears before work,
   updates between actions and ends with all completed steps. Repeat three times.
2. Separately ask for a known valid native plan_progress call. Check the returned
   BB stamp and rendered plan. Test CLI fallback separately; it cannot prove native
   tool availability. Ask for an invalid step and check that old progress remains.
3. Set needs_input, send a visible test answer, continue and finish. Check an
   interrupted run and resumption; test helpers/approvals only when supported.
4. Reload the page, then plugin, then provider session as distinct cases. Record
   any stale data. Changed tools/instructions require a new provider session.
5. Run diagnose --json and report only the bounded diagnostic fields, not raw
   conversations, commands or credentials. Distinguish not-tested from failed
   and not-applicable. A failure or limit is not proof the task succeeded.

General settings, themes, hide/restore and mobile layout are shared regressions;
repeat per connection only when provider-specific helper or lifecycle events
justify it. No need to intentionally exhaust a real subscription.

## 0.5.0 changes

Implementation reviewed through `7300bb18b97ebd5592fbe72b3f9501766df98d9a`.
Independent review found no remaining code blockers in the checked scope.
This record covers local release acceptance. The release implements three
packages; it does not promise full upstream parity.

| Area | Implemented in 0.5.0 | Verification boundary |
| --- | --- | --- |
| Independent compact agents | Thread-level block, three rows plus counts, expansion memory, independent of plan visibility; whole Progress collapse hides the agents too | Component matrix 0/1/3/10 agents with 0/1/9 plans; actual BB composer checked at 390 px in light/dark themes with reduced motion |
| Delegation collection | Flat collection traverses BB's turn.children grouping (delegation childRows remain activity, not ownership);  native delegation completion remains distinct from background launch completion | A real Codex native-agent trace confirmed turn.children and separate root/agent scopes; anonymised regression fixtures cover those shapes |
| Outcomes | Workflow/backgroundTask outcomes joined using public identifiers; unknown stays unknown; child outcome uses the main turn that accepted the latest request | SDK fixtures and recorded Codex traces; fresh Claude/Pi sequences unavailable on this server |
| Errors | Observed errors retained in a bounded per-thread KV trace across segment changes/reload; unknown and stale observations do not supersede the trace; newer terminal evidence or a proven new run can replace it | Integration checks; bounded to 100 retained error entries |
| Approvals | General pending-approval signal includes current thread and direct child threads, and marks incomplete coverage on failed reads; no invented assignment to a particular native agent | Server/UI fixtures cover lifecycle refresh; final live approve/deny/cancel check pending |
| Human replies | Visible user request correlated with its input-accepted event, excluding hidden reminders, system/agent sends, retries and answers older than the waiting state | Real envelope shapes from Codex and historic Claude/Pi demos; integration tests protect negative cases |
| Model/duration | No inherited first-run model presented as current; child model hidden while active when correlation is not sufficient; unreliable child duration omitted | Resumed-run fixtures; live review boundary stated explicitly |
| Plan displays | skipped agrees in percentage/fill/ARIA; stage timing is a documented wall-clock span; unknown time is omitted; checkpoint completion uses step states | Tests cover out-of-order steps and all-finished needs_input/error; actual compact plan checked in both themes at 390 px |

The implementation reads up to 500 matching recent events and 500 direct children.
Unchanged snapshots and in-flight reads are shared until the relevant thread
changes. An SDK-harness run with ten separated child notifications measured
1 timeline, 1 child-list and 20 event reads without a mounted UI (previously
20, 20 and 140); this is a bounded scenario, not a production benchmark.
No arbitrary ownership tree, full historical import, approved Plan Mode import,
blocking Stop/tool hooks, translations or plugin-specific updater are included.
Read the release verification record before treating any pending live check as
passed. Older Claude/Pi event traces are schema evidence, not fresh 0.5.0 tests.

## Release verification (2026-10-30)

- 58 unit, 16 integration and 14 UI tests passed, with typecheck, build and
  diff checks. Independent review reproduced and closed the realtime regression.
- Linked backend-to-React checks cover initial empty/nonempty snapshots, removal,
  completion, a following helper and delayed initial RPCs without remounting.
- Live Codex native-helper startup and completion updated the open BB composer
  without remounting. Recorded real events also verify root/helper turn scopes.
- Local runtime reloaded at `7300bb1`; compact summary and plan were checked in
  the actual BB composer at 390 px, light/dark themes and reduced motion.
  Expansion survives overall collapse/reload in the component tests.
- A Git source snapshot builds with production dependencies only
  (`npm ci --omit=dev --ignore-scripts`, then `bb plugin build`).
- Fresh Claude/Pi scenarios were not run: these providers are not registered
  on this host. Live approval approve/deny/cancel was not exercised; SDK fixtures
  are not a substitute for that provider-level check.

## Coverage against the original (audit: 2026-10-30)

This is a partial port, not feature parity. Compared BB 0.4.0
(`d3d3a133e5ba39da5cb5908cf2d254205a315fd7`) against a fresh Git clone of
[zycck/claude-mods at b77335e](https://github.com/zycck/claude-mods/tree/b77335ee560c609d67ae85c7321f886719361426/plugins/plan-progress).
That is still upstream main and is identical to our recorded original baseline.
This audit reads the implementation, types, settings, skill and regression
scenarios; it does not claim live equivalence across platforms or providers.

| Capability | BB 0.4.0 compared with upstream |
| --- | --- |
| Plans, stages, steps, short updates, replanning, restart under the same id | Core operations supported, not exact protocol compatibility. BB retains case/spaces in ids and limits plans to 12 stages × 30 steps; upstream slugs ids and has no matching normalizer limits |
| Four plan states, progress marks and effects | Present; drawing uses React/CSS rather than SVG and terminal raster frames |
| Step and stage timings | Partial: BB tracks active-step intervals. Upstream estimates intervals between completions. BB currently labels stage boundaries with the last step time, not the stage duration |
| Expandable step list | BB addition; the upstream row has no equivalent expandable list |
| Reduced-motion preference | Partial: track animations respect it; pulsing step/agent dots are not all disabled by that rule |
| Answer speed | Partial: estimated from BB events, corrected with final token counts; model changes do not reset the meter as upstream does. Exact tokens do not make measured writing time exact |
| Sounds | Partial: browser-synthesised tones, default off, versus upstream host WAV sounds, default on. A newly seen bar does not chime without an observed state transition |
| Persistence | Present per BB thread in KV; upstream has its own last-20-session save/restore mechanism |
| Hide all plans | Present in 0.4.0 with a persistent Progress button. Upstream uses `/progress`; a new plan reopens its block |
| Completed-plan auto-close | Partial. **Upstream defaults to off**; BB defaults to on. Both initially use 30 seconds. BB runs this in the mounted browser and waits for any tracked agent in the thread; upstream uses a process timer and the agents of that plan |
| Plan-list length | BB shows three and retains hidden plans. Upstream retains at most three and evicts older plans |
| Individual hide/restore | BB addition. Upstream's cross removes the plan; it has no hidden-plan restore list |
| Limit the number of agent strips | **Missing.** Upstream budgets 3/4/5 rows according to the number of bars, prioritises unfinished agents and adds a `+N more · K done` row. Our current AgentStrips maps every visible agent |
| Fold agent strips | Partial, with a reproduced state-loss bug: folding/unfolding the whole Progress block remounts and resets the locally folded agents. Upstream stores the choice on the plan and has `/progress-agents` |
| Readable model/tool labels in narrow strips | Partial. Upstream shortens Claude model names and MCP tool prefixes, drops tool/time before the task name in a narrow strip, and marks nested agents. BB mostly truncates the combined title/model; child-thread tools are absent |
| Automatic Agents bar without a task plan | **Missing.** Upstream creates `agents:auto` without a model call. BB hides agents when there is no rendered host plan. The same disappearance is reproduced with a hidden host plan or one outside the first three rows |
| Bind agents to their own plan | **Missing equivalent.** Upstream stores home plan and parent/depth; BB assigns the aggregate to the latest updated unfinished plan, so another plan update can relocate it |
| Collect nested agents | **Missing.** BB requests nested timeline rows but its collector does not recurse into childRows; a nested delegation is absent in a synthetic fixture |
| Waiting for approval | **Missing agent state.** Upstream turns a strip amber while a real permission dialog is open. BB AgentState is running/done/error |
| Resumed agents and teammates | Incomplete lifecycle support. BB rereads status but caches the first child-thread model and uses thread creation/updatedAt for duration. Upstream tracks current model, resting/woken agents, missing finish events and ownership handover |
| Confirm background task outcomes | Incomplete: BB can treat successful launch completion as task success after it leaves the active list; taskStatus is not read. A failed-background fixture yields done. Live provider event sequences still need validation |
| Fold a completed group | Different: BB hides each completed agent after five seconds; upstream waits five seconds after the entire group completes |
| Keep failed agent strips visible | Different: upstream keeps failed strips with the bar until it closes; BB filters errors out after two minutes |
| Parse an approved Plan Mode plan into a bar | **Missing.** Upstream handles ExitPlanMode and builds/updates the `plan` bar from Markdown; BB currently relies on the agent to call the progress tool |
| Detect a question automatically | Partial. Upstream intercepts AskUserQuestion/Stop; BB relies on explicit needs_input. BB clears waiting plans on any thread.active; that event alone does not establish a human answer |
| Remind the agent of existing plans at a new human prompt | **Missing equivalent.** Upstream adds a short list of open plan ids and positions to prompt context |
| Enforce a plan before repeated edits | **Missing equivalent.** Upstream refuses the fourth edit once if no plan exists, exempting shell calls and plan-file writes; BB sends a bounded reminder after work calls instead |
| Remind repeatedly about stale plans | Different: upstream can nudge every six successful edits with an open plan; BB sends at most one reminder per active turn and counts reads/commands too |
| Check open plans before ending the answer | **Missing.** Upstream's Stop hook can block one unexplained finish, while allowing questions/background waits. BB does not block a completed turn |
| Settings shortcut next to speed | **Missing.** Upstream has a gear and `/plan-progress-settings`; BB settings are reached through host plugin settings |
| Localised settings and update UI | **Missing.** Upstream contains 35 language tables and chooses language from Claude/app/system settings. Our plugin labels are English |
| Plugin-specific update check and notice | BB provides installation/update management; a duplicate updater is not needed. Upstream has a six-hour check and gear badge; equivalent notice timing in BB has not been established |
| Arbitrary auto-close delay | Different: upstream config accepts positive seconds; BB offers 10/30/60 |
| Theme-specific terminal drawing, Omarchy and OS appearance probes | Terminal probes are not applicable as-is. Light-theme contrast remains applicable: upstream has a separate light palette for agent strips; BB fixed colours need a browser audit |
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
- Independent SDK-harness review reproduced the skipped-step disagreement: one skipped step of two gives text 50%, fill 0%, and ARIA 0. It also reproduced loss of the agent fold choice and disappearing agents for hidden/out-of-view/no host plans.
- On the same timed operations, a stage boundary showed 15 seconds upstream versus 10 in BB, and a never-active step showed 5 seconds upstream versus 0 in BB. These confirm different semantics; neither estimate is an exact measurement of parallel work.
- Browser layout, live provider event sequences and the remaining edge cases still need separate verification.

Corrections to earlier comparisons: upstream auto-close is **off**, and its
whole-block toggle is the `/progress` command, not a Progress-count button.
The earlier comparison did not inspect the complete pinned source. A fresh
clone at the pinned commit is the evidence for this table.
A claim of complete parity must be backed by this inventory and scenario
checks, not by the number of passing tests in the port alone.
