import { test } from "node:test";
import assert from "node:assert/strict";
import { newReminderState, observeWork } from "../reminders.ts";
const work = seq => ({ seq, createdAt: 100, type: "item/completed", data: { item: { type: "fileRead" } } });
const progress = seq => ({ ...work(seq), data: { item: { type: "toolCall", server: "bb", tool: "plan_progress" } } });

test("only multiple current-turn work calls trigger the missing-plan reminder", () => {
  const state = newReminderState(100);
  assert.equal(observeWork(state, [work(1), work(2)]), false);
  assert.equal(observeWork(state, [work(2)]), false);
  assert.equal(observeWork(state, [work(3)]), true);
  state.sent = true;
  assert.equal(observeWork(state, [work(4), work(5)]), false);
  const later = newReminderState(101);
  assert.equal(observeWork(later, [work(1), work(2), work(3)]), false);
});

test("progress updates reset the stale counter; subagents do not increment it", () => {
  const state = newReminderState(100);
  assert.equal(observeWork(state, [progress(1), ...[2,3,4,5,6].map(work)]), false);
  assert.equal(observeWork(state, [progress(7), work(8)]), false);
  assert.equal(state.sinceUpdate, 1);
  const child = { ...work(9), data: { parentToolCallId: "child", item: { type: "fileRead" } } };
  assert.equal(observeWork(state, [child]), false);
  assert.equal(state.sinceUpdate, 1);
  assert.equal(observeWork(state, [10,11,12,13,14].map(work)), true);
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
  assert.equal(observeWork(state,[scoped(1,'a','turn/started'),scoped(2,'a'),scoped(3,'a'),scoped(4,'a')]),true);
  state.sent=true;
  const restored=JSON.parse(JSON.stringify(state));
  assert.equal(observeWork(restored,[scoped(4,'a'),scoped(5,'a')]),false);
  assert.equal(observeWork(restored,[scoped(6,'b','turn/started'),scoped(7,'b'),scoped(8,'b'),scoped(9,'b')]),true);
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
  assert.equal(observeWork(state,[row(104,'c','turn/started'),row(105,'c'),row(106,'c'),row(107,'c')]),true);
});
