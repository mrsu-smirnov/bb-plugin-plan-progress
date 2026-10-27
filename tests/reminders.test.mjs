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
