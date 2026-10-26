import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeedMeter, speedLabel, toolChars } from "../speed.ts";

let seq = 0;
const ev = (type, createdAt, data = {}) => ({ seq: ++seq, type, createdAt, data });
const text = (id, at, delta) => ev("item/agentMessage/delta", at, { itemId: id, delta });
const started = (item, at) => ev("item/started", at, { item });
const completed = (item, at) => ev("item/completed", at, { item });
const feed = (meter, events) => events.forEach((e) => meter.feed(e));

test("a block landing at once was written during the silence before it", () => {
  const m = new SpeedMeter([0.5]);
  feed(m, [ev("turn/started", 0), started({ type: "agentMessage", id: "a" }, 3000), text("a", 4000, "x".repeat(400))]);
  // 400 chars × 0.5 over 4 s
  assert.deepEqual(m.speed(), { rate: 50, exact: false });
});

test("the time a tool runs is not writing", () => {
  const m = new SpeedMeter([0.5]);
  const tool = { type: "commandExecution", id: "c", command: "x".repeat(90) };
  feed(m, [
    ev("turn/started", 0),
    text("a", 2000, "x".repeat(200)),
    started(tool, 2000),
    completed({ ...tool, aggregatedOutput: "y".repeat(5000) }, 60_000),
    text("b", 62_000, "x".repeat(200)),
  ]);
  const chars = 200 + toolChars(tool) + 200;
  assert.equal(m.speed().rate, (chars * 0.5) / 4);
});

test("thinking counts, a subagent's writing does not", () => {
  const m = new SpeedMeter([1]);
  feed(m, [
    ev("turn/started", 0),
    ev("item/reasoning/textDelta", 1000, { itemId: "r", delta: "x".repeat(100) }),
    ev("item/agentMessage/delta", 1500, { itemId: "s", delta: "x".repeat(5000), parentToolCallId: "toolu_1" }),
    text("a", 2000, "x".repeat(100)),
  ]);
  assert.equal(m.speed().rate, 100);
});

test("a block known only from its completed item still counts, once", () => {
  const m = new SpeedMeter([1]);
  feed(m, [
    ev("turn/started", 0),
    text("a", 1000, "x".repeat(100)),
    completed({ type: "agentMessage", id: "a", text: "x".repeat(300) }, 2000),
  ]);
  assert.equal(m.speed().rate, 150);
});

test("the exact count replaces the estimate and teaches the ratio", () => {
  const m = new SpeedMeter();
  feed(m, [
    ev("turn/started", 0),
    text("a", 10_000, "x".repeat(1000)),
    ev("thread/tokenUsage/updated", 10_100, { tokenUsage: { last: { outputTokens: 600 } } }),
    ev("turn/completed", 10_100),
  ]);
  assert.deepEqual(m.speed(), { rate: 60, exact: true });
  assert.deepEqual(m.learned(), [0.6]);
  // the next turn's estimate uses what was learned, and is an estimate again
  feed(m, [ev("turn/started", 20_000), text("b", 30_000, "x".repeat(1000))]);
  assert.deepEqual(m.speed(), { rate: 60, exact: false });
});

test("the average is over the latest minute of writing", () => {
  const m = new SpeedMeter([1]);
  feed(m, [ev("turn/started", 0), text("a", 60_000, "x".repeat(600)), ev("turn/completed", 60_000)]);
  feed(m, [ev("turn/started", 100_000), text("b", 160_000, "x".repeat(6000))]);
  assert.equal(m.speed().rate, 100);
});

test("nothing before a second of writing; the label marks an estimate", () => {
  const m = new SpeedMeter();
  assert.equal(m.speed().rate, null);
  assert.equal(speedLabel({ rate: null, exact: false }), "⚡ – tok/s");
  assert.equal(speedLabel({ rate: 7.25, exact: false }), "⚡ ≈ 7.3 tok/s");
  assert.equal(speedLabel({ rate: 42.4, exact: true }), "⚡ 42 tok/s");
});
