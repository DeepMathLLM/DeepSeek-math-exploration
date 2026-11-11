'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Azure picker offers request levels without claiming provider verification and preserves default inheritance', () => {
  const elements = {
    '#project-model': { innerHTML: '', value: '', disabled: false },
    '#project-effort': { innerHTML: '', value: '', disabled: true },
    '#reasoning-effort-note': { textContent: '', title: '', classList: { toggle() {} } }
  };
  const context = vm.createContext({ sessionStorage: { getItem: () => '' },
    document: { querySelector: selector => elements[selector] } });
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/\binit\(\);\s*$/, '');
  vm.runInContext(source, context);
  vm.runInContext("state.project = {model:'generic-test-model',reasoningEffort:''}; state.models=[{model:'generic-test-model',isDefault:true,defaultReasoningEffort:'high',supportedReasoningEfforts:[],configurableReasoningEfforts:['none','minimal','low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort})),reasoningEffortNotice:'Azure 实际可用档位尚未验证',reasoningEffortDetails:'兼容档位可能映射'}]; renderModelPicker()", context);
  assert.equal(elements['#project-effort'].disabled, false);
  assert.equal(elements['#project-effort'].value, '');
  assert.match(elements['#project-effort'].innerHTML, /跟随配置（高）/);
  for (const value of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    assert.ok(elements['#project-effort'].innerHTML.includes('value="' + value + '"'));
  }
  assert.equal(elements['#reasoning-effort-note'].textContent, '');
  assert.equal(elements['#reasoning-effort-note'].title, '');
  assert.doesNotMatch(elements['#project-effort'].title + elements['#project-effort'].innerHTML, /尚未验证|兼容档位可能映射/);
  vm.runInContext("state.project.reasoningEffort='xhigh';renderModelPicker()", context);
  assert.equal(elements['#project-effort'].value, 'xhigh');
  vm.runInContext("state.models[0].configurableReasoningEfforts=['none','low','high','max'].map(reasoningEffort=>({reasoningEffort}));renderModelPicker()", context);
  assert.equal(elements['#project-effort'].value, 'xhigh');
  assert.match(elements['#project-effort'].innerHTML, /disabled[^>]*>原档位不可用/);
  assert.match(elements['#reasoning-effort-note'].textContent, /请重新选择/);
  vm.runInContext("state.models[0].reasoningEffortSupported=false;state.models[0].defaultReasoningEffort='';state.models[0].configurableReasoningEfforts=[];renderModelPicker()", context);
  assert.equal(elements['#project-effort'].value, '');
  assert.equal(elements['#project-effort'].disabled, true);
  assert.match(elements['#project-effort'].innerHTML, /推理：模型默认/);
  assert.doesNotMatch(elements['#project-effort'].innerHTML, /xhigh|原档位不可用/);
  assert.equal(elements['#reasoning-effort-note'].textContent, '');
  vm.runInContext("state.project=null;renderModelPicker()", context);
  assert.equal(elements['#project-effort'].disabled, true);
});

