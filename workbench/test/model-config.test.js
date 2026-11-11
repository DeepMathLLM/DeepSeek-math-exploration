'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeModelConfig, findModel, requireModel, publicModels } = require('../src/model-config');

test('model mappings separate display names from API deployments and retain the legacy format', () => {
  const legacy = normalizeModelConfig({ model: 'old-deployment', reasoningEffort: 'high' });
  assert.equal(requireModel(legacy, '').apiModel, 'old-deployment');
  const catalog = normalizeModelConfig({ defaultModel: 'fast', models: [
    { id: 'research', displayName: '研究模型', apiModel: 'AZURE_RESEARCH_PRIVATE', reasoningEffort: 'high' },
    { id: 'fast', displayName: '快速模型', apiModel: 'AZURE_FAST_PRIVATE', reasoningEffort: 'low', reasoningEfforts: ['low', 'high'] },
    { id: 'unused', enabled: false }
  ] });
  assert.equal(requireModel(catalog, '').id, 'fast');
  assert.equal(findModel(catalog, 'AZURE_RESEARCH_PRIVATE').id, 'research');
  assert.equal(requireModel(catalog, 'fast').reasoningEffort, 'low');
  assert.throws(() => requireModel(catalog, 'unconfigured'), { statusCode: 400 });
  const visible = publicModels(catalog);
  assert.deepEqual(visible.map(model => model.displayName), ['研究模型', '快速模型']);
  assert.deepEqual(visible.map(model => model.model), ['research', 'fast']);
  assert.doesNotMatch(JSON.stringify(visible), /AZURE_RESEARCH_PRIVATE|AZURE_FAST_PRIVATE/);
  assert.deepEqual(visible[1].configurableReasoningEfforts.map(item => item.reasoningEffort), ['low', 'high']);
});

test('invalid, ambiguous or disabled model selections fail before making a request', () => {
  for (const config of [
    { models: [] },
    { models: [{ enabled: false }] },
    { models: [{ id: 'same', apiModel: 'a' }, { id: 'same', apiModel: 'b' }] },
    { models: [{ id: 'a', apiModel: 'same' }, { id: 'b', apiModel: 'same' }] },
    { defaultModel: 'missing', models: [{ id: 'a', apiModel: 'a' }] },
    { models: [{ id: 'a', apiModel: 'b' }, { id: 'b', apiModel: 'c' }] },
    { models: [{ id: 'a', apiModel: 'a', reasoningEffort: 'max', reasoningEfforts: ['low'] }] },
    { models: [{ id: 'a', apiModel: 'a', baseUrl: 'https://unintended.example' }] }
  ]) assert.throws(() => normalizeModelConfig(config));
});

test('Azure DeepSeek V4.1 request options follow the deployed gateway instead of vendor aliases', () => {
  for (const model of ['FW-DeepSeek-V4.1-Flash', 'FW-DeepSeek-V4.1-Flash-1']) {
    const catalog = normalizeModelConfig({ model });
    assert.deepEqual(catalog.models[0].reasoningEfforts, ['low', 'medium', 'high']);
    assert.equal(catalog.models[0].reasoningEffort, 'high');
    assert.equal(normalizeModelConfig({ model, reasoningEffort: '' }).models[0].reasoningEffort, 'high');
    assert.match(publicModels(catalog)[0].reasoningEffortDetails, /不做别名映射或自动降档/);
  }
});

test('a deployment without effort support ignores global defaults and exposes only model default', () => {
  const catalog = normalizeModelConfig({ reasoningEffort: 'high', models: [
    { id: 'pro', apiModel: 'DeepSeek-V4-Pro', reasoningEffortSupported: false, reasoningEffort: '', reasoningEfforts: [] }
  ] });
  assert.equal(catalog.models[0].reasoningEffort, '');
  assert.deepEqual(catalog.models[0].reasoningEfforts, []);
  const visible = publicModels(catalog)[0];
  assert.equal(visible.reasoningEffortSupported, false);
  assert.equal(visible.defaultReasoningEffort, '');
  assert.deepEqual(visible.configurableReasoningEfforts, []);
  for (const entry of [
    { reasoningEffortSupported: 'false' },
    { reasoningEffortSupported: false, reasoningEffort: 'none' },
    { reasoningEffortSupported: false, reasoningEfforts: ['high'] }
  ]) assert.throws(() => normalizeModelConfig({ models: [{ id: 'pro', apiModel: 'DeepSeek-V4-Pro', ...entry }] }));
});

