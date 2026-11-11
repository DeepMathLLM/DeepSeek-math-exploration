const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { executeTool, runtimeSnapshot, teamSnapshot } = require('../src/mcp-tools');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmath-v2-scheduler-'));
process.env.deepmath_auth_required = '0';
process.env.deepmath_app_data = path.join(temporaryRoot, 'app-data');
const { ProjectStore, AgentManager, CodexClient, restoreActiveProject, registry, closeResearchLibrary } = require('../src/server');

test('Codex reports preserve Unicode across arbitrary stdout byte boundaries', () => {
  const codex = new CodexClient(), received = [], errors = [];
  const message = { method: 'test', params: { text: '中文证明𝛼：条件与结论。'.repeat(20) } };
  codex.handleMessage = (item) => received.push(item);
  codex.on('stderr', (error) => errors.push(error));
  const bytes = Buffer.from(JSON.stringify(message) + '\n' + JSON.stringify(message) + '\n');
  for (let i = 0; i < bytes.length; i++) codex.consume(bytes.subarray(i, i + 1));
  assert.deepEqual(received, [message, message]); assert.deepEqual(errors, []);
});
const { ResearchLibrary } = require('../src/research-store');
const libraries = [];
function attachResearch(store) { const library = new ResearchLibrary(':memory:'); libraries.push(library); store.research = library; library.ensureProject(store.project); return library; }

after(() => {
  const target = path.resolve(temporaryRoot);
  const parent = path.resolve(os.tmpdir());
  if (path.dirname(target) !== parent || !path.basename(target).startsWith('deepmath-v2-scheduler-')) {
    throw new Error('Refusing to remove an unexpected test directory');
  }
  libraries.forEach((library) => library.close()); closeResearchLibrary();
  fs.rmSync(target, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'case-'));
  const workspacePath = path.join(directory, 'workspace');
  fs.mkdirSync(workspacePath);
  const store = new ProjectStore();
  store.runtimeDir = path.join(directory, 'state');
  store.project = {
    id: 'test-project', name: 'Test project', workspacePath,
    automation: { state: 'running', goal: 'Test goal', reason: '' },
    agents: [], runs: [], progress: [], activity: [], artifacts: []
  };
  const codex = new EventEmitter();
  codex.isSimulation = () => true;
  codex.interruptTurn = async () => ({});
  const manager = new AgentManager(store, codex);
  const scheduled = [];
  manager.scheduleControllerReview = (options = {}) => {
    if (store.project.automation.state === 'running') scheduled.push(options);
  };
  return { store, codex, manager, scheduled };
}

function completedRun(number) {
  return {
    id: `run-${number}`, agentId: 'agent-1', status: 'completed',
    completedAt: `2026-01-01T00:00:${String(number).padStart(2, '0')}Z`,
    pendingControllerReview: true
  };
}

function controllerRun(sourceRunIds, extra = {}) {
  return {
    id: 'controller-run', agentId: null, status: 'running', autoReview: true,
    sourceRunIds, controllerActions: [], retryAttempt: 0,
    prompt: 'Review', userPrompt: 'Review', events: [], threadId: 'controller-thread', turnId: 'controller-turn',
    ...extra
  };
}

test('runtime display counts active work and pending reviews without persisted display state', () => {
  const { store } = fixture();
  store.project.runs = [
    controllerRun([], { id: 'controller-active' }),
    { id: 'agent-active', agentId: 'agent-1', status: 'running', pendingControllerReview: false },
    { id: 'agent-pending', agentId: 'agent-2', status: 'completed', pendingControllerReview: true },
    ...Array.from({ length: 60 }, (_, index) => ({ id: `old-${index}`, agentId: 'agent-3', status: 'completed' }))
  ];

  assert.deepEqual(runtimeSnapshot(store.project), {
    controllerRunId: 'controller-active', runningAgentCount: 1, pendingReviewCount: 1
  });
  store.project.runs[0].status = 'completed';
  store.project.runs[1].status = 'completed';
  assert.deepEqual(runtimeSnapshot(store.project), {
    controllerRunId: null, runningAgentCount: 0, pendingReviewCount: 1
  });
  assert.equal(store.project.runtime, undefined);
});

test('team query separates a current instruction from progress published by an earlier Run', async () => {
  const { store, manager } = fixture();
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Running', currentRunId: 'current-run', currentAction: 'Using a tool', status: { current: 'Old result' } };
  const currentRun = { id: 'current-run', agentId: agent.id, status: 'running', startedAt: '2026-01-02T00:00:00Z', userPrompt: 'Verify the new conjecture' };
  const oldProgress = { id: 'progress-old', agentId: agent.id, runId: 'old-run', message: 'Earlier result' };
  store.project.agents.push(agent);
  store.project.runs.push(currentRun);
  store.project.progress.push(oldProgress);

  const listed = await executeTool({ name: 'list_agents', kind: 'controller', store, manager });
  assert.equal(listed.agents[0].currentRunId, 'current-run');
  assert.equal(Object.hasOwn(listed.agents[0], 'status'), false);

  const state = teamSnapshot(store, agent);
  assert.equal(state.currentRun.instruction, 'Verify the new conjecture');
  assert.equal(state.progress.runId, 'old-run');
  assert.equal(state.progressFromCurrentRun, false);
  const queried = await executeTool({ name: 'get_team_state', arguments: { agentId: agent.id }, kind: 'controller', store, manager });
  assert.deepEqual(queried, state);
  const status = await executeTool({ name: 'get_agent_status', arguments: { agentId: agent.id }, kind: 'controller', store, manager });
  assert.equal(status.currentRun.id, 'current-run');
  assert.equal(Object.hasOwn(status.agent, 'status'), false);

  store.project.progress.push({ id: 'progress-current', agentId: agent.id, runId: 'current-run', message: 'Current finding' });
  assert.equal(teamSnapshot(store, agent).progressFromCurrentRun, true);
  currentRun.status = 'completed';
  agent.currentRunId = null;
  assert.equal(teamSnapshot(store, agent).currentRun, null);
  assert.equal(teamSnapshot(store, agent).progressFromCurrentRun, false);
});

test('a successful batch advances to pending Runs beyond the first six', () => {
  const { store, manager, scheduled } = fixture();
  const runs = Array.from({ length: 7 }, (_, index) => completedRun(index + 1));
  const controller = controllerRun(runs.slice(0, 6).map((run) => run.id));
  store.project.runs = [controller, ...runs];
  assert.equal(manager.pendingControllerRuns().length, 6);

  manager.finishAutomaticReview(controller, true);

  assert.ok(runs.slice(0, 6).every((run) => !run.pendingControllerReview));
  assert.equal(runs[6].pendingControllerReview, true);
  assert.equal(store.project.automation.state, 'running');
  assert.equal(scheduled.length, 1);
});

test('waiting for a running Agent does not re-inject evidence already seen by Controller', () => {
  const { store, manager, scheduled } = fixture();
  store.project.agents.push({ id: 'agent-2', lifecycleState: 'Running' });
  const source = completedRun(1);
  const controller = controllerRun([source.id]);
  store.project.runs = [controller, source];

  manager.finishAutomaticReview(controller, true);

  assert.equal(source.pendingControllerReview, false);
  assert.equal(scheduled.length, 0);
});

test('pausing after Controller accepted the review does not make its source pending again', () => {
  const { store, manager } = fixture();
  const source = completedRun(1);
  const controller = controllerRun([source.id]);
  store.project.runs = [controller, source];
  store.project.automation.state = 'paused';

  manager.finishAutomaticReview(controller, true);

  assert.equal(source.pendingControllerReview, false);
});

test('a review that never entered Controller context remains pending', () => {
  const { store, manager, scheduled } = fixture();
  const source = completedRun(1);
  const controller = controllerRun([source.id], { turnId: undefined });
  store.project.runs = [controller, source];

  manager.finishAutomaticReview(controller, false);

  assert.equal(source.pendingControllerReview, true);
  assert.equal(store.project.automation.state, 'running');
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].retry, true);
});

test('the first Controller tool call acknowledges its source before turn/start responds', async () => {
  const { store, manager } = fixture();
  const source = completedRun(1);
  const controller = controllerRun([source.id], { turnId: undefined });
  store.project.runs = [controller, source];

  await executeTool({ name: 'list_agents', kind: 'controller', store, manager, turnId: 'early-turn' });

  assert.equal(source.pendingControllerReview, false);
  assert.equal(controller.status, 'running');
});

test('a stale Controller thread cannot acknowledge a new review before turn/start responds', async () => {
  const { store, manager } = fixture();
  const source = completedRun(1);
  const controller = controllerRun([source.id], { turnId: undefined, threadId: 'new-controller-thread' });
  store.project.runs = [controller, source];

  await assert.rejects(executeTool({ name: 'list_agents', kind: 'controller', store, manager, threadId: 'old-controller-thread', turnId: 'old-turn' }), /inactive Codex Turn/);
  assert.equal(source.pendingControllerReview, true);
  assert.equal(controller.turnId, undefined);

  await executeTool({ name: 'list_agents', kind: 'controller', store, manager, threadId: 'new-controller-thread', turnId: 'new-turn' });
  assert.equal(source.pendingControllerReview, false);
  assert.equal(controller.turnId, 'new-turn');
});

test('manual Controller reads acknowledge only the Run evidence returned in context', async () => {
  const { store, manager } = fixture();
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Idle' };
  const source = completedRun(1);
  const controller = controllerRun([], { autoReview: false, sourceRunIds: [] });
  const progress = { id: 'progress-1', agentId: agent.id, runId: source.id, message: 'Checked the key lemma.' };
  store.project.agents.push(agent);
  store.project.runs = [controller, source];
  store.project.progress.push(progress);

  await executeTool({ name: 'get_team_state', arguments: { agentId: agent.id }, kind: 'controller', store, manager, threadId: 'controller-thread', turnId: 'controller-turn' });
  assert.equal(source.pendingControllerReview, false);

  source.pendingControllerReview = true;
  await executeTool({ name: 'get_run_detail', arguments: { runId: source.id }, kind: 'controller', store, manager, threadId: 'controller-thread', turnId: 'controller-turn' });
  assert.equal(source.pendingControllerReview, false);
});

test('an inconclusive review continues the goal without repeating the same context', () => {
  const { store, manager, scheduled } = fixture();
  const source = completedRun(1);
  const controller = controllerRun([source.id]);
  store.project.runs = [controller, source];

  manager.finishAutomaticReview(controller, true);
  assert.equal(source.pendingControllerReview, false);
  assert.equal(store.project.automation.state, 'running');
  assert.deepEqual(scheduled, [{ goalCheck: true }]);
});

test('a failed Controller steer retries without reviewing the same source again', async () => {
  const { store, codex, manager, scheduled } = fixture();
  const source = completedRun(1);
  const controller = controllerRun([source.id]);
  store.project.runs = [controller, source];
  let interrupted = false;
  codex.steerTurn = async () => { throw new Error('steer failed'); };
  codex.interruptTurn = async () => { interrupted = true; };

  manager.steerController('New user instruction');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.status, 'failed');
  assert.equal(source.pendingControllerReview, false);
  assert.equal(interrupted, true);
  assert.equal(store.project.automation.state, 'running');
  assert.equal(scheduled[0].retry, true);
});

test('a failed Agent instruction is returned to the same Controller Turn without another review', async () => {
  const { store, codex, manager, scheduled } = fixture();
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Running', currentRunId: 'active-run', threadId: 'agent-thread' };
  const active = { id: 'active-run', agentId: agent.id, status: 'running', prompt: 'Original task', userPrompt: 'Original task', threadId: 'agent-thread', turnId: 'agent-turn', events: [], userMessages: [] };
  const source = completedRun(1);
  const controller = controllerRun([source.id]);
  store.project.agents.push(agent);
  store.project.runs = [controller, active, source];
  codex.steerTurn = async () => { throw new Error('steer rejected'); };

  await assert.rejects(executeTool({ name: 'run_agent', arguments: { agentId: agent.id, prompt: 'New task' }, kind: 'controller', store, manager, turnId: 'controller-turn' }), /not delivered: steer rejected/);
  assert.equal(active.status, 'running');
  assert.equal(active.userMessages.at(-1).delivery, 'failed');
  assert.equal(source.pendingControllerReview, false);
  assert.deepEqual(controller.controllerActions.map((action) => action.action), ['instruction_delivery_failed']);

  manager.finishAutomaticReview(controller, true);
  assert.equal(store.project.automation.state, 'running');
  assert.equal(scheduled.length, 0);
});

test('Agent startup failure is reported in the same Controller Turn without a second review', async () => {
  const { store, codex, manager, scheduled } = fixture();
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Idle', threadId: null, pendingMessages: [], skills: [] };
  const source = completedRun(1);
  const controller = controllerRun([source.id]);
  store.project.agents.push(agent);
  store.project.runs = [controller, source];
  codex.startTurn = async () => { throw new Error('Agent turn/start rejected'); };

  await assert.rejects(executeTool({ name: 'run_agent', arguments: { agentId: agent.id, prompt: 'New task' }, kind: 'controller', store, manager, threadId: 'controller-thread', turnId: 'controller-turn' }), /not delivered: Agent turn\/start rejected/);
  const failed = store.project.runs.find((run) => run.agentId === agent.id && run.id !== source.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.pendingControllerReview, false);
  assert.equal(source.pendingControllerReview, false);
  manager.finishAutomaticReview(controller, true);
  assert.equal(store.project.automation.state, 'running');
  assert.deepEqual(scheduled, [{ goalCheck: true }]);
});

test('an Agent failure replayed before start returns is included once in the Controller tool result', async () => {
  const { store, codex, manager } = fixture();
  codex.isSimulation = () => false;
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Idle', threadId: null, pendingMessages: [], skills: [] };
  const source = completedRun(1);
  const controller = controllerRun([source.id]);
  store.project.agents.push(agent);
  store.project.runs = [controller, source];
  let resolveStart;
  codex.startTurn = (threadId, prompt, cwd, instructions, kind, model, effort, onThreadReady) => {
    onThreadReady('agent-thread');
    return new Promise((resolve) => { resolveStart = resolve; });
  };

  const toolCall = executeTool({ name: 'run_agent', arguments: { agentId: agent.id, prompt: 'New task' }, kind: 'controller', store, manager, threadId: 'controller-thread', turnId: 'controller-turn' });
  const run = store.project.runs.find((item) => item.agentId === agent.id);
  codex.emit('turn.error', { turnId: 'agent-turn', error: { message: 'Agent runtime failed' } });
  resolveStart({ threadId: 'agent-thread', turnId: 'agent-turn' });
  const result = await toolCall;

  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.runId, run.id);
  assert.equal(result.run.detailAvailable, true);
  assert.equal(Object.hasOwn(result.run, 'finalOutput'), false);
  assert.match(manager.getRunDetail(run.id).finalOutput, /Agent runtime failed/);
  assert.equal(run.pendingControllerReview, false);
});

test('pausing automation stops its active review and blocks further Controller changes', async () => {
  const { store, manager } = fixture();
  const controller = controllerRun([]);
  store.project.runs.push(controller);
  store.setAutomation({ state: 'paused' });
  manager.pauseAutomaticReview();

  assert.equal(controller.status, 'interrupted');
  await assert.rejects(executeTool({ name: 'create_agent', arguments: { displayName: 'Late', researchContent: 'Research', skills: ['Analysis'] }, kind: 'controller', store, manager, turnId: 'controller-turn' }), /inactive Codex Turn/);
  assert.equal(store.project.agents.length, 0);
});

test('Controller thread creation is single-flight and cannot attach to another project', async () => {
  const { store } = fixture();
  let resolveStart;
  let starts = 0;
  const codex = { isSimulation: () => false, startThread: () => { starts += 1; return new Promise((resolve) => { resolveStart = resolve; }); } };

  const first = store.ensureController(codex);
  const second = store.ensureController(codex);
  assert.equal(starts, 1);
  resolveStart('controller-thread');
  assert.equal(await first, 'controller-thread');
  assert.equal(await second, 'controller-thread');

  store.project.controllerThreadReady = false;
  const oldProject = store.project;
  const pending = store.ensureController(codex);
  store.project = { id: 'other-project', model: '', runs: [], agents: [], automation: { state: 'paused' } };
  resolveStart('thread-for-old-project');
  await assert.rejects(pending, /project or model changed/);
  assert.equal(store.project.controllerThreadId, undefined);
  store.project = oldProject;
});

test('Controller instruction revisions keep the existing research thread', async () => {
  const { store } = fixture();
  store.project.controllerThreadReady = true;
  store.project.controllerThreadId = 'existing-controller-thread';
  store.project.controllerInstructionVersion = 1;
  const codex = { isSimulation: () => false, startThread: () => { throw new Error('Must retain the existing thread'); } };

  assert.equal(await store.ensureController(codex), 'existing-controller-thread');
});

test('runtime failure closes active Runs and leaves Agent work for review', () => {
  const { store, codex, manager, scheduled } = fixture();
  const agent = {
    id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Running',
    currentRunId: 'active-agent-run', status: { current: '', next: '', blocked: '' }
  };
  const source = completedRun(1);
  const active = { id: 'active-agent-run', agentId: agent.id, status: 'running', userPrompt: 'Research', events: [] };
  const controller = controllerRun([source.id]);
  store.project.agents.push(agent);
  store.project.runs = [controller, active, source];

  codex.emit('runtime.error', new Error('runtime exited'));

  assert.equal(active.status, 'failed');
  assert.equal(active.pendingControllerReview, true);
  assert.equal(agent.lifecycleState, 'Idle');
  assert.equal(controller.status, 'failed');
  assert.equal(source.pendingControllerReview, false);
  assert.equal(store.project.automation.state, 'running');
  assert.ok(scheduled.some((options) => options.retry));
});

test('the last viewed project is persisted and one ProjectStore cannot replace its running project', () => {
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'restore-'));
  const first = path.join(directory, 'first');
  const second = path.join(directory, 'second');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  const store = new ProjectStore();
  store.load(first, 'First');
  const pointer = JSON.parse(fs.readFileSync(path.join(temporaryRoot, 'app-data', 'active-project.json'), 'utf8'));
  assert.equal(pointer.workspacePath, fs.realpathSync.native(first));
  restoreActiveProject();
  assert.equal(registry.selected().store.project.workspacePath, pointer.workspacePath);
  store.setAutomation({ state: 'running', goal: 'Continue research' });
  assert.throws(() => store.load(second, 'Second'), /cannot be rebound/);
});

test('streaming state writes are coalesced', async () => {
  const { store } = fixture();
  let writes = 0;
  store.save = () => { writes += 1; store.saveTimer = null; };
  store.scheduleSave();
  store.scheduleSave();
  store.scheduleSave();
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(writes, 0);
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(writes, 1);
});

test('state backup is periodic but can be refreshed at a checkpoint', () => {
  const { store } = fixture();
  const stateFile = path.join(store.runtimeDir, 'state.json');
  const backupFile = `${stateFile}.bak`;
  store.save();
  assert.equal(JSON.parse(fs.readFileSync(backupFile, 'utf8')).name, 'Test project');

  store.project.name = 'New name';
  store.save();
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).name, 'New name');
  assert.equal(JSON.parse(fs.readFileSync(backupFile, 'utf8')).name, 'Test project');

  store.save({ checkpoint: true });
  assert.equal(JSON.parse(fs.readFileSync(backupFile, 'utf8')).name, 'New name');
});

test('a corrupt primary state can still recover from the latest checkpoint backup', () => {
  const workspacePath = fs.mkdtempSync(path.join(temporaryRoot, 'recovery-workspace-'));
  const original = new ProjectStore();
  original.load(workspacePath, 'Recovery project');
  original.setAutomation({ state: 'running', goal: 'Preserve research state' });
  const stateFile = path.join(original.runtimeDir, 'state.json');
  fs.writeFileSync(stateFile, '{broken json', 'utf8');

  const reopened = new ProjectStore();
  reopened.load(workspacePath);
  assert.equal(reopened.project.automation.goal, 'Preserve research state');
  assert.equal(reopened.project.automation.state, 'running');
});

test('missing progress produces a short handoff rather than injecting final output', () => {
  const { store, manager } = fixture();
  const agent = {
    id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Running',
    currentRunId: 'active-run', status: { current: '', next: '', blocked: '' }
  };
  const run = { id: 'active-run', agentId: agent.id, status: 'running', userPrompt: 'Research', events: [] };
  store.project.agents.push(agent);
  store.project.runs.push(run);

  manager.finish(agent, run, 'A very long final output that belongs in get_run_detail.');

  assert.equal(store.project.progress.length, 1);
  assert.match(store.project.progress[0].message, /get_run_detail/);
  assert.doesNotMatch(store.project.progress[0].message, /very long final output/);
  const reviewPrompt = manager.buildControllerReviewPrompt([run]);
  assert.match(reviewPrompt, /get_run_detail/);
  assert.doesNotMatch(reviewPrompt, /very long final output/);
});

test('manually stopping an Agent hands the interrupted Run to Controller', () => {
  const { store, manager, scheduled } = fixture();
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Running', currentRunId: 'active-run', threadId: 'agent-thread' };
  const run = { id: 'active-run', agentId: agent.id, status: 'running', userPrompt: 'Research', threadId: 'agent-thread', turnId: 'active-turn', events: [] };
  store.project.agents.push(agent);
  store.project.runs.push(run);

  manager.stop(agent);

  assert.equal(run.status, 'interrupted');
  assert.equal(run.pendingControllerReview, true);
  assert.equal(agent.lifecycleState, 'Idle');
  assert.equal(store.project.progress.length, 1);
  assert.match(manager.buildControllerReviewPrompt([run]), /Interruption: This Turn was explicitly stopped/);
  assert.equal(scheduled.length, 1);
});

test('pausing a running Agent hands off its Run without making the Agent schedulable', () => {
  const { store, manager, scheduled } = fixture();
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Running', currentRunId: 'active-run', threadId: 'agent-thread' };
  const run = { id: 'active-run', agentId: agent.id, status: 'running', userPrompt: 'Research', threadId: 'agent-thread', turnId: 'active-turn', events: [] };
  store.project.agents.push(agent);
  store.project.runs.push(run);

  manager.pause(agent);

  assert.equal(run.pendingControllerReview, true);
  assert.equal(agent.lifecycleState, 'Paused');
  assert.equal(scheduled.length, 1);
});

test('an interrupted Run stays pending while automation is off and after it is re-enabled', () => {
  const { store, manager, scheduled } = fixture();
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Running', currentRunId: 'active-run', threadId: 'agent-thread' };
  const run = { id: 'active-run', agentId: agent.id, status: 'running', userPrompt: 'Research', threadId: 'agent-thread', turnId: 'active-turn', events: [] };
  store.project.agents.push(agent);
  store.project.runs.push(run);
  store.setAutomation({ state: 'paused' });

  manager.stop(agent);
  assert.equal(scheduled.length, 0);
  assert.equal(run.pendingControllerReview, true);

  store.setAutomation({ state: 'running' });
  assert.deepEqual(manager.pendingControllerRuns().map((item) => item.id), [run.id]);
});

test('an unexpected Codex interruption remains pending and wakes Controller', () => {
  const { store, codex, scheduled } = fixture();
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Running', currentRunId: 'active-run', threadId: 'agent-thread' };
  const run = { id: 'active-run', agentId: agent.id, status: 'running', userPrompt: 'Research', threadId: 'agent-thread', turnId: 'active-turn', events: [] };
  store.project.agents.push(agent);
  store.project.runs.push(run);

  codex.emit('turn.completed', { threadId: 'agent-thread', turnId: 'active-turn', status: 'interrupted' });

  assert.equal(run.status, 'interrupted');
  assert.equal(run.pendingControllerReview, true);
  assert.equal(agent.lifecycleState, 'Idle');
  assert.equal(store.project.progress.length, 1);
  assert.equal(scheduled.length, 1);
});

test('a stale event on the same thread cannot complete the next Run', () => {
  const { store, codex, manager, scheduled } = fixture();
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Running', currentRunId: 'new-run', threadId: 'agent-thread' };
  const oldRun = { id: 'old-run', agentId: agent.id, status: 'interrupted', threadId: 'agent-thread', turnId: 'old-turn' };
  const newRun = { id: 'new-run', agentId: agent.id, status: 'running', userPrompt: 'New task', threadId: 'agent-thread', turnId: 'new-turn', events: [] };
  store.project.agents.push(agent);
  store.project.runs.push(newRun, oldRun);

  assert.equal(manager.findRun({ threadId: 'agent-thread', turnId: 'old-turn' }), null);
  assert.equal(manager.findRun({ threadId: 'agent-thread' }), null);
  codex.emit('turn.completed', { threadId: 'agent-thread', turnId: 'old-turn', status: 'completed' });

  assert.equal(newRun.status, 'running');
  assert.equal(agent.currentRunId, 'new-run');
  assert.equal(scheduled.length, 0);
});

test('a stale completion is ignored while the next Run is waiting for its Turn ID', () => {
  const { store, codex, manager, scheduled } = fixture();
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Running', currentRunId: 'new-run', threadId: 'agent-thread' };
  const oldRun = { id: 'old-run', agentId: agent.id, status: 'interrupted', threadId: 'agent-thread', turnId: 'old-turn' };
  const newRun = { id: 'new-run', agentId: agent.id, status: 'running', userPrompt: 'New task', threadId: 'agent-thread', events: [] };
  store.project.agents.push(agent);
  store.project.runs.push(newRun, oldRun);

  codex.emit('turn.completed', { threadId: 'agent-thread', turnId: 'old-turn', status: 'completed' });

  assert.equal(newRun.status, 'running');
  assert.equal(manager.earlyTurnEvents.has('old-turn'), false);
  assert.equal(scheduled.length, 0);
});

test('a stale Agent tool call cannot publish progress into the next Run', async () => {
  const { store, manager } = fixture();
  attachResearch(store);
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Running', currentRunId: 'new-run', threadId: 'agent-thread' };
  const oldRun = { id: 'old-run', agentId: agent.id, status: 'interrupted', threadId: 'agent-thread', turnId: 'old-turn' };
  const newRun = { id: 'new-run', agentId: agent.id, status: 'running', threadId: 'agent-thread', turnId: 'new-turn' };
  store.project.agents.push(agent);
  store.project.runs.push(newRun, oldRun);

  await assert.rejects(executeTool({ name: 'submit_report', arguments: { summary: 'Old output', body_md: 'Old work' }, kind: 'agent', store, manager, threadId: 'agent-thread', turnId: 'old-turn' }), /inactive Codex Turn/);
  assert.equal(store.project.progress.length, 0);
  await executeTool({ name: 'submit_report', arguments: { summary: 'Current output', body_md: 'Current work' }, kind: 'agent', store, manager, threadId: 'agent-thread', turnId: 'new-turn' });
  assert.equal(store.project.progress[0].runId, 'new-run');
});

test('a stale Controller tool call cannot complete the project', async () => {
  const { store, manager } = fixture();
  const oldRun = controllerRun([], { id: 'old-controller', status: 'interrupted', turnId: 'old-turn' });
  const newRun = controllerRun([], { id: 'new-controller', turnId: 'new-turn' });
  store.project.runs.push(newRun, oldRun);

  await assert.rejects(executeTool({ name: 'set_project_state', arguments: { state: 'completed', reason: 'Done' }, kind: 'controller', store, manager, threadId: 'controller-thread', turnId: 'old-turn' }), /inactive Codex Turn/);
  assert.equal(store.project.automation.state, 'running');
});

test('a rejected Agent steer leaves the original Turn running and marks only that instruction failed', async () => {
  const { store, codex, manager, scheduled } = fixture();
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Running', currentRunId: 'active-run', threadId: 'agent-thread' };
  const run = { id: 'active-run', agentId: agent.id, status: 'running', userPrompt: 'Original task', prompt: 'Original task', threadId: 'agent-thread', turnId: 'active-turn', events: [], userMessages: [] };
  store.project.agents.push(agent);
  store.project.runs.push(run);
  let interrupted = false;
  codex.steerTurn = async () => { throw new Error('steer rejected'); };
  codex.interruptTurn = async () => { interrupted = true; };

  manager.steer(agent, 'Additional task');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(run.status, 'running');
  assert.equal(agent.lifecycleState, 'Running');
  assert.equal(run.userPrompt, 'Original task');
  assert.equal(run.userMessages[0].delivery, 'failed');
  assert.equal(interrupted, false);
  assert.equal(scheduled.length, 0);
});

test('an Agent steer sent during startup waits for the real Turn ID', async () => {
  const { store, codex, manager } = fixture();
  codex.isSimulation = () => false;
  let resolveStart;
  const steers = [];
  codex.startTurn = () => new Promise((resolve) => { resolveStart = resolve; });
  codex.steerTurn = async (threadId, instruction, turnId) => { steers.push({ threadId, instruction, turnId }); };
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Idle', threadId: 'agent-thread', pendingMessages: [] };
  store.project.agents.push(agent);

  const run = manager.run(agent, 'Original task');
  manager.steer(agent, 'Additional task');
  assert.equal(run.userMessages.at(-1).delivery, 'queued');
  assert.equal(steers.length, 0);
  resolveStart({ threadId: 'agent-thread', turnId: 'active-turn' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(steers, [{ threadId: 'agent-thread', instruction: 'Additional task', turnId: 'active-turn' }]);
  assert.equal(run.userMessages.at(-1).delivery, 'delivered');
  assert.match(run.userPrompt, /Additional task/);
  assert.equal(run.status, 'running');
});

test('a user-created new Agent conversation can use tools before turn/start responds', async () => {
  const { store } = fixture();
  const codex = new CodexClient();
  codex.simulated = false;
  codex.connect = async () => {};
  codex.resumeThread = async () => { throw new Error('An empty new conversation must not resume an old thread'); };
  let newThreadInstructions = '';
  codex.startThread = async (_cwd, instructions) => { newThreadInstructions = instructions; return 'replacement-agent-thread'; };
  let resolveStart;
  codex.request = () => new Promise((resolve) => { resolveStart = resolve; });
  const manager = new AgentManager(store, codex);
  manager.scheduleControllerReview = () => {};
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Idle', threadId: null, pendingMessages: [] };
  store.project.agents.push(agent);

  const run = manager.run(agent, 'Research task');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.turnId, undefined);
  assert.equal(run.threadId, 'replacement-agent-thread');
  assert.equal(agent.threadId, 'replacement-agent-thread');
  assert.doesNotMatch(newThreadInstructions, /\[BEGIN BUNDLED SKILL/);
  const state = await executeTool({ name: 'get_team_state', arguments: { agentId: agent.id }, kind: 'agent', store, manager, threadId: 'replacement-agent-thread', turnId: 'early-turn' });
  assert.equal(state.currentRun.id, run.id);

  resolveStart({ turn: { id: 'early-turn' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.turnId, 'early-turn');
});

test('a paused automatic review cannot re-enable automation or complete the project', () => {
  const { store, manager } = fixture();
  const source = completedRun(1);
  store.project.runs = [controllerRun([source.id]), source];
  store.setAutomation({ state: 'paused', reason: 'User paused automatic orchestration' });

  assert.throws(() => manager.setProjectState('running', 'Continue'), /no longer running/);
  assert.throws(() => manager.setProjectState('completed', 'Done'), /no longer running/);
  assert.equal(store.project.automation.state, 'paused');
  assert.equal(source.pendingControllerReview, true);
});

test('early Agent output and completion are replayed after turn/start binds the ID', async () => {
  const { store, codex, manager, scheduled } = fixture();
  codex.isSimulation = () => false;
  let resolveStart;
  codex.startTurn = () => new Promise((resolve) => { resolveStart = resolve; });
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Idle', threadId: 'agent-thread', pendingMessages: [] };
  store.project.agents.push(agent);

  const run = manager.run(agent, 'Research');
  codex.emit('turn.delta', { threadId: 'agent-thread', turnId: 'early-turn', delta: 'Verified result' });
  codex.emit('turn.completed', { threadId: 'agent-thread', turnId: 'early-turn', status: 'completed' });
  assert.equal(run.status, 'running');
  resolveStart({ threadId: 'agent-thread', turnId: 'early-turn' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(run.status, 'completed');
  assert.equal(run.finalOutput, 'Verified result');
  assert.equal(run.pendingControllerReview, true);
  assert.equal(agent.lifecycleState, 'Idle');
  assert.equal(scheduled.length, 1);
});

test('early Controller completion is replayed after its turn/start response', async () => {
  const { store, codex, manager } = fixture();
  codex.isSimulation = () => false;
  let resolveStart;
  codex.startTurn = () => new Promise((resolve) => { resolveStart = resolve; });
  const run = controllerRun([], { autoReview: false, turnId: undefined });
  store.project.runs.push(run);

  manager.startControllerRun(run);
  codex.emit('turn.completed', { threadId: 'controller-thread', turnId: 'early-controller-turn', status: 'completed' });
  resolveStart({ threadId: 'controller-thread', turnId: 'early-controller-turn' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(run.status, 'completed');
  assert.equal(manager.earlyTurnEvents.size, 0);
});

test('queued Controller work and follow-ups receive the latest goal without changing the user request', async () => {
  const { store, codex, manager } = fixture(), starts = [], steers = [];
  codex.isSimulation = () => false;
  codex.startTurn = async (threadId, prompt) => { starts.push(prompt); return { threadId, turnId: `turn-${starts.length}` }; };
  codex.steerTurn = async (threadId, prompt) => { steers.push(prompt); };
  let releaseStop;
  manager.controllerStopBarrier = new Promise((resolve) => { releaseStop = resolve; });
  const run = controllerRun([], { autoReview: false, turnId: undefined, prompt: 'Check the next research step', userPrompt: 'Check the next research step' });
  store.project.runs.push(run);
  manager.startControllerRun(run);
  assert.equal(starts.length, 0);
  store.project.automation.goal = 'Updated overall goal';
  releaseStop(null);
  await manager.controllerStartOutcomes.get(run);
  manager.controllerStopBarrier = null;
  assert.match(starts[0], /^Project research goal: Updated overall goal\nResearch reminder:/);
  assert.match(starts[0], /Check the next research step$/);
  assert.equal(run.userPrompt, 'Check the next research step');
  store.project.automation.goal = 'Latest overall goal';
  manager.steerController('Check whether this case generalizes');
  assert.match(steers[0], /^Project research goal: Latest overall goal\nResearch reminder:/);
  assert.match(steers[0], /Check whether this case generalizes$/);
  assert.equal(run.userMessages.at(-1).text, 'Check whether this case generalizes');
  run.status = 'completed';
  store.project.automation.goal = '';
  const noGoal = controllerRun([], { id: 'no-goal', autoReview: false, turnId: undefined, prompt: 'Clarify the question' });
  store.project.runs.push(noGoal);
  manager.startControllerRun(noGoal);
  await manager.controllerStartOutcomes.get(noGoal);
  assert.equal(starts.at(-1), 'Clarify the question');
});

test('an early completion does not resurrect a finished Codex Turn after start responds', async () => {
  const codex = new CodexClient();
  codex.simulated = false;
  codex.connect = async () => {};
  codex.threads.add('agent-thread');
  let resolveStart;
  codex.request = () => new Promise((resolve) => { resolveStart = resolve; });

  const started = codex.startTurn('agent-thread', 'Research', 'C:/workspace');
  await new Promise((resolve) => setImmediate(resolve));
  codex.handleMessage({ method: 'turn/completed', params: { threadId: 'agent-thread', turn: { id: 'early-turn', status: 'completed' } } });
  resolveStart({ turn: { id: 'early-turn' } });
  await started;

  assert.equal(codex.turns.has('early-turn'), false);
  assert.equal(codex.pendingTurnStarts, 0);
  assert.equal(codex.completedDuringStart.size, 0);
});

test('updated developer instructions reach an existing thread before its next Turn', async () => {
  const codex = new CodexClient();
  codex.simulated = false;
  codex.connect = async () => {};
  codex.threads.add('agent-thread');
  const calls = [];
  codex.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'turn/start') return { turn: { id: `turn-${calls.length}` } };
    return {};
  };

  await codex.startTurn('agent-thread', 'First task', 'C:/workspace', 'Old instructions');
  assert.deepEqual(calls.map((call) => call.method), ['thread/inject_items', 'turn/start']);
  assert.equal(calls[0].params.items[0].role, 'developer');
  assert.match(calls[0].params.items[0].content[0].text, /Old instructions/);
  calls.length = 0;

  await codex.startTurn('agent-thread', 'Next task', 'C:/workspace', 'New instructions');
  assert.deepEqual(calls.map((call) => call.method), ['thread/inject_items', 'turn/start']);
  assert.match(calls[0].params.items[0].content[0].text, /New instructions/);
  assert.match(calls[0].params.items[0].content[0].text, /supersedes earlier/);
  assert.equal(calls[1].params.threadId, 'agent-thread');
  calls.length = 0;

  await codex.startTurn('agent-thread', 'Another task', 'C:/workspace', 'New instructions');
  assert.deepEqual(calls.map((call) => call.method), ['turn/start']);
  calls.length = 0;

  codex.handleMessage({ method: 'item/completed', params: { threadId: 'agent-thread', item: { type: 'contextCompaction' } } });
  await codex.startTurn('agent-thread', 'After compaction', 'C:/workspace', 'New instructions');
  assert.deepEqual(calls.map((call) => call.method), ['thread/inject_items', 'turn/start']);
});

test('cold resume supplies the current instructions and injects them before a Turn', async () => {
  const codex = new CodexClient();
  codex.simulated = false;
  codex.connect = async () => {};
  const calls = [];
  codex.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'turn/start') return { turn: { id: 'resumed-turn' } };
    return {};
  };

  const result = await codex.startTurn('persisted-agent-thread', 'Continue', 'C:/workspace', 'Current instructions');
  assert.equal(result.threadId, 'persisted-agent-thread');
  assert.deepEqual(calls.map((call) => call.method), ['thread/resume', 'thread/inject_items', 'turn/start']);
  assert.equal(calls[0].params.developerInstructions, 'Current instructions');
  assert.equal(calls[1].params.items[0].role, 'developer');
  assert.equal(calls[2].params.threadId, 'persisted-agent-thread');
});

test('an unloaded Codex thread is re-resumed and refreshed before reuse', async () => {
  const codex = new CodexClient();
  codex.simulated = false;
  codex.connect = async () => {};
  codex.threads.add('agent-thread');
  codex.threadInstructionHashes.set('agent-thread', 'previous-hash');
  codex.handleMessage({ method: 'thread/closed', params: { threadId: 'agent-thread' } });
  const calls = [];
  codex.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'turn/start') return { turn: { id: 'resumed-turn' } };
    return {};
  };

  await codex.startTurn('agent-thread', 'Continue', 'C:/workspace', 'Current instructions');
  assert.deepEqual(calls.map((call) => call.method), ['thread/resume', 'thread/inject_items', 'turn/start']);
});

test('a failed instruction update blocks the next Turn instead of silently using stale instructions', async () => {
  const codex = new CodexClient();
  codex.simulated = false;
  codex.connect = async () => {};
  codex.threads.add('agent-thread');
  const calls = [];
  codex.request = async (method) => {
    calls.push(method);
    if (method === 'thread/inject_items') throw new Error('Injection unavailable');
    return { turn: { id: 'must-not-start' } };
  };

  await assert.rejects(codex.startTurn('agent-thread', 'Continue', 'C:/workspace', 'Updated instructions'), /updated developer instructions could not be applied/);
  assert.deepEqual(calls, ['thread/inject_items']);
  assert.equal(codex.threadInstructionHashes.has('agent-thread'), false);
});

test('a transient resume failure does not replace a persisted conversation', async () => {
  const codex = new CodexClient();
  codex.simulated = false;
  codex.connect = async () => {};
  codex.resumeThread = async () => { throw new Error('Codex runtime temporarily unavailable'); };
  codex.startThread = async () => { throw new Error('Must not create a replacement thread'); };

  await assert.rejects(codex.startTurn('existing-thread', 'Continue', 'C:/workspace', 'Current instructions'), /temporarily unavailable/);
});

test('canceling during context preparation prevents the late user prompt from reaching the native runner', async () => {
  const codex = new CodexClient(); codex.simulated = false; codex.process = {};
  codex.connect = async () => {}; codex.threads.add('existing-thread');
  let release, current = true; const requests = [];
  codex.contextWindowPolicy = { ensure: () => new Promise(resolve => { release = resolve; }) };
  codex.request = async method => { requests.push(method); return { turn: { id: 'must-not-send' } }; };
  const start = codex.startTurn('existing-thread', 'Canceled prompt', 'C:/workspace', '', 'agent', '', '', () => current);
  await new Promise(resolve => setImmediate(resolve)); current = false; release();
  assert.equal(await start, null); assert.deepEqual(requests, []);
});

test('missing Controller session files fail visibly without replacing the selected conversation', async (t) => {
  const { store } = fixture();
  const codex = new CodexClient();
  codex.simulated = false;
  codex.connect = async () => {};
  codex.resumeThread = async () => { throw new Error('thread not found: old-controller-thread'); };
  codex.startThread = async () => { throw new Error('Must not create a replacement thread'); };
  codex.request = async () => ({ turn: { id: 'replacement-turn' } });
  store.project.controllerThreadId = 'old-controller-thread';
  const manager = new AgentManager(store, codex);
  t.after(() => {
    store.project.automation.state = 'paused';
    manager.pauseAutomaticReview();
  });
  const run = controllerRun([], { autoReview: false, threadId: 'old-controller-thread', turnId: undefined });
  store.project.runs.push(run);

  manager.startControllerRun(run);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(run.status, 'failed');
  assert.match(run.finalOutput, /会话文件不存在/);
  assert.equal(run.threadId, 'old-controller-thread');
  assert.equal(store.project.controllerThreadId, 'old-controller-thread');
});

test('stopping before turn/start returns interrupts the late Turn ID', async () => {
  const { store, codex, manager, scheduled } = fixture();
  codex.isSimulation = () => false;
  let resolveStart;
  const interrupted = [];
  codex.startTurn = () => new Promise((resolve) => { resolveStart = resolve; });
  codex.interruptTurn = async (threadId, turnId) => { interrupted.push({ threadId, turnId }); };
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Idle', threadId: null, pendingMessages: [] };
  store.project.agents.push(agent);

  const run = manager.run(agent, 'Research');
  manager.stop(agent);
  assert.equal(interrupted.length, 0);
  resolveStart({ threadId: 'late-thread', turnId: 'late-turn' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(interrupted, [{ threadId: 'late-thread', turnId: 'late-turn' }]);
  assert.equal(run.status, 'interrupted');
  assert.equal(run.pendingControllerReview, true);
  assert.equal(agent.lifecycleState, 'Idle');
  assert.equal(agent.threadId, null);
  assert.equal(scheduled.length, 1);
});

test('an Agent cannot start its next Turn until the prior interrupt completes', async () => {
  const { store, codex, manager } = fixture();
  codex.isSimulation = () => false;
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Running', currentRunId: 'old-run', threadId: 'agent-thread', pendingMessages: [] };
  const oldRun = { id: 'old-run', agentId: agent.id, status: 'running', threadId: 'agent-thread', turnId: 'old-turn', userPrompt: 'Old task', events: [] };
  store.project.agents.push(agent);
  store.project.runs.push(oldRun);
  let releaseInterrupt;
  const starts = [];
  codex.interruptTurn = () => new Promise((resolve) => { releaseInterrupt = resolve; });
  codex.startTurn = async (threadId) => { starts.push(threadId); return { threadId, turnId: 'new-turn' }; };

  manager.stop(agent);
  const next = manager.run(agent, 'Next task');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, []);
  assert.equal(next.status, 'running');

  releaseInterrupt({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ['agent-thread']);
  assert.equal(next.turnId, 'new-turn');
});

test('stopping during Agent startup waits for the late Turn to be interrupted before restarting', async () => {
  const { store, codex, manager } = fixture();
  codex.isSimulation = () => false;
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Idle', threadId: 'agent-thread', pendingMessages: [] };
  store.project.agents.push(agent);
  let releaseStart;
  let releaseInterrupt;
  let starts = 0;
  codex.startTurn = async () => {
    starts += 1;
    if (starts === 1) return new Promise((resolve) => { releaseStart = resolve; });
    return { threadId: 'agent-thread', turnId: 'next-turn' };
  };
  codex.interruptTurn = () => new Promise((resolve) => { releaseInterrupt = resolve; });

  const old = manager.run(agent, 'Old task');
  manager.stop(agent);
  const next = manager.run(agent, 'Next task');
  assert.equal(starts, 1);
  releaseStart({ threadId: 'agent-thread', turnId: 'old-turn' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal(old.status, 'interrupted');

  releaseInterrupt({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 2);
  assert.equal(next.turnId, 'next-turn');
});

test('an early-bound Agent Turn is interrupted once and its start response drains before reuse', async () => {
  const { store, codex, manager } = fixture();
  codex.isSimulation = () => false;
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Idle', threadId: 'agent-thread', pendingMessages: [] };
  store.project.agents.push(agent);
  let releaseStart;
  let releaseInterrupt;
  let starts = 0;
  let interrupts = 0;
  codex.startTurn = () => {
    starts += 1;
    if (starts === 1) return new Promise((resolve) => { releaseStart = resolve; });
    return Promise.resolve({ threadId: 'agent-thread', turnId: 'next-turn' });
  };
  codex.interruptTurn = () => { interrupts += 1; return new Promise((resolve) => { releaseInterrupt = resolve; }); };

  const old = manager.run(agent, 'Old task');
  old.turnId = 'early-turn';
  manager.stop(agent);
  const next = manager.run(agent, 'Next task');
  await new Promise((resolve) => setImmediate(resolve));
  releaseInterrupt({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);

  releaseStart({ threadId: 'agent-thread', turnId: 'early-turn' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interrupts, 1);
  assert.equal(starts, 2);
  assert.equal(next.turnId, 'next-turn');
});

test('a failed late Agent interrupt reconciles in the background without requiring manual acknowledgement', async () => {
  const { store, codex, manager } = fixture();
  codex.isSimulation = () => false;
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Idle', threadId: 'agent-thread', pendingMessages: [] };
  store.project.agents.push(agent);
  let releaseStart;
  codex.startTurn = () => new Promise((resolve) => { releaseStart = resolve; });
  let interruptCalls = 0; manager.stopRecoveryWait = async () => {};
  codex.interruptTurn = async () => { if (++interruptCalls === 1) throw new Error('Interrupt rejected'); };

  manager.run(agent, 'Research');
  manager.stop(agent);
  releaseStart({ threadId: 'agent-thread', turnId: 'late-turn' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(agent.lifecycleState, 'Idle');
  assert.equal(agent.attention, null); assert.equal(interruptCalls, 2); assert.equal(agent.stopPending, false);
});

test('a failed Agent is immediately available for a new instruction without acknowledging Attention', async () => {
  const { store, codex, manager } = fixture(); codex.isSimulation = () => false;
  const agent = { id: 'recover-agent', displayName: 'Research Agent', lifecycleState: 'Running', currentRunId: 'failed-run', threadId: 'same-thread', pendingMessages: [] };
  const failed = { id: 'failed-run', agentId: agent.id, status: 'running', threadId: 'same-thread', turnId: 'old-turn', userPrompt: 'Old work', finalOutput: 'Preserved partial work', events: [] };
  store.project.agents.push(agent); store.project.runs.push(failed);
  codex.startTurn = async () => ({ threadId: 'same-thread', turnId: 'new-turn' });
  manager.fail(agent, failed, new Error('Synthetic task error'));
  assert.equal(agent.lifecycleState, 'Idle'); assert.equal(agent.attention, null); assert.match(failed.finalOutput, /Preserved partial work/);
  const next = manager.run(agent, 'Continue with a corrected instruction'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(next.status, 'running'); assert.equal(next.turnId, 'new-turn'); assert.equal(failed.status, 'failed');
});

test('malformed tool JSON is returned as feedback before a tool can create any Agent', async () => {
  const { store, manager } = fixture();
  await assert.rejects(executeTool({ name: 'create_agent', kind: 'controller', arguments: '{', store, manager }), { code: 'INVALID_TOOL_ARGUMENTS' });
  assert.equal(store.project.agents.length, 0);
});

test('automatic Controller review waits for an Agent stop to finish', async () => {
  const { store, codex, manager } = fixture();
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Running', currentRunId: 'old-run', threadId: 'agent-thread' };
  const oldRun = { id: 'old-run', agentId: agent.id, status: 'running', threadId: 'agent-thread', turnId: 'old-turn', userPrompt: 'Old task', events: [] };
  store.project.agents.push(agent);
  store.project.runs.push(oldRun);
  let releaseInterrupt;
  codex.interruptTurn = () => new Promise((resolve) => { releaseInterrupt = resolve; });
  manager.startControllerRun = () => {};

  manager.stop(agent);
  const review = manager.startAutomaticReview();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.project.runs.filter((run) => !run.agentId).length, 0);

  releaseInterrupt({});
  await review;
  assert.equal(store.project.runs.filter((run) => !run.agentId).length, 1);
  assert.equal(store.project.automation.state, 'running');
});

test('a queued Controller request waits for the interrupted Controller Turn', async () => {
  const { store, codex, manager } = fixture();
  codex.isSimulation = () => false;
  const old = controllerRun([], { id: 'old-controller', autoReview: false });
  const next = controllerRun([], { id: 'next-controller', autoReview: false, status: 'queued', turnId: undefined });
  store.project.runs.push(old, next);
  let releaseInterrupt;
  let starts = 0;
  codex.interruptTurn = () => new Promise((resolve) => { releaseInterrupt = resolve; });
  codex.startTurn = async () => { starts += 1; return { threadId: 'controller-thread', turnId: 'next-turn' }; };

  manager.stopController(old);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(next.status, 'running');
  assert.equal(starts, 0);

  releaseInterrupt({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal(next.turnId, 'next-turn');
});

test('Agent collaboration is recorded only after the target instruction is delivered', async () => {
  const { store, codex, manager } = fixture();
  const source = { id: 'agent-source', displayName: 'Source Agent', lifecycleState: 'Running', currentRunId: 'source-run', threadId: 'source-thread' };
  const target = { id: 'agent-target', displayName: 'Target Agent', lifecycleState: 'Running', currentRunId: 'target-run', threadId: 'target-thread' };
  const sourceRun = { id: 'source-run', agentId: source.id, status: 'running', threadId: 'source-thread', turnId: 'source-turn', events: [] };
  const targetRun = { id: 'target-run', agentId: target.id, status: 'running', threadId: 'target-thread', turnId: 'target-turn', prompt: 'Original task', userPrompt: 'Original task', events: [], userMessages: [] };
  store.project.agents.push(source, target);
  store.project.runs.push(sourceRun, targetRun);
  codex.steerTurn = async () => { throw new Error('Delivery rejected'); };

  await assert.rejects(executeTool({ name: 'team_message', arguments: { target: target.id, message: 'Check the lemma' }, kind: 'agent', store, manager, threadId: source.threadId, turnId: sourceRun.turnId }), /not delivered/);
  assert.deepEqual(sourceRun.collaborationMessages || [], []);

  codex.steerTurn = async () => ({});
  const delivered = await executeTool({ name: 'team_message', arguments: { target: target.id, message: 'Check the lemma' }, kind: 'agent', store, manager, threadId: source.threadId, turnId: sourceRun.turnId });
  assert.equal(delivered.result.mode, 'steer');
  assert.equal(delivered.result.run.runId, targetRun.id);
  assert.equal(Object.hasOwn(delivered, 'message'), false);
  assert.equal(sourceRun.collaborationMessages.length, 1);
  assert.equal(sourceRun.collaborationMessages[0].delivery, 'steer');
});

test('saving an asset returns a compact receipt and is restricted to the Controller', async () => {
  const { store, manager } = fixture();
  attachResearch(store);
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Running', currentRunId: 'active-run', threadId: 'agent-thread', researchResults: [] };
  const run = { id: 'active-run', agentId: agent.id, status: 'running', threadId: agent.threadId, turnId: 'active-turn', savedResultIds: [] };
  store.project.agents.push(agent);
  store.project.runs.push(run);
  const controller = controllerRun([], { autoReview: false }); store.project.runs.push(controller);
  const technicalContent = 'Detailed verification with reproducible calculations';
  const conciseContent = 'The result holds under the stated assumptions';

  const saved = await executeTool({
    name: 'save_asset', kind: 'controller', store, manager, threadId: controller.threadId, turnId: controller.turnId,
    arguments: { title: 'Checked result', body_md: technicalContent + '\n' + conciseContent }
  });

  assert.equal(saved.record.revision, 1);
  assert.equal(Object.hasOwn(saved.record, 'body_md'), false);
  assert.equal(store.research.get(saved.record.id).body_md, technicalContent + '\n' + conciseContent);
  await assert.rejects(executeTool({ name: 'save_asset', kind: 'agent', store, manager, threadId: agent.threadId, turnId: run.turnId, arguments: { title: 'Unauthorized edit' } }), /not available/);
});

test('generated automatic review context and state reasons use English with English research data', () => {
  const { store, manager } = fixture();
  const agent = { id: 'agent-1', displayName: 'Research Agent', lifecycleState: 'Idle' };
  const source = { ...completedRun(1), userPrompt: 'Check the lemma' };
  const controller = controllerRun([source.id]);
  store.project.agents.push(agent);
  store.project.runs.push(controller, source);
  const prompt = manager.buildControllerReviewPrompt([source]);
  assert.doesNotMatch(prompt, /[\u3400-\u9fff]/u);

  manager.finishAutomaticReview(controller, true);
  assert.doesNotMatch(store.project.automation.reason, /[\u3400-\u9fff]/u);
});

test('project completion atomically acknowledges only the reviewed batch', () => {
  const { store, manager } = fixture();
  const source = completedRun(1);
  const controller = controllerRun([source.id]);
  store.project.runs = [controller, source];

  manager.setProjectState('completed', 'Research goal verified');

  const persisted = JSON.parse(fs.readFileSync(path.join(store.runtimeDir, 'state.json'), 'utf8'));
  assert.equal(persisted.automation.state, 'completed');
  assert.equal(persisted.runs.find((run) => run.id === source.id).pendingControllerReview, false);
  assert.equal(store.project.automation.state, 'completed');
  assert.equal(source.pendingControllerReview, false);
});

test('completion rejects pending Runs outside the review batch and direct completion', () => {
  const { store, manager } = fixture();
  const first = completedRun(1);
  const second = completedRun(2);
  store.project.runs = [controllerRun([first.id]), first, second];

  assert.throws(() => manager.setProjectState('completed', 'Done'), /still await review/);
  assert.equal(store.project.automation.state, 'running');
  assert.equal(first.pendingControllerReview, true);
  assert.throws(() => store.setAutomation({ state: 'completed' }), /still await review/);
});

test('reopening an older completed project with pending Runs returns to goal review', () => {
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'legacy-completed-'));
  const workspacePath = path.join(directory, 'workspace');
  fs.mkdirSync(workspacePath);
  const original = new ProjectStore();
  original.load(workspacePath, 'Legacy');
  original.project.runs.push(completedRun(1));
  original.project.automation = { state: 'completed', goal: 'Research goal', reason: '' };
  original.save();

  const reopened = new ProjectStore();
  reopened.load(workspacePath);

  assert.equal(reopened.project.automation.state, 'running');
  assert.equal(reopened.project.runs[0].pendingControllerReview, true);
});
