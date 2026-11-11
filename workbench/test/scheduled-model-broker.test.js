'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { ModelBroker } = require('../src/agent-runtime');
const { ModelRequestScheduler } = require('../src/model-request-scheduler');
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, fetchUpstream) {
  const names = ['AZURE_OPENAI_API_KEY', 'deepmath_model_proxy_port', 'deepmath_model_proxy_host', 'deepmath_models', 'deepmath_default_model'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { AZURE_OPENAI_API_KEY: 'synthetic-not-a-real-key', deepmath_model_proxy_port: '0', deepmath_model_proxy_host: '127.0.0.1',
    deepmath_models: JSON.stringify([{ id: 'flash', apiModel: 'FW-DeepSeek-V4.1-Flash', maxOutputTokens: 262144 }]), deepmath_default_model: 'flash' });
  const scheduler = new ModelRequestScheduler({ settings: { defaults: { maxConcurrent: 1, maxPerAccount: 1, agingMs: 15000, continuationBurst: 2 }, models: {} } });
  const broker = new ModelBroker({ scheduler, fetchUpstream });
  t.after(() => { broker.close(); for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; });
  await broker.start();
  for (const [token, account] of [['a-project-one', 'account-a'], ['a-project-two', 'account-a'], ['b-project', 'account-b']]) {
    broker.tokens.add(token); broker.tokenOwners.set(token, account); broker.tokenScopes.set(token, token);
  }
  const post = (token, input, signal, routing, extra = {}) => fetch('http://127.0.0.1:' + broker.server.address().port + '/v1/responses', {
    method: 'POST', signal, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
      'x-codex-turn-metadata': JSON.stringify(routing || { thread_id: token, turn_id: 'logical-turn' }) },
    body: JSON.stringify({ model: 'FW-DeepSeek-V4.1-Flash', input, reasoning: { effort: 'high' }, max_output_tokens: 4096, ...extra }) });
  return { broker, scheduler, post };
}

test('actual broker queues all projects by trusted account and forwards the configured output budget unchanged', async t => {
  const sent = []; let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { broker, post } = await fixture(t, async (url, options) => {
    const payload = JSON.parse(options.body); sent.push(payload.input); assert.equal(payload.max_output_tokens, 262144);
    if (payload.input === 'A1') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('A1')); release = () => controller.close(); entered();
    } }));
    return new Response(payload.input);
  });
  const first = post('a-project-one', 'A1'); await started;
  const states = [], queued = new Map();
  for (const token of ['a-project-two', 'b-project']) broker.retryHandlers.set(token, event => { states.push(event); if (event.retrying) queued.get(token)?.(); });
  const waitingA = new Promise(resolve => queued.set('a-project-two', resolve));
  const a = post('a-project-two', 'A2'); await waitingA;
  const waitingB = new Promise(resolve => queued.set('b-project', resolve));
  const b = post('b-project', 'B'); await waitingB;
  assert.deepEqual(sent, ['A1']); release();
  assert.equal(await (await first).text(), 'A1'); assert.equal(await (await b).text(), 'B'); assert.equal(await (await a).text(), 'A2');
  assert.deepEqual(sent, ['A1', 'B', 'A2']);
  assert.ok(states.filter(event => event.retrying).every(event => event.state === 'internal'));
  assert.ok(!JSON.stringify(states).includes('synthetic-not-a-real-key'));
});

test('canceling a real queued proxy request never sends it upstream and leaves the other account running', async t => {
  const sent = []; let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const { broker, post } = await fixture(t, async (url, options) => {
    const value = JSON.parse(options.body).input; sent.push(value);
    if (value === 'held') return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('held')); release = () => controller.close(); entered(); } }));
    return new Response(value);
  });
  const held = post('a-project-one', 'held'); await started;
  let queued; const waiting = new Promise(resolve => { queued = resolve; });
  broker.retryHandlers.set('b-project', event => { if (event.retrying) queued(); });
  const abort = new AbortController(), canceled = assert.rejects(post('b-project', 'canceled', abort.signal), { name: 'AbortError' });
  await waiting; abort.abort(); await canceled;
  for (let i = 0; i < 30 && broker.activeRequests.get('b-project')?.size; i++) await flush();
  release(); await (await held).text();
  assert.deepEqual(sent, ['held']); assert.ok(broker.tokens.has('a-project-one'));
  assert.equal(broker.scheduler.pool('FW-DeepSeek-V4.1-Flash').queue.length, 0);
});

test('canceling one Agent blocks its late resends but leaves another Agent on the same project token usable', async t => {
  const sent = [];
  const { broker, post } = await fixture(t, async (url, options) => { sent.push(JSON.parse(options.body).input); return new Response('OK'); });
  broker.cancelTurn('a-project-one', 'a-project-one', 'logical-turn');
  const canceled = await post('a-project-one', 'late canceled request');
  assert.equal(canceled.status, 422); assert.equal((await canceled.json()).error.code, 'deepmath_turn_canceled');
  const sibling = await post('a-project-one', 'sibling Agent', undefined, { thread_id: 'sibling-thread', turn_id: 'sibling-turn' });
  assert.equal(await sibling.text(), 'OK'); assert.deepEqual(sent, ['sibling Agent']);
  assert.ok(broker.tokens.has('a-project-one'));
});

test('normal HTTP completion retains the logical turn until the native terminal event', async t => {
  const { broker, scheduler, post } = await fixture(t, async () => new Response('tool-call-step'));
  const response = await post('a-project-one', 'one step'); await response.text(); await flush();
  const turn = [...scheduler.pool('FW-DeepSeek-V4.1-Flash').turns.values()][0];
  assert.ok(turn, 'HTTP completion must retain the logical research turn');
  assert.equal(turn.finished, false);
  turn.limited = true;
  await (await post('a-project-one', 'continuation after tool result')).text(); await flush();
  assert.equal([...scheduler.pool('FW-DeepSeek-V4.1-Flash').turns.values()][0], turn);
  assert.equal(turn.limited, true, 'quota priority spans HTTP responses and tool gaps');
  broker.finishTurn('a-project-one', 'a-project-one', 'logical-turn');
  assert.equal(scheduler.pool('FW-DeepSeek-V4.1-Flash').turns.size, 0);
});

test('a queued streaming call receives protocol heartbeats and remains cancellable before an upstream send', async t => {
  let entered, release; const sent = [], started = new Promise(resolve => { entered = resolve; });
  const { broker, post } = await fixture(t, async (url, options) => {
    const input = JSON.parse(options.body).input; sent.push(input);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('HELD')); release = () => controller.close(); entered(); } }));
  });
  const held = post('a-project-one', 'held'); await started;
  const abort = new AbortController(), queued = await post('b-project', 'queued', abort.signal, undefined, { stream: true });
  assert.match(queued.headers.get('content-type'), /event-stream/);
  const reader = queued.body.getReader(); assert.match(Buffer.from((await reader.read()).value).toString(), /^: internal processing/);
  assert.deepEqual(sent, ['held']); abort.abort(); await assert.rejects(reader.read(), { name: 'AbortError' });
  for (let n = 0; n < 50 && broker.activeRequests.get('b-project')?.size; n++) await flush();
  release(); await (await held).text(); assert.deepEqual(sent, ['held']);
});

test('a permanent API failure after keepalive is a semantic stream error instead of an endless internal state', async t => {
  let calls = 0;
  const { post } = await fixture(t, async () => { calls++; return Response.json({ error: { code: 'invalid_api_key', message: 'Access denied' } }, { status: 401 }); });
  const response = await post('a-project-one', 'one-call', undefined, undefined, { stream: true });
  const wire = await response.text(); assert.match(wire, /response.failed/); assert.match(wire, /invalid_api_key/); assert.equal(calls, 1);
});
