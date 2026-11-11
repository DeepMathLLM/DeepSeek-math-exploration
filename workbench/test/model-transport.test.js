'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: wait } = require('node:timers/promises');
const { requestModel, responseChunks, networkError } = require('../src/model-transport');

const fault = code => Object.assign(new Error('synthetic transport error'), { code });
const context = extra => ({ upstream: new URL('https://synthetic.invalid/openai/v1/responses'),
  credential: 'synthetic-private-key', body: '{"model":"fixed","reasoning":{"effort":"low"}}',
  signal: new AbortController().signal, ...extra });
async function text(result) { let out = ''; for await (const chunk of responseChunks(result)) out += Buffer.from(chunk).toString(); return out; }
const peakError = { type: 'error', error: { type: 'too_many_requests', code: 'no_capacity',
  message: 'The system is currently experiencing high demand and cannot process your request. Your request exceeds the maximum usage size allowed during peak load.' } };
const sseFrame = data => 'event: ' + data.type + '\r\ndata: ' + JSON.stringify(data) + '\r\n\r\n';
function splitSse(value, headers = {}) {
  const bytes = Buffer.from(value);
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.subarray(offset, offset + 7));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream', ...headers } });
}

test('HTTP 200 Azure capacity errors after empty metadata retry before any output is committed', async () => {
  const sent = [], waits = [], attempts = [];
  const limited = structuredClone(peakError); limited.error.headers = { 'retry-after-ms': '75000' };
  const created = sseFrame({ type: 'response.created', response: { id: 'discarded-response', output: [] } });
  const good = sseFrame({ type: 'response.created', response: { id: 'accepted-response', output: [] } })
    + sseFrame({ type: 'response.output_text.delta', delta: '有效回答🙂' })
    + sseFrame({ type: 'response.completed', response: { status: 'completed' } });
  const result = await requestModel(context({ waitForRetry: async delay => waits.push(delay), onRetry: attempt => attempts.push(attempt),
    fetchUpstream: async (url, options) => {
      sent.push(options.body); return splitSse(sent.length === 1 ? created + sseFrame(limited) : good);
    } }));
  assert.equal(await text(result), good); assert.equal(sent.length, 2); assert.equal(new Set(sent).size, 1);
  assert.equal(waits.length, 1); assert.ok(waits[0] >= 75000 && waits[0] <= 80000); assert.deepEqual(attempts, [1]);
});

test('structured response.failed, Chat errors and JSON capacity errors share rate-limit handling', async () => {
  for (const variant of ['failed', 'chat', 'json200', 'json400']) {
    let calls = 0; const waits = [];
    const result = await requestModel(context({ waitForRetry: async delay => waits.push(delay), fetchUpstream: async () => {
      if (++calls > 1) return new Response('RECOVERED');
      if (variant === 'failed') return splitSse(sseFrame({ type: 'response.failed', response: { error: peakError.error } }));
      if (variant === 'chat') return splitSse('data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n' + 'data: ' + JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Rate limit exceeded' } }) + '\n\n');
      return Response.json(peakError, { status: variant === 'json400' ? 400 : 200 });
    } }));
    assert.equal(await text(result), 'RECOVERED'); assert.equal(calls, 2); assert.ok(waits[0] >= 60000 && waits[0] <= 65000);
  }
});

test('streamed capacity errors exhaust exactly the same five-retry budget as network and HTTP throttling', async () => {
  let calls = 0; const waits = [];
  await assert.rejects(requestModel(context({ waitForRetry: async delay => waits.push(delay), fetchUpstream: async () => {
    calls++;
    if (calls === 2) throw fault('ECONNRESET');
    if (calls === 3) return new Response('Limited', { status: 429 });
    return splitSse(sseFrame({ type: 'response.created', response: { output: [] } }) + sseFrame(peakError));
  } })), error => error.code === 'DEEPMATH_NETWORK_RETRIES_EXHAUSTED' && /持续限流.*已重试 5 次/.test(error.message));
  assert.equal(calls, 6); assert.equal(waits.length, 5);
});

test('policy errors and quota failures are passed through, and model text mentioning rate limits never triggers a replay', async () => {
  const events = [
    { type: 'error', error: { code: 'content_filter', type: 'too_many_requests', message: 'Blocked by policy' } },
    { type: 'error', error: { code: 'insufficient_quota', message: 'Too many requests; billing needed' } },
    { type: 'response.output_text.delta', delta: 'rate limit exceeded: this is model text' }
  ];
  for (const event of events) {
    let calls = 0; const wire = sseFrame(event) + sseFrame(peakError);
    const result = await requestModel(context({ waitForRetry: async () => assert.fail('Committed or permanent error replayed'),
      fetchUpstream: async () => { calls++; return splitSse(wire); } }));
    assert.equal(await text(result), wire); assert.equal(calls, 1);
  }
});

test('capacity errors after reasoning or a tool event never replay the request, including within the same chunk', async () => {
  for (const event of [
    { type: 'response.reasoning_text.delta', delta: 'Partial thought' },
    { type: 'response.output_item.added', item: { type: 'function_call', name: 'inspect', arguments: '' } }
  ]) {
    let calls = 0; const wire = sseFrame({ type: 'response.in_progress', response: { output: [] } }) + sseFrame(event) + sseFrame(peakError);
    const result = await requestModel(context({ waitForRetry: async () => assert.fail('Partially delivered request replayed'),
      fetchUpstream: async () => { calls++; return new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } }); } }));
    assert.equal(await text(result), wire); assert.equal(calls, 1);
  }
});

test('an empty stream prelude has bounded buffering and an exhausted iterator stays readable without losing bytes', async () => {
  const wire = sseFrame({ type: 'response.created', response: { output: [], metadata: { filler: 'x'.repeat(65536) } } }) + sseFrame(peakError);
  const result = await requestModel(context({ waitForRetry: async () => assert.fail('Bounded prelude was replayed'), fetchUpstream: async () => splitSse(wire) }));
  assert.equal(await text(result), wire);
  const small = sseFrame({ type: 'response.created', response: { output: [] } });
  assert.equal(await text(await requestModel(context({ fetchUpstream: async () => splitSse(small) }))), small);
});

test('network failures retry five times at 60000 ms with an unchanged request and then succeed', async () => {
  let calls = 0;
  const delays = [], requests = [];
  const result = await requestModel(context({
    waitForRetry: async milliseconds => { delays.push(milliseconds); },
    fetchUpstream: async (url, options) => {
      calls++; requests.push(JSON.stringify({ url: String(url), method: options.method, headers: options.headers, body: options.body }));
      if (calls <= 5) throw new TypeError('fetch failed', { cause: fault('ECONNRESET') });
      return new Response('SUCCESS_ON_SIXTH_ATTEMPT');
    }
  }));
  assert.equal(await text(result), 'SUCCESS_ON_SIXTH_ATTEMPT');
  assert.equal(calls, 6); assert.deepEqual(delays, Array(5).fill(60000));
  assert.equal(new Set(requests).size, 1);
});

test('exhaustion permits no seventh attempt and produces a safe, terminal error', async () => {
  let calls = 0; const delays = [];
  await assert.rejects(requestModel(context({ waitForRetry: async delay => { delays.push(delay); },
    fetchUpstream: async () => { calls++; throw fault('UND_ERR_CONNECT_TIMEOUT'); } })), error => {
    assert.equal(error.code, 'DEEPMATH_NETWORK_RETRIES_EXHAUSTED');
    assert.match(error.message, /已重试 5 次/);
    assert.ok(!error.message.includes('synthetic-private-key')); return true;
  });
  assert.equal(calls, 6); assert.deepEqual(delays, Array(5).fill(60000));
});

test('gateway network failures are retried; bad parameters and credentials are not', async () => {
  for (const status of [408, 500, 502, 503, 504]) {
    let calls = 0, waits = 0;
    const result = await requestModel(context({ waitForRetry: async delay => { assert.equal(delay, 60000); waits++; },
      fetchUpstream: async () => ++calls === 1 ? new Response('Gateway failed', { status }) : new Response('OK') }));
    assert.equal(await text(result), 'OK'); assert.equal(calls, 2); assert.equal(waits, 1);
  }
  for (const status of [400, 401, 403, 404, 422]) {
    let calls = 0;
    const result = await requestModel(context({ waitForRetry: async () => assert.fail('Non-network response retried'),
      fetchUpstream: async () => { calls++; return new Response('ERROR_BODY', { status }); } }));
    assert.equal(result.response.status, status); assert.equal(await text(result), 'ERROR_BODY'); assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(requestModel(context({ waitForRetry: async () => assert.fail('Bad credential body retried'),
    fetchUpstream: async () => { calls++; return new Response(new ReadableStream({ start(c) { c.error(fault('ECONNRESET')); } }), { status: 401 }); } })));
  assert.equal(calls, 1);
});

test('a stream failing before its first byte retries, but a stream already delivered is never replayed', async () => {
  let calls = 0, waits = 0;
  const result = await requestModel(context({ waitForRetry: async () => { waits++; },
    fetchUpstream: async () => {
      calls++;
      return calls === 1 ? new Response(new ReadableStream({ start(c) { c.error(fault('ECONNRESET')); } })) : new Response('FIRST_BYTE_RECOVERED');
    } }));
  assert.equal(await text(result), 'FIRST_BYTE_RECOVERED'); assert.equal(calls, 2); assert.equal(waits, 1);
  calls = 0; let controller;
  const partial = await requestModel(context({ waitForRetry: async () => assert.fail('Partial model stream replayed'),
    fetchUpstream: async () => {
      calls++; return new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(Buffer.from('TOOL_CALL_ALREADY_DELIVERED')); } }));
    } }));
  const iterator = responseChunks(partial);
  assert.equal(Buffer.from((await iterator.next()).value).toString(), 'TOOL_CALL_ALREADY_DELIVERED');
  controller.error(fault('UND_ERR_SOCKET'));
  await assert.rejects(iterator.next()); assert.equal(calls, 1);
});

test('rate limits honor upstream cooldown headers with a one-minute floor and bounded jitter', async t => {
  const timestamp = Date.parse('2026-11-06T00:00:00Z');
  t.mock.method(Date, 'now', () => timestamp);
  const cases = [
    [{}, 60000],
    [{ 'retry-after': '1' }, 60000],
    [{ 'retry-after': '120' }, 120000],
    [{ 'retry-after': '90.5' }, 90500],
    [{ 'retry-after-ms': '90000' }, 90000],
    [{ 'x-ms-retry-after-ms': '75000' }, 75000],
    [{ 'retry-after-ms': '90000', 'retry-after': '120' }, 120000],
    [{ 'retry-after': new Date(timestamp + 120000).toUTCString() }, 120000],
    [{ 'retry-after': new Date(timestamp - 120000).toUTCString() }, 60000],
    [{ 'retry-after': 'invalid', 'retry-after-ms': 'invalid' }, 60000],
    [{ 'retry-after': '-1', 'retry-after-ms': '-20' }, 60000],
    [{ 'retry-after': 'Infinity', 'retry-after-ms': 'Infinity' }, 60000]
  ];
  for (const [headers, expectedMinimum] of cases) {
    const requests = [], delays = [], notifications = [];
    let cancelled = false;
    const result = await requestModel(context({
      waitForRetry: async delay => {
        assert.equal(cancelled, true);
        delays.push(delay);
      },
      onRetry: attempt => notifications.push(attempt),
      fetchUpstream: async (url, options) => {
        requests.push(options.body);
        if (requests.length > 1) return new Response('RECOVERED');
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 429, headers });
      }
    }));
    assert.equal(await text(result), 'RECOVERED');
    assert.equal(requests.length, 2);
    assert.equal(new Set(requests).size, 1);
    assert.deepEqual(notifications, [1]);
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= expectedMinimum && delays[0] <= expectedMinimum + 5000);
  }
});

test('long rate-limit cooldowns are split into valid cancellable Node timer intervals', async () => {
  const delays = [];
  let calls = 0;
  const result = await requestModel(context({
    waitForRetry: async delay => delays.push(delay),
    fetchUpstream: async () => ++calls === 1
      ? new Response('Limited', { status: 429, headers: { 'retry-after-ms': '2147490000' } })
      : new Response('RECOVERED')
  }));
  assert.equal(await text(result), 'RECOVERED');
  assert.equal(delays.length, 2);
  assert.equal(delays[0], 2147483647);
  const total = delays.reduce((sum, delay) => sum + delay, 0);
  assert.ok(total >= 2147490000 && total <= 2147495000);
});

test('rate-limit exhaustion shares the retry budget with network failures and remains terminal', async () => {
  const delays = [], notifications = [];
  let calls = 0;
  await assert.rejects(requestModel(context({
    waitForRetry: async delay => delays.push(delay),
    onRetry: attempt => notifications.push(attempt),
    fetchUpstream: async () => {
      calls++;
      if (calls === 2) throw fault('ECONNRESET');
      return new Response('private limit details', { status: calls === 3 ? 503 : 429 });
    }
  })), error => {
    assert.equal(error.code, 'DEEPMATH_NETWORK_RETRIES_EXHAUSTED');
    assert.match(error.message, /持续限流.*已重试 5 次/);
    assert.doesNotMatch(error.message, /private limit details|synthetic-private-key/);
    return true;
  });
  assert.equal(calls, 6);
  assert.equal(delays.length, 5);
  assert.ok(delays.every(delay => delay >= 60000 && delay <= 65000));
  assert.deepEqual(notifications, [1, 2, 3, 4, 5]);
});

test('a caller can cancel its rate-limit wait without affecting another request', async () => {
  const abort = new AbortController();
  let entered, callsA = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const a = requestModel(context({
    signal: abort.signal,
    waitForRetry: (...args) => { entered(args[0]); return wait(...args); },
    fetchUpstream: async () => { callsA++; return new Response('Limited', { status: 429 }); }
  }));
  const delay = await waiting;
  assert.ok(delay >= 60000 && delay <= 65000);
  const b = await requestModel(context({ fetchUpstream: async () => new Response('OTHER_ACCOUNT_OK') }));
  assert.equal(await text(b), 'OTHER_ACCOUNT_OK');
  abort.abort();
  await assert.rejects(a, { name: 'AbortError' });
  assert.equal(callsA, 1);

  let authorized = true, calls = 0;
  await assert.rejects(requestModel(context({
    authorized: () => authorized,
    waitForRetry: async () => { authorized = false; },
    fetchUpstream: async () => { calls++; return new Response('Limited', { status: 429 }); }
  })), { code: 'ABORT_ERR' });
  assert.equal(calls, 1);
});

test('cancellation and authorization revocation prevent delayed retries', async () => {
  const abort = new AbortController(); let calls = 0, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const operation = requestModel(context({ signal: abort.signal,
    waitForRetry: async (...args) => { entered(args[0]); return wait(...args); },
    fetchUpstream: async () => { calls++; throw fault('ECONNREFUSED'); } }));
  assert.equal(await waiting, 60000); abort.abort();
  await assert.rejects(operation, { name: 'AbortError' }); assert.equal(calls, 1);
  let authorized = true;
  await assert.rejects(requestModel(context({ authorized: () => authorized,
    waitForRetry: async () => { authorized = false; },
    fetchUpstream: async () => { calls++; throw fault('ENETUNREACH'); } })), { code: 'ABORT_ERR' });
  assert.equal(calls, 2);
});

test('certificate errors, arbitrary errors and cyclic causes are classified without credential-dependent messages', () => {
  assert.equal(networkError(new TypeError('fetch failed', { cause: fault('CERT_HAS_EXPIRED') })), false);
  assert.equal(networkError(new TypeError('fetch failed', { cause: fault('DEPTH_ZERO_SELF_SIGNED_CERT') })), false);
  assert.equal(networkError(new Error('synthetic-private-key')), false);
  assert.equal(networkError(new AggregateError([fault('ECONNREFUSED')], 'all attempts failed')), true);
  const cyclic = fault('EAI_AGAIN'); cyclic.cause = cyclic;
  assert.equal(networkError(cyclic), true);
});
