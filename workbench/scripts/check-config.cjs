'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fromEnvironment } = require('../src/model-config');
const { resolveCodexLaunch } = require('../src/codex-launch');
const { loadSettings } = require('../src/model-request-scheduler');

try {
  const catalog = fromEnvironment();
  loadSettings();
  const baseUrl = new URL(process.env.deepmath_model_base_url || '');
  if (baseUrl.protocol !== 'https:' || baseUrl.hostname.includes('your-resource')) throw new Error('请在 .env 中填写真实的 HTTPS 模型接口地址');
  const key = process.env.AZURE_OPENAI_API_KEY;
  if (!key || /^replace/i.test(key)) throw new Error('请在 .env 中填写 AZURE_OPENAI_API_KEY');
  if (catalog.models.some(model => /^replace-with-/i.test(model.apiModel))) throw new Error('请在 models.config.json 中填写实际部署名');
  const launch = resolveCodexLaunch();
  for (const folder of [process.env.deepmath_app_data || './data', process.env.deepmath_workspace_root || './workspace']) {
    fs.mkdirSync(path.resolve(folder), { recursive: true, mode: 0o700 });
    fs.accessSync(path.resolve(folder), fs.constants.R_OK | fs.constants.W_OK);
  }
  console.log(`模型配置有效，共 ${catalog.models.length} 个模型，默认 ${catalog.defaultModel}`);
  console.log(`本机 Codex CLI 已找到，来源 ${launch.source}`);
  console.log('配置检查通过，可以运行 npm start。此检查没有发送模型请求。');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
