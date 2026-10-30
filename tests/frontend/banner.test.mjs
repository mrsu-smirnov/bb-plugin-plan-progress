import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { applyOp, setVisibility } from "../../engine.ts";

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const name of ['window', 'document', 'HTMLElement', 'Node', 'MutationObserver', 'localStorage']) {
  globalThis[name] = dom.window[name];
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { loadPluginApp, renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
const { fireEvent, waitFor, act } = await import('@testing-library/react');
await mkdir('.test-tmp', { recursive: true });
await build({ entryPoints: ['app.tsx'], outfile: '.test-tmp/app.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external' });
const app = await loadPluginApp(() => import('../../.test-tmp/app.mjs'));
const banner = app.composerCustomizations[0].banners[0];

const titles = ['Приёмка текущего релиза', 'Две согласованные правки', 'Маппинг статей движения', 'ЦФО по названиям', 'Выбор ответственного', 'Повторное открытие задачи', 'Подготовка публикации', 'Проверка сборки', 'Работа с документами'];
function fixture() {
  return titles.map((title, index) => {
    let bar = applyOp([], { id: `b${index}`, title,
      steps: [{ title: 'Собрать данные' }, { title: 'Подготовить результат' }, { title: 'Проверить' }, { title: 'Завершить' }] }, 1000 + index).bar;
    bar = applyOp([bar], { id: bar.id, next: true }, 2000 + index).bar;
    bar = applyOp([bar], { id: bar.id, next: true }, 3000 + index).bar;
    if (index === 6) bar = applyOp([bar], { id: bar.id, state: 'needs_input', note: 'Выбрать вариант' }, 4000).bar;
    if (index === 7) bar = applyOp([bar], { id: bar.id, state: 'error', note: 'Ошибка сборки' }, 4001).bar;
    return bar;
  });
}

function mount(getBars, change = () => {}, settings = { autoClose: false, effects: false }, getAgents = () => [], getApprovals = () => 0) {
  return renderSlot(banner, {}, { context: { threadId: 'fixture-thread', projectId: null },
    settings, rpc: {
      bars_get: () => ({ bars: getBars() }),
      agents_get: () => ({ agents: getAgents() }),
      approvals_get: () => ({ count: getApprovals() }),
      diagnostics_get: () => ({ diagnostic: { source: 'bb', warning: null, lastCallSeq: 0 } }),
      bars_setVisibility: args => { change(args); return { changed: true }; },
    } });
}

test('nine plans stay compact; collapse persists through updates, remount and thread switches; hidden plan restores', async () => {
  localStorage.clear();
  let bars = fixture();
  let slot = mount(() => bars, args => { bars = bars.map(b => b.id === args.id ? setVisibility(b, args.hidden, args.endedAt) : b); });
  try {
    await slot.findByRole('button', { name: 'Show all (9)' });
    assert.equal(slot.getAllByRole('progressbar').length, 3);
    fireEvent.click(slot.getByRole('button', { name: /Progress · 9/ }));
    assert.equal(slot.queryAllByRole('progressbar').length, 0);
    bars = [...bars, applyOp([], { id: 'new', title: 'New work', steps: [{ title: 'Work' }] }, 9000).bar];
    await slot.emitRealtime('bars-changed', { threadId: 'fixture-thread' });
    assert.equal(slot.queryAllByRole('progressbar').length, 0);
    slot.unmount();
    slot = mount(() => bars, args => { bars = bars.map(b => b.id === args.id ? setVisibility(b, args.hidden, args.endedAt) : b); });
    await slot.findByRole('button', { name: /Progress · 10/ });
    assert.equal(slot.queryAllByRole('progressbar').length, 0);
    await slot.setComposerScope({ kind: 'thread', threadId: 'other-thread' });
    await waitFor(() => assert.equal(slot.getAllByRole('progressbar').length, 3));
    await slot.setComposerScope({ kind: 'thread', threadId: 'fixture-thread' });
    await waitFor(() => assert.equal(slot.queryAllByRole('progressbar').length, 0));
    fireEvent.click(slot.getByRole('button', { name: /Progress · 10/ }));
    fireEvent.click(slot.getByRole('button', { name: 'Show all (10)' }));
    await waitFor(() => assert.equal(slot.getAllByRole('progressbar').length, 10));
    fireEvent.click(slot.getByLabelText('Actions for plan "New work"'));
    fireEvent.click(slot.getByRole('button', { name: /Hide plan "New work"/ }));
    await waitFor(() => assert.equal(bars.find(b => b.id === 'new').hidden, 'manual'));
    await slot.emitRealtime('bars-changed', { threadId: 'fixture-thread' });
    fireEvent.click(await slot.findByRole('button', { name: 'Hidden plans (1)' }));
    fireEvent.click(slot.getByRole('button', { name: 'Restore plan "New work"' }));
    await waitFor(() => assert.equal(bars.find(b => b.id === 'new').hidden, undefined));
    bars = fixture();
    await slot.emitRealtime('bars-changed', { threadId: 'fixture-thread' });
    fireEvent.click(await slot.findByRole('button', { name: 'Show fewer' }));
    await waitFor(() => assert.equal(slot.getAllByRole('progressbar').length, 3));
    const previewDir = process.env.PLAN_PROGRESS_PREVIEW_DIR;
    if (previewDir) {
      const css = await readFile('dist/app.css', 'utf8');
      await mkdir(previewDir, { recursive: true });
      await writeFile(`${previewDir}/index.html`, `<!doctype html><html class="dark"><meta charset="utf-8"><link rel="stylesheet" href="bb-base.css"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plan Progress 0.4.0 — compact view</title><style>${css}
      :root{--color-foreground:#eee;--color-muted-foreground:#aaa;--color-muted:#303030;--color-border:#454545;--foreground:#eee;--muted-foreground:#aaa;--muted:#303030;--border:#454545}
      body{margin:0;background:#171717;color:#eee;font:14px system-ui;padding:24px}main{max-width:760px;margin:auto}h1{font-size:18px}p{color:#aaa}button{cursor:pointer}
      </style><main data-bb-plugin="plan-progress"><h1>Plan Progress · 0.4.0</h1><p>Проверка девяти планов в узкой и широкой колонке</p>${slot.container.innerHTML}<p>Здесь остаётся место для переписки.</p><div style="border:1px solid #444;border-radius:16px;padding:20px;color:#888">Ask a follow-up</div></main></html>`);
    }
  } finally { slot.unmount(); await rm('.test-tmp', { recursive: true, force: true }); }
});


test('one and three plans need no Show all control', async () => {
  localStorage.clear();
  for (const count of [1, 3]) {
    const slot = mount(() => fixture().slice(0, count));
    try {
      await waitFor(() => assert.equal(slot.getAllByRole('progressbar').length, count));
      assert.equal(slot.queryByRole('button', { name: /Show all/ }), null);
    } finally { slot.unmount(); }
  }
});

test('auto-hide is on by default and a restored finish stays visible', async () => {
  localStorage.clear();
  let bars = [applyOp([fixture()[0]], { id: 'b0', state: 'done' }, 10000).bar];
  const calls = [];
  const slot = mount(() => bars, args => {
    calls.push(args);
    bars = bars.map(b => setVisibility(b, args.hidden, args.endedAt));
  }, { effects: false });
  try {
    await waitFor(() => assert.equal(calls.length, 1));
    assert.equal(calls[0].endedAt, 10000);
    await slot.emitRealtime('bars-changed', { threadId: 'fixture-thread' });
    fireEvent.click(await slot.findByRole('button', { name: 'Hidden plans (1)' }));
    fireEvent.click(slot.getByRole('button', { name: /Restore plan/ }));
    await waitFor(() => assert.equal(calls.length, 2));
    await slot.emitRealtime('bars-changed', { threadId: 'fixture-thread' });
    await waitFor(() => assert.equal(slot.getAllByRole('progressbar').length, 1));
    assert.equal(calls.length, 2);
  } finally { slot.unmount(); }
});


test('thread agents remain independent of plan visibility and preserve expansion', async () => {
  for (const planCount of [0, 1, 9]) for (const agentCount of [0, 1, 3, 10]) {
    localStorage.clear();
    const bars = fixture().slice(0, planCount).map((bar, i) => i === planCount - 1 ? setVisibility(bar, true) : bar);
    const agents = Array.from({length: agentCount}, (_, i) => ({ id: `agent-${i}`, name: `Task ${i}`, kind: null,
      model: null, state: 'running', tool: null, startedAt: Date.now(), endedAt: null }));
    let slot = mount(() => bars, undefined, undefined, () => agents);
    try {
      if (!agentCount) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); assert.equal(slot.queryByLabelText('Thread agents'), null); continue; }
      await slot.findByLabelText('Thread agents');
      assert.equal(slot.queryAllByText(/^Task /).length, Math.min(agentCount, 3));
      if (agentCount === 10) {
        if (planCount === 9 && process.env.PLAN_PROGRESS_PREVIEW_DIR) {
          const css = await readFile('dist/app.css', 'utf8');
          await writeFile(`${process.env.PLAN_PROGRESS_PREVIEW_DIR}/agents.html`, `<!doctype html><html class="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
            :root {--color-foreground:#eee;--color-muted-foreground:#aaa;--color-muted:#303030;--color-border:#454545}
            body {margin:0;background:#171717;color:#eee;font:14px system-ui;padding:16px} button {background:transparent;color:inherit;border:0;cursor:pointer} main {max-width:760px;margin:auto}</style><main data-bb-plugin="plan-progress">${slot.container.innerHTML}</main></html>`);
        }
        fireEvent.click(slot.getByRole('button', {name: /Thread agents/}));
        assert.equal(slot.queryAllByText(/^Task /).length, 10);
        if (planCount) {
          fireEvent.click(slot.getByRole('button', {name: /Progress/}));
          assert.equal(slot.queryAllByText(/^Task /).length, 0);
          await slot.emitRealtime('agents-changed', {threadId: 'fixture-thread', agents});
          fireEvent.click(slot.getByRole('button', {name: /Progress/}));
        }
        assert.equal(slot.queryAllByText(/^Task /).length, 10);
        slot.unmount(); slot = mount(() => bars, undefined, undefined, () => agents);
        await slot.findByLabelText('Thread agents');
        assert.equal(slot.queryAllByText(/^Task /).length, 10);
      }
    } finally { slot.unmount(); }
  }
});

test('skipped steps agree in text, fill and ARIA while waiting', async () => {
  localStorage.clear();
  let bar = applyOp([], {id:'skipped', title:'Skipped', steps:[{title:'A',status:'skipped'},{title:'B'}], state:'needs_input'}, 1000).bar;
  const slot = mount(() => [bar]);
  try {
    const track = await slot.findByRole('progressbar');
    assert.equal(track.getAttribute('aria-valuenow'), '50');
    assert.equal(parseFloat(track.querySelector('.pp-glide').style.width), 50);
    assert.ok(slot.getByText('50%'));
  } finally { slot.unmount(); }
});

test('open approval count refreshes independently of plans', async () => {
  localStorage.clear(); let count = 1;
  const slot = mount(() => [], undefined, undefined, () => [], () => count);
  try {
    await slot.findByText('1 open approval request in this thread and its direct children');
    count = 0; await slot.emitRealtime('approvals-changed', {threadId:'fixture-thread'});
    await waitFor(() => assert.equal(slot.queryByRole('status'), null));
  } finally { slot.unmount(); }
});


test('stage markers reflect their own steps, even out of order and at 100 percent waiting', async () => {
  for (const state of ['needs_input','error']) {
    const bar = applyOp([], {id:`ordered-${state}`, title:'Ordered', state, stages:[
      {name:'First', steps:[{title:'A',status:'active'},{title:'B',status:'done'}]},
      {name:'Second', steps:[{title:'C',status:'done'},{title:'D',status:'done'}]}]}, 1000).bar;
    const slot = mount(() => [bar]);
    try {
      const track = await slot.findByRole('progressbar');
      assert.equal(track.getAttribute('aria-valuenow'),'75');
      const boundary = track.querySelectorAll('.pp-mark')[1];
      assert.equal(boundary.querySelector('.pp-tip').textContent, 'Second');
    } finally {slot.unmount();}
    const complete = {...bar, stages:bar.stages.map(stage => ({...stage,steps:stage.steps.map(step => ({...step,status:'done'}))}))};
    const full = mount(() => [complete]);
    try {const track = await full.findByRole('progressbar'); assert.equal(track.getAttribute('aria-valuenow'),'100');
      assert.match(track.getAttribute('aria-label'), state === 'error' ? /Error/ : /Needs your answer/);
    } finally {full.unmount();}
  }
});

test('late agents RPC cannot overwrite realtime or another thread', async () => {
  localStorage.clear(); let resolveFirst;
  const old = {id:'old',name:'Old task',kind:null,model:null,state:'running',tool:null,startedAt:1,endedAt:null};
  const fresh = {...old,id:'new',name:'New task'};
  const slot = renderSlot(banner, {}, {context:{threadId:'one',projectId:null},settings:{autoClose:false,effects:false},rpc:{
    bars_get:()=>({bars:[]}), diagnostics_get:()=>({diagnostic:{source:'bb',warning:null,lastCallSeq:0}}), approvals_get:()=>({count:0}),
    agents_get:({threadId}) => threadId === 'one' ? new Promise(resolve => {resolveFirst=resolve;}) : ({agents:[]}),
  }});
  try {
    await waitFor(()=>assert.equal(typeof resolveFirst,'function'));
    await slot.emitRealtime('agents-changed',{threadId:'one',agents:[fresh]});
    await slot.findByText('New task');
    await act(async()=>resolveFirst({agents:[old]}));
    assert.equal(slot.queryByText('Old task'),null);
    await slot.setComposerScope({kind:'thread',threadId:'two'});
    await waitFor(()=>assert.equal(slot.queryByText('New task'),null));
  } finally {slot.unmount();}
});
