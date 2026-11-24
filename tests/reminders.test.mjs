import { test } from "node:test";
import assert from "node:assert/strict";
import { newReminderState, observeWork } from "../reminders.ts";
const work = seq => ({ seq, createdAt: 100, type: "item/completed", data: { item: { type: "fileRead" } } });
const command = seq => ({ ...work(seq), data: { item: { type: "commandExecution" } } });
const started = (seq, item = { type: "commandExecution" }) => ({ ...work(seq), type: "item/started", data: { item } });
const progress = seq => ({ ...work(seq), data: { item: { type: "toolCall", server: "bb", tool: "plan_progress", status: "completed" } } });

test("only multiple current-turn work calls trigger the missing-plan reminder", () => {
  const state = newReminderState(100);
  assert.equal(observeWork(state, [work(1), work(2)]), false);
  assert.equal(observeWork(state, [work(2)]), false);
  assert.equal(observeWork(state, [work(3)]), false);
  assert.equal(observeWork(state, [started(4)]), true);
  state.sent = true;
  assert.equal(observeWork(state, [work(4), work(5)]), false);
  const later = newReminderState(101);
  assert.equal(observeWork(later, [work(1), work(2), work(3)]), false);
});

test("progress updates reset the stale counter; subagents do not increment it", () => {
  const state = newReminderState(100);
  assert.equal(observeWork(state, [progress(1), ...[2,3,4,5,6].map(command)]), false);
  assert.equal(observeWork(state, [progress(7), command(8)]), false);
  assert.equal(state.sinceUpdate, 1);
  const child = { ...work(9), data: { parentToolCallId: "child", item: { type: "fileRead" } } };
  assert.equal(observeWork(state, [child]), false);
  assert.equal(state.sinceUpdate, 1);
  assert.equal(observeWork(state, [10,11,12,13,14].map(command)), false);
  assert.equal(observeWork(state, [started(15)]), true);
});

test('agent-scoped work never advances the main thread reminder', () => {
  const state = newReminderState(100);
  const rows = [1,2,3].map(seq => ({...work(seq), scope:{kind:'agent',agentId:'native',turnId:'helper'}}));
  assert.equal(observeWork(state, rows), false);
  assert.equal(state.work, 0);
});

test('a root turn has one durable budget, a new turn resets it and completion suppresses late work', () => {
  const scoped=(seq,turnId,type='item/completed')=>({...work(seq),createdAt:100+seq,scope:{kind:'turn',turnId},type});
  const state=newReminderState(0);
  assert.equal(observeWork(state,[scoped(1,'a','turn/started'),scoped(2,'a'),scoped(3,'a'),scoped(4,'a'),scoped(4.5,'a','item/started')]),true);
  state.sent=true;
  const restored=JSON.parse(JSON.stringify(state));
  assert.equal(observeWork(restored,[scoped(4,'a'),scoped(5,'a')]),false);
  assert.equal(observeWork(restored,[scoped(6,'b','turn/started'),scoped(7,'b'),scoped(8,'b'),scoped(9,'b'),scoped(9.5,'b','item/started')]),true);
  assert.equal(observeWork(restored,[scoped(10,'b','turn/completed'),scoped(11,'b')]),false);
});

test('late events from a previous turn cannot reset a sent reminder', () => {
  const state=newReminderState(0);
  const row=(seq,turnId,type='item/completed')=>({seq,createdAt:seq+100,type,scope:{kind:'turn',turnId},data:{item:{type:'fileRead'}}});
  observeWork(state,[row(1,'a','turn/started'),row(2,'a'),row(3,'a'),row(4,'a')]);state.sent=true;
  observeWork(state,[row(5,'b','turn/started'),row(6,'b'),row(7,'b'),row(8,'b')]);state.sent=true;
  assert.equal(observeWork(state,[row(9,'a'),row(10,'a'),row(11,'a')]),false);
  assert.equal(observeWork(state,[row(12,'b'),row(13,'b'),row(14,'b')]),false);
  assert.equal(state.turnId,'b');assert.equal(state.sent,true);
  const missingStart=newReminderState(0);
  assert.equal(observeWork(missingStart,[row(1,'unknown'),row(2,'unknown'),row(3,'unknown')]),false);
  assert.equal(missingStart.turnId,null);
});

test('saved due state cannot send from a different bounded turn without a root start', () => {
  const state={...newReminderState(100),turnId:'a',rootConfirmed:true,work:3,lastSeq:4};
  const row=(seq,turnId,type='item/completed')=>({seq,createdAt:seq+100,type,scope:{kind:'turn',turnId},data:{item:{type:'fileRead'}}});
  assert.equal(observeWork(state,[row(101,'b'),row(102,'b')]),false);
  assert.equal(state.rootConfirmed,false);
  assert.equal(observeWork(JSON.parse(JSON.stringify(state)),[row(103,'a')]),false);
  assert.equal(observeWork(state,[row(104,'c','turn/started'),row(105,'c'),row(106,'c'),row(107,'c'),row(108,'c','item/started')]),true);
});

test('failed or truncated ACP progress batches do not reset the stale-work count', () => {
  const state=newReminderState(0);state.hasPlan=true;state.sinceUpdate=5;
  const row={seq:1,createdAt:100,type:'item/completed',data:{item:{type:'toolCall',tool:'execute',server:'bb',status:'completed',
    result:{metadata:{truncated:false,toolCalls:[{tool:'bb-bridge.plan_progress',status:'error'}]}}}}};
  assert.equal(observeWork(state,[row]),false);assert.equal(state.sinceUpdate,5);
  row.seq=2;row.data.item.result.metadata.truncated=true;row.data.item.result.metadata.toolCalls[0].status='completed';
  observeWork(state,[row]);assert.equal(state.sinceUpdate,5);
});

test("with a bar in place reads do not count toward the stale-update reminder; edits and commands do", () => {
  const state = newReminderState(100);
  assert.equal(observeWork(state, [progress(1), ...[2,3,4,5,6,7,8,9].map(work)]), false);
  assert.equal(state.sinceUpdate, 0);
  const edit = seq => ({ ...work(seq), data: { item: { type: "fileChange" } } });
  assert.equal(observeWork(state, [10,11,12,13].map(edit)), false);
  assert.equal(observeWork(state, [command(14), edit(15)]), false);
  assert.equal(observeWork(state, [started(16)]), true);
});

test("without a bar reads still count toward the three-call reminder", () => {
  assert.equal(observeWork(newReminderState(100), [work(1), work(2), work(3), started(4)]), true);
});

test("0.6.2: a reached threshold waits for the next work call to begin", () => {
  const state = newReminderState(100);
  assert.equal(observeWork(state, [work(1), work(2), work(3)]), false);
  assert.equal(state.armedSeq, 3);
  assert.equal(observeWork(state, [started(4, { type: "fileRead" })]), true);
});

test("0.6.2: starting plan_progress (BB or original) or ToolSearch does not release the reminder", () => {
  const state = newReminderState(100);
  observeWork(state, [work(1), work(2), work(3)]);
  const tool = (seq, item) => started(seq, { type: "toolCall", ...item });
  assert.equal(observeWork(state, [tool(4, { tool: "mcp__bb-bridge__plan_progress" })]), false);
  assert.equal(observeWork(state, [tool(5, { tool: "plan_progress", server: "bb-bridge" })]), false);
  assert.equal(observeWork(state, [tool(6, { tool: "mcp__plan-progress__plan_progress" })]), false);
  assert.equal(observeWork(state, [tool(7, { tool: "ToolSearch" })]), false);
  assert.equal(observeWork(state, [started(8, { type: "agentMessage" })]), false);
  assert.equal(observeWork(state, [tool(9, { tool: "Bash" })]), true);
});

test("0.6.2: a call that began before the threshold (parallel) does not release the reminder", () => {
  const state = newReminderState(100);
  assert.equal(observeWork(state, [started(1), started(2), work(3), work(4), work(5)]), false);
  assert.equal(state.continued, false);
  assert.equal(observeWork(state, [started(6)]), true);
});

test("0.6.2: a start in a helper scope or a finished turn does not release it", () => {
  const state = newReminderState(100);
  observeWork(state, [work(1), work(2), work(3)]);
  const helper = { ...started(4), data: { parentToolCallId: "p", item: { type: "commandExecution" } } };
  assert.equal(observeWork(state, [helper]), false);
  assert.equal(observeWork(state, [{ ...work(5), type: "turn/completed" }, started(6)]), false);
});

test("0.6.2: with a bar, six calls since the update also wait for a next start; an update disarms", () => {
  const state = newReminderState(100);
  assert.equal(observeWork(state, [progress(1), ...[2,3,4,5,6,7].map(command)]), false);
  assert.equal(state.armedSeq, 7);
  assert.equal(observeWork(state, [progress(8), started(9)]), false);
  assert.equal(state.armedSeq, null);
  assert.equal(observeWork(state, [...[10,11,12,13,14,15].map(command)]), false);
  assert.equal(observeWork(state, [started(16)]), true);
});

test("0.6.2: saved state from before 0.6.2 (no new fields) is read and waits for a start", () => {
  const old = JSON.parse(JSON.stringify(newReminderState(100)));
  delete old.armedSeq; delete old.continued;
  Object.assign(old, { work: 3, lastSeq: 3 });
  assert.equal(observeWork(old, [work(3)]), false);
  assert.equal(observeWork(old, [started(4)]), true);
});
