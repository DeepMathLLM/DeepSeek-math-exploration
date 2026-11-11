const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmath-v2-multiproject-'));
process.env.deepmath_app_data = path.join(temporaryRoot, 'app-data');
process.env.deepmath_codex_mode = 'simulated';
process.env.deepmath_auth_required = '0';
process.env.deepmath_workspace_root = os.tmpdir();
const { registry, server, ProjectRuntimeRegistry, ProjectStore, closeResearchLibrary } = require('../src/server');

after(async () => {
  for (const runtime of registry.runtimes.values()) {
    if (runtime.manager.controllerReviewTimer) clearTimeout(runtime.manager.controllerReviewTimer);
    for (const timer of runtime.store.timers.values()) clearTimeout(timer);
  }
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  const target = path.resolve(temporaryRoot);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('deepmath-v2-multiproject-')) {
    throw new Error('Refusing to remove an unexpected test directory');
  }
  closeResearchLibrary();
  fs.rmSync(target, { recursive: true, force: true });
});

function workspace(name) {
  const directory = path.join(temporaryRoot, name);
  fs.mkdirSync(directory);
  return directory;
}

test('projects run independently and API, Codex tools, and events remain project-scoped', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, projectId = '', body) {
    const response = await fetch(`${base}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(projectId ? { 'x-deepmath-project-id': projectId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  }

  assert.equal(registry.runtimes.size, 0);
  const emptyStartup = new ProjectRuntimeRegistry();
  emptyStartup.restore();
  assert.equal(emptyStartup.selected(), null);
  assert.equal(emptyStartup.runtimes.size, 0);
  assert.deepEqual((await request('/api/projects')).body.projects, []);
  assert.equal((await request('/api/project')).body, null);
  assert.equal((await request('/api/automation')).status, 400);

  const first = (await request('/api/project', '', { workspacePath: workspace('first'), name: 'First' })).body;
  assert.equal(first.automation.state, 'paused');
  assert.equal(registry.runtimes.size, 1);
  assert.equal((await request('/api/automation', first.id, { state: 'running', goal: 'First goal' })).body.automation.state, 'running');
  const second = (await request('/api/project', first.id, { workspacePath: workspace('second'), name: 'Second' })).body;
  assert.notEqual(first.id, second.id);
  assert.equal(registry.runtimes.size, 2);
  assert.notEqual(registry.byId(first.id).store.runtimeDir, registry.byId(second.id).store.runtimeDir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(registry.byId(first.id).store.runtimeDir, 'state.json'), 'utf8')).id, first.id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(registry.byId(second.id).store.runtimeDir, 'state.json'), 'utf8')).id, second.id);
  assert.equal((await request('/api/automation', first.id)).body.automation.state, 'running');
  assert.equal((await request('/api/automation', second.id)).body.automation.state, 'paused');
  assert.equal((await request('/api/automation')).status, 400);
  const conflicting = await fetch(`${base}/api/automation?projectId=${second.id}`, {
    headers: { 'x-deepmath-project-id': first.id }
  });
  assert.equal(conflicting.status, 400);
  assert.equal((await request('/api/project', first.id)).body.name, 'First');
  assert.equal((await request('/api/project', second.id)).body.name, 'Second');

  const projects = (await request('/api/projects')).body.projects;
  assert.equal(projects.find((project) => project.id === first.id).automationState, 'running');
  assert.equal(projects.find((project) => project.id === second.id).automationState, 'paused');

  await request('/api/automation', first.id, { state: 'paused' });
  registry.byId(first.id).manager.pauseAutomaticReview();
  const firstAgent = (await request('/api/agents', first.id, { displayName: 'First Agent', researchContent: 'First task', skills: ['Analysis'] })).body.agent;
  const secondAgent = (await request('/api/agents', second.id, { displayName: 'Second Agent', researchContent: 'Second task', skills: ['Analysis'] })).body.agent;
  assert.equal((await request(`/api/agents/${firstAgent.id}/status`, second.id)).status, 404);

  const firstRun = (await request(`/api/agents/${firstAgent.id}/run`, first.id, { prompt: 'Work in first project' })).body.run;
  const concurrent = await request(`/api/agents/${secondAgent.id}/run`, second.id, { prompt: 'Work in second project' });
  assert.equal(concurrent.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  const firstRuntime = registry.byId(first.id);
  const secondRuntime = registry.byId(second.id);
  const liveFirst = firstRuntime.store.project.runs.find((run) => run.id === firstRun.id);
  const liveSecond = secondRuntime.store.project.runs.find((run) => run.id === concurrent.body.run.id);
  assert.notEqual(firstRuntime.codex, secondRuntime.codex);
  assert.ok(liveFirst.turnId);
  assert.ok(liveSecond.turnId);

  firstRuntime.codex.emit('turn.delta', { threadId: liveFirst.threadId, turnId: liveFirst.turnId, delta: 'First project output' });
  assert.match(liveFirst.finalOutput, /First project output/);
  assert.doesNotMatch(liveSecond.finalOutput, /First project output/);
  secondRuntime.codex.emit('turn.delta', { threadId: liveFirst.threadId, turnId: 'not-a-second-project-turn', delta: 'Wrong-thread output' });
  assert.doesNotMatch(liveSecond.finalOutput, /Wrong-thread output/);
  const progress = await firstRuntime.codex.toolExecutor({ name: 'submit_report', arguments: { summary: 'First project progress', body_md: 'Detailed original work in first project', phase: 'checkpoint' }, threadId: liveFirst.threadId, turnId: liveFirst.turnId });
  assert.equal(firstRuntime.store.research.get(progress.report_id).run_id, liveFirst.id);
  assert.equal(firstRuntime.store.project.progress.length, 1);
  assert.equal(secondRuntime.store.project.progress.length, 0);

  firstRuntime.manager.stop(firstRuntime.store.getAgent(firstAgent.id));
  await Promise.all(firstRuntime.manager.agentStopBarriers.values());
  assert.equal(liveSecond.status, 'running');
  secondRuntime.manager.stop(secondRuntime.store.getAgent(secondAgent.id));
  await Promise.all(secondRuntime.manager.agentStopBarriers.values());
  const secondRun = (await request(`/api/agents/${secondAgent.id}/run`, second.id, { prompt: 'Work in second project after stop' })).body.run;
  assert.ok(secondRun);
  secondRuntime.manager.stop(secondRuntime.store.getAgent(secondAgent.id));
  await Promise.all(secondRuntime.manager.agentStopBarriers.values());

  const firstEventsAbort = new AbortController();
  const secondEventsAbort = new AbortController();
  const firstEvents = (await fetch(`${base}/api/events?projectId=${first.id}`, { signal: firstEventsAbort.signal })).body.getReader();
  const secondEvents = (await fetch(`${base}/api/events?projectId=${second.id}`, { signal: secondEventsAbort.signal })).body.getReader();
  await firstEvents.read();
  await secondEvents.read();
  secondRuntime.store.addActivity('Only the second project changed');
  const secondUpdate = new TextDecoder().decode((await secondEvents.read()).value);
  assert.match(secondUpdate, /Only the second project changed/);
  const firstUpdate = await Promise.race([
    firstEvents.read().then(() => 'unexpected event'),
    new Promise((resolve) => setTimeout(() => resolve('no event'), 80))
  ]);
  assert.equal(firstUpdate, 'no event');
  firstEventsAbort.abort();
  secondEventsAbort.abort();

  // Independent projects can run automatic Controller reviews concurrently.
  firstRuntime.store.setAutomation({ state: 'running', goal: 'First goal' });
  secondRuntime.store.setAutomation({ state: 'running', goal: 'Second goal' });
  firstRuntime.manager.startControllerRun = () => {};
  secondRuntime.manager.startControllerRun = () => {};
  const firstReview = await firstRuntime.manager.startAutomaticReview({ initial: true });
  const secondReview = await secondRuntime.manager.startAutomaticReview({ initial: true });
  assert.equal(firstReview.status, 'running');
  assert.equal(secondReview.status, 'running');
  firstRuntime.manager.stopController(firstReview);
  firstRuntime.store.setAutomation({ state: 'paused' });
  await Promise.all([firstRuntime.manager.controllerStopBarrier].filter(Boolean));
  assert.equal(secondReview.status, 'running');
  secondRuntime.manager.stopController(secondReview);
  await Promise.all([secondRuntime.manager.controllerStopBarrier].filter(Boolean));
  secondRuntime.store.setAutomation({ state: 'running', goal: 'Resume second goal' });
  const recovered = new ProjectRuntimeRegistry();
  recovered.restore();
  assert.equal(recovered.selected().id, second.id);
  assert.equal(recovered.byId(first.id).store.project.automation.state, 'paused');
  assert.equal(recovered.byId(second.id).store.project.automation.state, 'running');
  for (const runtime of recovered.runtimes.values()) {
    if (runtime.manager.controllerReviewTimer) clearTimeout(runtime.manager.controllerReviewTimer);
  }
  firstRuntime.store.setAutomation({ state: 'paused' });
  secondRuntime.store.setAutomation({ state: 'paused' });
});

test('a copied state file with another project identity cannot be opened', () => {
  const directory = workspace('mismatched-state');
  const original = new ProjectStore();
  original.load(directory, 'Mismatched state');
  const stateFile = path.join(original.runtimeDir, 'state.json');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  saved.id = registry.selected().id;
  fs.writeFileSync(stateFile, JSON.stringify(saved));
  assert.throws(() => new ProjectStore().load(directory), /Project state identity does not match/);
});

test('saving a research asset preserves UTF-8 when HTTP chunks split a character', async () => {
  const current = registry.selected(), body_md = '中文数学结论𝛼：'.repeat(12000);
  const bytes = Buffer.from(JSON.stringify({ name: 'save_asset', arguments: { title: 'Unicode transport check', body_md } }));
  const split = bytes.indexOf(Buffer.from('中文')) + 1;
  const saved = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/research/tools', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-deepmath-project-id': current.id } }, (res) => {
      res.setEncoding('utf8'); let response = '';
      res.on('data', (chunk) => { response += chunk; });
      res.on('end', () => { try { assert.equal(res.statusCode, 200); resolve(JSON.parse(response)); } catch (error) { reject(error); } });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(bytes.subarray(0, split));
    setTimeout(() => req.end(bytes.subarray(split)), 20);
  });
  assert.equal(current.store.research.get(saved.record.id).body_md, body_md);
});
