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
