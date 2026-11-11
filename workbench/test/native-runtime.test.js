const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtime = require('../src/agent-runtime');
const models = require('../src/model-config');
const { loadSettings } = require('../src/model-request-scheduler');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmath-native-runtime-'));
const previous = new Map();
function setEnv(name, value) {
  if (!previous.has(name)) previous.set(name, process.env[name]);
  process.env[name] = value;
}
after(() => {
  runtime.close();
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('model catalog loads readable JSON, keeps explicit overrides and rejects invalid files', () => {
  const file = path.join(temporary, 'models.json');
  fs.writeFileSync(file, JSON.stringify({ defaultModel: 'fast', models: [{ id: 'fast', apiModel: 'fixture-fast' }] }));
  assert.equal(models.fromEnvironment({ deepmath_models_file: file }).defaultModel, 'fast');
  const override = [{ id: 'override', apiModel: 'fixture-override' }];
  assert.equal(models.fromEnvironment({ deepmath_models_file: file, deepmath_models: JSON.stringify(override), deepmath_default_model: 'override' }).defaultModel, 'override');
  fs.writeFileSync(file, '{"models":false}');
  assert.throws(() => models.fromEnvironment({ deepmath_models_file: file }), /models 数组/);
});

test('model JSON optionally carries scheduling limits while ordinary setup uses defaults', () => {
  assert.equal(loadSettings({}).defaults.maxConcurrent, 8);
  const file = path.join(temporary, 'models-and-scheduler.json');
  const catalog = { defaultModel: 'fast', models: [{ id: 'fast', apiModel: 'fixture-fast' }] };
  const save = () => fs.writeFileSync(file, JSON.stringify(catalog));
  const env = { deepmath_models_file: file };
  save();
  assert.equal(loadSettings(env).defaults.maxConcurrent, 8);
  catalog.scheduler = { defaults: { maxConcurrent: 3 }, models: { 'fixture-fast': { tpm: 100000, rpm: 60, utilization: 0.8 } } };
  save();
  const settings = loadSettings(env);
  assert.equal(settings.defaults.maxConcurrent, 3);
  assert.equal(settings.models['fixture-fast'].tpm, 100000);
  assert.equal(models.fromEnvironment(env).defaultModel, 'fast');
  assert.equal(loadSettings({ ...env, deepmath_model_limits: '{"defaults":{"maxConcurrent":2}}' }).defaults.maxConcurrent, 2);
  catalog.scheduler = { defaults: { maxConcurrent: 0 } };
  save();
  assert.throws(() => loadSettings(env), /Invalid model scheduler limit/);
  catalog.scheduler = null;
  save();
  assert.throws(() => loadSettings(env), /Invalid model scheduler configuration/);
});

test('native projects use independent Codex homes and proxy tokens without a container command', async () => {
  setEnv('AZURE_OPENAI_API_KEY', 'SYNTHETIC_KEY_FOR_NATIVE_CHECK_ONLY');
  setEnv('deepmath_model_base_url', 'https://example.invalid/v1');
  setEnv('deepmath_model_proxy_host', '127.0.0.1');
  setEnv('deepmath_model_proxy_port', '0');
  setEnv('deepmath_models', JSON.stringify([{ id: 'fixture', apiModel: 'fixture-model', reasoningEffortSupported: false, reasoningEffort: '', reasoningEfforts: [] }]));
  setEnv('deepmath_default_model', 'fixture');
  const contexts = ['one', 'two'].map(name => ({ workspace: path.join(temporary, name), codexHome: path.join(temporary, name + '-sessions') }));
  for (const context of contexts) fs.mkdirSync(context.workspace);
  const executable = { command: process.execPath, executable: process.execPath, args: ['app-server'], source: 'test-native' };
  const launches = await Promise.all(contexts.map(context => runtime.prepareRuntime(context, executable)));
  assert.notEqual(launches[0].env.CODEX_HOME, launches[1].env.CODEX_HOME);
  assert.notEqual(launches[0].env.deepmath_agent_token, launches[1].env.deepmath_agent_token);
  for (const [index, launch] of launches.entries()) {
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.args, ['app-server']);
    assert.equal(launch.env.CODEX_HOME, contexts[index].codexHome);
    assert.equal(launch.env.AZURE_OPENAI_API_KEY, undefined);
    const config = fs.readFileSync(path.join(launch.env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.match(config, /http:\/\/127\.0\.0\.1:\d+\/v1/);
    assert.doesNotMatch(config, /SYNTHETIC_KEY|host\.docker/);
  }
  const broker = runtime.getBroker();
  const first = launches[0].env.deepmath_agent_token, second = launches[1].env.deepmath_agent_token;
  assert.ok(broker.tokens.has(first) && broker.tokens.has(second));
  launches[0].dispose();
  assert.equal(broker.tokens.has(first), false); assert.equal(broker.tokens.has(second), true);
  launches[1].dispose();
});

