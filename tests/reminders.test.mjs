import { test } from "node:test";
import assert from "node:assert/strict";
import { newReminderState, observeWork, releaseModeFor, START_RELEASE_PROVIDERS } from "../reminders.ts";
// The tests up to 0.6.2 describe the "on-start" mode (Claude Code, Codex, OpenCode v2).
const onStart = (state, events) => observeWork(state, events, "on-start");
const work = seq => ({ seq, createdAt: 100, type: "item/completed", data: { item: { type: "fileRead" } } });
const command = seq => ({ ...work(seq), data: { item: { type: "commandExecution" } } });
const started = (seq, item = { type: "commandExecution" }) => ({ ...work(seq), type: "item/started", data: { item } });
const progress = seq => ({ ...work(seq), data: { item: { type: "toolCall", server: "bb", tool: "plan_progress", status: "completed" } } });

test("only multiple current-turn work calls trigger the missing-plan reminder", () => {
  const state = newReminderState(100);
  assert.equal(onStart(state, [work(1), work(2)]), false);
  assert.equal(onStart(state, [work(2)]), false);
  assert.equal(onStart(state, [work(3)]), false);
  assert.equal(onStart(state, [started(4)]), true);
  state.sent = true;
  assert.equal(onStart(state, [work(4), work(5)]), false);
  const later = newReminderState(101);
  assert.equal(onStart(later, [work(1), work(2), work(3)]), false);
});

test("progress updates reset the stale counter; subagents do not increment it", () => {
  const state = newReminderState(100);
  assert.equal(onStart(state, [progress(1), ...[2,3,4,5,6].map(command)]), false);
  assert.equal(onStart(state, [progress(7), command(8)]), false);
  assert.equal(state.sinceUpdate, 1);
  const child = { ...work(9), data: { parentToolCallId: "child", item: { type: "fileRead" } } };
  assert.equal(onStart(state, [child]), false);
  assert.equal(state.sinceUpdate, 1);
  assert.equal(onStart(state, [10,11,12,13,14].map(command)), false);
  assert.equal(onStart(state, [started(15)]), true);
});

test('agent-scoped work never advances the main thread reminder', () => {
  const state = newReminderState(100);
  const rows = [1,2,3].map(seq => ({...work(seq), scope:{kind:'agent',agentId:'native',turnId:'helper'}}));
  assert.equal(onStart(state, rows), false);
  assert.equal(state.work, 0);
});

test('a root turn has one durable budget, a new turn resets it and completion suppresses late work', () => {
  const scoped=(seq,turnId,type='item/completed')=>({...work(seq),createdAt:100+seq,scope:{kind:'turn',turnId},type});
  const state=newReminderState(0);
  assert.equal(onStart(state,[scoped(1,'a','turn/started'),scoped(2,'a'),scoped(3,'a'),scoped(4,'a'),scoped(4.5,'a','item/started')]),true);
  state.sent=true;
  const restored=JSON.parse(JSON.stringify(state));
  assert.equal(onStart(restored,[scoped(4,'a'),scoped(5,'a')]),false);
  assert.equal(onStart(restored,[scoped(6,'b','turn/started'),scoped(7,'b'),scoped(8,'b'),scoped(9,'b'),scoped(9.5,'b','item/started')]),true);
  assert.equal(onStart(restored,[scoped(10,'b','turn/completed'),scoped(11,'b')]),false);
});

test('late events from a previous turn cannot reset a sent reminder', () => {
  const state=newReminderState(0);
  const row=(seq,turnId,type='item/completed')=>({seq,createdAt:seq+100,type,scope:{kind:'turn',turnId},data:{item:{type:'fileRead'}}});
  onStart(state,[row(1,'a','turn/started'),row(2,'a'),row(3,'a'),row(4,'a')]);state.sent=true;
  onStart(state,[row(5,'b','turn/started'),row(6,'b'),row(7,'b'),row(8,'b')]);state.sent=true;
  assert.equal(onStart(state,[row(9,'a'),row(10,'a'),row(11,'a')]),false);
  assert.equal(onStart(state,[row(12,'b'),row(13,'b'),row(14,'b')]),false);
  assert.equal(state.turnId,'b');assert.equal(state.sent,true);
  const missingStart=newReminderState(0);
  assert.equal(onStart(missingStart,[row(1,'unknown'),row(2,'unknown'),row(3,'unknown')]),false);
  assert.equal(missingStart.turnId,null);
});

test('saved due state cannot send from a different bounded turn without a root start', () => {
  const state={...newReminderState(100),turnId:'a',rootConfirmed:true,work:3,lastSeq:4};
  const row=(seq,turnId,type='item/completed')=>({seq,createdAt:seq+100,type,scope:{kind:'turn',turnId},data:{item:{type:'fileRead'}}});
  assert.equal(onStart(state,[row(101,'b'),row(102,'b')]),false);
  assert.equal(state.rootConfirmed,false);
  assert.equal(onStart(JSON.parse(JSON.stringify(state)),[row(103,'a')]),false);
  assert.equal(onStart(state,[row(104,'c','turn/started'),row(105,'c'),row(106,'c'),row(107,'c'),row(108,'c','item/started')]),true);
});

test('failed or truncated ACP progress batches do not reset the stale-work count', () => {
  const state=newReminderState(0);state.hasPlan=true;state.sinceUpdate=5;
  const row={seq:1,createdAt:100,type:'item/completed',data:{item:{type:'toolCall',tool:'execute',server:'bb',status:'completed',
    result:{metadata:{truncated:false,toolCalls:[{tool:'bb-bridge.plan_progress',status:'error'}]}}}}};
  assert.equal(onStart(state,[row]),false);assert.equal(state.sinceUpdate,5);
  row.seq=2;row.data.item.result.metadata.truncated=true;row.data.item.result.metadata.toolCalls[0].status='completed';
  onStart(state,[row]);assert.equal(state.sinceUpdate,5);
});

test("with a bar in place reads do not count toward the stale-update reminder; edits and commands do", () => {
  const state = newReminderState(100);
  assert.equal(onStart(state, [progress(1), ...[2,3,4,5,6,7,8,9].map(work)]), false);
  assert.equal(state.sinceUpdate, 0);
  const edit = seq => ({ ...work(seq), data: { item: { type: "fileChange" } } });
  assert.equal(onStart(state, [10,11,12,13].map(edit)), false);
  assert.equal(onStart(state, [command(14), edit(15)]), false);
  assert.equal(onStart(state, [started(16)]), true);
});

test("without a bar reads still count toward the three-call reminder", () => {
  assert.equal(onStart(newReminderState(100), [work(1), work(2), work(3), started(4)]), true);
});

test("0.6.2: a reached threshold waits for the next work call to begin", () => {
  const state = newReminderState(100);
  assert.equal(onStart(state, [work(1), work(2), work(3)]), false);
  assert.equal(state.armedSeq, 3);
  assert.equal(onStart(state, [started(4, { type: "fileRead" })]), true);
});

test("0.6.2: starting plan_progress (BB or original) or ToolSearch does not release the reminder", () => {
  const state = newReminderState(100);
  onStart(state, [work(1), work(2), work(3)]);
  const tool = (seq, item) => started(seq, { type: "toolCall", ...item });
  assert.equal(onStart(state, [tool(4, { tool: "mcp__bb-bridge__plan_progress" })]), false);
  assert.equal(onStart(state, [tool(5, { tool: "plan_progress", server: "bb-bridge" })]), false);
  assert.equal(onStart(state, [tool(6, { tool: "mcp__plan-progress__plan_progress" })]), false);
  assert.equal(onStart(state, [tool(7, { tool: "ToolSearch" })]), false);
  assert.equal(onStart(state, [started(8, { type: "agentMessage" })]), false);
  assert.equal(onStart(state, [tool(9, { tool: "Bash" })]), true);
});

test("0.6.2: a call that began before the threshold (parallel) does not release the reminder", () => {
  const state = newReminderState(100);
  assert.equal(onStart(state, [started(1), started(2), work(3), work(4), work(5)]), false);
  assert.equal(state.continued, false);
  assert.equal(onStart(state, [started(6)]), true);
});

test("0.6.2: a start in a helper scope or a finished turn does not release it", () => {
  const state = newReminderState(100);
  onStart(state, [work(1), work(2), work(3)]);
  const helper = { ...started(4), data: { parentToolCallId: "p", item: { type: "commandExecution" } } };
  assert.equal(onStart(state, [helper]), false);
  assert.equal(onStart(state, [{ ...work(5), type: "turn/completed" }, started(6)]), false);
});

test("0.6.2: with a bar, six calls since the update also wait for a next start; an update disarms", () => {
  const state = newReminderState(100);
  assert.equal(onStart(state, [progress(1), ...[2,3,4,5,6,7].map(command)]), false);
  assert.equal(state.armedSeq, 7);
  assert.equal(onStart(state, [progress(8), started(9)]), false);
  assert.equal(state.armedSeq, null);
  assert.equal(onStart(state, [...[10,11,12,13,14,15].map(command)]), false);
  assert.equal(onStart(state, [started(16)]), true);
});

test("0.6.2: saved state from before 0.6.2 (no new fields) is read and waits for a start", () => {
  const old = JSON.parse(JSON.stringify(newReminderState(100)));
  delete old.armedSeq; delete old.continued;
  Object.assign(old, { work: 3, lastSeq: 3 });
  assert.equal(onStart(old, [work(3)]), false);
  assert.equal(onStart(old, [started(4)]), true);
});

// 0.6.2, second change: two release modes chosen by the thread's provider.
const call = (id, type = "commandExecution", extra = {}) => ({ id, type, ...extra });
const begin = (seq, item) => ({ seq, createdAt: 100, type: "item/started", data: { item } });
const end = (seq, item) => ({ seq, createdAt: 100, type: "item/completed", data: { item: { status: "completed", ...item } } });
// Three finished calls reach the no-bar threshold at seq 6; a fourth begins at 7.
const tape = () => [begin(1, call("a")), end(2, call("a")), begin(3, call("b")), end(4, call("b")),
  begin(5, call("c", "fileRead")), end(6, call("c", "fileRead")), begin(7, call("d"))];

test("ACP mode: the same tape releases on the next start on-start, on its completion between calls", () => {
  const early = newReminderState(100);
  assert.equal(observeWork(early, tape(), "on-start"), true);
  const safe = newReminderState(100);
  assert.equal(observeWork(safe, tape().slice(0, 6), "between-calls"), false);
  assert.equal(safe.armedSeq, 6);
  assert.equal(observeWork(safe, [begin(7, call("d"))], "between-calls"), false, "never while a call runs");
  assert.deepEqual(safe.open, ["d"]);
  assert.equal(observeWork(safe, [end(8, call("d"))], "between-calls"), true);
});

test("ACP mode: no release while any call is open, parallel ones included", () => {
  const state = newReminderState(100);
  observeWork(state, [...tape(), begin(8, call("e", "toolCall", { tool: "Read" }))], "between-calls");
  assert.equal(observeWork(state, [end(9, call("d"))], "between-calls"), false, "e is still running");
  assert.equal(observeWork(state, [end(10, call("e", "toolCall", { tool: "Read" }))], "between-calls"), true);
  // calls that began before the threshold and ended with it do not release it
  const before = newReminderState(100);
  assert.equal(observeWork(before, [begin(1, call("a")), begin(2, call("b")), begin(3, call("c")),
    end(4, call("a")), end(5, call("b")), end(6, call("c"))], "between-calls"), false);
  assert.equal(observeWork(before, [begin(7, call("d")), end(8, call("d"))], "between-calls"), true);
});

test("ACP mode: a started plan_progress or ToolSearch also blocks; their completion never releases", () => {
  const pp = call("p", "toolCall", { tool: "plan_progress", server: "bb-bridge" });
  const search = call("s", "toolCall", { tool: "ToolSearch" });
  const state = newReminderState(100);
  observeWork(state, tape(), "between-calls");
  assert.equal(observeWork(state, [begin(8, pp), end(9, call("d"))], "between-calls"), false, "plan_progress is open");
  assert.equal(observeWork(state, [end(10, { ...pp, status: "failed" })], "between-calls"), false, "a failed bar call does not release");
  assert.equal(observeWork(state, [begin(11, search), end(12, search)], "between-calls"), false);
  assert.equal(observeWork(state, [begin(13, call("f")), end(14, call("f"))], "between-calls"), true);
  const updated = newReminderState(100);
  observeWork(updated, tape(), "between-calls");
  assert.equal(observeWork(updated, [end(8, call("d")), begin(9, pp)], "between-calls"), false);
  assert.equal(observeWork(updated, [end(10, pp)], "between-calls"), false, "a successful bar call resets the count");
  assert.equal(updated.armedSeq, null);
});

test("ACP mode: repeated starts of one call, reasoning and messages, a reload and a new root turn", () => {
  const scoped = (row, turnId) => ({ ...row, scope: { kind: "turn", turnId } });
  const state = newReminderState(0);
  observeWork(state, [scoped({ seq: 0.5, createdAt: 100, type: "turn/started", data: {} }, "t1"),
    ...tape().map(row => scoped(row, "t1")), scoped(begin(7.5, call("d")), "t1"),
    scoped(begin(7.6, call("r", "reasoning")), "t1"), scoped(begin(7.7, call("m", "agentMessage")), "t1")], "between-calls");
  assert.deepEqual(state.open, ["d"], "one entry per call; reasoning never completes in ACP and is not a call");
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(observeWork(restored, [scoped(end(8, call("d")), "t1")], "between-calls"), true);
  restored.sent = true;
  observeWork(restored, [scoped(begin(9, call("x")), "t1")], "between-calls");
  observeWork(restored, [scoped({ seq: 10, createdAt: 110, type: "turn/started", data: {} }, "t2")], "between-calls");
  assert.deepEqual(restored.open, []);
  assert.equal(restored.openKnown, true);
});

test("ACP mode: unknown accounting stays silent until a root start is observed", () => {
  const unmatched = newReminderState(100);
  assert.equal(observeWork(unmatched, [end(1, call("a")), end(2, call("b")), end(3, call("c")),
    begin(4, call("d")), end(5, call("d"))], "between-calls"), false, "a completion without its start");
  assert.equal(unmatched.openKnown, false);
  const gap = newReminderState(100);
  assert.equal(observeWork(gap, [...tape(), end(8, call("d"))], "between-calls", { gap: true }), false);
  const restart = newReminderState(0);
  observeWork(restart, [{ seq: 1, createdAt: 100, type: "turn/started", scope: { kind: "turn", turnId: "t" }, data: {} }], "between-calls", { gap: true });
  assert.equal(restart.openKnown, true, "the root start is in the window, so every later start is too");
});

test("ACP mode: saved state without the new fields is read; on-start still works, between calls waits for a root start", () => {
  const strip = state => { const old = JSON.parse(JSON.stringify(state)); delete old.open; delete old.openKnown; return old; };
  const armed = newReminderState(100);
  observeWork(armed, tape().slice(0, 6), "on-start");
  assert.equal(observeWork(strip(armed), [begin(7, call("d"))], "on-start"), true);
  const old = strip(armed);
  assert.equal(observeWork(old, [begin(7, call("d")), end(8, call("d"))], "between-calls"), false);
  assert.deepEqual(old.open, []);
});

test("ACP mode: the provider list is the only way to the early mode; anything else is between calls", () => {
  assert.deepEqual([...START_RELEASE_PROVIDERS].sort(), ["claude-code", "codex", "opencode2"]);
  for (const id of START_RELEASE_PROVIDERS) assert.equal(releaseModeFor(id), "on-start");
  for (const id of ["acp-kimi-code", "acp-other", "pi", "opencode", "", null, undefined])
    assert.equal(releaseModeFor(id), "between-calls", String(id));
  // the default of observeWork is the safe mode
  assert.equal(observeWork(newReminderState(100), tape()), false);
});
