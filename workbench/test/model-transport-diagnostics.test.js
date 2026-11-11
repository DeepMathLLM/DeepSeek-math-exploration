'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { requestModel, responseChunks } = require('../src/model-transport');
const base = extra => ({ upstream: new URL('https://secret-host.invalid/private/responses?key=DO_NOT_LOG'),
  credential: 'fixture-private-credential', body: '{"input":"private research prompt"}',
  signal: new AbortController().signal, waitForRetry: async () => {}, ...extra });
async function consume(result) { let text = ''; for await (const chunk of responseChunks(result)) text += Buffer.from(chunk).toString(); return text; }

test('429 records rate limit, delay, trace and recovery, excluding secrets and request content', async () => {
  const logs = []; let calls = 0;
  const result = await requestModel(base({ onDiagnostic: record => logs.push(record), fetchUpstream: async () => ++calls === 1
    ? new Response('SECRET provider body', { status: 429, headers: { 'Retry-After': '90', 'x-request-id': 'private-header' } }) : new Response('OK') }));
  assert.equal(await consume(result), 'OK');
  assert.equal(calls, 2);
  assert.equal(logs[0].event, 'retry');
  assert.equal(logs[0].category, 'rate_limit');
  assert.equal(logs[0].httpStatus, 429);
  assert.ok(logs[0].waitMs >= 90000 && logs[0].waitMs <= 95000);
  assert.equal(logs[1].event, 'recovered');
  assert.equal(logs[0].traceId, logs[1].traceId);
  const wire = JSON.stringify(logs);
  for (const secret of ['fixture-private-credential', 'private research prompt', 'SECRET provider body', 'secret-host', 'private-header', 'DO_NOT_LOG']) assert.ok(!wire.includes(secret));
});

test('HTTP 200 SSE no_capacity gets a distinct capacity code', async () => {
  const logs = []; let calls = 0;
  const capacity = 'data: ' + JSON.stringify({ type: 'error', error: { code: 'no_capacity', message: 'private provider text' } }) + '\n\n';
  const result = await requestModel(base({ onDiagnostic: record => logs.push(record), fetchUpstream: async () => ++calls === 1
    ? new Response(capacity, { headers: { 'Content-Type': 'text/event-stream' } }) : new Response('OK') }));
  assert.equal(await consume(result), 'OK');
  assert.equal(logs[0].httpStatus, 200);
  assert.equal(logs[0].apiCode, 'no_capacity');
  assert.equal(logs[0].category, 'capacity');
  assert.ok(!JSON.stringify(logs).includes('private provider text'));
});

test('nested connection timeout is specific and the same five-retry budget remains', async () => {
  const logs = []; let calls = 0;
  await assert.rejects(requestModel(base({ onDiagnostic: record => logs.push(record), fetchUpstream: async () => {
    calls++; throw new TypeError('fetch failed', { cause: Object.assign(new Error('private message'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
  } })), { code: 'DEEPMATH_NETWORK_RETRIES_EXHAUSTED' });
  assert.equal(calls, 6);
  assert.equal(logs.filter(record => record.event === 'retry').length, 5);
  assert.equal(logs.at(-1).event, 'exhausted');
  assert.equal(logs[0].networkCode, 'UND_ERR_CONNECT_TIMEOUT');
  assert.equal(logs[0].category, 'timeout');
  assert.ok(!JSON.stringify(logs).includes('private message'));
});

test('authentication HTTP error is logged once without changing the response or retrying', async () => {
  const logs = [];
  const result = await requestModel(base({ onDiagnostic: record => logs.push(record), fetchUpstream: async () => new Response('provider auth body', { status: 401 }) }));
  assert.equal(await consume(result), 'provider auth body');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'http_error');
  assert.equal(logs[0].httpStatus, 401);
});

test('mid-stream failure is recorded and never replays delivered output', async () => {
  const logs = []; let controller, calls = 0;
  const result = await requestModel(base({ onDiagnostic: record => logs.push(record), fetchUpstream: async () => {
    calls++; return new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(Buffer.from('DELIVERED')); } }));
  } }));
  const stream = responseChunks(result);
  assert.equal(Buffer.from((await stream.next()).value).toString(), 'DELIVERED');
  controller.error(Object.assign(new Error('private stream content'), { code: 'UND_ERR_SOCKET' }));
  await assert.rejects(stream.next());
  assert.equal(calls, 1);
  assert.equal(logs.at(-1).event, 'stream_failed');
  assert.equal(logs.at(-1).networkCode, 'UND_ERR_SOCKET');
});

test('a broken diagnostic sink cannot break request retry and recovery', async () => {
  let calls = 0;
  const result = await requestModel(base({ onDiagnostic: () => { throw new Error('sink broken'); }, fetchUpstream: async () => ++calls === 1
    ? new Response('busy', { status: 503 }) : new Response('OK') }));
  assert.equal(await consume(result), 'OK');
  assert.equal(calls, 2);
});
