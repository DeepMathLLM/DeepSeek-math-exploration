'use strict';
const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const LEGACY_MODEL = 'FW-DeepSeek-V4.1-Flash';
const isDeepSeekV41 = apiModel => /deepseek.*v4[._-]?1/i.test(apiModel);
function fail(message) { const error = new Error(message); error.statusCode = 400; throw error; }
function string(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}
function effort(value, label) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !REASONING_EFFORTS.includes(value)) fail(label + ' 无效');
  return value;
}
function normalizeModelConfig(config = {}) {
  const globalEffort = effort(config.reasoningEffort, 'reasoningEffort');
  const legacy = string(config.model, LEGACY_MODEL);
  const entries = config.models === undefined ? [{ id: legacy, displayName: legacy, apiModel: legacy }] : config.models;
  if (!Array.isArray(entries) || !entries.length) fail('models 必须是非空模型数组');
  const ids = new Set(), apiNames = new Set();
  const models = [];
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('models[' + index + '] 必须是模型对象');
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') fail('模型 enabled 必须为 true 或 false');
    if (entry.enabled === false) continue;
    if (entry.id !== undefined && typeof entry.id !== 'string') fail('模型 id 必须是字符串');
    if (entry.displayName !== undefined && typeof entry.displayName !== 'string') fail('模型 displayName 必须是字符串');
    const apiModel = string(entry.apiModel);
    const id = string(entry.id, apiModel);
    if (!apiModel || apiModel.length > 200 || /[\x00-\x1f]/.test(apiModel)) fail('models[' + index + '].apiModel 必须填写实际部署名');
    if (!id || id.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(id)) fail('模型 id 只能包含字母、数字、点、下划线、短横线和冒号');
    if (ids.has(id) || apiNames.has(apiModel)) fail('模型 id 和 apiModel 均不能重复');
    if (entry.baseUrl || entry.apiKeyEnv || entry.apiKeyFile) fail('模型列表共用顶部 baseUrl 和 Key 配置，请勿在模型条目中填写独立连接参数');
    if (entry.apiMode !== undefined && typeof entry.apiMode !== 'string') fail('模型 apiMode 必须是字符串');
    const apiMode = string(entry.apiMode, 'responses');
    if (!['responses', 'azure-deepseek-pro-hybrid'].includes(apiMode)) fail('模型 apiMode 无效');
    if (entry.webSearch !== undefined && typeof entry.webSearch !== 'boolean') fail('模型 webSearch 必须为 true 或 false');
    if (entry.maxOutputTokens !== undefined && (!Number.isSafeInteger(entry.maxOutputTokens) || entry.maxOutputTokens < 128 || entry.maxOutputTokens > 262144)) fail('模型 maxOutputTokens 必须是 128 到 262144 之间的整数');
    const hybrid = apiMode === 'azure-deepseek-pro-hybrid';
    if (entry.reasoningEffortSupported !== undefined && typeof entry.reasoningEffortSupported !== 'boolean') fail('模型 reasoningEffortSupported 必须为 true 或 false');
    const reasoningEffortSupported = entry.reasoningEffortSupported !== false;
    if (hybrid && !reasoningEffortSupported) fail('混合模式需要启用推理档位配置');
    if (!reasoningEffortSupported && (entry.reasoningEffort || entry.reasoningEfforts?.length)) fail('不支持推理档位的模型应将 reasoningEffort 留空、reasoningEfforts 设为空数组');
    // Resolve the application's configured default to an explicit value.
    // Sending null to turn/start retains the preceding turn's effort.
    const reasoningEffort = reasoningEffortSupported ? effort(entry.reasoningEffort === undefined ? globalEffort : entry.reasoningEffort, '模型 reasoningEffort')
      || (hybrid || isDeepSeekV41(apiModel) ? 'high' : '') : '';
    const reasoningEfforts = !reasoningEffortSupported ? [] : entry.reasoningEfforts === undefined
      ? (hybrid ? ['high', 'max'] : isDeepSeekV41(apiModel) ? ['low', 'medium', 'high'] : [...REASONING_EFFORTS])
      : entry.reasoningEfforts;
    if (!Array.isArray(reasoningEfforts) || reasoningEfforts.some(value => !REASONING_EFFORTS.includes(value))
        || new Set(reasoningEfforts).size !== reasoningEfforts.length) fail('模型 reasoningEfforts 必须是互不重复的推理档位数组');
    if (reasoningEffort && !reasoningEfforts.includes(reasoningEffort)) fail('模型默认推理强度必须包含在 reasoningEfforts 中');
    if (hybrid && reasoningEfforts.some(value => !['high', 'max'].includes(value))) fail('当前混合模式只开放 high、max 档位');
    const displayName = string(entry.displayName, apiModel);
    if (displayName.length > 100) fail('模型 displayName 不能超过 100 字');
    models.push({ id, displayName, apiModel, apiMode, webSearch: entry.webSearch === true, ...(entry.maxOutputTokens ? { maxOutputTokens: entry.maxOutputTokens } : {}), reasoningEffortSupported, reasoningEffort, reasoningEfforts: [...reasoningEfforts], description: string(entry.description) });
    ids.add(id); apiNames.add(apiModel);
  }
  if (!models.length) fail('至少需要启用一个模型');
  if (models.some(model => models.some(other => model !== other && model.id === other.apiModel))) fail('模型 id 不能与另一个模型的 apiModel 冲突');
  const requestedDefault = string(config.defaultModel);
  const selected = requestedDefault
    ? models.find(model => model.id === requestedDefault || model.apiModel === requestedDefault)
    : models.find(model => model.id === legacy || model.apiModel === legacy) || models[0];
  if (!selected) fail('defaultModel 必须指向已启用的模型；请核对 deepmath_default_model 与 deepmath_models 中的 id，并移除重复的旧配置');
  return { models, defaultModel: selected.id };
}
function fromEnvironment(env = process.env) {
  let models;
  let fileConfig = {};
  if (env.deepmath_models_file) {
    const file = require('node:path').resolve(env.deepmath_models_file);
    try {
      fileConfig = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
    } catch (error) { fail('无法读取模型配置文件 ' + file + '：' + error.message); }
    if (!fileConfig || typeof fileConfig !== 'object' || Array.isArray(fileConfig)) fail('模型配置文件必须是包含 models 和 defaultModel 的 JSON 对象');
    models = fileConfig.models;
    if (!Array.isArray(models)) fail('模型配置文件缺少 models 数组');
  }
  if (env.deepmath_models) {
    try { models = JSON.parse(env.deepmath_models); } catch { fail('deepmath_models 不是有效 JSON'); }
  }
  return normalizeModelConfig({ models, model: env.deepmath_model, defaultModel: env.deepmath_default_model || fileConfig.defaultModel,
    reasoningEffort: env.deepmath_reasoning_effort || '' });
}
function findModel(catalog, value) {
  const name = string(value, catalog.defaultModel);
  return catalog.models.find(model => model.id === name || model.apiModel === name);
}
function requireModel(catalog, value) {
  const model = findModel(catalog, value);
  if (!model) fail('所选模型未在服务器配置中启用，请重新选择模型');
  return model;
}
function publicModels(catalog) {
  return catalog.models.map(model => ({
    id: model.id, model: model.id, displayName: model.displayName,
    description: model.description || model.displayName,
    isDefault: model.id === catalog.defaultModel,
    reasoningEffortSupported: model.reasoningEffortSupported,
    defaultReasoningEffort: model.reasoningEffort, supportedReasoningEfforts: [],
    configurableReasoningEfforts: model.reasoningEfforts.map(reasoningEffort => ({ reasoningEffort })),
    reasoningEffortSupportVerified: false,
    reasoningEffortNotice: model.reasoningEffortSupported === false ? '使用模型默认推理，不发送 reasoning.effort。' : '切换后用于下一次请求；Azure 实际可用档位尚未逐档验证。',
    reasoningEffortDetails: model.reasoningEffortSupported === false ? '此部署不接受推理强度参数，使用模型默认行为。' : isDeepSeekV41(model.apiModel)
      ? '此 Azure 连接默认列出 low、medium、high；请求按配置中的实际档位原样发送，不做别名映射或自动降档。'
      : '可提交的请求档位不等于模型已验证支持的档位，实际支持取决于当前部署。'
  }));
}
module.exports = { REASONING_EFFORTS, normalizeModelConfig, fromEnvironment, findModel, requireModel, publicModels };

