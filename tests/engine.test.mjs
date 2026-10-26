import { test } from "node:test";
import assert from "node:assert/strict";
import { answered, applyOp, counts, describe } from "../engine.ts";

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

test("state done fills the bar", () => {
  const { bar } = run([plan, { id: "auth", state: "done" }]);
  assert.equal(bar.state, "done");
  assert.deepEqual(counts(bar), { done: 4, total: 4 });
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
  const { bar } = run([plan, { id: "auth", state: "done" }, grown]);
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

test("the cap drops finished bars, then running ones, and keeps a question", () => {
  let bars = [];
  for (let index = 0; index < 12; index += 1) {
    const id = `b${index}`;
    bars = applyOp(bars, { id, title: id, steps: [{ title: "x" }] }, index).bars;
  }
  bars = applyOp(bars, { id: "b0", state: "needs_input" }, 20).bars;
  bars = applyOp(bars, { id: "b5", state: "done" }, 21).bars;
  bars = applyOp(bars, { id: "b12", title: "b12", steps: [{ title: "x" }] }, 22).bars;
  bars = applyOp(bars, { id: "b13", title: "b13", steps: [{ title: "x" }] }, 23).bars;
  const ids = bars.map((bar) => bar.id);
  assert.equal(ids.length, 12);
  assert.ok(ids.includes("b0"), "the question stays");
  assert.ok(!ids.includes("b5"), "the finished bar goes first");
  assert.ok(!ids.includes("b1"), "then the oldest running one");
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
