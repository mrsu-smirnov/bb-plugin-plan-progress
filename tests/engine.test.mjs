import { test } from "node:test";
import assert from "node:assert/strict";
import { answered, applyOp, counts, describe, LIMITS, setVisibility } from "../engine.ts";

const plan = {
  id: "auth",
  title: "Вход по паролю",
  stages: [
    { name: "Схема", steps: [{ title: "Таблицы" }, { title: "Миграция" }] },
    { name: "API", steps: [{ title: "Маршруты" }, { title: "Тесты" }] },
  ],
};

function run(ops, start = []) {
  let bars = start;
  let last;
  ops.forEach((op, index) => {
    last = applyOp(bars, op, 1000 * (index + 1));
    assert.ok(last.ok, last.error);
    bars = last.bars;
  });
  return { bars, bar: last.bar };
}

const statuses = (bar) => bar.stages.flatMap((stage) => stage.steps.map((step) => step.status));
const next = { id: "auth", next: true };

test("create makes the first step active", () => {
  const { bar } = run([plan]);
  assert.equal(bar.kind, "plan");
  assert.equal(bar.state, "running");
  assert.deepEqual(statuses(bar), ["active", "pending", "pending", "pending"]);
});

test("next walks the plan and finishes it", () => {
  const { bar } = run([plan, next, next]);
  assert.deepEqual(statuses(bar), ["done", "done", "active", "pending"]);
  const end = run([plan, next, next, next, next]).bar;
  assert.equal(end.state, "done");
  assert.ok(end.endedAt !== undefined);
  assert.deepEqual(counts(end), { done: 4, total: 4 });
});

test("active finishes only steps that were active before it", () => {
  const { bar } = run([plan, { id: "auth", active: "Маршруты" }]);
  assert.deepEqual(statuses(bar), ["done", "pending", "active", "pending"]);
});

test("next with active names the new step and leaves it active", () => {
  const { bar } = run([plan, { id: "auth", next: true, active: "Маршруты" }]);
  assert.deepEqual(statuses(bar), ["done", "pending", "active", "pending"]);
});

test("done on the active step moves to the step after it", () => {
  const replanned = {
    ...plan,
    stages: [
      { name: "Схема", steps: [{ title: "Таблицы" }, { title: "Миграция" }] },
      { name: "API", steps: [{ title: "Маршруты", status: "active" }, { title: "Тесты" }] },
    ],
  };
  const { bar } = run([replanned, { id: "auth", done: ["Маршруты"] }]);
  assert.deepEqual(statuses(bar), ["pending", "pending", "done", "active"]);
});

test("an unknown title is refused with the step list", () => {
  const { bars } = run([plan]);
  const result = applyOp(bars, { id: "auth", done: ["Нет такого"] }, 5000);
  assert.equal(result.ok, false);
  assert.match(result.error, /Таблицы/);
});

test("an op on a missing bar is refused", () => {
  assert.equal(applyOp([], { id: "x", next: true }, 1).ok, false);
});

test("needs_input clears with the next call without a state", () => {
  const asked = run([plan, { id: "auth", state: "needs_input", note: "Какой пароль?" }]).bar;
  assert.equal(asked.state, "needs_input");
  assert.equal(asked.note, "Какой пароль?");
  const resumed = run([plan, { id: "auth", state: "needs_input", note: "?" }, next]).bar;
  assert.equal(resumed.state, "running");
  assert.equal(resumed.note, undefined);
});

test("the person answering clears needs_input", () => {
  const { bars } = run([plan, { id: "auth", state: "needs_input", note: "?" }]);
  const after = answered(bars, 9000);
  assert.equal(after[0].state, "running");
  assert.equal(after[0].note, undefined);
  assert.equal(answered(after, 9001), null);
});

test("failed marks the step, and next closes it", () => {
  const { bar } = run([plan, { id: "auth", failed: "Таблицы", note: "нет доступа" }]);
  assert.equal(bar.state, "error");
  assert.deepEqual(statuses(bar), ["error", "pending", "pending", "pending"]);
  const closed = run([plan, { id: "auth", failed: "Таблицы" }, next]).bar;
  assert.equal(closed.state, "running");
  assert.deepEqual(statuses(closed), ["done", "active", "pending", "pending"]);
  const all = run([plan, { id: "auth", failed: "Таблицы" }, next, next, next, next]).bar;
  assert.equal(all.state, "done");
});

test("active past a failed step keeps the error", () => {
  const { bar } = run([plan, { id: "auth", failed: "Таблицы" }, { id: "auth", active: "Маршруты" }]);
  assert.deepEqual(statuses(bar), ["error", "pending", "active", "pending"]);
});

test("original state names and the port's old ones are both accepted", () => {
  assert.equal(run([plan, { id: "auth", state: "error" }]).bar.state, "error");
  assert.equal(run([plan, { id: "auth", state: "failed" }]).bar.state, "error");
  assert.equal(run([plan, { id: "auth", state: "working" }]).bar.state, "running");
});

test("state done finishes the bar and leaves its steps as they were, as in the original", () => {
  const { bar } = run([plan, next, { id: "auth", state: "done" }]);
  assert.equal(bar.state, "done");
  assert.equal(bar.endedAt, 3000);
  assert.deepEqual(statuses(bar), ["done", "active", "pending", "pending"]);
  assert.deepEqual(counts(bar), { done: 1, total: 4 });
});

test("a replan keeps done steps by title", () => {
  const replanned = {
    ...plan,
    stages: [
      { name: "Схема", steps: [{ title: "Таблицы" }, { title: "Миграция" }] },
      { name: "API", steps: [{ title: "Маршруты" }, { title: "Права" }, { title: "Тесты" }] },
    ],
  };
  const { bar } = run([plan, next, replanned]);
  assert.deepEqual(statuses(bar), ["done", "active", "pending", "pending", "pending"]);
});

test("the same plan sent to a finished bar starts a new run", () => {
  const { bar } = run([plan, { id: "auth", state: "done" }, plan]);
  assert.equal(bar.state, "running");
  assert.deepEqual(statuses(bar), ["active", "pending", "pending", "pending"]);
});

test("a finished plan grown by a step carries its done steps over", () => {
  const grown = {
    ...plan,
    title: "вход ПО паролю",
    stages: [...plan.stages, { name: "Финиш", steps: [{ title: "Коммит" }] }],
  };
  const { bar } = run([plan, next, next, next, next, grown]);
  assert.deepEqual(statuses(bar), ["done", "done", "done", "done", "active"]);
  assert.equal(bar.state, "running");
});

test("a flat list is a todo bar", () => {
  const { bar } = run([{ id: "t", title: "Дела", steps: [{ title: "Раз" }, { title: "Два" }] }]);
  assert.equal(bar.kind, "todo");
  assert.equal(bar.stages.length, 1);
  assert.equal(bar.stages[0].name, "");
});

test("a title used twice means the open one", () => {
  const twice = {
    id: "d",
    title: "Двойной",
    stages: [
      { name: "A", steps: [{ title: "Проверка" }] },
      { name: "B", steps: [{ title: "Проверка" }] },
    ],
  };
  const { bar } = run([twice, { id: "d", done: ["Проверка"] }, { id: "d", done: ["Проверка"] }]);
  assert.equal(bar.state, "done");
});

test("more than twelve plans are retained; reaching the safety cap never evicts one", () => {
  let bars = [];
  for (let index = 0; index < LIMITS.barsPerThread; index++) {
    const result = applyOp(bars, { id: `b${index}`, steps: [{ title: "x" }] }, index);
    assert.ok(result.ok, result.error);
    bars = result.bars;
  }
  const refused = applyOp(bars, { id: "overflow", steps: [{ title: "x" }] }, 200);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /already keeps/);
  assert.equal(bars.length, LIMITS.barsPerThread);
  assert.ok(applyOp(bars, { id: "b0", next: true }, 201).ok);
});

test("hiding preserves short updates, restores explicitly, and surfaces new questions and errors", () => {
  const initial = run([plan]).bar;
  const hidden = setVisibility(initial, true);
  assert.equal(hidden.hidden, "manual");
  const updated = applyOp([hidden], next, 3000).bar;
  assert.equal(updated.hidden, "manual");
  assert.equal(counts(updated).done, 1);
  assert.equal(setVisibility(updated, false).hidden, undefined);
  const asking = applyOp([updated], { id: plan.id, state: "needs_input", note: "Choose" }, 4000).bar;
  assert.equal(asking.hidden, undefined);
  const hiddenQuestion = setVisibility(asking, true);
  assert.equal(applyOp([hiddenQuestion], { id: plan.id, state: "needs_input", note: "Choose" }, 5000).bar.hidden, "manual");
  assert.equal(applyOp([hiddenQuestion], { id: plan.id, state: "error", note: "Failed" }, 6000).bar.hidden, undefined);
});

test("auto-hide is tied to a finish and restoration is not immediately hidden again", () => {
  const finished = run([plan, { id: plan.id, state: "done" }]).bar;
  const hidden = setVisibility(finished, true, finished.endedAt);
  assert.equal(hidden.hidden, "auto");
  const restored = setVisibility(hidden, false);
  assert.equal(restored.autoCloseHandledAt, finished.endedAt);
  assert.equal(setVisibility(restored, true, finished.endedAt), restored);
  const reopened = applyOp([hidden], { id: plan.id, active: "Миграция" }, 5000).bar;
  assert.equal(reopened.hidden, undefined);
  assert.equal(reopened.autoCloseHandledAt, undefined);
  assert.equal(setVisibility(reopened, true, finished.endedAt), reopened);
  const nextRun = applyOp([hidden], { ...plan, title: "Next task" }, 6000).bar;
  assert.equal(nextRun.hidden, undefined);
});

test("storage overflow is refused without losing the old plans", () => {
  const bars = Array.from({ length: 80 }, (_, i) => ({ ...run([plan]).bar, id: `b${i}`, note: "я".repeat(2000) }));
  const before = JSON.stringify(bars);
  const result = applyOp(bars, { id: "new", steps: [{ title: "x" }] }, 9999);
  assert.equal(result.ok, false);
  assert.match(result.error, /storage is full/);
  assert.equal(JSON.stringify(bars), before);
});

test("describe answers done/total, state and active step", () => {
  const { bar } = run([plan, next]);
  assert.equal(describe(bar), 'auth "Вход по паролю": 1/4 done, running, active: Миграция');
});

test("the input is never mutated", () => {
  const { bars } = run([plan]);
  const before = JSON.stringify(bars);
  applyOp(bars, next, 9);
  assert.equal(JSON.stringify(bars), before);
});

test("a long title is found by the same long text", () => {
  const long = "Шаг ".repeat(40).trim();
  const { bar } = run([{ id: "l", title: "Длинный", steps: [{ title: "Первый" }, { title: long }] }, { id: "l", active: long }]);
  assert.equal(bar.stages[0].steps[1].status, "active");
});

test("naming the active step again keeps its clock", () => {
  const { bar } = run([plan, { id: "auth", active: "Таблицы" }]);
  assert.equal(bar.stages[0].steps[0].startedAt, 1000);
});
