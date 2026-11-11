'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const delta = require('../public/project-delta');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/\binit\(\);\s*$/, '');
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const requests = [], sources = [], timers = new Map(); let timer = 0;
  const context = vm.createContext({ AbortController, DeepMathDelta: delta,
    sessionStorage: { getItem: () => '', setItem() {}, removeItem() {} },
    document: { hidden: false, querySelector: () => ({ classList: { add() {}, remove() {} } }), querySelectorAll: () => [] },
    setTimeout: callback => { timers.set(++timer, callback); return timer; }, clearTimeout: id => timers.delete(id),
    EventSource: class { constructor(url) { this.url = url; this.listeners = new Map(); sources.push(this); }
      addEventListener(type, listener) { this.listeners.set(type, listener); } close() { this.closed = true; } },
    fakeApi(route, options) { return new Promise((resolve, reject) => requests.push({ route, options, resolve, reject })); }
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  run(`api = fakeApi; renderHeader = () => {}; render = () => {};
    state.authenticated = true; state.projectId = 'A'; state.project = {id:'A', runs:[], agents:[]}; connectEvents();`);
  return { context, run, requests, sources, timers,
    send(type, value, source = sources.at(-1)) { source.listeners.get(type)({ data: JSON.stringify(value) }); },
    snapshot(project) { this.send('snapshot', { protocol: delta.protocol, version: 0, project }); } };
}
const project = () => ({ id: 'A', agents: [], model: 'original', contextCompactions: {},
  conversations: { controller: { currentId: 'c', items: [{ id: 'c', runCount: 1 }] } },
  runs: [{ id: 'r', status: 'running', finalOutput: '完整开头🙂\n'.repeat(50) }] });

test('streamed text and completion apply without GET refreshes, preserving independently paged history and optimistic UI fields', () => {
  const f = fixture(); let state = project();
  f.run(`state.project.runs.push({id:'older-history',finalOutput:'saved history'})`);
  f.snapshot(state);
  assert.match(f.sources[0].url, /transport=delta-v1/);
  f.run(`state.project.model='optimistic'; state.project.conversations.controller.items[0].runCount=99;
    state.project.contextCompactions.controller={status:'completed'};`);
  for (let i = 1; i <= 100; i++) {
    const next = clone(state); next.runs[0].finalOutput += `增量 ${i}🙂\n`;
    if (i === 100) next.runs[0].status = 'completed';
    f.send('project.delta', { protocol: delta.protocol, projectId: 'A', baseVersion: i - 1, version: i, ops: delta.diff(state, next) });
    state = next;
  }
  assert.equal(f.requests.length, 0);
  assert.equal(f.run('state.project.runs[0].finalOutput'), state.runs[0].finalOutput);
  assert.equal(f.run('state.project.runs[0].status'), 'completed');
  assert.equal(f.run('state.project.runs[1].id'), 'older-history');
  assert.equal(f.run('state.project.conversations.controller.items[0].runCount'), 1);
  assert.equal(f.run('state.project.contextCompactions.controller'), undefined);
  assert.equal(f.timers.size, 1);
});
test('a version gap reconnects for a full snapshot and obsolete connections cannot modify the displayed project', () => {
  const f = fixture(), old = f.sources[0]; f.snapshot(project());
  f.send('project.delta', { protocol: delta.protocol, projectId: 'A', baseVersion: 4, version: 5, ops: [] });
  assert.equal(old.closed, true); assert.equal(f.sources.length, 2);
  const recovered = project(); recovered.runs[0].status = 'completed'; recovered.runs[0].finalOutput += 'Recovered final answer';
  f.snapshot(recovered);
  f.send('snapshot', { protocol: delta.protocol, version: 0, project: { ...project(), id: 'B' } }, old);
  assert.equal(f.run('state.project.id'), 'A');
  assert.match(f.run('state.project.runs[0].finalOutput'), /Recovered final answer/);
  assert.equal(f.requests.length, 0);
});
test('a late HTTP response cannot overwrite a newer stream update', async () => {
  const f = fixture(); const old = f.run('reload()');
  f.snapshot(project());
  f.requests[0].resolve({ ...project(), model: 'obsolete-http-response' }); await old;
  assert.equal(f.run('state.project.model'), 'original');
});
test('backgrounding disconnects only the browser stream; returning receives complete state without starting any task', () => {
  const f = fixture(); f.snapshot(project());
  f.run('document.hidden=true; pauseProjectEvents(); connectEvents()');
  assert.equal(f.sources[0].closed, true); assert.equal(f.sources.length, 1);
  f.run('document.hidden=false; connectEvents()'); assert.equal(f.sources.length, 2);
  const finished = project(); finished.runs[0].status = 'completed'; f.snapshot(finished);
  assert.equal(f.run('state.project.runs[0].status'), 'completed'); assert.equal(f.requests.length, 0);
});
