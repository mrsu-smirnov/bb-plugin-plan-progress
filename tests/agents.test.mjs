import { test } from "node:test";
import assert from "node:assert/strict";
import { agentsFromRows, toolWord, visibleAgents } from "../agents.ts";

const delegation = (over = {}) => ({
  kind: "work",
  workKind: "delegation",
  callId: "c1",
  status: "pending",
  description: "Разбор плана",
  subagentType: null,
  startedAt: 1000,
  completedAt: null,
  presentation: { title: "Разбор плана", detail: "Explore agent · model haiku" },
  childRows: [
    { kind: "work", workKind: "file-read", status: "completed" },
    { kind: "work", workKind: "command", status: "pending" },
  ],
  ...over,
});

test("a running delegation becomes a strip with its current tool", () => {
  const [agent] = agentsFromRows([{ kind: "conversation" }, delegation()]);
  assert.deepEqual(agent, {
    id: "c1",
    name: "Разбор плана",
    kind: "Explore agent",
    model: "haiku",
    state: "running",
    tool: "Bash",
    startedAt: 1000,
    endedAt: null,
  });
});

test("a finished one has its end and no tool", () => {
  const [agent] = agentsFromRows([delegation({ status: "completed", completedAt: 5000 })]);
  assert.equal(agent.state, "done");
  assert.equal(agent.endedAt, 5000);
  assert.equal(agent.tool, null);
});

test("tool words", () => {
  assert.equal(toolWord({ workKind: "tool", toolName: "WebFetch" }), "WebFetch");
  assert.equal(toolWord({ workKind: "file-read" }), "Read");
  assert.equal(toolWord({ workKind: "something-new" }), "something-new");
});

test("finished agents fold away after a while", () => {
  const done = agentsFromRows([delegation({ status: "completed", completedAt: 5000 })]);
  assert.equal(visibleAgents(done, 6000, 30_000).length, 1);
  assert.equal(visibleAgents(done, 40_000, 30_000).length, 0);
  const mixed = agentsFromRows([delegation({ callId: "old", status: "completed", completedAt: 5000 }), delegation()]);
  assert.deepEqual(visibleAgents(mixed, 10_000_000, 30_000).map((agent) => agent.id), ["c1"]);
});
