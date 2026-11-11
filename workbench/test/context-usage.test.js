'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function fixture() {
  const context = vm.createContext({ sessionStorage: { getItem: () => '' } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/\binit\(\);\s*$/, ''), context);
  return context;
}
test('context percentage uses the latest prompt and output, without adding cumulative, cached or reasoning tokens twice', () => {
  const context = fixture();
  const metrics = vm.runInContext('contextUsageMetrics', context);
  assert.deepEqual(JSON.parse(JSON.stringify(metrics({ total: { totalTokens: 9000000 }, last: { totalTokens: 348000, inputTokens: 347000, cachedInputTokens: 200000, outputTokens: 1000, reasoningOutputTokens: 500 }, modelContextWindow: 475000 }))), { used: 348000, limit: 475000, percent: 73 });
  assert.equal(metrics({ last: { inputTokens: 200, outputTokens: 50, reasoningOutputTokens: 20 }, modelContextWindow: 1000 }).used, 250);
  assert.equal(metrics({ total: { totalTokens: 9000000 }, modelContextWindow: 475000 }).percent, null);
  assert.equal(metrics({ last: { totalTokens: 200 } }).percent, null);
  assert.equal(metrics({ last: { totalTokens: 200 }, modelContextWindow: 0 }).percent, null);
});
test('the context indicator follows the selected Agent, thread and model and avoids stale values after compaction', () => {
  const context = fixture();
  vm.runInContext(`state.project = {model:'research',controllerThreadId:'controller',agents:[{id:'a',displayName:'边界检验',threadId:'thread-a'}],runs:[],contextUsage:{controller:{threadId:'controller',model:'research',tokenUsage:{last:{totalTokens:348000},modelContextWindow:475000}},a:{threadId:'thread-a',model:'research',tokenUsage:{last:{totalTokens:20000},modelContextWindow:200000}}}}`, context);
  const current = vm.runInContext('currentContextUsage', context);
  assert.equal(current().percent, 73);
  vm.runInContext("state.selectedAgentId='a'", context);
  assert.equal(current().name, '边界检验');
  assert.equal(current().percent, 10);
  vm.runInContext("state.project.contextUsage.a={threadId:'thread-a',model:'research',tokenUsage:null,status:'awaiting-usage'}", context);
  assert.equal(current().used, null);
  vm.runInContext("state.project.agents[0].threadId='new-thread';state.project.runs=[{agentId:'a',threadId:'old-thread',tokenUsage:{last:{totalTokens:100},modelContextWindow:200}}]", context);
  assert.equal(current().percent, null);
  vm.runInContext("state.selectedAgentId=null;state.project.model='different-model'", context);
  assert.equal(current().percent, null);
});

test('128K total and native usable capacity remain distinct; oversized usage is displayed without clamping the reported percentage', () => {
  const context = fixture(), metrics = vm.runInContext('contextUsageMetrics', context);
  const value = JSON.parse(JSON.stringify(metrics({ last: { totalTokens: 180000 }, modelContextWindow: 121600, configuredContextWindow: 128000 })));
  assert.deepEqual(value, { used: 180000, limit: 121600, percent: 148, configuredWindow: 128000 });
  const nodes = {};
  for (const id of ['context-meter', 'context-meter-button', 'context-meter-value', 'context-meter-tooltip']) nodes['#' + id] = {
    classList: { toggle() {} }, style: { setProperty() {} }, setAttribute() {}
  };
  context.document = { querySelector: selector => nodes[selector] };
  vm.runInContext(`state.project={model:'flash',controllerThreadId:'thread',agents:[],runs:[],contextUsage:{controller:{threadId:'thread',model:'flash',status:'preparing',tokenUsage:{last:{totalTokens:180000},modelContextWindow:121600,configuredContextWindow:128000}}}};renderContextUsage();`, context);
  assert.equal(nodes['#context-meter-value'].textContent, '148%');
  assert.match(nodes['#context-meter-tooltip'].innerHTML, /正在整理上下文/);
  assert.match(nodes['#context-meter-tooltip'].innerHTML, /窗口 128k，运行器可用 121.6k/);
  assert.match(nodes['#context-meter-tooltip'].innerHTML, /已用 180k/);
});


test('a confirmed idle window displays 128K without inventing a new percentage before inference', () => {
  const context=fixture(),nodes={};
  for (const id of ['context-meter','context-meter-button','context-meter-value','context-meter-tooltip']) nodes['#'+id]={classList:{toggle(){}},style:{setProperty(){}},setAttribute(){}};
  context.document={querySelector:selector=>nodes[selector]};
  vm.runInContext(`state.project={model:'flash',controllerThreadId:'thread',agents:[],runs:[],contextUsage:{controller:{threadId:'thread',model:'flash',status:'awaiting-window-usage',tokenUsage:{last:{totalTokens:23500},modelContextWindow:null,configuredContextWindow:128000}}}};renderContextUsage();`,context);
  assert.equal(nodes['#context-meter-value'].textContent,'128k');
  assert.match(nodes['#context-meter-tooltip'].innerHTML,/窗口已生效/);
  assert.match(nodes['#context-meter-tooltip'].innerHTML,/上轮用量 23.5k/);
  assert.doesNotMatch(nodes['#context-meter-tooltip'].innerHTML,/258.4k|9%/);
});
