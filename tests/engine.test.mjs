import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOp, counts, describe } from "../engine.ts";

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

test("create makes the first step active", () => {
  const { bar } = run([plan]);
  assert.equal(bar.kind, "plan");
  assert.equal(bar.state, "working");
  assert.deepEqual(statuses(bar), ["active", "pending", "pending", "pending"]);
});

test("next walks the plan and finishes it", () => {
  const { bar } = run([plan, { id: "auth", next: true }, { id: "auth", next: true }]);
  assert.deepEqual(statuses(bar), ["done", "done", "active", "pending"]);
  const end = run([plan, ...Array(4).fill({ id: "auth", next: true })]).bar;
  assert.equal(end.state, "done");
  assert.ok(end.endedAt !== undefined);
  assert.deepEqual(counts(end), { done: 4, total: 4 });
});

test("active marks earlier steps done", () => {
  const { bar } = run([plan, { id: "auth", active: "Маршруты" }]);
  assert.deepEqual(statuses(bar), ["done", "done", "active", "pending"]);
});

test("an unknown title is refused with the step list", () => {
  const { bars } = run([plan]);
  const result = applyOp(bars, { id: "auth", done: ["Нет такого"] }, 5000);
  assert.equal(result.ok, false);
  assert.match(result.error, /Таблицы/);
});

test("an op on a missing bar is refused", () => {
  const result = applyOp([], { id: "x", next: true }, 1);
  assert.equal(result.ok, false);
});

test("needs_input, then progress returns to working", () => {
  const asked = run([plan, { id: "auth", state: "needs_input", note: "Какой пароль?" }]).bar;
  assert.equal(asked.state, "needs_input");
  assert.equal(asked.note, "Какой пароль?");
  const resumed = run([plan, { id: "auth", state: "needs_input", note: "?" }, { id: "auth", next: true }]).bar;
  assert.equal(resumed.state, "working");
  assert.equal(resumed.note, undefined);
});

test("failed marks the step and the bar", () => {
  const { bar } = run([plan, { id: "auth", failed: "Таблицы", note: "нет доступа" }]);
  assert.equal(bar.state, "failed");
  assert.equal(statuses(bar)[0], "failed");
  assert.equal(bar.note, "нет доступа");
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
  const { bar } = run([plan, { id: "auth", next: true }, replanned]);
  assert.deepEqual(statuses(bar), ["done", "active", "pending", "pending", "pending"]);
});

test("the same plan sent to a finished bar starts a new run", () => {
  const { bar } = run([plan, { id: "auth", state: "done" }, plan]);
  assert.equal(bar.state, "working");
  assert.deepEqual(statuses(bar), ["active", "pending", "pending", "pending"]);
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

test("bars of a thread are capped, finished ones leave first", () => {
  let bars = [];
  for (let index = 0; index < 14; index += 1) {
    const id = `b${index}`;
    bars = applyOp(bars, { id, title: id, steps: [{ title: "x" }] }, index).bars;
    if (index < 3) bars = applyOp(bars, { id, state: "done" }, index).bars;
  }
  assert.equal(bars.length, 12);
  assert.ok(!bars.some((bar) => ["b0", "b1"].includes(bar.id)));
});

test("describe answers done/total, state and active step", () => {
  const { bar } = run([plan, { id: "auth", next: true }]);
  assert.equal(describe(bar), 'auth "Вход по паролю": 1/4 done, working, active: Миграция');
});

test("the input is never mutated", () => {
  const { bars } = run([plan]);
  const before = JSON.stringify(bars);
  applyOp(bars, { id: "auth", next: true }, 9);
  assert.equal(JSON.stringify(bars), before);
});
