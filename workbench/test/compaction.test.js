const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmath-v3-compaction-'));
process.env.deepmath_app_data = path.join(temporaryRoot, 'app-data');
process.env.deepmath_codex_mode = 'simulated';
process.env.deepmath_auth_required = '0';
process.env.deepmath_workspace_root = os.tmpdir();
const { CodexClient, registry, server, closeResearchLibrary } = require('../src/server');
after(async () => {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  for (const runtime of registry.runtimes.values()) {
    if (runtime.manager.controllerReviewTimer) clearTimeout(runtime.manager.controllerReviewTimer);
    for (const timer of runtime.store.timers.values()) clearTimeout(timer);
  }
  closeResearchLibrary();
  assert.equal(path.dirname(temporaryRoot), os.tmpdir());
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

function client() {
  const codex = new CodexClient();
  codex.simulated = false;
  codex.connect = async () => {};
  codex.threads.add('thread-1');
  return codex;
}

test('manual compaction sends the thread RPC and waits for verified completion', async () => {
  const codex = client();
  const requests = [];
  codex.request = async (method, params) => { requests.push({ method, params }); return {}; };
  const operation = codex.compactThread('thread-1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, [{ method: 'thread/compact/start', params: { threadId: 'thread-1' } }]);
  assert.equal(codex.compactions.has('thread-1'), true);
  codex.handleMessage({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'compact-turn', item: { type: 'contextCompaction' } } });
  codex.handleMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'compact-turn', status: 'completed' } } });
  await operation;
  assert.equal(codex.compactions.has('thread-1'), false);
});

test('manual compaction reports remote failure and releases the thread', async () => {
  const codex = client();
  codex.request = async () => ({});
  const operation = codex.compactThread('thread-1');
  await new Promise((resolve) => setImmediate(resolve));
  codex.handleMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'compact-turn', status: 'failed', error: { message: 'remote compact failed' } } } });
  await assert.rejects(operation, /remote compact failed/);
  assert.equal(codex.compactions.has('thread-1'), false);
});

test('Controller and Agent compaction endpoints preserve project records and reject busy sessions', async () => {
  const workspace = path.join(temporaryRoot, 'workspace');
  fs.mkdirSync(workspace);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, projectId, body = {}) => {
    const response = await fetch(`${base}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(projectId ? { 'x-deepmath-project-id': projectId } : {}) },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const project = (await post('/api/project', '', { workspacePath: workspace })).body;
  const runtime = registry.byId(project.id);
  runtime.store.project.controllerThreadId = 'controller-thread';
  runtime.store.project.controllerThreadReady = true;
  const agent = runtime.store.createAgent({ displayName: 'Verifier', researchContent: 'Check proofs', skills: ['Proof'] });
  agent.threadId = 'agent-thread';
  runtime.store.save();
  const publicResponse = await fetch(`${base}/api/project?projectId=${project.id}`);
  const publicProject = await publicResponse.json();
  assert.equal(publicProject.agents.find((item) => item.id === agent.id).threadId, 'agent-thread');
  const originalAgentCount = runtime.store.project.agents.length;
  const controller = await post('/api/controller/compact', project.id);
  assert.equal(controller.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.store.contextCompactions.controller.status, 'completed');
  const worker = await post(`/api/agents/${agent.id}/compact`, project.id);
  assert.equal(worker.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.store.contextCompactions[agent.id].status, 'completed');
  assert.equal(runtime.store.project.agents.length, originalAgentCount);
  assert.equal(runtime.store.project.controllerThreadId, 'controller-thread');
  assert.equal(agent.threadId, 'agent-thread');
  const run = { id: 'busy-run', agentId: agent.id, status: 'running' };
  agent.currentRunId = run.id;
  runtime.store.project.runs.push(run);
  assert.equal((await post(`/api/agents/${agent.id}/compact`, project.id)).status, 409);
  runtime.store.project.runs.pop();
  assert.equal((await post('/api/agents/unknown/compact', project.id)).status, 404);
});
