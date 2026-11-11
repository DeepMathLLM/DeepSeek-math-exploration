const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8').replace(/\binit\(\);\s*$/, '');
const context = vm.createContext({ sessionStorage: { getItem: () => '' } });
vm.runInContext(source, context);

const captureInstructionScroll = vm.runInContext('captureInstructionScroll', context);
const restoreInstructionScroll = vm.runInContext('restoreInstructionScroll', context);
const renderControllerUserMessage = vm.runInContext('renderControllerUserMessage', context);

test('long input bubbles retain their own scroll positions after a conversation redraw', () => {
  const bubble = (key, top = 0, left = 0) => ({ dataset: { instructionKey: key }, scrollTop: top, scrollLeft: left });
  const oldRoot = { querySelectorAll: () => [bubble('run-one:0', 245, 12), bubble('run-two:0', 380, 0)] };
  const positions = captureInstructionScroll(oldRoot);
  const nextBubble = bubble('run-two:0');
  const newBubble = bubble('run-three:0');
  const firstBubble = bubble('run-one:0');
  restoreInstructionScroll({ querySelectorAll: () => [nextBubble, newBubble, firstBubble] }, positions);

  assert.equal(firstBubble.scrollTop, 245);
  assert.equal(firstBubble.scrollLeft, 12);
  assert.equal(nextBubble.scrollTop, 380);
  assert.equal(newBubble.scrollTop, 0);
});

test('long input bubbles use the Run and message index as a stable scroll key', () => {
  const message = { kind: 'initial', text: 'A long research instruction. '.repeat(50) };
  const first = renderControllerUserMessage(message, 0, 'Task', 'run-one');
  const second = renderControllerUserMessage(message, 0, 'Task', 'run-two');

  assert.match(first, /data-instruction-key="run-one:0"/);
  assert.match(second, /data-instruction-key="run-two:0"/);
});

test('an idle Agent can click compact even when its public summary omits the thread ID', () => {
  const element = () => ({ classList: { toggle() {} }, querySelectorAll: () => [], querySelector: () => null, innerHTML: '' });
  const dashboard = element(), view = element(), bottom = element();
  context.document = { querySelector: (selector) => ({ '#dashboard-view': dashboard, '#agent-view': view, '#bottom-section': bottom })[selector] };
  vm.runInContext('typesetMath = () => {}; state.project = { agents: [{ id: "agent-1", displayName: "Verifier", lifecycleState: "Idle", researchContent: "Check proof", skills: [] }], runs: [], contextCompactions: {} }; state.selectedAgentId = "agent-1";', context);
  vm.runInContext('renderAgentView()', context);
  assert.match(view.innerHTML, /<button class="outline-button" data-compact-agent >压缩上下文<\/button>/);
});

test('only actual connection problems display network recovery, without queue or retry wording', () => {
  const status = vm.runInContext('controllerRunStatus', context);
  const agentConversation = vm.runInContext('renderAgentConversation', context);
  const run = { id: 'retry', status: 'running', networkRetrying: true, finalOutput: 'Existing reply', events: [] };
  assert.equal(status(run)[0], '网络连接暂时异常，正在恢复…');
  assert.match(agentConversation(run, '研究 Agent'), /网络连接暂时异常，正在恢复…/);
  assert.match(agentConversation(run, '研究 Agent'), /Existing reply/);
  for (const terminal of ['completed', 'failed', 'interrupted']) {
    assert.notEqual(status({ ...run, status: terminal })[0], '网络连接暂时异常，正在恢复…');
  }
  assert.notEqual(status({ ...run, networkRetrying: false })[0], '网络连接暂时异常，正在恢复…');
});

test('quota scheduling stays running, preserves received output and displays only internal processing', () => {
  const status = vm.runInContext('controllerRunStatus', context), activity = vm.runInContext('runtimeActivity', context);
  const render = vm.runInContext('renderAgentConversation', context);
  const run = { id: 'internal', status: 'running', internalProcessing: true, networkRetrying: false, finalOutput: 'Saved partial reply', events: [] };
  assert.equal(status(run)[0], '正在内部处理…'); assert.equal(status(run)[1], 'running');
  assert.equal(activity(run), '正在内部处理…');
  const html = render(run, '研究 Agent');
  assert.match(html, /正在内部处理…/); assert.match(html, /Saved partial reply/);
  assert.doesNotMatch(html, /等待|重试|排队|网络波动/);
  assert.equal(status({ ...run, status: 'queued' })[0], '正在内部处理…');
  for (const terminal of ['completed', 'failed', 'interrupted']) assert.notEqual(status({ ...run, status: terminal })[0], '正在内部处理…');
});
