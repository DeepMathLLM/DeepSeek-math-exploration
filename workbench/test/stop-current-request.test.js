const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8').replace(/\binit\(\);\s*$/, '');

function fixture() {
  const elements = new Map(['#stop-controller', '#stop-agent-run'].map(selector => {
    const classes = new Set(['hidden']);
    return [selector, { disabled: false, classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); }
    } }];
  }));
  elements.set('#toast', { textContent: '', classList: { add() {}, remove() {} } });
  const context = vm.createContext({
    sessionStorage: { getItem: () => '' },
    document: { querySelector: selector => elements.get(selector) },
    setTimeout() {}, clearTimeout() {}
  });
  vm.runInContext(source, context);
  const project = {
    id: 'first-project', agents: [{ id: 'researcher', lifecycleState: 'Running' }],
    conversations: {
      controller: { currentId: 'controller-chat' },
      researcher: { currentId: 'agent-chat' }
    },
    runs: [
      { id: 'controller-run', agentId: null, conversationId: 'controller-chat', status: 'running' },
      { id: 'agent-run', agentId: 'researcher', conversationId: 'agent-chat', status: 'running' }
    ]
  };
  context.project = project;
  vm.runInContext("Object.assign(state, { project, projectId: project.id, home: false, activeView: 'conversation', selectedAgentId: null });", context);
  const render = () => vm.runInContext('renderStopButtons()', context);
  const hidden = selector => elements.get(selector).classList.contains('hidden');
  return { context, project, elements, render, hidden };
}

test('the Controller stop button follows the conversation when navigating to overview, research and home', () => {
  const f = fixture();
  f.render();
  assert.equal(f.hidden('#stop-controller'), false);
  assert.equal(f.hidden('#stop-agent-run'), true);
  for (const view of ['overview', 'research']) {
    vm.runInContext(`state.activeView = '${view}'`, f.context);
    f.render();
    assert.equal(f.hidden('#stop-controller'), true);
  }
  vm.runInContext("state.activeView = 'conversation'; state.home = true", f.context);
  f.render();
  assert.equal(f.hidden('#stop-controller'), true);
});

test('switching projects hides the previous request, including while the next project is loading', () => {
  const f = fixture();
  f.render();
  vm.runInContext("state.projectId = 'second-project'", f.context);
  f.render();
  assert.equal(f.hidden('#stop-controller'), true);
  vm.runInContext("state.project = { id: 'second-project', agents: [], runs: [], conversations: { controller: { currentId: 'second-chat' } } }", f.context);
  f.render();
  assert.equal(f.hidden('#stop-controller'), true);
});

test('Controller and Agent stop actions appear only for the currently displayed conversation', () => {
  const f = fixture();
  vm.runInContext("state.selectedAgentId = 'researcher'; state.activeView = 'agent'", f.context);
  f.render();
  assert.equal(f.hidden('#stop-controller'), true);
  assert.equal(f.hidden('#stop-agent-run'), false);
  f.project.conversations.researcher.currentId = 'empty-agent-chat';
  f.render();
  assert.equal(f.hidden('#stop-agent-run'), true);
  vm.runInContext("state.selectedAgentId = null; state.activeView = 'conversation'", f.context);
  f.project.conversations.controller.currentId = 'empty-controller-chat';
  f.render();
  assert.equal(f.hidden('#stop-controller'), true);
});

test('completed requests release their stop action and in-flight stop actions stay disabled', () => {
  const f = fixture();
  vm.runInContext("state.stoppingRunId = 'controller-run'", f.context);
  f.render();
  assert.equal(f.elements.get('#stop-controller').disabled, true);
  f.project.runs[0].status = 'completed';
  f.render();
  assert.equal(f.hidden('#stop-controller'), true);
});

test('a stop request captures its project, chat and run and leaves a subsequently selected project visible', async () => {
  const f = fixture(), requests = [];
  let resolveStop;
  let reloads = 0;
  f.context.recordStop = (route, options) => {
    requests.push({ route, options });
    return new Promise(resolve => { resolveStop = resolve; });
  };
  f.context.recordReload = () => { reloads += 1; };
  vm.runInContext('api = recordStop; reload = recordReload;', f.context);
  const stopping = vm.runInContext('stopController()', f.context);
  await vm.runInContext('stopController()', f.context);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].route, '/api/controller/stop');
  assert.equal(requests[0].options.headers['x-deepmath-project-id'], 'first-project');
  assert.deepEqual(JSON.parse(requests[0].options.body), { runId: 'controller-run', conversationId: 'controller-chat' });
  vm.runInContext("state.projectId = 'second-project'; state.project = { id: 'second-project', agents: [], runs: [] };", f.context);
  resolveStop({});
  await stopping;
  assert.equal(reloads, 0);
  assert.equal(f.hidden('#stop-controller'), true);
});

test('Agent stops send the currently displayed Agent run identity', async () => {
  const f = fixture(), requests = [];
  f.context.recordStop = async (route, options) => { requests.push({ route, options }); };
  vm.runInContext("api = recordStop; reload = async () => {}; state.selectedAgentId = 'researcher'; state.activeView = 'agent';", f.context);
  await vm.runInContext('stopCurrentAgentRun()', f.context);
  assert.equal(requests[0].route, '/api/agents/researcher/stop');
  assert.deepEqual(JSON.parse(requests[0].options.body), { runId: 'agent-run', conversationId: 'agent-chat' });
});

test('both stop controls live in the composer and every render refreshes their visibility', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const composer = html.slice(html.indexOf('<div class="composer-wrap">'), html.indexOf('<aside id="context-panel"'));
  assert.match(composer, /id="stop-controller"/);
  assert.match(composer, /id="stop-agent-run"/);
  assert.doesNotMatch(html, /controller-stop-floating/);
  assert.match(source, /function render\(\) \{\s*renderStopButtons\(\);/);
});
