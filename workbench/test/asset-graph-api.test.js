const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmath-asset-graph-'));
process.env.deepmath_app_data = path.join(temporaryRoot, 'app-data');
process.env.deepmath_codex_mode = 'simulated';
process.env.deepmath_auth_required = '0';
process.env.deepmath_workspace_root = os.tmpdir();
const { server, registry, closeResearchLibrary } = require('../src/server');
after(async () => {
  for (const runtime of registry.runtimes.values()) { if (runtime.store.saveTimer) clearTimeout(runtime.store.saveTimer); for (const timer of runtime.store.timers.values()) clearTimeout(timer); }
  if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  closeResearchLibrary();
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('graph API returns exact version endpoints and serves the new browser module without altering research records', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let projectId;
  async function post(route, body) {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(projectId ? { 'x-deepmath-project-id': projectId } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  const project = await post('/api/project', { workspacePath: temporaryRoot, name: '研究联系检查' }); projectId = project.data.id;
  const lib = registry.byId(projectId).store.research;
  const a = lib.save('asset', { title: '依据', body_md: '原始内容' }, { project_id: projectId });
  const b = lib.save('asset', { title: '结果', references: [{ asset_id: a.id, revision: 1, relation: 'uses', note: '用于边界估计' }] }, { project_id: projectId });
  lib.save('asset', { id: a.id, title: '已修订依据' }, { expected_revision: 1 });
  const before = lib.db.prepare('SELECT * FROM records ORDER BY id').all();
  const graph = await post('/api/research/graph', { project_id: projectId });
  assert.equal(graph.status, 200); assert.equal(graph.data.nodes.length, 2);
  assert.equal(graph.data.edges[0].source, a.id); assert.equal(graph.data.edges[0].source_revision, 1); assert.equal(graph.data.edges[0].target, b.id);
  const historical = await post('/api/research/graph', { project_id: projectId, asset_id: a.id, revision: 1 });
  assert.equal(historical.status, 200); assert.equal(historical.data.focus.title, '依据'); assert.equal(historical.data.edges.length, 1);
  const allVersions = await post('/api/research/graph', { project_id: projectId, asset_id: a.id, all_versions: true });
  assert.equal(allVersions.status, 200); assert.equal(allVersions.data.focus.revision, null);
  assert.deepEqual(allVersions.data.nodes.find((node) => node.id === a.id).versions, [1, 2]);
  assert.equal(allVersions.data.edges[0].source_revision, 1);
  assert.equal((await post('/api/research/graph', { project_id: 'missing' })).status, 400);
  const moduleResponse = await fetch(base + '/asset-graph.js'); assert.equal(moduleResponse.status, 200); assert.match(await moduleResponse.text(), /function trace\(/);
  assert.deepEqual(lib.db.prepare('SELECT * FROM records ORDER BY id').all(), before);
});
