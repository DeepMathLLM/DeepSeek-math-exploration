const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8').replace(/\binit\(\);\s*$/, '');

function navigationHarness() {
  const frames = [];
  let top = 0;
  const viewport = {
    scrollHeight: 2000, clientHeight: 600, scrollLeft: 0,
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
  };
  const context = vm.createContext({
    sessionStorage: { getItem: () => '' },
    document: { querySelector: (selector) => selector === '.content-scroll' ? viewport : null, querySelectorAll: () => [] },
    requestAnimationFrame: (callback) => frames.push(callback),
    viewport
  });
  const run = (script) => vm.runInContext(script, context);
  run(source);
  run(`
    state.project = {
      id: 'project-1', workspacePath: 'project-1',
      agents: [{ id: 'agent-1' }, { id: 'agent-2' }],
      runs: [{ agentId: 'agent-1' }, { agentId: 'agent-2' }, { agentId: null }]
    };
    state.home = false;
    renderHeader = renderAgents = renderContext = renderStats = renderPulse =
      renderRecentProgress = renderTabs = renderComposerTarget = renderAgentView =
      renderConversationView = loadProjects = () => {};
    renderHome = () => {
      viewport.scrollHeight = state.home ? 1200 : selectedAgent() ? 9000 :
        state.activeView === 'conversation' ? 7000 : state.activeView === 'research' ? 3000 : 2000;
      viewport.scrollTop = viewport.scrollTop;
    };
    render();
  `);
  const flush = () => { while (frames.length) frames.shift()(); };
  const agent = (id = 'agent-1') => run(`
    state.selectedAgentId = ${JSON.stringify(id)};
    state.activeView = 'agent';
    state.scrollConversationToEnd = true;
    state.conversationFollowEnd = true;
    render();
  `);
  return { run, flush, agent, viewport };
}

test('opening project overview from the bottom of an Agent starts at its own position', () => {
  const app = navigationHarness();
  app.agent(); app.flush();
  assert.equal(app.viewport.scrollTop, 8400);
  app.run('showProjectOverview()');
  assert.equal(app.viewport.scrollTop, 0);
  app.flush();
  assert.equal(app.viewport.scrollTop, 0);
});

test('overview retains its own reading position through Agent navigation and live updates', () => {
  const app = navigationHarness();
  app.viewport.scrollTop = 420;
  app.agent(); app.flush();
  app.run('showProjectOverview()');
  assert.equal(app.viewport.scrollTop, 420);
  app.run('render()'); app.flush();
  assert.equal(app.viewport.scrollTop, 420);
});

test('a queued Agent auto-scroll cannot move the overview after navigation', () => {
  const app = navigationHarness();
  app.viewport.scrollTop = 180;
  app.agent();
  app.run('showProjectOverview()');
  app.flush();
  assert.equal(app.viewport.scrollTop, 180);
});

test('Controller, research assets and home do not inherit conversation scroll positions', () => {
  const app = navigationHarness();
  app.run('showResearchAssets()');
  app.viewport.scrollTop = 300;
  app.run('showConversation()'); app.flush();
  assert.equal(app.viewport.scrollTop, 6400);
  app.run('showResearchAssets()');
  assert.equal(app.viewport.scrollTop, 300);
  app.agent();
  app.run('goHome()'); app.flush();
  assert.equal(app.viewport.scrollTop, 0);
});

test('overview scroll positions are isolated by project', () => {
  const app = navigationHarness();
  app.viewport.scrollTop = 420;
  app.run("state.project.id = 'project-2'; render();");
  assert.equal(app.viewport.scrollTop, 0);
  app.viewport.scrollTop = 650;
  app.run("state.project.id = 'project-1'; render();");
  assert.equal(app.viewport.scrollTop, 420);
});

test('reading older Agent messages cancels queued following and survives live updates', () => {
  const app = navigationHarness();
  app.agent(); app.flush();
  app.run('render()');
  app.viewport.scrollTop = 2400;
  app.run('state.conversationFollowEnd = false');
  app.flush();
  assert.equal(app.viewport.scrollTop, 2400);
  app.run('render()'); app.flush();
  assert.equal(app.viewport.scrollTop, 2400);
  app.agent('agent-2'); app.flush();
  assert.equal(app.viewport.scrollTop, 8400);
});

test('following an active conversation continues to show new output', () => {
  const app = navigationHarness();
  app.agent(); app.flush();
  app.run('render()');
  app.viewport.scrollHeight += 600;
  app.flush();
  assert.equal(app.viewport.scrollTop, 9000);
});
