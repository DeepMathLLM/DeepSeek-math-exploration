'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmath-open-source-check-'));
process.env.deepmath_codex_mode = 'simulated';
process.env.deepmath_app_data = path.join(temporary, 'data');
process.env.deepmath_workspace_root = path.join(temporary, 'workspace');
process.env.deepmath_model = 'deepseek-flash';
process.env.deepmath_default_model = 'deepseek-flash';
process.env.deepmath_models = JSON.stringify([{ id: 'deepseek-flash', displayName: 'DeepSeek Flash', apiModel: 'FW-DeepSeek-V4.1-Flash', reasoningEffort: 'high', reasoningEfforts: ['low', 'medium', 'high'], maxOutputTokens: 262144 }]);

const { server, registry, closeResearchLibrary } = require('../src/server');

async function request(base, route, body) {
  const response = await fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await request(base, '/api/health');
  if (health.status !== 200 || health.body.limits.maxProjects !== null || health.body.limits.maxAgentsPerProject !== null) throw new Error('Open-source limit policy is not active');
  const config = await request(base, '/api/model-config');
  if (config.status !== 200 || config.body.models.length !== 1 || config.body.models[0].id !== 'deepseek-flash') throw new Error('Model configuration endpoint is not using the configured model');
  if (config.body.models[0].apiModel !== 'FW-DeepSeek-V4.1-Flash' || config.body.models[0].maxOutputTokens !== 262144) throw new Error('Model details are missing');
  if (Object.keys(config.body).some(key => /key|password|secret/i.test(key))) throw new Error('Model configuration response exposes a credential field');
  const projects = [];
  for (let index = 0; index < 21; index++) {
    const result = await request(base, '/api/project', { name: `open-source-project-${index}` });
    if (result.status !== 200) throw new Error(`Project creation failed at ${index}`);
    projects.push(result.body);
  }
  for (let index = 0; index < 6; index++) {
    const result = await request(base, `/api/agents?projectId=${encodeURIComponent(projects[0].id)}`, { displayName: `Open Agent ${index}`, researchContent: 'Open-source smoke check' });
    if (result.status !== 201) throw new Error(`Agent creation failed at ${index}`);
  }
  const releaseFirst = registry.reserveRun(projects[0].id);
  const releaseSecond = registry.reserveRun(projects[1].id);
  releaseFirst(); releaseSecond();
  console.log(JSON.stringify({ loginRequired: false, limits: health.body.limits, projects: projects.length, agents: 6, model: config.body.defaultModel, modelCalls: 0 }, null, 2));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  closeResearchLibrary();
  fs.rmSync(temporary, { recursive: true, force: true });
})().catch(error => {
  console.error(error.stack);
  try { server.closeAllConnections(); server.close(); closeResearchLibrary(); } catch {}
  process.exitCode = 1;
});
