import { test } from "node:test";
import assert from "node:assert/strict";
import { orderedPlans, dueToHide, VISIBLE_PLANS } from "../presentation.ts";

test("questions and errors precede recent work in the compact three-plan view", () => {
  const bars = [{ id: "done", state: "done", updatedAt: 100 },
    { id: "recent", state: "running", updatedAt: 90 },
    { id: "old", state: "running", updatedAt: 10 },
    { id: "ask", state: "needs_input", updatedAt: 1 },
    { id: "error", state: "error", updatedAt: 2 }];
  assert.deepEqual(orderedPlans(bars).slice(0, VISIBLE_PLANS).map(b => b.id), ["ask", "error", "recent"]);
  assert.equal(bars[0].id, "done");
});

test("auto-hide waits for completion, the delay and agents; restored finishes stay visible", () => {
  const bar = { state: "done", endedAt: 1000 };
  assert.equal(dueToHide(bar, 30_999, 30, false), false);
  assert.equal(dueToHide(bar, 31_000, 30, true), false);
  assert.equal(dueToHide(bar, 31_000, 30, false), true);
  assert.equal(dueToHide({ ...bar, state: "error" }, 31_000, 30, false), false);
  assert.equal(dueToHide({ ...bar, hidden: "manual" }, 31_000, 30, false), false);
  assert.equal(dueToHide({ ...bar, autoCloseHandledAt: 1000 }, 31_000, 30, false), false);
});
