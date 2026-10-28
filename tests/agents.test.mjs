import { test } from "node:test";
import assert from "node:assert/strict";
import { agentFromChild, agentsFromRows, toolWord, visibleAgents } from "../agents.ts";

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

test("model and effort read together", () => {
  const [agent] = agentsFromRows([
    delegation({ presentation: { detail: "general-purpose agent · model sonnet 5.5 · effort medium" } }),
  ]);
  assert.equal(agent.kind, "general-purpose agent");
  assert.equal(agent.model, "sonnet 5.5 · medium");
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

test("a background agent runs while bb lists it as active", () => {
  const launched = delegation({
    callId: "bg",
    status: "completed",
    completedAt: 1100,
    background: true,
    childRows: [{ kind: "work", workKind: "file-read", status: "pending", startedAt: 1200 }],
  });
  const active = [{ taskType: "local_agent", description: "Разбор плана", startedAt: 1050, itemId: "t1" }];
  const [running] = agentsFromRows([launched], active);
  assert.equal(running.state, "running");
  assert.equal(running.tool, "Read");
  assert.equal(running.endedAt, null);

  const finished = delegation({
    callId: "bg",
    status: "completed",
    completedAt: 1100,
    background: true,
    childRows: [{ kind: "work", workKind: "tool", toolName: "SubagentHandback", status: "completed", startedAt: 8000, completedAt: 9000 }],
  });
  const [done] = agentsFromRows([finished], []);
  assert.equal(done.state, "done");
  assert.equal(done.endedAt, 9000);
});

test("an active background agent without its launch row still gets a strip", () => {
  const agents = agentsFromRows([], [{ taskType: "local_agent", description: "Старый", startedAt: 5, itemId: "t9" }]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].state, "running");
});

test("a child thread on another provider becomes a strip with provider and model", () => {
  const thread = { id: "thr_1", title: "Демо: Codex", providerId: "codex", status: "idle", createdAt: 1000, updatedAt: 5000 };
  assert.deepEqual(agentFromChild(thread, { model: "gpt-6.1-terra", reasoningLevel: "medium" }), {
    id: "thr_1", name: "Демо: Codex", kind: "Codex", model: "Codex · gpt-6.1-terra · medium",
    state: "done", tool: null, startedAt: 1000, endedAt: 5000,
  });
  assert.equal(agentFromChild({ ...thread, status: "active" }, null).state, "running");
  assert.equal(agentFromChild({ ...thread, status: "failed" }, null).model, "Codex");
  assert.equal(
    agentFromChild({ ...thread, providerId: "pi" }, { model: "openrouter/anthropic/claude-haiku-5.5" }).model,
    "Pi · claude-haiku-5.5",
  );
});
