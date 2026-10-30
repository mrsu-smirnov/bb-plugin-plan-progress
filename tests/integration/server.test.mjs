import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../dist/server.js";
import hostEntry from "../../dist/host.js";

test("isolation is contributed only to Claude thread processes, never model listing or other providers", async () => {
  const { bb, harness: h } = createFakePluginHost({ pluginId: "plan-progress",
    experimental_callHostRpc: () => ({ launcher: "/plugin/launcher.mjs", executable: "/bin/claude" }),
  });
  try {
    await plugin(bb);
    const ctx = { hostId: "host-test", threadId: "thread-test", projectId: "project-test" };
    assert.deepEqual(await h.resolveProviderEnv("codex", ctx), []);
    assert.deepEqual(await h.resolveProviderEnv("pi", ctx), []);
    assert.deepEqual(await h.resolveProviderEnv("claude-code", { ...ctx, threadId: null }), []);
    const env = await h.resolveProviderEnv("claude-code", ctx);
    assert.equal(env[0].name, "BB_CLAUDE_CODE_EXECUTABLE");
    assert.equal(env[0].value, "/plugin/launcher.mjs");
    assert.equal(h.experimental_hostRpcCalls.length, 1);
    await h.setSettings({ isolateClaude: false });
    assert.deepEqual(await h.resolveProviderEnv("claude-code", ctx), []);
    assert.equal(h.experimental_hostRpcCalls.length, 1);
    assert.match(h.registrations.agentTools[0].instructions, /Read-only work counts/);
    assert.match(h.registrations.agentTools[0].instructions, /mcp__bb-bridge__plan_progress/);
  } finally { await h.dispose(); }
});

test("RPC and CLI expose an original-tool collision without any BB bars; later BB call clears it", async () => {
  let events = [{ seq: 30, type: "item/completed", data: {
    item: { type: "toolCall", server: "plan-progress", tool: "plan_progress" },
  } }];
  const { bb, harness: h } = createFakePluginHost({ pluginId: "plan-progress",
    sdk: { threads: { events: { list: async args => events.filter(e => e.seq > Number(args.afterSeq ?? 0)) } } },
  });
  try {
    await plugin(bb);
    const before = await h.callRpc("diagnostics_get", { threadId: "thread-test" });
    assert.equal(before.diagnostic.source, "claude-original");
    assert.ok(before.diagnostic.warning);
    const report = await h.runCli(["diagnose", "--json"], { threadId: "thread-test" });
    assert.equal(JSON.parse(report.stdout).bars, 0);
    const created = await h.callAgentTool("plan_progress", {
      id: "test", title: "Check", steps: [{ title: "Read" }, { title: "Report" }],
    });
    assert.match(created, /^BB\/thread-test:/);
    events = [{ seq: 31, type: "item/completed", data: {
      item: { type: "toolCall", server: "bb", tool: "plan_progress" },
    } }];
    const after = await h.callRpc("diagnostics_get", { threadId: "thread-test" });
    assert.equal(after.diagnostic.warning, null);
    assert.equal(after.diagnostic.lastCallSeq, 31);
  } finally { await h.dispose(); }
});

test("built host prepares a working launcher concurrently and leaves source settings unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bb-host-progress-"));
  try {
    const executable = join(dir, "fake claude.mjs");
    await writeFile(executable, 'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 7;');
    await chmod(executable, 0o700);
    const dataDir = join(dir, "plugin data");
    const context = { experimental_paths: { dataDir }, signal: new AbortController().signal };
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      hostEntry.handlers.prepareClaude({ executable }, context)));
    assert.equal(new Set(results.map(r => r.launcher)).size, 1);
    const settings = join(dir, "Desktop settings.json");
    const original = '{"enabledPlugins":{"plan-progress@zycck-mods":true},"fastMode":true}';
    await writeFile(settings, original);
    const run = spawnSync(process.execPath, [results[0].launcher, "--settings", settings, "plugin", "list", "--json"], { encoding: "utf8" });
    assert.equal(run.status, 7, run.stderr);
    const args = JSON.parse(run.stdout);
    assert.equal(args[0], "--settings");
    assert.deepEqual(args.slice(2), ["plugin", "list", "--json"]);
    assert.equal(JSON.parse(args[1]).enabledPlugins["plan-progress@zycck-mods"], false);
    assert.equal(JSON.parse(args[1]).fastMode, true);
    assert.equal(await readFile(settings, "utf8"), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a missing-plan reminder uses strict steering once and never sends from an idle thread", async () => {
  let events = [];
  const sent = [];
  const { bb, harness: h } = createFakePluginHost({ pluginId: "plan-progress", sdk: { threads: {
    events: { list: async args => events.filter(e => e.seq > Number(args.afterSeq ?? 0))
      .sort((a,b) => args.order === "desc" ? b.seq-a.seq : a.seq-b.seq) },
    timeline: async () => ({ rows: [], activeBackgroundCommands: [] }),
    send: async args => { sent.push(args); return { ok: true, delivery: "sent" }; },
  } } });
  try {
    await plugin(bb);
    await h.emitThreadEvent("thread.active", { thread: { id: "thread-test" } });
    events = [1,2,3].map(seq => ({ seq, createdAt: Date.now() + 1, type: "item/completed",
      data: { item: { type: "fileRead" } } }));
    await h.callRpc("diagnostics_get", { threadId: "thread-test" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].mode, "steer");
    assert.equal(sent[0].input[0].visibility, "agent-only");
    events.push({ ...events[2], seq: 4 });
    await h.callRpc("diagnostics_get", { threadId: "thread-test" });
    assert.equal(sent.length, 1);
    await h.emitThreadEvent("thread.idle", { thread: { id: "thread-test" } });
    events.push({ ...events[2], seq: 5 });
    await h.callRpc("diagnostics_get", { threadId: "thread-test" });
    assert.equal(sent.length, 1);
  } finally { await h.dispose(); }
});


test("hiding through RPC keeps the plan updatable, survives reload, and is reversible", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "plan-progress", settings: { autoClose: false } });
  let h = harness;
  try {
    await plugin(bb);
    const args = { threadId: "thread-test", id: "visibility" };
    await h.callAgentTool("plan_progress", { id: args.id, steps: [{ title: "First" }, { title: "Second" }] });
    await h.callRpc("bars_setVisibility", { ...args, hidden: true });
    const result = await h.callAgentTool("plan_progress", { id: args.id, next: true });
    assert.match(result, /1\/2 done/);
    h = (await h.lifecycle.reload(plugin)).harness;
    let { bars } = await h.callRpc("bars_get", { threadId: args.threadId });
    assert.equal(bars.length, 1);
    assert.equal(bars[0].hidden, "manual");
    await h.callRpc("bars_setVisibility", { ...args, hidden: false });
    ({ bars } = await h.callRpc("bars_get", { threadId: args.threadId }));
    assert.equal(bars[0].hidden, undefined);
    // The old frontend's cross must also be safe during an upgrade.
    await h.callRpc("bars_dismiss", args);
    assert.match(await h.callAgentTool("plan_progress", { id: args.id, next: true }), /2\/2 done/);
    ({ bars } = await h.callRpc("bars_get", { threadId: args.threadId }));
    const endedAt = bars[0].endedAt;
    await h.callRpc("bars_setVisibility", { ...args, hidden: false });
    assert.equal((await h.callRpc("bars_setVisibility", { ...args, hidden: true, endedAt })).changed, false);
    const config = await h.runCli(["show", "--json"], { threadId: args.threadId });
    assert.equal(JSON.parse(config.stdout).length, 1);
  } finally { await h.dispose(); }
});
