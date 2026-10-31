import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceDiagnostic, NO_DIAGNOSTIC, progressSource } from "../diagnostics.ts";

const call = (seq, server, extra = {}) => ({ seq, type: "item/completed", data: {
  item: { type: "toolCall", tool: "plan_progress", server }, ...extra,
} });

test("detect the original tool even when there are no BB bars", () => {
  const diagnostic = advanceDiagnostic(NO_DIAGNOSTIC, [call(30, "plan-progress")]);
  assert.equal(diagnostic.source, "claude-original");
  assert.match(diagnostic.warning, /Claude Code plugin/);
  assert.equal(progressSource(call(31, "unrelated")), null);
});

test("a later BB call clears a collision; stale events cannot restore it", () => {
  const old = advanceDiagnostic(NO_DIAGNOSTIC, [call(30, "plan-progress")]);
  const current = advanceDiagnostic(old, [call(31, "bb-bridge")]);
  assert.equal(current.warning, null);
  assert.equal(current.source, "bb");
  assert.equal(advanceDiagnostic(current, [call(30, "plan-progress")]), current);
});

test("subagents and incomplete calls do not change the main agent's diagnostic", () => {
  assert.equal(progressSource(call(30, "plan-progress", { parentToolCallId: "child" })), null);
  assert.equal(progressSource({ ...call(30, "plan-progress"), type: "item/started" }), null);
});

test("Pi's unnamespaced BB tool is recognized by the stamped response", () => {
  const row = call(30, undefined);
  row.data.item.result = 'BB/thread-test: task "Check": 0/3 done, running';
  assert.equal(progressSource(row), "bb");
});

test('agent-scoped progress cannot replace the main agent route', () => {
  const row = {...call(40,'plan-progress'),scope:{kind:'agent',agentId:'helper',turnId:'child'}};
  assert.equal(progressSource(row),null);
});

test('a failed native progress call with plugin presentation is recognized without a success stamp', () => {
  const row = call(41,undefined);
  row.data.item.status='failed';
  row.data.item.presentation={icon:{glyph:'ListTodo'}};
  assert.equal(progressSource(row),'bb');
  assert.equal(advanceDiagnostic(NO_DIAGNOSTIC,[row]).lastOutcome,'failed');
});

test('ACP batch outcome follows the last progress call, not the successful code wrapper', () => {
  const row=call(60,'bb');row.data.item.tool='execute';row.data.item.status='completed';
  row.data.item.result={metadata:{truncated:false,toolCalls:[
    {tool:'bb-bridge.plan_progress',status:'completed'},
    {tool:'bb-bridge.plan_progress',status:'error'},
    {tool:'other.read',status:'completed'},
  ]}};
  assert.equal(progressSource(row),'bb');
  assert.equal(advanceDiagnostic(NO_DIAGNOSTIC,[row]).lastOutcome,'failed');
  row.data.item.result.metadata.truncated=true;
  assert.equal(advanceDiagnostic(NO_DIAGNOSTIC,[row]).lastOutcome,'unknown');
  row.scope={kind:'agent',agentId:'helper'};assert.equal(progressSource(row),null);
});
