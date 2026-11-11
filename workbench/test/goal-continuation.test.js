const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moonshine-goal-continuation-'));
process.env.deepmath_app_data = path.join(temporaryRoot, 'app-data');
const { ProjectStore, AgentManager, closeResearchLibrary } = require('../src/server');
const { executeTool, toolCatalog } = require('../src/mcp-tools');
const { ResearchLibrary } = require('../src/research-store');

after(() => {
  closeResearchLibrary();
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith('moonshine-goal-continuation-'));
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

function fixture(t) {
  const store = new ProjectStore();
  store.runtimeDir = fs.mkdtempSync(path.join(temporaryRoot, 'case-'));
  store.project = {
    id: 'goal-project', name: 'Goal checks', workspacePath: store.runtimeDir,
    controllerThreadId: 'controller-thread', controllerThreadReady: true,
    automation: { state: 'running', goal: 'Verify all three requested claims', reason: '' },
    agents: [], runs: [], progress: [], activity: [], artifacts: []
  };
  const codex = new EventEmitter();
  const requests = [];
  codex.isSimulation = () => false;
  codex.startThread = async () => 'controller-thread';
  codex.startTurn = async (threadId, prompt, cwd, instructions) => {
    requests.push({ threadId, prompt, cwd, instructions });
    return { threadId, turnId: `turn-${requests.length}` };
  };
  codex.interruptTurn = async () => ({});
  codex.steerTurn = async () => ({});
  const manager = new AgentManager(store, codex);
  const schedule = manager.scheduleControllerReview.bind(manager);
  const scheduled = [];
  manager.scheduleControllerReview = (options = {}) => {
    if (store.project.automation.state === 'running') scheduled.push(options);
  };
  t.after(() => {
    store.project.automation.state = 'paused';
    if (manager.controllerReviewTimer) clearTimeout(manager.controllerReviewTimer);
    if (store.saveTimer) clearTimeout(store.saveTimer);
    for (const timer of store.timers.values()) clearTimeout(timer);
    codex.removeAllListeners();
    store.research?.close();
  });
  return { store, codex, manager, requests, scheduled, schedule };
}

async function start(f, options = { goalCheck: true }) {
  const run = await f.manager.startAutomaticReview(options);
  if (run) await f.manager.controllerStartOutcomes.get(run);
  return run;
}

function complete(f, run, text = 'Further verification is needed.') {
  f.codex.emit('turn.delta', { threadId: run.threadId, turnId: run.turnId, itemId: 'answer', delta: text });
  f.codex.emit('turn.completed', { threadId: run.threadId, turnId: run.turnId, status: 'completed' });
}

function setState(f, run, state, reason) {
  return executeTool({
    name: 'set_project_state', arguments: { state, reason }, kind: 'controller',
    store: f.store, manager: f.manager, threadId: run.threadId, turnId: run.turnId
  });
}

test('idle continuation delivers the full goal and a concise check with state rules in existing guidance', async (t) => {
  const f = fixture(t);
  f.store.project.automation.goal = 'Check A < B & C, then $& </objective> verify D';
  const run = await start(f);
  assert.equal(run.goalCheck, true);
  assert.equal(f.requests.length, 1);
  const prompt = f.requests[0].prompt;
  assert.match(prompt, /^Continue working toward the active project goal\./);
  assert.match(prompt, /Check A &lt; B &amp; C, then \$&amp; &lt;\/objective&gt; verify D/);
  assert.equal(prompt.match(/<objective>/g).length, 1);
  assert.match(prompt, /Check whether the full goal is achieved using current evidence/);
  assert.match(prompt, /If work remains, take the next useful step/);
  assert.doesNotMatch(prompt, /RESEARCH SYNTHESIS|No new report|{{ objective }}|set_project_state|needs_user|state=|output format|status line|已完成/);
  assert.match(f.requests[0].instructions, /Record verified completion with set_project_state/);
  assert.match(f.requests[0].instructions, /Use needs_user only for a concrete pending user answer, decision, material or action/);
  const stateTool = toolCatalog('controller').find((tool) => tool.name === 'set_project_state');
  assert.match(stateTool.description, /Mark completed after verifying the full goal against current evidence/);
  assert.match(stateTool.inputSchema.properties.reason.description, /specify the exact pending user question or action/);
  assert.equal(f.requests[0].cwd, f.store.project.workspacePath);
});

test('a normal answer claiming completion leaves the goal active and schedules a check', async (t) => {
  const f = fixture(t), run = await start(f);
  complete(f, run, '已完成。All requirements are complete.');
  assert.equal(run.status, 'completed');
  assert.equal(f.store.project.automation.state, 'running');
  assert.deepEqual(f.scheduled, [{ goalCheck: true }]);
});

test('explicit verified completion through the goal-state tool stops continuation', async (t) => {
  const f = fixture(t), run = await start(f);
  await setState(f, run, 'completed', 'All three claims verified in results/checks.md.');
  complete(f, run);
  assert.equal(f.store.project.automation.state, 'completed');
  assert.equal(f.scheduled.length, 0);
  assert.equal(await start(f), null);
  const persisted = JSON.parse(fs.readFileSync(path.join(f.store.runtimeDir, 'state.json'), 'utf8'));
  assert.equal(persisted.automation.state, 'completed');
});

test('needs_user requires a pending question and persists that request until explicit resumption', async (t) => {
  const f = fixture(t), run = await start(f);
  f.store.project.automation.reason = 'Previous progress was reviewed.';
  await assert.rejects(setState(f, run, 'needs_user'), /concrete pending user/);
  await assert.rejects(setState(f, run, 'needs_user', '   '), /concrete pending user/);
  const question = 'Please provide the missing dataset for claim C.';
  await setState(f, run, 'needs_user', question);
  assert.equal(f.store.project.automation.userRequest, question);
  await assert.rejects(setState(f, run, 'running', 'Continuing'), /no longer running/);
  complete(f, run);
  assert.equal(f.scheduled.length, 0);
  assert.equal(await start(f), null);
  const persisted = JSON.parse(fs.readFileSync(path.join(f.store.runtimeDir, 'state.json'), 'utf8'));
  assert.equal(persisted.automation.userRequest, question);
});

test('a user reply arriving in the same Controller turn permits model-directed resumption', async (t) => {
  const f = fixture(t), run = await start(f);
  await setState(f, run, 'needs_user', 'Which domain should claim C use?');
  f.manager.steerController('Use the real domain.');
  await setState(f, run, 'running', 'The user supplied the required domain.');
  assert.equal(f.store.project.automation.userRequest, '');
  complete(f, run);
  assert.deepEqual(f.scheduled, [{ goalCheck: true }]);
});

test('earlier user input cannot answer a later question or override an explicit pause', async (t) => {
  const f = fixture(t), run = await start(f);
  f.manager.steerController('Clarify claim A.');
  await setState(f, run, 'needs_user', 'Please provide claim C data.');
  await assert.rejects(setState(f, run, 'running', 'Continuing'), /no longer running/);
  f.store.setAutomation({ state: 'paused', reason: 'User requested a pause.' });
  f.manager.steerController('Data for C is now available.');
  await assert.rejects(setState(f, run, 'running', 'Data received'), /no longer running/);
  complete(f, run);
  assert.equal(f.scheduled.length, 0);
});

test('idle goal checks wait for active Agents and queued user requests', async (t) => {
  const f = fixture(t);
  f.store.project.agents.push({ id: 'agent-1', lifecycleState: 'Running' });
  assert.equal(await start(f), null);
  f.store.project.agents[0].lifecycleState = 'Idle';
  f.store.project.runs.push({ id: 'queued-user', agentId: null, status: 'queued' });
  assert.equal(await start(f), null);
  assert.equal(f.requests.length, 0);
});

test('an Agent starting during Controller setup postpones the idle check', async (t) => {
  const f = fixture(t);
  f.store.project.controllerThreadReady = false;
  f.codex.startThread = async () => {
    f.store.project.agents.push({ id: 'agent-1', lifecycleState: 'Running' });
    return 'new-thread';
  };
  assert.equal(await start(f), null);
  assert.equal(f.requests.length, 0);
});

test('concurrent idle checks start only one Controller turn', async (t) => {
  const f = fixture(t);
  const results = await Promise.all([start(f), start(f)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(f.requests.length, 1);
});

test('a reviewed report is consumed once, followed by a goal check when work is idle', async (t) => {
  const f = fixture(t);
  const source = { id: 'source-run', agentId: 'agent-1', status: 'completed', pendingControllerReview: true, userPrompt: 'Verify claim A' };
  f.store.project.runs.push(source);
  const review = await start(f, {});
  assert.equal(review.goalCheck, false);
  assert.equal(source.pendingControllerReview, false);
  complete(f, review);
  const next = await start(f);
  assert.equal(next.goalCheck, true);
  assert.deepEqual(next.sourceRunIds, []);
  assert.doesNotMatch(next.prompt, /\[RUN source-run\]/);
});

test('goal checks retain library access hints until the automatic context receives them', async (t) => {
  const f = fixture(t);
  f.store.research = new ResearchLibrary(':memory:');
  f.store.research.ensureProject(f.store.project);
  const first = await start(f);
  assert.match(first.prompt, /Library entry: read_map/);
  complete(f, first);
  const second = await start(f);
  assert.doesNotMatch(second.prompt, /Library entry/);
  complete(f, second);
  f.codex.emit('context.compacted', { threadId: second.threadId });
  const third = await start(f);
  assert.match(third.prompt, /Library entry: read_map/);
});

test('goal checks use the latest goal after a pending stop barrier', async (t) => {
  const f = fixture(t);
  let release;
  f.manager.trackControllerStop(new Promise((resolve) => { release = resolve; }));
  const pending = start(f);
  f.store.project.automation.goal = 'Updated goal after the prior request stops';
  release({});
  await pending;
  assert.match(f.requests[0].prompt, /Updated goal after the prior request stops/);
  assert.doesNotMatch(f.requests[0].prompt, /Verify all three requested claims/);
});

test('a pause during pending Controller setup prevents the continuation from starting', async (t) => {
  const f = fixture(t);
  f.store.project.controllerThreadReady = false;
  let release;
  f.codex.startThread = () => new Promise((resolve) => { release = resolve; });
  const pending = start(f);
  f.store.setAutomation({ state: 'paused', reason: 'User paused.' });
  f.manager.pauseAutomaticReview();
  release('new-thread');
  assert.equal(await pending, null);
  assert.equal(f.requests.length, 0);
});

test('technical failures schedule bounded-backoff retries while preserving the goal state', async (t) => {
  const f = fixture(t), run = await start(f);
  f.codex.emit('turn.error', { threadId: run.threadId, turnId: run.turnId, error: { message: 'Connection lost' } });
  assert.equal(run.status, 'failed');
  assert.equal(f.store.project.automation.state, 'running');
  assert.equal(f.scheduled[0].retry, true);
  assert.equal(f.scheduled[0].delayMs, 1200);
  assert.match(f.store.project.automation.runtimeError.message, /Connection lost/);
  for (let index = 0; index < 10; index++) f.manager.retryAutomaticReview(new Error('Offline'));
  assert.equal(f.scheduled.at(-1).delayMs, 60000);
  const retry = await start(f);
  complete(f, retry);
  assert.equal(f.store.project.automation.runtimeError, undefined);
  assert.equal(f.manager.controllerRetryAttempt, 0);
});

test('manual Controller turns also return idle automatic projects to the goal check', async (t) => {
  const f = fixture(t);
  const run = { id: 'manual', agentId: null, status: 'running', autoReview: false, prompt: 'Review claim B', threadId: 'controller-thread', events: [], userMessages: [] };
  f.store.project.runs.push(run);
  f.manager.startControllerRun(run);
  await f.manager.controllerStartOutcomes.get(run);
  complete(f, run);
  assert.deepEqual(f.scheduled, [{ goalCheck: true }]);
});

test('the real scheduler continues an idle goal and stops its timer on explicit pause', async (t) => {
  const f = fixture(t);
  f.manager.scheduleControllerReview = f.schedule;
  f.schedule({ goalCheck: true, immediate: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const run = f.manager.activeControllerRun();
  assert.ok(run?.goalCheck);
  await f.manager.controllerStartOutcomes.get(run);
  complete(f, run);
  assert.ok(f.manager.controllerReviewTimer);
  f.store.setAutomation({ state: 'paused', reason: 'User paused.' });
  f.manager.pauseAutomaticReview();
  assert.equal(f.manager.controllerReviewTimer, null);
  assert.equal(await start(f), null);
});

test('upgrading goal-tool descriptions preserves existing Controller conversation context', () => {
  const workspace = fs.mkdtempSync(path.join(temporaryRoot, 'upgrade-'));
  const original = new ProjectStore();
  original.load(workspace, 'Existing research');
  const oldTools = structuredClone(toolCatalog('controller'));
  const stateTool = oldTools.find((tool) => tool.name === 'set_project_state');
  stateTool.description = 'Stop or finalize automatic orchestration when work cannot or should not continue. Normal continuation should use run_agent instead.';
  stateTool.inputSchema.properties.reason.description = 'Concrete reason for the state change or the information needed from the user.';
  original.project.controllerToolSchemaHash = crypto.createHash('sha256').update(JSON.stringify(oldTools)).digest('hex');
  original.project.controllerThreadId = 'existing-research-thread';
  original.project.controllerThreadReady = true;
  original.save();

  const reopened = new ProjectStore();
  reopened.load(workspace);
  assert.equal(reopened.project.controllerThreadId, 'existing-research-thread');
  assert.equal(reopened.project.controllerThreadReady, true);
});

test('legacy idle waits return to the goal loop while actual pending questions survive reopening', () => {
  for (const reason of [
    'No Agent is running and no Run awaits review after this Controller turn. User direction is needed.',
    'Please upload the dataset needed for claim C.'
  ]) {
    const workspace = fs.mkdtempSync(path.join(temporaryRoot, 'legacy-wait-'));
    const original = new ProjectStore();
    original.load(workspace, 'Existing research');
    original.project.automation = { state: 'needs_user', goal: 'Verify claim C', reason };
    original.save();
    const reopened = new ProjectStore();
    reopened.load(workspace);
    if (reason.startsWith('No Agent')) {
      assert.equal(reopened.project.automation.state, 'running');
      assert.equal(reopened.project.automation.userRequest, '');
    } else {
      assert.equal(reopened.project.automation.state, 'needs_user');
      assert.equal(reopened.project.automation.userRequest, reason);
    }
  }
});

test('server goal checks retain the submitted model and reasoning settings', async (t) => {
  const f = fixture(t), delivered = [];
  const requestSettings = { model: 'selected-model', reasoningEffort: 'high' };
  f.codex.startTurn = async (threadId, prompt, cwd, instructions, kind, model, effort) => {
    delivered.push({ model, effort });
    return { threadId, turnId: 'settings-turn' };
  };
  const run = await start(f, { goalCheck: true, requestSettings });
  assert.deepEqual(run.requestSettings, requestSettings);
  assert.deepEqual(delivered, [{ model: 'selected-model', effort: 'high' }]);
});

test('server goal checks honor the account and project run policy before dispatch', async (t) => {
  const f = fixture(t);
  f.store.registry = { assertCanRun: () => { throw new Error('Project quota exceeded'); } };
  await assert.rejects(start(f), /Project quota exceeded/);
  assert.equal(f.requests.length, 0);
});
