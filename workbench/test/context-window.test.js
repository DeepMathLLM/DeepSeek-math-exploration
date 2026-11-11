'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ContextWindowPolicy, contextTokens, threadConfig } = require('../src/context-window');
function fixture({ loaded = true, used = 180000, applied = false } = {}) {
  const client = new EventEmitter(), calls = [], stages = [];
  Object.assign(client, { process: {}, threads: new Set(loaded ? ['thread'] : []), turns: new Map(), contextUnloadTimeoutMs: 30 });
  const policy = new ContextWindowPolicy(client);
  client.contextUsageProvider = () => ({ last: { totalTokens: used }, total: { totalTokens: 9000000 }, modelContextWindow: 475000 });
  client.request = async (method, params) => {
    calls.push(method);
    if (method === 'thread/unsubscribe') setImmediate(() => {
      client.threads.delete(params.threadId); client.emit('notification', { method: 'thread/closed', params });
    });
    return {};
  };
  client.resumeThread = async threadId => { calls.push('resume'); client.threads.add(threadId); policy.markApplied(threadId); };
  client.compactThread = async threadId => { calls.push('compact'); policy.invalidate(threadId); };
  let reserved = 0;
  client.reserveContextMaintenance = () => { reserved++; return () => reserved--; };
  client.contextMaintenance = (threadId, status) => stages.push(status);
  if (applied) policy.markApplied('thread');
  return { client, policy, calls, stages, reserved: () => reserved };
}
test('the context config changes the real window without introducing a compaction percentage or output budget', () => {
  assert.deepEqual(threadConfig(), { model_context_window: 128000 });
  assert.equal(contextTokens({ last: { totalTokens: 129000 }, total: { totalTokens: 9000000 } }), 129000);
  assert.equal(contextTokens({ lastTokenUsage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 } }), 120);
  assert.equal(contextTokens({ total: { totalTokens: 10000000 } }), null);
});
test('oversized loaded history is refreshed and compacted once; no user instruction is submitted', async () => {
  const f = fixture(); const a = f.policy.ensure('thread'), b = f.policy.ensure('thread');
  assert.equal(a, b); await a;
  assert.deepEqual(f.calls, ['thread/unsubscribe', 'resume', 'compact']);
  assert.deepEqual(f.stages, ['running', 'completed']); assert.equal(f.reserved(), 0);
  await f.policy.ensure('thread'); assert.equal(f.calls.length, 3);
});
test('active model and tool rounds are left intact; transition starts only at a terminal boundary', async () => {
  const f = fixture(); f.client.turns.set('turn', 'thread');
  await assert.rejects(f.policy.ensure('thread'), /本轮结束/); assert.deepEqual(f.calls, []);
  f.client.turns.clear(); await f.policy.ensure('thread'); assert.equal(f.calls.at(-1), 'compact');
});
test('another Agent can remain active while an idle sibling changes its window', async () => {
  const f = fixture(); f.client.turns.set('other-turn', 'other-thread');
  await f.policy.ensure('thread'); assert.equal(f.client.turns.get('other-turn'), 'other-thread');
});
test('cold-resumed oversized history is compacted without an unnecessary unload', async () => {
  const f = fixture({ loaded: false }); await f.policy.ensure('thread');
  assert.deepEqual(f.calls, ['resume', 'compact']);
});
test('native usage discovered during cold resume is checked before continuing', async () => {
  const f = fixture({ loaded: false, used: 1 });
  f.client.resumeThread = async threadId => { f.calls.push('resume'); f.policy.markApplied(threadId); f.policy.record(threadId, { last: { totalTokens: 180000 } }); };
  await f.policy.ensure('thread'); assert.deepEqual(f.calls, ['resume', 'compact']);
});
test('small and unknown histories adopt the window without forced compaction', async () => {
  for (const used of [20000, undefined]) {
    const f = fixture({ used }); if (used === undefined) f.client.contextUsageProvider = () => null;
    await f.policy.ensure('thread'); assert.deepEqual(f.calls, ['thread/unsubscribe', 'resume']);
  }
});
test('the native usable capacity is preserved and old in-flight windows are never relabeled', () => {
  const f = fixture({ applied: true });
  const legacy = { modelContextWindow: 475000, last: { totalTokens: 180000 } };
  assert.deepEqual(f.policy.decorate('thread', legacy), { ...legacy, modelContextWindow: null, model_context_window: null, configuredContextWindow: 128000 });
  f.policy.applied.delete('thread'); assert.equal(f.policy.decorate('thread', legacy), legacy); f.policy.markApplied('thread');
  assert.deepEqual(f.policy.decorate('thread', { modelContextWindow: 121600 }), { modelContextWindow: 121600, configuredContextWindow: 128000 });
  assert.deepEqual(f.policy.decorate('other-thread', { modelContextWindow: 121600 }), { modelContextWindow: 121600 });
});
test('unload confirmation has a deadline; failure releases the reservation and blocks delivery', async () => {
  const f = fixture(); f.client.request = async method => { f.calls.push(method); return {}; };
  await assert.rejects(f.policy.ensure('thread'), /未得到运行器确认/);
  assert.deepEqual(f.calls, ['thread/unsubscribe']); assert.equal(f.reserved(), 0);
  assert.equal(f.policy.operations.size, 0); assert.equal(f.policy.applied.has('thread'), false);
  assert.equal(f.client.listenerCount('notification'), 0);
});
test('native process failures release unload listeners and do not replace the saved conversation', async () => {
  const f = fixture(); f.client.request = async () => { setImmediate(() => f.client.emit('runtime.error', Error('native exited'))); return {}; };
  await assert.rejects(f.policy.ensure('thread'), /native exited/); assert.equal(f.reserved(), 0);
  assert.equal(f.client.listenerCount('runtime.error'), 0); assert.equal(f.calls.includes('resume'), false);
});
test('failed compaction is visible and a later request can prepare the same thread again', async () => {
  const f = fixture({ applied: true }); f.client.compactThread = async () => { throw Error('provider rejected compaction'); };
  await assert.rejects(f.policy.ensure('thread'), /provider rejected/);
  assert.deepEqual(f.stages, ['running', 'failed']); assert.equal(f.reserved(), 0);
  f.client.compactThread = async id => f.policy.invalidate(id); await f.policy.ensure('thread');
  assert.equal(f.stages.at(-1), 'completed');
});
test('a confirmed but still oversized summary does not unblock a new prompt', async () => {
  const f = fixture({ applied: true }); f.client.compactThread = async id => f.policy.record(id, { last: { totalTokens: 130000 } });
  await assert.rejects(f.policy.ensure('thread'), /仍超出/); assert.equal(f.reserved(), 0);
});
test('changed native processes cannot reuse an applied marker or stale usage', async () => {
  const f = fixture({ applied: true }); f.policy.record('thread', { last: { totalTokens: 1 } });
  f.client.process = {}; await f.policy.ensure('thread');
  assert.deepEqual(f.calls, ['thread/unsubscribe', 'resume', 'compact']);
});
test('a busy round that starts before the preparation microtask cannot be unloaded', async () => {
  const f = fixture(); const operation = f.policy.ensure('thread');
  f.client.turns.set('turn', 'thread'); await assert.rejects(operation, /本轮结束/);
  assert.deepEqual(f.calls, []); assert.equal(f.reserved(), 0);
});
