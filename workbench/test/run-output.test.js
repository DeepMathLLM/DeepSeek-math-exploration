'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmath-output-'));
process.env.deepmath_app_data = path.join(root, 'data');
process.env.deepmath_codex_mode = 'simulated';
const { ProjectStore, CodexClient, AgentManager } = require('../src/server');
const output = require('../src/run-output');
const stores = [];
after(() => {
  for (const store of stores) if (store.saveTimer) clearTimeout(store.saveTimer);
  assert.equal(path.dirname(root), os.tmpdir());
  fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const store = new ProjectStore();
  store.runtimeDir = fs.mkdtempSync(path.join(root, 'state-'));
  const run = { id: 'run-proof', agentId: null, threadId: 'thread-proof', turnId: 'turn-proof', status: 'running', events: [], finalOutput: '' };
  store.project = { id: 'proof', name: 'Output proof', runs: [run], agents: [], progress: [], activity: [], automation: { state: 'paused' } };
  stores.push(store);
  const codex = new CodexClient();
  const manager = new AgentManager(store, codex);
  const notify = (method, params) => codex.handleMessage({ method, params: { threadId: run.threadId, turnId: run.turnId, ...params } });
  return { store, run, codex, manager, notify };
}
test('runtime preserves ordered text, provider reasoning and complete command output through persistence', () => {
  const { run, store, notify } = fixture();
  notify('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: '检查边界条件。' });
  notify('item/agentMessage/delta', { itemId: 'm1', delta: '阶段说明。' });
  notify('item/completed', { item: { id: 'm1', type: 'agentMessage', phase: 'commentary', text: '校正后的阶段说明。' } });
  const longOutput = '完整命令输出α\n'.repeat(10000) + 'END_OF_COMMAND';
  notify('item/commandExecution/outputDelta', { itemId: 'command', delta: longOutput });
  notify('item/completed', { item: { id: 'command', type: 'commandExecution', command: 'synthetic check', aggregatedOutput: longOutput, exitCode: 0 } });
  notify('item/agentMessage/delta', { itemId: 'm2', delta: '最终结论。' });
  notify('item/completed', { item: { id: 'm2', type: 'agentMessage', phase: 'final_answer', text: '最终结论。' } });
  assert.equal(run.finalOutput, '校正后的阶段说明。\n\n最终结论。');
  assert.deepEqual(run.outputItems.map((item) => item.id), ['r', 'm1', 'command', 'm2']);
  assert.equal(run.outputItems[0].data.summary[0], '检查边界条件。');
  assert.equal(run.outputItems[2].data.aggregatedOutput, longOutput);
  store.save();
  const saved = JSON.parse(fs.readFileSync(path.join(store.runtimeDir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.runs[0].outputItems, run.outputItems);
});
test('reused message ids add a readable boundary after a tool call', () => {
  const run = { id: 'boundary', outputItems: [], finalOutput: '' };
  output.recordText(run, { itemId: 'message', delta: '工具前的说明' });
  output.recordTool(run, { callId: 'tool', tool: 'read_asset', arguments: {} });
  output.recordText(run, { itemId: 'message', delta: '工具后的结论' });
  assert.equal(run.outputItems[0].data.text, '工具前的说明\n\n工具后的结论');
  assert.equal(run.finalOutput, '工具前的说明\n\n工具后的结论');
});
test('dynamic tool arguments and actual success or failure payloads are retained', async () => {
  const { run, codex } = fixture();
  codex.toolExecutor = async () => ({ proof: '工具返回的完整证明', tail: 'END_OF_TOOL' });
  codex.respond = () => {};
  await codex.handleServerRequest({ id: 1, method: 'item/tool/call', params: { threadId: run.threadId, turnId: run.turnId, callId: 'c', tool: 'read_asset', arguments: { asset_id: 'A000001' } } });
  assert.equal(run.outputItems.length, 1);
  assert.equal(run.outputItems[0].data.arguments.asset_id, 'A000001');
  assert.match(run.outputItems[0].data.contentItems[0].text, /END_OF_TOOL/);
  codex.toolExecutor = async () => { throw new Error('有证据的工具错误'); };
  await codex.handleServerRequest({ id: 2, method: 'item/tool/call', params: { threadId: run.threadId, turnId: run.turnId, callId: 'c2', tool: 'read_asset', arguments: {} } });
  assert.equal(run.outputItems[1].status, 'failed');
  assert.match(run.outputItems[1].data.contentItems[0].text, /有证据的工具错误/);
});
test('completed snapshots recover missing text and retry errors never erase partial output', () => {
  const { run, notify } = fixture();
  notify('item/agentMessage/delta', { itemId: 'partial', delta: '已有部分结果' });
  notify('error', { willRetry: true, error: { message: 'retry 1' } });
  assert.equal(run.status, 'running');
  notify('error', { willRetry: false, error: { message: 'actual failure' } });
  assert.match(run.finalOutput, /已有部分结果/);
  assert.match(run.finalOutput, /actual failure/);
  assert.equal(run.outputItems.filter((item) => item.type === 'error').length, 2);
  const next = fixture();
  next.notify('turn/completed', { turn: { id: 'turn-proof', status: 'completed', items: [{ id: 'only-final', type: 'agentMessage', text: '快照恢复的结论' }] } });
  assert.equal(next.run.finalOutput, '快照恢复的结论');
});
test('the frontend preserves model paragraphs and omits all tool blocks, names and payloads', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/\binit\(\);\s*$/, '');
  const context = vm.createContext({ sessionStorage: { getItem: () => '' } });
  vm.runInContext(source, context);
  const render = vm.runInContext('renderRunOutput', context);
  const copyValue = vm.runInContext('runCopyText', context);
  const run = { id: 'x', status: 'completed', finalOutput: 'END_OF_REPLY' };
  output.recordItem(run, { method: 'item/completed', item: { id: 'm', type: 'agentMessage', text: '<script>attack()</script> END_OF_REPLY' } });
  output.recordItem(run, { method: 'item/completed', item: { id: 't', type: 'dynamicToolCall', tool: 'read_asset', arguments: { name: 'PROOF_ARGUMENT' }, contentItems: [{ type: 'inputText', text: 'x'.repeat(50000) + 'END_OF_TOOL' }] } });
  output.recordItem(run, { method: 'item/completed', item: { id: 'cmd', type: 'commandExecution', command: 'PRIVATE_COMMAND', aggregatedOutput: 'PRIVATE_STDOUT' } });
  output.recordItem(run, { method: 'item/completed', item: { id: 'file', type: 'fileChange', changes: [{ diff: 'PRIVATE_DIFF' }] } });
  const html = render(run);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>attack/);
  assert.match(html, /END_OF_REPLY/);
  assert.doesNotMatch(html, /END_OF_TOOL|PROOF_ARGUMENT|PRIVATE_COMMAND|PRIVATE_STDOUT|PRIVATE_DIFF/);
  assert.doesNotMatch(html, /runtime-tool-call|read_asset|终端|工具调用/);
  assert.match(render({ id: 'line-breaks', status: 'completed', finalOutput: '第一行\n第二行\n\n第三段' }), /第一行<br>第二行/);
  const sequenced = render({ id: 'sequence', status: 'completed', outputItems: [
    { id: 'before', type: 'agentMessage', data: { text: '工具前的说明' } },
    { id: 'tool', type: 'dynamicToolCall', status: 'completed', data: { tool: 'read_asset' } },
    { id: 'after', type: 'agentMessage', data: { text: '工具后的结论' } }
  ] });
  assert.match(sequenced, /工具前的说明[\s\S]*runtime-response-text[\s\S]*工具后的结论/);
  assert.doesNotMatch(render({ ...run, status: 'running' }), /复制回复|runtime-output-actions/);
  for (const status of ['completed', 'failed', 'interrupted']) {
    assert.match(render({ ...run, status }), /复制回复/);
    assert.doesNotMatch(render({ id: 'empty', status, outputItems: [], finalOutput: '' }), /复制回复|runtime-output-actions/);
  }
  assert.doesNotMatch(render({ ...run, status: 'queued' }), /复制回复/);
  assert.equal(copyValue({ outputItems: [{ type: 'agentMessage', data: { text: '第一段\n第二段' } }] }), '第一段\n第二段');
  assert.doesNotMatch(html, /data-tool-disclosure="[^"]*" open/);
  assert.doesNotMatch(html, /下载对话记录|完整事件数据|runtime-output-download|runtime-output-item/);
  const active = render({ id: 'active', status: 'running', outputItems: [{ id: 'running', type: 'mcpToolCall', status: 'inProgress', data: { tool: '<unsafe_tool>', result: 'PRIVATE_RESULT' } }] });
  assert.doesNotMatch(active, /工具|PRIVATE_RESULT|unsafe_tool|data-tool-disclosure/);
  assert.match(render({ id: 'old', finalOutput: '旧版完整记录' }), /旧版完整记录/);
});

test('empty completion snapshots do not erase received final text or its phase', () => {
  const { run, notify } = fixture();
  notify('item/agentMessage/delta', { itemId: 'final', phase: 'final_answer', delta: 'FULL_FINAL_REPLY' });
  notify('item/completed', { item: { id: 'final', type: 'agentMessage', phase: null, text: '' } });
  notify('turn/completed', { turn: { id: run.turnId, status: 'completed', items: [{ id: 'final', type: 'agentMessage', text: '' }] } });
  assert.equal(run.finalOutput, 'FULL_FINAL_REPLY');
  assert.equal(run.completion.finalAnswer, 'received');
});

test('commentary-only completion is distinguished from a final answer without changing model history', () => {
  const { run, notify } = fixture();
  notify('item/completed', { item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Let me gather details before summarizing.' } });
  notify('turn/completed', { turn: { id: run.turnId, status: 'completed', items: [] } });
  assert.equal(run.status, 'completed'); assert.equal(run.completion.finalAnswer, 'missing');
  const context = vm.createContext({ sessionStorage: { getItem: () => '' } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/\binit\(\);\s*$/, ''), context);
  const render = vm.runInContext('renderRunOutput', context), badge = vm.runInContext('controllerRunStatus', context);
  assert.match(render(run), /Let me gather details[\s\S]*未收到模型的最终答复/);
  assert.equal(badge(run)[0], '本轮结束，未收到最终答复');
  assert.equal(badge({ status: 'completed', finalOutput: 'Unphased legacy reply' })[0], '本次执行结束');
  const unphased = { outputItems: [{ type: 'agentMessage', data: { text: 'Provider reply without phase' } }] };
  assert.equal(output.completionInfo(unphased).finalAnswer, 'unknown');
});

test('saved-turn lookup restores a missed final message only to its originating run and does not run the model', async () => {
  const { run, codex, store, notify } = fixture();
  notify('item/completed', { item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'PROGRESS_ONLY' } });
  codex.simulated = false; codex.process = { stdin: { writable: true } };
  let resolveRead, reads = 0;
  codex.readThread = async threadId => { assert.equal(threadId, run.threadId); reads++; return new Promise(resolve => { resolveRead = resolve; }); };
  codex.startTurn = async () => assert.fail('Recovery must not start an inference turn');
  notify('turn/completed', { turn: { id: run.turnId, status: 'completed', items: [] } });
  const newer = { id: 'newer-run', threadId: 'new-thread', turnId: 'new-turn', status: 'running', finalOutput: 'NEW_REPLY' };
  store.project.runs.unshift(newer);
  resolveRead({ thread: { turns: [{ id: 'unrelated-turn', items: [{ type: 'agentMessage', text: 'WRONG_REPLY' }] },
    { id: run.turnId, items: [{ id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'RECOVERED_FINAL' }] }] } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1); assert.match(run.finalOutput, /PROGRESS_ONLY[\s\S]*RECOVERED_FINAL/);
  assert.doesNotMatch(run.finalOutput, /WRONG_REPLY|NEW_REPLY/); assert.equal(newer.finalOutput, 'NEW_REPLY');
  assert.equal(run.completion.finalAnswer, 'received'); assert.equal(run.completion.checkedSavedTurn, true);
});

test('Controller completion carrying an error retains partial text and fails visibly', () => {
  const { run, notify } = fixture();
  notify('item/agentMessage/delta', { itemId: 'partial', delta: 'PARTIAL_REPLY' });
  notify('turn/completed', { turn: { id: run.turnId, status: 'completed', items: [], error: { message: 'UPSTREAM_END_ERROR' } } });
  assert.equal(run.status, 'failed'); assert.match(run.finalOutput, /PARTIAL_REPLY[\s\S]*UPSTREAM_END_ERROR/);
});

test('activity is a transient state and never remains in ended conversations', () => {
  const context = vm.createContext({ sessionStorage: { getItem: () => '' } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/\binit\(\);\s*$/, ''), context);
  const activity = vm.runInContext('runtimeActivity', context);
  assert.equal(activity({ status: 'running', liveActivity: 'tool' }), '正在调用工具…');
  assert.equal(activity({ status: 'running', liveActivity: 'writing' }), '正在生成回复…');
  for (const status of ['completed', 'failed', 'interrupted']) assert.equal(activity({ status, liveActivity: 'tool' }), '');
});

test('all received reasoning survives empty final fields and persists without truncation', () => {
  const { run, store, notify } = fixture();
  const full = '详细推理内容α\n'.repeat(6000) + 'END_OF_FULL_REASONING';
  notify('item/reasoning/summaryTextDelta', { itemId: 'reasoning', summaryIndex: 0, delta: '完整接收的推理摘要' });
  notify('item/reasoning/textDelta', { itemId: 'reasoning', contentIndex: 0, delta: full.slice(0, 1000) });
  notify('item/reasoning/textDelta', { itemId: 'reasoning', contentIndex: 0, delta: full.slice(1000) });
  notify('item/completed', { item: { id: 'reasoning', type: 'reasoning', summary: [], content: [] } });
  assert.deepEqual(run.outputItems[0].data.summary, ['完整接收的推理摘要']);
  assert.deepEqual(run.outputItems[0].data.content, [full]);
  const display = output.forDisplay(run);
  assert.equal(display.outputItems[0].data.content[0], full);
  store.save();
  const saved = JSON.parse(fs.readFileSync(path.join(store.runtimeDir, 'state.json'), 'utf8'));
  assert.equal(saved.runs[0].outputItems[0].data.content[0], full);
});

test('reasoning is combined into one collapsed disclosure with complete summary and raw content', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/\binit\(\);\s*$/, '');
  const context = vm.createContext({ sessionStorage: { getItem: () => '' } });
  vm.runInContext(source, context);
  const render = vm.runInContext('renderRunOutput', context);
  const full = '详细步骤\n'.repeat(6000) + 'END_OF_VISIBLE_REASONING';
  const run = { id: 'reasoning-flow', status: 'completed', tokenUsage: { last: { inputTokens: 1234, outputTokens: 567 } }, outputItems: [
    { id: 'r1', type: 'reasoning', data: { summary: ['SUMMARY_START', { text: 'SUMMARY_END' }], content: [{ type: 'reasoning_text', text: full }], encrypted_content: 'PRIVATE_CIPHERTEXT' } },
    { id: 'm1', type: 'agentMessage', data: { text: '第一段回复' } },
    { id: 'r2', type: 'reasoning', data: { summary: ['SECOND_REASONING_SECTION'], content: [] } },
    { id: 'plan', type: 'plan', data: { plan: [{ step: '核查条件', status: 'completed' }] } },
    { id: 'm2', type: 'agentMessage', data: { text: '第二段回复' } }
  ] };
  let html = render(run);
  assert.equal((html.match(/class="runtime-reasoning"/g) || []).length, 1);
  assert.match(html, /<summary>推理摘要<\/summary>/);
  assert.match(html, /SUMMARY_START[\s\S]*SUMMARY_END[\s\S]*END_OF_VISIBLE_REASONING[\s\S]*SECOND_REASONING_SECTION/);
  assert.equal((html.match(/详细步骤/g) || []).length, 6000);
  assert.doesNotMatch(html, /data-reasoning-disclosure="[^"]*" open|模型返回的推理摘要|完整事件数据|下载对话记录|PRIVATE_CIPHERTEXT|runtime-output-item/);
  assert.match(html, /第一段回复[\s\S]*核查条件[\s\S]*第二段回复/);
  assert.doesNotMatch(html, /令牌用量|runtime-token-usage/);
  vm.runInContext("expandedReasoningRuns.add(':reasoning-flow')", context);
  html = render(run);
  assert.match(html, /data-reasoning-disclosure=":reasoning-flow" open/);
  const rawOnly = { id: 'raw-only', outputItems: [{ id: 'reason', type: 'reasoning', data: { content: ['RAW_VISIBLE_TEXT'], summary: [] } }] };
  const rawHtml = render(rawOnly); assert.match(rawHtml, /<summary>推理内容<\/summary>/); assert.match(rawHtml, /RAW_VISIBLE_TEXT/);
  assert.doesNotMatch(rawHtml, /data-reasoning-disclosure="[^"]*" open/);
});

test('context usage updates the matching conversation outside active turns and invalidates after compaction', () => {
  const { store, run, codex, notify } = fixture();
  store.project.model = 'research-model';
  store.project.controllerThreadId = run.threadId;
  store.project.agents.push({ id: 'agent-one', threadId: 'agent-thread' });
  const usage = { total: { totalTokens: 9000000 }, last: { totalTokens: 348000, inputTokens: 347000, outputTokens: 1000 }, modelContextWindow: 475000 };
  notify('thread/tokenUsage/updated', { tokenUsage: usage });
  assert.deepEqual(store.project.contextUsage.controller.tokenUsage, usage);
  run.status = 'completed';
  run.requestSettings = { model: 'research-model', reasoningEffort: 'high' };
  store.project.model = 'newly-selected-model';
  codex.handleMessage({ method: 'thread/tokenUsage/updated', params: { threadId: run.threadId, turnId: run.turnId, tokenUsage: usage } });
  assert.equal(store.project.contextUsage.controller.model, 'research-model');
  store.project.model = 'research-model';
  const after = { ...usage, last: { totalTokens: 40000 } };
  codex.handleMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 'agent-thread', tokenUsage: after } });
  assert.deepEqual(store.project.contextUsage['agent-one'].tokenUsage, after);
  assert.deepEqual(store.project.contextUsage.controller.tokenUsage, usage);
  codex.handleMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 'unrelated-thread', tokenUsage: usage } });
  assert.equal(store.project.contextUsage['unrelated-thread'], undefined);
  codex.handleMessage({ method: 'item/completed', params: { threadId: run.threadId, item: { id: 'compacted', type: 'contextCompaction' } } });
  assert.equal(store.project.contextUsage.controller.status, 'awaiting-usage');
  assert.equal(store.project.contextUsage.controller.tokenUsage, null);
  codex.handleMessage({ method: 'thread/tokenUsage/updated', params: { threadId: run.threadId, tokenUsage: after } });
  assert.equal(store.project.contextUsage.controller.tokenUsage.last.totalTokens, 40000);
  store.save();
  const saved = JSON.parse(fs.readFileSync(path.join(store.runtimeDir, 'state.json'), 'utf8'));
  assert.equal(saved.contextUsage.controller.tokenUsage.last.totalTokens, 40000);
});
test('browser transport removes tool results and parameters while retaining complete internal research state', () => {
  const run = { id: 'export', finalOutput: 'MODEL_REPLY', diff: 'PRIVATE_DIFF', events: [{ kind: 'output', text: 'PRIVATE_STDOUT' }], outputItems: [
    { id: 'tool', type: 'dynamicToolCall', status: 'completed', data: { tool: 'read_asset', arguments: { private: 'PRIVATE_ARGUMENT' }, contentItems: [{ text: 'PRIVATE_TOOL_RESULT' }] } },
    { id: 'command', type: 'commandExecution', data: { command: 'PRIVATE_COMMAND', aggregatedOutput: 'PRIVATE_STDOUT' } },
    { id: 'message', type: 'agentMessage', data: { text: 'MODEL_REPLY' } },
    { id: 'reasoning', type: 'reasoning', data: { summary: [], content: ['VISIBLE_REASONING'], encrypted_content: 'PRIVATE_CIPHERTEXT' } }
  ] };
  const display = output.forDisplay({ type: 'run.updated', run });
  assert.doesNotMatch(JSON.stringify(display), /PRIVATE_/);
  assert.equal(display.run.outputItems[0].data.tool, 'read_asset');
  assert.equal(display.run.outputItems[1].data.tool, '终端');
  assert.equal(display.run.finalOutput, 'MODEL_REPLY');
  assert.equal(run.outputItems[0].data.contentItems[0].text, 'PRIVATE_TOOL_RESULT');
});
test('known credential values are redacted without cutting unrelated output', () => {
  process.env.deepmath_azure_probe_key = 'a-synthetic-secret-value';
  try { assert.deepEqual(output.redact({ text: 'before a-synthetic-secret-value after' }), { text: 'before [REDACTED] after' }); }
  finally { delete process.env.deepmath_azure_probe_key; }
});

test('host tool results and failures redact known credentials before being returned to the model', async () => {
  const { codex } = fixture();
  const saved = process.env.deepmath_azure_probe_key;
  const key = 'synthetic-tool-bridge-private-key';
  process.env.deepmath_azure_probe_key = key;
  const replies = [];
  codex.process = { stdin: { writable: true, write(value) { replies.push(JSON.parse(value)); } } };
  try {
    codex.setToolExecutor(async () => ({ content: `RESEARCH_OK ${key}`, nested: { key } }));
    await codex.handleServerRequest({ id: 1, method: 'item/tool/call', params: { tool: 'read_report' } });
    assert.equal(replies[0].result.success, true);
    const result = replies[0].result.contentItems[0].text;
    assert.ok(result.includes('RESEARCH_OK'));
    assert.ok(result.includes('[REDACTED]'));
    assert.ok(!result.includes(key));
    codex.setToolExecutor(async () => { throw new Error(`Unexpected secret in failure: ${key}`); });
    await codex.handleServerRequest({ id: 2, method: 'item/tool/call', params: { tool: 'read_report' } });
    assert.equal(replies[1].result.success, false);
    assert.ok(!JSON.stringify(replies[1]).includes(key));
    assert.ok(JSON.stringify(replies[1]).includes('[REDACTED]'));
  } finally {
    if (saved === undefined) delete process.env.deepmath_azure_probe_key; else process.env.deepmath_azure_probe_key = saved;
    codex.process = null;
  }
});

test('model requests cannot approve elevated execution or invent host file/environment tools', async () => {
  const { codex } = fixture();
  const replies = [];
  codex.process = { stdin: { writable: true, write(value) { replies.push(JSON.parse(value)); } } };
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']) {
    await codex.handleServerRequest({ id: replies.length + 1, method, params: { path: '/opt/deepmath/.env' } });
  }
  assert.equal(replies[0].result.decision, 'decline');
  assert.equal(replies[1].result.decision, 'decline');
  assert.equal(replies[2].error.code, -32001);
  const { executeTool } = require('../src/mcp-tools');
  for (const kind of ['controller', 'agent']) for (const name of ['read_file', 'read_environment', 'exec', 'get_api_key', '__proto__']) {
    await assert.rejects(executeTool({ kind, name, arguments: { path: '/opt/deepmath/.env', name: 'AZURE_OPENAI_API_KEY' } }), /not available/);
  }
  codex.process = null;
});

test('network retry status follows the exact turn and clears only after all of its retrying requests finish', () => {
  const { store, run, codex, manager } = fixture();
  const other = { id: 'other-agent-run', agentId: 'other', threadId: 'other-thread', turnId: 'other-turn', status: 'running', finalOutput: '', events: [] };
  store.project.runs.push(other);
  const emit = (requestId, retrying, turnId = run.turnId) => codex.emit('network.retry', { threadId: run.threadId, turnId, requestId, retrying });
  emit('request-one', true);
  assert.equal(run.networkRetrying, true); assert.ok(!other.networkRetrying);
  emit('request-two', true);
  emit('request-one', false);
  assert.equal(run.networkRetrying, true);
  emit('request-two', false);
  assert.equal(run.networkRetrying, false);
  emit('stale-request', true, 'old-turn');
  assert.equal(run.networkRetrying, false);
  emit('cancelled-request', true);
  run.status = 'interrupted';
  emit('cancelled-request', false);
  assert.equal(run.networkRetrying, false); assert.equal(manager.networkRetryRequests.size, 0);
});

test('network retry during compaction updates its own disclosure and clears after completion', () => {
  const { store, run, codex } = fixture();
  const status = store.contextCompactions.controller = { status: 'running', threadId: run.threadId };
  const event = { threadId: run.threadId, turnId: 'compact-turn', requestId: 'compact-request', retrying: true };
  codex.emit('network.retry', event);
  assert.equal(status.networkRetrying, true); assert.ok(!run.networkRetrying);
  status.status = 'completed';
  codex.emit('network.retry', { ...event, retrying: false });
  assert.equal(status.networkRetrying, false);
});

test('repeated retry notifications do not rewrite durable state or repeat unchanged browser status', () => {
  const { store, run, codex } = fixture();
  let writes = 0, updates = 0;
  store.scheduleSave = () => { writes++; };
  store.subscribe(event => { if (event.type === 'run.updated') updates++; });
  const event = { threadId: run.threadId, turnId: run.turnId, requestId: 'same-request', retrying: true };
  for (let attempt = 1; attempt <= 5; attempt++) codex.emit('network.retry', { ...event, attempt });
  assert.equal(run.networkRetrying, true); assert.equal(updates, 1); assert.equal(writes, 0);
  codex.emit('network.retry', { ...event, retrying: false });
  assert.equal(run.networkRetrying, false); assert.equal(updates, 2); assert.equal(writes, 0);
});

test('quota scheduling stays attached to the running turn and never masquerades as a network failure', () => {
  const { store, run, codex, manager } = fixture();
  const event = { threadId: run.threadId, turnId: run.turnId, requestId: 'background-call', retrying: true, state: 'internal' };
  for (let i = 0; i < 8; i++) codex.emit('network.retry', { ...event, attempt: 0 });
  assert.equal(run.status, 'running'); assert.equal(run.internalProcessing, true); assert.equal(Boolean(run.networkRetrying), false);
  assert.equal(run.completedAt, undefined); assert.equal(run.outputItems, undefined);
  codex.emit('network.retry', { ...event, state: 'network' });
  assert.equal(run.networkRetrying, true); assert.equal(run.internalProcessing, false);
  codex.emit('network.retry', { ...event, retrying: false, state: null });
  assert.equal(run.internalProcessing, false); assert.equal(run.networkRetrying, false); assert.equal(manager.networkRetryRequests.size, 0);
  assert.equal(store.project.runs.length, 1);
});

test('runtime releases logical-turn priority only on the real terminal event, including canceled turns', () => {
  const { codex, run } = fixture(); const ended = [];
  codex.finishModelTurn = (...ids) => ended.push(ids);
  codex.handleMessage({ method: 'item/completed', params: { threadId: run.threadId, turnId: run.turnId, item: { type: 'dynamicToolCall' } } });
  assert.equal(ended.length, 0);
  codex.handleMessage({ method: 'turn/completed', params: { threadId: run.threadId, turn: { id: run.turnId, status: 'interrupted' } } });
  assert.deepEqual(ended, [[run.threadId, run.turnId]]);
});


test('an idle confirmed 128K session never presents the previous turn old capacity as current', () => {
  const { store, codex, run, notify } = fixture(); store.project.controllerThreadId=run.threadId;
  const oldUsage={last:{totalTokens:23500},modelContextWindow:258400};
  notify('thread/tokenUsage/updated',{tokenUsage:oldUsage});
  assert.equal(store.project.contextUsage.controller.tokenUsage.modelContextWindow,258400);
  const history=JSON.stringify(store.project.runs);const events=[];store.subscribe(event=>events.push(event));
  codex.contextMaintenance(run.threadId,'running');codex.contextPolicy().markApplied(run.threadId);codex.contextMaintenance(run.threadId,'completed');
  const saved=store.project.contextUsage.controller;
  assert.equal(saved.tokenUsage.modelContextWindow,null);assert.equal(saved.tokenUsage.configuredContextWindow,128000);
  assert.equal(saved.tokenUsage.last.totalTokens,23500);assert.equal(saved.status,'awaiting-window-usage');
  assert.equal(JSON.stringify(store.project.runs),history);
  const count=events.length;codex.contextWindowApplied(run.threadId,128000);assert.equal(events.length,count);
  // The native process can replay its previous usage on resume. It must stay historical.
  notify('thread/tokenUsage/updated',{tokenUsage:oldUsage});
  assert.equal(store.project.contextUsage.controller.tokenUsage.modelContextWindow,null);
  assert.equal(store.project.contextUsage.controller.status,'awaiting-window-usage');
  notify('thread/tokenUsage/updated',{tokenUsage:{last:{totalTokens:24000},modelContextWindow:121600}});
  assert.equal(store.project.contextUsage.controller.status,'ready');
  assert.equal(store.project.contextUsage.controller.tokenUsage.modelContextWindow,121600);
});
