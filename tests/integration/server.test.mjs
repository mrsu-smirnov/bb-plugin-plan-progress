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
    get: async () => ({ status: "active", providerId: "claude-code" }),
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
    await h.emitThreadEvent('experimental_thread.events',{thread:{id:'thread-test',status:'active'}});
    await h.callRpc("diagnostics_get", { threadId: "thread-test" });
    assert.equal(sent.length, 0, "no next call has started yet");
    events.push({ seq: 3.5, createdAt: Date.now() + 1, type: "item/started", data: { item: { type: "commandExecution" } } });
    await h.emitThreadEvent('experimental_thread.events',{thread:{id:'thread-test',status:'active'}});
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

test('accepted human replies clear only older waits, never hidden messages or replay', async () => {
  let events = [];
  const {bb, harness:h} = createFakePluginHost({pluginId:'plan-progress', sdk:{threads:{events:{list: async args => events
    .filter(e => (!args.types || args.types.includes(e.type)) && (!args.beforeSeq || e.seq < Number(args.beforeSeq)))
    .sort((a,b) => b.seq-a.seq).slice(0,Number(args.limit || 100))}}}});
  try {
    await plugin(bb);
    await h.callAgentTool('plan_progress',{id:'wait',steps:[{title:'A'},{title:'B'}],state:'needs_input'});
    let {bars} = await h.callRpc('bars_get',{threadId:'thread-test'});
    const at = bars[0].updatedAt;
    const req = (seq, createdAt, input) => ({seq,createdAt,type:'client/turn/requested',data:{requestId:`r${seq}`,initiator:'user',senderThreadId:null,systemMessageKind:'unlabeled',input}});
    const accept = (seq, id, createdAt) => ({seq,createdAt,type:'turn/input/accepted',data:{clientRequestId:id}});
    events = [req(1,at+10,[{type:'text',visibility:'agent-only'}]),accept(2,'r1',at+11)];
    await h.emitThreadEvent('experimental_thread.events',{thread:{id:'thread-test'}});
    ({bars}=await h.callRpc('bars_get',{threadId:'thread-test'})); assert.equal(bars[0].state,'needs_input');
    events.push(req(3,at+20,[{type:'text'}]),accept(4,'r3',at+21));
    await h.emitThreadEvent('experimental_thread.events',{thread:{id:'thread-test'}});
    ({bars}=await h.callRpc('bars_get',{threadId:'thread-test'})); assert.equal(bars[0].state,'running');
    await new Promise(resolve => setTimeout(resolve, 30));
    await h.callAgentTool('plan_progress',{id:'wait',state:'needs_input'});
    // The previously accepted request cannot clear a newer question even after restart.
    const reloaded = (await h.lifecycle.reload(plugin)).harness;
    ({bars}=await reloaded.callRpc('bars_get',{threadId:'thread-test'}));
    assert.equal(bars[0].state,'needs_input');
  } finally { await h.dispose(); }
});

test('approval count includes only pending approvals of the thread and direct children', async () => {
  let status = 'pending';
  const {bb,harness:h} = createFakePluginHost({pluginId:'plan-progress',sdk:{threads:{
    list:async args => args.offset ? [] : [{id:'child'}],
    interactions:{list:async ({threadId}) => threadId === 'child' ? [{status,payload:{kind:'approval'}}] : [{status:'resolved',payload:{kind:'approval'}},{status:'pending',payload:{kind:'question'}}]},
  }}});
  try {
    await plugin(bb);
    assert.equal((await h.callRpc('approvals_get',{threadId:'thread-test'})).count,1);
    for (status of ['resolved','interrupted','resolving']) {
      await h.emitThreadEvent('experimental_thread.events',{thread:{id:'child'}});
      assert.equal((await h.callRpc('approvals_get',{threadId:'thread-test'})).count,0);
    }
  } finally { await h.dispose(); }
});

test('failed workflow survives timeline eviction and plugin reload', async () => {
  let rows = [{kind:'work',workKind:'delegation',callId:'call',childRef:'task',background:true,status:'completed',startedAt:100,completedAt:110,description:'Task'},
    {kind:'work',workKind:'workflow',itemId:'task',taskType:'local_agent',taskStatus:'failed',status:'error',description:'Task',startedAt:120,completedAt:900}];
  const {bb,harness:h} = createFakePluginHost({pluginId:'plan-progress',sdk:{threads:{
    timeline:async()=>({rows,activeBackgroundCommands:[]}), list:async()=>[], events:{list:async()=>[]},
  }}});
  try {
    await plugin(bb);
    let result = await h.callRpc('agents_get',{threadId:'thread-test'});
    assert.equal(result.agents.length,1); assert.equal(result.agents[0].state,'error');
    rows = [];
    const reload = (await h.lifecycle.reload(plugin)).harness;
    result = await reload.callRpc('agents_get',{threadId:'thread-test'});
    assert.equal(result.agents.length,1); assert.equal(result.agents[0].state,'error');
  } finally {await h.dispose();}
});

test('direct child result follows the latest run without exposing the old model on restart', async () => {
  let status = 'idle';
  let events = [{seq:1,createdAt:100,type:'client/turn/requested',data:{requestId:'req',execution:{model:'old'}}},
    {seq:2,createdAt:110,type:'turn/started',scope:{kind:'turn',turnId:'main'},data:{}},
    {seq:3,createdAt:120,type:'turn/input/accepted',scope:{kind:'turn',turnId:'main'},data:{clientRequestId:'req'}},
    {seq:4,createdAt:200,type:'turn/completed',scope:{kind:'turn',turnId:'main'},data:{status:'completed'}}];
  const {bb,harness:h} = createFakePluginHost({pluginId:'plan-progress',sdk:{threads:{
    timeline:async()=>({rows:[],activeBackgroundCommands:[]}),
    list:async ({offset})=>offset ? [] : [{id:'child',title:'Child',providerId:'codex',status,createdAt:10,updatedAt:200}],
    events:{list:async ({types})=>events.filter(e=>types?.includes(e.type)).sort((a,b)=>b.seq-a.seq)},
  }}});
  try {
    await plugin(bb);
    let result = await h.callRpc('agents_get',{threadId:'thread-test'});
    assert.equal(result.agents[0].state,'done'); assert.equal(result.agents[0].model,'old');
    status='active';
    const reload = (await h.lifecycle.reload(plugin)).harness;
    result = await reload.callRpc('agents_get',{threadId:'thread-test'});
    assert.equal(result.agents[0].state,'running'); assert.equal(result.agents[0].model,null);
  } finally {await h.dispose();}
});

test('background completion events provide outcomes without inventing fields on delegation rows', async () => {
  let outcome = 'failed';
  const row = {kind:'work',workKind:'delegation',callId:'launch',childRef:'task',background:true,status:'completed',startedAt:100,completedAt:110,description:'Task'};
  const {bb,harness:h} = createFakePluginHost({pluginId:'plan-progress',sdk:{threads:{
    timeline:async()=>({rows:[row],activeBackgroundCommands:[]}), list:async()=>[],
    events:{list:async ({types})=>types?.includes('item/backgroundTask/completed') ? [{seq:1,createdAt:outcome === 'failed' ? 500 : 1000,type:'item/backgroundTask/completed',data:{item:{type:'backgroundTask',id:'task',taskType:'local_agent',taskStatus:outcome,description:'Task'}}}] : []},
  }}});
  try {
    await plugin(bb);
    let result = await h.callRpc('agents_get',{threadId:'thread-test'});
    assert.equal(result.agents.length,1); assert.equal(result.agents[0].state,'error');
    outcome='completed';
    const reload = (await h.lifecycle.reload(plugin)).harness;
    result = await reload.callRpc('agents_get',{threadId:'thread-test'});
    assert.equal(result.agents.length,1); assert.equal(result.agents[0].state,'done');
  } finally {await h.dispose();}
});


test('the SDK timeline turn container keeps a completed native delegation in the thread list', async () => {
  const child = {kind:'work',workKind:'delegation',callId:'native-call',childRef:'provider-child',background:false,
    status:'completed',startedAt:100,completedAt:200,description:'Inspect',childRows:[]};
  const {bb,harness:h} = createFakePluginHost({pluginId:'plan-progress',sdk:{threads:{
    timeline:async()=>({rows:[{kind:'turn',status:'completed',children:[{kind:'conversation'},child]}],activeBackgroundCommands:[]}),
    list:async()=>[],events:{list:async()=>[]},
  }}});
  try {await plugin(bb); const {agents}=await h.callRpc('agents_get',{threadId:'thread-test'});
    assert.equal(agents.length,1);assert.equal(agents[0].id,'native-call');assert.equal(agents[0].state,'done');
  } finally {await h.dispose();}
});

test('error trace survives an unknown intermediate snapshot and restart', async () => {
  const launch={kind:'work',workKind:'delegation',callId:'call',childRef:'task',background:true,status:'completed',startedAt:100,completedAt:110,description:'Task'};
  const failure={kind:'work',workKind:'workflow',itemId:'task',taskType:'local_agent',taskStatus:'failed',status:'error',description:'Task',startedAt:120,completedAt:900};
  let rows=[launch,failure];
  const {bb,harness:h}=createFakePluginHost({pluginId:'plan-progress',sdk:{threads:{timeline:async()=>({rows,activeBackgroundCommands:[]}),list:async()=>[],events:{list:async()=>[]}}}});
  try {
    await plugin(bb); assert.equal((await h.callRpc('agents_get',{threadId:'thread-test'})).agents[0].state,'error');
    rows=[launch]; let current=(await h.lifecycle.reload(plugin)).harness;
    assert.equal((await current.callRpc('agents_get',{threadId:'thread-test'})).agents[0].state,'error');
    rows=[]; current=(await current.lifecycle.reload(plugin)).harness;
    assert.equal((await current.callRpc('agents_get',{threadId:'thread-test'})).agents[0].state,'error');
  } finally {await h.dispose();}
});

test('stale progress cannot replace a newer workflow failure; aliases merge without launch', async () => {
  const workflow={kind:'work',workKind:'workflow',itemId:'task',taskType:'local_agent',taskStatus:'failed',status:'error',description:'Task',startedAt:120,completedAt:900};
  let timestamp=200, taskStatus='running';
  const {bb,harness:h}=createFakePluginHost({pluginId:'plan-progress',sdk:{threads:{timeline:async()=>({rows:[workflow],activeBackgroundCommands:[]}),list:async()=>[],
    events:{list:async ({types})=>types.includes('item/backgroundTask/progress') ? [{seq:1,createdAt:timestamp,type:'item/backgroundTask/progress',data:{item:{type:'backgroundTask',id:'task',parentToolCallId:'call',taskType:'local_agent',taskStatus,description:'Task'}}}] : []}}}});
  try {
    await plugin(bb);let {agents}=await h.callRpc('agents_get',{threadId:'thread-test'});
    assert.equal(agents.length,1);assert.equal(agents[0].state,'error');assert.equal(agents[0].endedAt,900);
    timestamp=1000;taskStatus='completed';const reload=(await h.lifecycle.reload(plugin)).harness;
    ({agents}=await reload.callRpc('agents_get',{threadId:'thread-test'}));
    assert.equal(agents.length,1);assert.equal(agents[0].state,'done');assert.equal(agents[0].endedAt,1000);
  } finally {await h.dispose();}
});

test('unavailable child preserves known parent approval and marks coverage incomplete', async () => {
  const {bb,harness:h}=createFakePluginHost({pluginId:'plan-progress',sdk:{threads:{list:async()=>[{id:'child'}],
    interactions:{list:async({threadId})=>{if(threadId==='child')throw Error('unavailable');return [{status:'pending',payload:{kind:'approval'}}];}}}}});
  try {await plugin(bb);assert.deepEqual(await h.callRpc('approvals_get',{threadId:'thread-test'}),{count:1,incomplete:true});}
  finally {await h.dispose();}
});

test('child event bursts reuse unchanged parent and child snapshots', async () => {
  const count={timeline:0,list:0,events:0};
  const children=Array.from({length:10},(_,i)=>({id:`child-${i}`,status:'idle',providerId:'codex',createdAt:1,updatedAt:2}));
  const {bb,harness:h}=createFakePluginHost({pluginId:'plan-progress',settings:{automaticReminders:false},sdk:{threads:{
    timeline:async()=>{count.timeline++;return {rows:[],activeBackgroundCommands:[]};},
    list:async({parentThreadId})=>{count.list++;return parentThreadId==='parent'?children:[];},
    events:{list:async()=>{count.events++;return [];}}
  }}});
  try {await plugin(bb);
    for(const child of children){await h.emitThreadEvent('experimental_thread.events',{thread:{...child,parentThreadId:'parent'}});await new Promise(resolve=>setTimeout(resolve,20));}
    assert.ok(count.timeline<=2,JSON.stringify(count));assert.ok(count.list<=2,JSON.stringify(count));assert.ok(count.events<=25,JSON.stringify(count));
  } finally {await h.dispose();}
});

test('simultaneous agent reads share their in-flight SDK snapshot', async () => {
  let reads=0;
  const {bb,harness:h}=createFakePluginHost({pluginId:'plan-progress',sdk:{threads:{
    timeline:async()=>{reads++;await new Promise(resolve=>setTimeout(resolve,15));return {rows:[],activeBackgroundCommands:[]};},
    list:async()=>[],events:{list:async()=>[]},
  }}});
  try {await plugin(bb);await Promise.all(Array.from({length:8},()=>h.callRpc('agents_get',{threadId:'thread-test'})));assert.equal(reads,1);}
  finally {await h.dispose();}
});

test('root reminder survives duplicate active and plugin reload; send errors stay observable', async () => {
  let events=[]; let sends=0;
  const sdk={threads:{
    get:async()=>({id:'thread-test',providerId:'opencode2',status:'active'}),
    events:{list:async args=>events.filter(e=>(!args.types || args.types.includes(e.type)) && e.seq>Number(args.afterSeq??0))
      .sort((a,b)=>args.order==='desc'?b.seq-a.seq:a.seq-b.seq)},
    send:async()=>{sends++;throw Error('transport unavailable');},
    timeline:async()=>({rows:[],activeBackgroundCommands:[]}),list:async()=>[],
  }};
  const {bb,harness:h}=createFakePluginHost({pluginId:'plan-progress',sdk});let current=h;
  const work=(seq,turnId,type='item/completed')=>({seq,createdAt:100+seq,type,scope:{kind:'turn',turnId},data:{item:{type:'fileRead'}}});
  try {
    await plugin(bb);
    await h.emitThreadEvent('thread.active',{thread:{id:'thread-test'}});
    events=[work(1,'main','turn/started'),work(2,'main'),work(3,'main'),work(4,'main'),work(5,'main','item/started')];
    await h.emitThreadEvent('experimental_thread.events',{thread:{id:'thread-test',status:'active'}});
    await h.callRpc('diagnostics_get',{threadId:'thread-test'});
    assert.equal(sends,1);
    await h.emitThreadEvent('thread.active',{thread:{id:'thread-test'}});
    await h.callRpc('diagnostics_get',{threadId:'thread-test'});assert.equal(sends,1);
    current=(await h.lifecycle.reload(plugin)).harness;
    let result=await current.runCli(['diagnose','--json'],{threadId:'thread-test'});
    const report=JSON.parse(result.stdout);
    assert.equal(sends,1);assert.equal(report.reminder.delivery,'send-error');
    assert.equal(report.providerId,'opencode2');assert.equal(report.nativeToolAvailability.startsWith('unknown'),true);
    events.push(work(15,'next','turn/started'),work(16,'next'),work(17,'next'),work(18,'next'),work(19,'next','item/started'));
    await current.emitThreadEvent('experimental_thread.events',{thread:{id:'thread-test',status:'active'}});
    await current.callRpc('diagnostics_get',{threadId:'thread-test'});assert.equal(sends,2);
  } finally {await current.dispose();}
});

test('diagnose separates CLI observations, plan state, unfinished counts and browser visibility', async () => {
  const {bb,harness:h}=createFakePluginHost({pluginId:'plan-progress',settings:{autoClose:false},sdk:{threads:{
    get:async()=>({id:'thread-test',providerId:'pi',status:'idle'}),
    events:{list:async({types})=>types.includes('client/turn/requested')?[{seq:1,createdAt:100,type:'client/turn/requested',scope:{kind:'thread'},data:{execution:{model:'observed-model'}}}]:[]},
    timeline:async()=>({rows:[],activeBackgroundCommands:[]}),list:async()=>[],
  }}});
  try {
    await plugin(bb);
    await h.runCli(['op',JSON.stringify({id:'example',steps:[{title:'A'},{title:'B'}],state:'done'})],{threadId:'thread-test'});
    const report=JSON.parse((await h.runCli(['diagnose','--json'],{threadId:'thread-test'})).stdout);
    assert.equal(report.lastOperation.route,'cli');assert.equal(report.lastRequestedModel,'observed-model');
    assert.equal(report.plans[0].state,'done');assert.equal(report.plans[0].done,0);
    assert.equal(report.plans[0].visibility,'auto-close-off');assert.equal(report.history.scope,'recent-window');
    assert.equal(JSON.stringify(report).includes('title'),false);
    const failed=await h.callAgentTool('plan_progress',{id:'does-not-exist',next:true});assert.equal(failed.isError,true);
    const after=JSON.parse((await h.runCli(['diagnose','--json'],{threadId:'thread-test'})).stdout);
    assert.equal(after.lastOperation.route,'native');assert.equal(after.lastOperation.ok,false);
  }finally{await h.dispose();}
});

test('event read failure is incomplete evidence, not a claim that a model lacks the tool', async () => {
  const {bb,harness:h}=createFakePluginHost({pluginId:'plan-progress',sdk:{threads:{
    events:{list:async()=>{throw Error('offline');}},
    timeline:async()=>({rows:[],activeBackgroundCommands:[]}),list:async()=>[],
  }}});
  try{
    await plugin(bb);
    const result=await h.runCli(['diagnose','--json'],{threadId:'thread-test'});
    const report=JSON.parse(result.stdout);
    assert.equal(report.history.readFailed,true);assert.equal(report.source,null);
    assert.equal(report.providerId,null);assert.equal(report.nativeToolAvailability.startsWith('unknown'),true);
  }finally{await h.dispose();}
});

test('a delayed reminder send cannot restore deleted state after thread deletion', async () => {
  let release,started;
  const sending=new Promise(resolve=>{started=resolve;});
  const rows=[{seq:1,createdAt:100,type:'turn/started',scope:{kind:'turn',turnId:'a'},data:{}},
    ...[2,3,4].map(seq=>({seq,createdAt:seq+100,type:'item/completed',scope:{kind:'turn',turnId:'a'},data:{item:{type:'fileRead'}}})),
    {seq:5,createdAt:105,type:'item/started',scope:{kind:'turn',turnId:'a'},data:{item:{type:'fileRead'}}}];
  const {bb,harness:h}=createFakePluginHost({pluginId:'plan-progress',sdk:{threads:{
    get:async()=>({status:'active',providerId:'codex'}),
    events:{list:async args=>rows.filter(e=>e.seq>Number(args.afterSeq??0)).sort((a,b)=>args.order==='desc'?b.seq-a.seq:a.seq-b.seq)},
    send:async()=>{started();return await new Promise(resolve=>{release=()=>resolve({delivery:'sent'});});},
  }}});
  try{
    await plugin(bb);
    await h.emitThreadEvent('thread.active',{thread:{id:'thread-test'}});
    const pending=h.callRpc('diagnostics_get',{threadId:'thread-test'});
    await sending;
    await h.emitThreadEvent('thread.deleted',{thread:{id:'thread-test'}});
    release();await pending;
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(await bb.storage.kv.get('reminder-v06:thread-test'),undefined);
  }finally{await h.dispose();}
});

test('diagnose only observes: no send even when a stored reminder threshold is due', async () => {
  const rows=[{seq:1,createdAt:100,type:'turn/started',scope:{kind:'turn',turnId:'a'},data:{}},
    ...[2,3,4].map(seq=>({seq,createdAt:seq+100,type:'item/completed',scope:{kind:'turn',turnId:'a'},data:{item:{type:'fileRead'}}})),
    {seq:5,createdAt:105,type:'item/started',scope:{kind:'turn',turnId:'a'},data:{item:{type:'fileRead'}}}];
  let sends=0;
  const {bb,harness:h}=createFakePluginHost({pluginId:'plan-progress',sdk:{threads:{
    get:async()=>({id:'thread-test',providerId:'codex',status:'active'}),
    events:{list:async args=>rows.filter(e=>(!args.types||args.types.includes(e.type))&&e.seq>Number(args.afterSeq??0)).sort((a,b)=>args.order==='desc'?b.seq-a.seq:a.seq-b.seq)},
    send:async()=>{sends++;return {delivery:'sent'};},timeline:async()=>({rows:[],activeBackgroundCommands:[]}),list:async()=>[],
  }}});
  try{
    await plugin(bb);
    const report=JSON.parse((await h.runCli(['diagnose','--json'],{threadId:'thread-test'})).stdout);
    assert.equal(sends,0);assert.equal(report.reminder.work,3);assert.equal(report.reminder.sent,false);
  }finally{await h.dispose();}
});

test('incremental history reaches its tail before any reminder decision', async () => {
  let rows=[];let sends=0;
  const {bb,harness:h}=createFakePluginHost({pluginId:'plan-progress',sdk:{threads:{
    get:async()=>({status:'active'}),
    events:{list:async args=>rows.filter(e=>e.seq>Number(args.afterSeq??0)).sort((a,b)=>args.order==='desc'?b.seq-a.seq:a.seq-b.seq).slice(0,100)},
    send:async()=>{sends++;return {delivery:'sent'};},
  }}});
  try{
    await plugin(bb);
    await h.emitThreadEvent('thread.active',{thread:{id:'thread-test'}});
    await h.callRpc('diagnostics_get',{threadId:'thread-test'});
    rows=[{seq:1,createdAt:1,type:'turn/started',scope:{kind:'turn',turnId:'old'},data:{}},
      ...Array.from({length:110},(_,i)=>({seq:i+2,createdAt:i+2,type:'item/completed',scope:{kind:'turn',turnId:'old'},data:{item:{type:'fileRead'}}})),
      {seq:112,createdAt:112,type:'turn/completed',scope:{kind:'turn',turnId:'old'},data:{}},
      {seq:113,createdAt:113,type:'turn/started',scope:{kind:'turn',turnId:'new'},data:{}}];
    await h.emitThreadEvent('experimental_thread.events',{thread:{id:'thread-test',status:'active'}});
    await h.callRpc('diagnostics_get',{threadId:'thread-test'});
    assert.equal(sends,0);
    assert.equal((await bb.storage.kv.get('reminder-v06:thread-test')).turnId,'new');
  }finally{await h.dispose();}
});

test('old send completion after plugin reload cannot overwrite the new generation', async () => {
  let release,entered;const sending=new Promise(resolve=>{entered=resolve;});
  const rows=[{seq:1,createdAt:100,type:'turn/started',scope:{kind:'turn',turnId:'a'},data:{}},
    ...[2,3,4].map(seq=>({seq,createdAt:seq+100,type:'item/completed',scope:{kind:'turn',turnId:'a'},data:{item:{type:'fileRead'}}})),
    {seq:5,createdAt:105,type:'item/started',scope:{kind:'turn',turnId:'a'},data:{item:{type:'fileRead'}}}];
  const {bb,harness:h}=createFakePluginHost({pluginId:'plan-progress',sdk:{threads:{
    get:async()=>({status:'active',providerId:'codex'}),
    events:{list:async args=>rows.filter(e=>e.seq>Number(args.afterSeq??0)).sort((a,b)=>args.order==='desc'?b.seq-a.seq:a.seq-b.seq)},
    send:async()=>{entered();return await new Promise(resolve=>{release=()=>resolve({delivery:'sent'});});},
  }}});let current=h;
  try{
    await plugin(bb);
    await h.emitThreadEvent('thread.active',{thread:{id:'thread-test'}});
    const pending=h.callRpc('diagnostics_get',{threadId:'thread-test'});
    await sending;
    const replacement=await h.lifecycle.reload(plugin);current=replacement.harness;
    release();await pending.catch(()=>{});
    const before=await current.callRpc('diagnostics_get',{threadId:'thread-test'});
    assert.equal(before.diagnostic.warning,null);
    const report=JSON.parse((await current.runCli(['diagnose','--json'],{threadId:'thread-test'})).stdout);
    assert.equal(report.reminder.delivery,'unknown');assert.equal(report.reminder.sent,true);
  }finally{await current.dispose();}
});

test('ACP caught inner failure remains failed in the public diagnostic', async () => {
  const row={seq:60,createdAt:100,type:'item/completed',scope:{kind:'turn',turnId:'root'},data:{item:{
    type:'toolCall',tool:'plan_progress',server:'bb',status:'completed',result:{metadata:{truncated:false,toolCalls:[
      {tool:'bb-bridge.plan_progress',status:'completed'}, {tool:'bb-bridge.plan_progress',status:'error'}]}}}}};
  const {bb,harness:h}=createFakePluginHost({pluginId:'plan-progress',sdk:{threads:{
    events:{list:async args=>Number(args.afterSeq??0)<60?[row]:[]},
  }}});
  try{await plugin(bb);const report=await h.callRpc('diagnostics_get',{threadId:'thread-test'});
    assert.equal(report.diagnostic.source,'bb');assert.equal(report.diagnostic.lastOutcome,'failed');
  }finally{await h.dispose();}
});

test("an op without a known action is refused by the tool and the CLI and keeps a question standing", async () => {
  const { bb, harness: h } = createFakePluginHost({ pluginId: "plan-progress" });
  try {
    await plugin(bb);
    await h.callAgentTool("plan_progress", { id: "q", title: "Ask", steps: ["A", "B"] });
    await h.callAgentTool("plan_progress", { id: "q", state: "needs_input", note: "Which one?" });
    for (const op of [{ id: "q" }, { id: "q", complete: ["A"] }]) {
      const refused = await h.callAgentTool("plan_progress", op);
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /none of stages, steps, next/);
      const cli = await h.runCli(["op", JSON.stringify(op)], { threadId: "thread-test" });
      assert.equal(cli.exitCode, 1);
      assert.match(cli.stderr, /none of stages, steps, next/);
    }
    const { bars } = await h.callRpc("bars_get", { threadId: "thread-test" });
    assert.equal(bars[0].state, "needs_input");
    assert.equal(bars[0].note, "Which one?");
    const warned = await h.callAgentTool("plan_progress", { id: "q", next: true, complete: ["A"], other: 1 });
    assert.match(warned, /ignored unknown field\(s\): complete, other/);
    const viaCli = await h.runCli(["op", JSON.stringify({ id: "q", next: true, bogus: true })], { threadId: "thread-test" });
    assert.equal(viaCli.exitCode, 0);
    assert.match(viaCli.stdout, /ignored unknown field\(s\): bogus/);
  } finally { await h.dispose(); }
});

test("the tool accepts plain-string steps and stage titles, and names an empty plan", async () => {
  const { bb, harness: h } = createFakePluginHost({ pluginId: "plan-progress" });
  try {
    await plugin(bb);
    assert.match(await h.callAgentTool("plan_progress", { id: "s", title: "T", stages: [{ title: "One", steps: ["A", "B"] }] }), /0\/2 done.*active: A/);
    const empty = await h.callAgentTool("plan_progress", { id: "e", title: "T", stages: [{ name: "One", steps: [] }] });
    assert.equal(empty.isError, true);
    assert.match(empty.content[0].text, /Could not read the breakdown/);
    assert.match(h.registrations.agentTools[0].instructions, /plain strings/);
  } finally { await h.dispose(); }
});

test("CLI reads --thread=ID like --thread ID, rejects stray words and options, and clear obeys the thread", async () => {
  const { bb, harness: h } = createFakePluginHost({ pluginId: "plan-progress" });
  try {
    await plugin(bb);
    const op = JSON.stringify({ id: "p", title: "P", steps: ["A", "B"] });
    assert.equal((await h.runCli(["op", op, "--thread=other"], { threadId: "mine" })).exitCode, 0);
    assert.equal((await h.runCli(["op", op, "--thread", "mine"], { threadId: "mine" })).exitCode, 0);
    assert.equal(JSON.parse((await h.runCli(["show", "--json", "--thread=other"], { threadId: "mine" })).stdout).length, 1);
    for (const argv of [["show", "--bogus"], ["show", "extra"], ["clear", "now"], ["show", "--thread="], ["show", "--thread"]]) {
      const result = await h.runCli(argv, { threadId: "mine" });
      assert.equal(result.exitCode, 1, argv.join(" "));
    }
    assert.match((await h.runCli(["show", "--bogus"], { threadId: "mine" })).stderr, /Unknown option --bogus/);
    assert.equal((await h.runCli(["clear", "--thread=other"], { threadId: "mine" })).exitCode, 0);
    assert.equal((await h.runCli(["show", "--thread=other"], { threadId: "mine" })).stdout, "No bars.");
    assert.notEqual((await h.runCli(["show"], { threadId: "mine" })).stdout, "No bars.");
  } finally { await h.dispose(); }
});

test("answer evidence is read only while a plan waits on a person, and a failed read is only logged", async () => {
  let reads = 0;
  const { bb, harness: h } = createFakePluginHost({ pluginId: "plan-progress",
    sdk: { threads: { events: { list: async (args) => { if (args.types?.includes("turn/input/accepted")) reads++; return []; } } } } });
  try {
    await plugin(bb);
    await h.callAgentTool("plan_progress", { id: "w", steps: ["A", "B"] });
    await h.emitThreadEvent("experimental_thread.events", { thread: { id: "thread-test" } });
    await h.callRpc("bars_get", { threadId: "thread-test" });
    assert.equal(reads, 0);
    await h.callAgentTool("plan_progress", { id: "w", state: "needs_input", note: "?" });
    await h.callRpc("bars_get", { threadId: "thread-test" });
    assert.ok(reads > 0);
    const rejections = [];
    const record = (error) => rejections.push(error);
    process.on("unhandledRejection", record);
    try {
      const get = bb.storage.kv.get;
      bb.storage.kv.get = async () => { throw new Error("kv down"); };
      await h.emitThreadEvent("experimental_thread.events", { thread: { id: "thread-test" } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      bb.storage.kv.get = get;
    } finally { process.off("unhandledRejection", record); }
    assert.deepEqual(rejections, []);
  } finally { await h.dispose(); }
});

test("a reminder is not sent when the turn ended during the final recheck, or the thread is no longer running", async () => {
  for (const ending of ["completed-event", "idle-status"]) {
    const sent = [];
    const rows = [{ seq: 1, createdAt: 100, type: "turn/started", scope: { kind: "turn", turnId: "a" }, data: {} },
      ...[2, 3, 4].map(seq => ({ seq, createdAt: seq + 100, type: "item/completed", scope: { kind: "turn", turnId: "a" }, data: { item: { type: "fileRead" } } })),
      { seq: 5, createdAt: 105, type: "item/started", scope: { kind: "turn", turnId: "a" }, data: { item: { type: "fileRead" } } }];
    const { bb, harness: h } = createFakePluginHost({ pluginId: "plan-progress", sdk: { threads: {
      // the turn finishes while the plugin is looking
      get: async () => {
        if (ending === "completed-event") rows.push({ seq: 6, createdAt: 200, type: "turn/completed", scope: { kind: "turn", turnId: "a" }, data: {} });
        return { status: ending === "idle-status" ? "idle" : "active" };
      },
      events: { list: async args => rows.filter(e => (!args.types || args.types.includes(e.type)) && e.seq > Number(args.afterSeq ?? 0))
        .sort((a, b) => args.order === "desc" ? b.seq - a.seq : a.seq - b.seq) },
      send: async args => { sent.push(args); return { ok: true, delivery: "sent" }; },
    } } });
    try {
      await plugin(bb);
      await h.emitThreadEvent("thread.active", { thread: { id: "thread-test", providerId: "codex" } });
      await h.callRpc("diagnostics_get", { threadId: "thread-test" });
      assert.equal(sent.length, 0, ending);
      const report = JSON.parse((await h.runCli(["diagnose", "--json"], { threadId: "thread-test" })).stdout);
      assert.equal(report.reminder.delivery, "skipped", ending);
    } finally { await h.dispose(); }
  }
});

test("0.6.2: the event request includes item/started; a turn ending without a next call sends nothing", async () => {
  const requested = []; const sent = [];
  const rows = [{ seq: 1, createdAt: 100, type: "turn/started", scope: { kind: "turn", turnId: "a" }, data: {} },
    ...[2, 3, 4].map(seq => ({ seq, createdAt: seq + 100, type: "item/completed", scope: { kind: "turn", turnId: "a" }, data: { item: { type: "fileRead" } } }))];
  const { bb, harness: h } = createFakePluginHost({ pluginId: "plan-progress", sdk: { threads: {
    get: async () => ({ status: "active", providerId: "codex" }),
    events: { list: async args => { requested.push(args.types);
      return rows.filter(e => (!args.types || args.types.includes(e.type)) && e.seq > Number(args.afterSeq ?? 0))
        .sort((a, b) => args.order === "desc" ? b.seq - a.seq : a.seq - b.seq); } },
    send: async args => { sent.push(args); return { ok: true, delivery: "sent" }; },
  } } });
  try {
    await plugin(bb);
    await h.emitThreadEvent("thread.active", { thread: { id: "thread-test" } });
    await h.callRpc("diagnostics_get", { threadId: "thread-test" });
    assert.equal(requested.some(types => types?.includes("item/started")), true);
    assert.equal(sent.length, 0);
    rows.push({ seq: 5, createdAt: 200, type: "turn/completed", scope: { kind: "turn", turnId: "a" }, data: {} },
      { seq: 6, createdAt: 201, type: "item/started", scope: { kind: "turn", turnId: "a" }, data: { item: { type: "commandExecution" } } });
    await h.callRpc("diagnostics_get", { threadId: "thread-test" });
    assert.equal(sent.length, 0);
  } finally { await h.dispose(); }
});

// 0.6.2, second change: a steer in an ACP provider interrupted a running command.
function releaseHost(providerId, onGet = () => {}) {
  const rows = [], sent = [], gets = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "plan-progress", sdk: { threads: {
    get: async () => { gets.push(1); onGet(rows); return { status: "active", providerId }; },
    events: { list: async args => rows.filter(e => (!args.types || args.types.includes(e.type)) && e.seq > Number(args.afterSeq ?? 0))
      .sort((a, b) => args.order === "desc" ? b.seq - a.seq : a.seq - b.seq).slice(0, Number(args.limit ?? 100)) },
    send: async args => { sent.push(args); return { ok: true, delivery: "sent" }; },
  } } });
  const at = (seq, type, item) => ({ seq, createdAt: Date.now() + seq, type, scope: { kind: "turn", turnId: "a" },
    data: item ? { item: { status: "completed", ...item } } : {} });
  const begin = (seq, id) => at(seq, "item/started", { id, type: "commandExecution", status: "pending" });
  const end = (seq, id) => at(seq, "item/completed", { id, type: "commandExecution" });
  rows.push(at(1, "turn/started"), begin(2, "a"), end(3, "a"), begin(4, "b"), end(5, "b"), begin(6, "c"), end(7, "c"));
  // Event-triggered reads run in the background; let a queued re-read finish.
  const settle = async () => { for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    await harness.callRpc("diagnostics_get", { threadId: "thread-test" });
  } };
  const tick = async () => {
    await harness.emitThreadEvent("experimental_thread.events", { thread: { id: "thread-test", status: "active" } });
    await settle();
  };
  return { bb, h: harness, rows, sent, gets, begin, end, at, tick, settle };
}

test("0.6.2 ACP: an acp provider gets the reminder only after the next call completed with nothing open", async () => {
  const { bb, h, rows, sent, begin, end, tick, settle } = releaseHost("acp-kimi-code");
  try {
    await plugin(bb);
    await h.emitThreadEvent("thread.active", { thread: { id: "thread-test", providerId: "acp-kimi-code" } });
    await settle();
    await tick();
    assert.equal(sent.length, 0, "threshold reached, no next call yet");
    rows.push(begin(8, "d"), begin(9, "d"));
    await tick();
    assert.equal(sent.length, 0, "never at the start of a call");
    rows.push(begin(10, "e"), end(11, "d"));
    await tick();
    assert.equal(sent.length, 0, "a parallel call is still running");
    rows.push(end(12, "e"));
    await tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].mode, "steer");
    rows.push(begin(13, "f"), end(14, "f"));
    await tick();
    assert.equal(sent.length, 1, "one reminder per turn");
  } finally { await h.dispose(); }
});

test("0.6.2 ACP: a call starting during the final recheck holds the reminder until it completes", async () => {
  let raced = false;
  const { bb, h, rows, sent, begin, end, tick, settle } = releaseHost("acp-kimi-code", list => {
    // the next call begins while the plugin looks one last time
    if (!raced && list.some(row => row.seq === 9)) { raced = true; list.push(begin(10, "e")); }
  });
  try {
    await plugin(bb);
    await h.emitThreadEvent("thread.active", { thread: { id: "thread-test", providerId: "acp-kimi-code" } });
    await settle();
    rows.push(begin(8, "d"), end(9, "d"));
    await tick();
    assert.equal(raced, true);
    assert.equal(sent.length, 0);
    const report = JSON.parse((await h.runCli(["diagnose", "--json"], { threadId: "thread-test" })).stdout);
    assert.equal(report.reminder.sent, false);
    assert.equal(report.reminder.delivery, "not-attempted");
    rows.push(end(11, "e"));
    await tick();
    assert.equal(sent.length, 1);
  } finally { await h.dispose(); }
});

test("0.6.2 ACP: an unknown provider is treated like ACP; codex still gets it at the next start", async () => {
  for (const providerId of [undefined, "codex"]) {
    const { bb, h, rows, sent, gets, begin, end, tick, settle } = releaseHost(providerId);
    try {
      await plugin(bb);
      await h.emitThreadEvent("thread.active", { thread: { id: "thread-test" } });
      await settle();
      rows.push(begin(8, "d"));
      await tick();
      assert.equal(sent.length, providerId === "codex" ? 1 : 0, String(providerId));
      rows.push(end(9, "d"));
      await tick();
      assert.equal(sent.length, 1, String(providerId));
      if (providerId === "codex") assert.ok(gets.length <= 2, "the provider is read once and remembered");
    } finally { await h.dispose(); }
  }
});
