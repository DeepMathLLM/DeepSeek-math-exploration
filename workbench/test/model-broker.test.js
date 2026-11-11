'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ModelBroker } = require('../src/agent-runtime');

test('model-default deployments omit inherited CLI effort without changing configured effort deployments', async t => {
  const names = ['AZURE_OPENAI_API_KEY', 'deepmath_models', 'deepmath_default_model', 'deepmath_model_proxy_port', 'deepmath_model_proxy_host'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { AZURE_OPENAI_API_KEY: 'synthetic-default-key', deepmath_model_proxy_port: '0', deepmath_model_proxy_host: '127.0.0.1',
    deepmath_default_model: 'pro', deepmath_models: JSON.stringify([
      { id: 'pro', apiModel: 'DeepSeek-V4-Pro', reasoningEffortSupported: false },
      { id: 'flash', apiModel: 'FW-DeepSeek-V4.1-Flash' }
    ]) });
  const sent = [];
  const broker = new ModelBroker({ fetchUpstream: async (url, options) => {
    sent.push(JSON.parse(options.body)); return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
  } });
  t.after(() => { broker.close(); for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; });
  await broker.start(); broker.tokens.add('default-test');
  const headers = { Authorization: 'Bearer default-test', 'Content-Type': 'application/json' };
  const url = `http://127.0.0.1:${broker.server.address().port}/v1/responses`;
  for (const reasoning of [undefined, { effort: 'high' }, { effort: 'max', summary: 'auto' }]) {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model: 'DeepSeek-V4-Pro', input: 'synthetic', reasoning }) });
    assert.equal(response.status, 200); await response.text();
  }
  for (const request of sent) assert.equal(Object.hasOwn(request.reasoning || {}, 'effort'), false);
  assert.equal(sent[1].reasoning, undefined);
  assert.deepEqual(sent[2].reasoning, { summary: 'auto' });
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model: 'FW-DeepSeek-V4.1-Flash', reasoning: { effort: 'low' } }) });
  assert.equal(response.status, 200); await response.text();
  assert.equal(sent.at(-1).reasoning.effort, 'low');
});
test('model proxy authorizes opaque tokens, restricts routes and deployment, and streams the upstream response', async (t) => {
  const originalFetch = global.fetch;
  process.env.AZURE_OPENAI_API_KEY = 'synthetic-upstream-key';
  process.env.deepmath_model_proxy_port = '0';
  process.env.deepmath_model_proxy_host = '127.0.0.1';
  const broker = new ModelBroker();
  t.after(() => { global.fetch = originalFetch; broker.close(); delete process.env.AZURE_OPENAI_API_KEY; });
  await broker.start();
  const base = `http://127.0.0.1:${broker.server.address().port}`;
  assert.equal((await originalFetch(base + '/v1/responses', { method: 'POST' })).status, 401);
  broker.tokens.add('internal-test-token');
  const headers = { Authorization: 'Bearer internal-test-token', 'Content-Type': 'application/json' };
  for (const body of ['null', '[]', 'true', '"invalid"']) {
    const response = await originalFetch(base + '/v1/responses', { method: 'POST', headers, body });
    assert.equal(response.status, 400); await response.text();
  }
  assert.equal((await originalFetch(base + '/other', { method: 'POST', headers })).status, 404);
  assert.equal((await originalFetch(base + '/v1/responses', { method: 'POST', headers, body: '{"model":"other"}' })).status, 400);
  for (const reasoning of [undefined, {}, { effort: 'ultra' }, { effort: 'max' }, { effort: 'none' }]) {
    const response = await originalFetch(base + '/v1/responses', { method: 'POST', headers,
      body: JSON.stringify({ model: 'FW-DeepSeek-V4.1-Flash', reasoning }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /not sent upstream/);
  }
  global.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/openai/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-upstream-key');
    assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).reasoning.effort, 'low');
    return new Response('data: SYNTHETIC_STREAM\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const response = await originalFetch(base + '/v1/responses', { method: 'POST', headers, body: '{"model":"FW-DeepSeek-V4.1-Flash","stream":true,"reasoning":{"effort":"low"}}' });
  assert.equal(response.status, 200); assert.equal(await response.text(), 'data: SYNTHETIC_STREAM\n\n');
  broker.tokens.clear();
  assert.equal((await originalFetch(base + '/v1/responses', { method: 'POST', headers })).status, 401);
});

test('model proxy accepts each configured API deployment and rejects display IDs and unconfigured models', async (t) => {
  const originalFetch = global.fetch;
  const saved = Object.fromEntries(['AZURE_OPENAI_API_KEY', 'deepmath_models', 'deepmath_default_model', 'deepmath_model_proxy_port', 'deepmath_model_proxy_host'].map(name => [name, process.env[name]]));
  process.env.AZURE_OPENAI_API_KEY = 'synthetic-shared-key';
  process.env.deepmath_models = JSON.stringify([{ id: 'first', displayName: 'First', apiModel: 'API_FIRST' }, { id: 'second', displayName: 'Second', apiModel: 'API_SECOND' }]);
  process.env.deepmath_default_model = 'first';
  process.env.deepmath_model_proxy_port = '0';
  process.env.deepmath_model_proxy_host = '127.0.0.1';
  const broker = new ModelBroker();
  t.after(() => {
    global.fetch = originalFetch; broker.close();
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });
  await broker.start();
  broker.tokens.add('mapping-test-token');
  const base = 'http://127.0.0.1:' + broker.server.address().port;
  const headers = { Authorization: 'Bearer mapping-test-token', 'Content-Type': 'application/json' };
  const forwarded = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body); forwarded.push(body);
    assert.equal(options.headers.Authorization, 'Bearer synthetic-shared-key');
    return new Response('data: OK\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  for (const model of ['API_FIRST', 'API_SECOND']) {
    const response = await originalFetch(base + '/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model, reasoning: { effort: 'high' } }) });
    assert.equal(response.status, 200); await response.text();
  }
  for (const model of ['first', 'Second', 'unconfigured']) {
    const response = await originalFetch(base + '/v1/responses', { method: 'POST', headers, body: JSON.stringify({ model }) });
    assert.equal(response.status, 400); await response.text();
  }
  assert.deepEqual(forwarded.map(body => body.model), ['API_FIRST', 'API_SECOND']);
  assert.deepEqual(forwarded.map(body => body.reasoning.effort), ['high', 'high']);
});

test('model proxy removes an accidentally echoed Azure key before it enters the agent, including split stream chunks', async t => {
  const originalFetch = global.fetch;
  const names = ['AZURE_OPENAI_API_KEY', 'deepmath_model_proxy_port', 'deepmath_model_proxy_host'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const key = 'synthetic-private-proxy-credential-987654321';
  process.env.AZURE_OPENAI_API_KEY = key;
  process.env.deepmath_model_proxy_port = '0';
  process.env.deepmath_model_proxy_host = '127.0.0.1';
  const broker = new ModelBroker();
  t.after(() => {
    global.fetch = originalFetch; broker.close();
    for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  });
  await broker.start();
  broker.tokens.add('response-credential-test');
  const base = 'http://127.0.0.1:' + broker.server.address().port;
  const headers = { Authorization: 'Bearer response-credential-test', 'Content-Type': 'application/json' };
  for (const stream of [false, true]) {
    const text = stream ? `data: 中文🙂 ${key}\n\ndata: OK ${key}\n\n: ordinary trailing prefix ${key.slice(0, 5)}` : JSON.stringify({ error: { message: `Provider echoed ${key}` } });
    const bytes = new TextEncoder().encode(text);
    global.fetch = async (url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${key}`);
      // One byte at a time splits both the credential and UTF-8 characters.
      return new Response(new ReadableStream({ start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      } }), { status: stream ? 200 : 400,
        headers: { 'Content-Type': (stream ? 'text/event-stream' : 'application/json') + `; charset=utf-8; unexpected=${key}`,
          'x-echoed-authorization': key, 'retry-after': stream ? '1' : key } });
    };
    const response = await originalFetch(base + '/v1/responses', { method: 'POST', headers,
      body: JSON.stringify({ model: 'FW-DeepSeek-V4.1-Flash', stream, reasoning: { effort: 'low' } }) });
    assert.equal(response.status, stream ? 200 : 400);
    assert.equal(response.headers.get('x-echoed-authorization'), null);
    assert.equal(response.headers.get('retry-after'), stream ? '1' : '[REDACTED]');
    assert.ok(!JSON.stringify([...response.headers]).includes(key));
    assert.equal(await response.text(), text.replaceAll(key, '[REDACTED]'));
  }
});

test('agent-controlled headers, body URLs and proxy failures cannot redirect or reveal host authorization', async t => {
  const originalFetch = global.fetch;
  const names = ['AZURE_OPENAI_API_KEY', 'deepmath_model_proxy_port', 'deepmath_model_proxy_host'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const key = 'synthetic-host-only-authorization';
  process.env.AZURE_OPENAI_API_KEY = key;
  process.env.deepmath_model_proxy_port = '0';
  process.env.deepmath_model_proxy_host = '127.0.0.1';
  const broker = new ModelBroker();
  t.after(() => {
    global.fetch = originalFetch; broker.close();
    for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  });
  await broker.start();
  broker.tokens.add('request-boundary-test');
  const base = 'http://127.0.0.1:' + broker.server.address().port;
  const headers = { Authorization: 'Bearer request-boundary-test', 'Content-Type': 'application/json',
    'api-key': 'attacker-supplied-key', 'x-forwarded-host': 'attacker.invalid' };
  let forwarded = 0;
  global.fetch = async (url, options) => {
    forwarded++;
    assert.equal(new URL(url).protocol, 'https:');
    assert.notEqual(new URL(url).hostname, 'attacker.invalid');
    assert.ok(new URL(url).pathname.endsWith('/openai/v1/responses'));
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` });
    throw new Error(`Unexpected transport detail contains ${key}`);
  };
  for (const route of ['/v1/responses?url=https://attacker.invalid', '/v1/responses/../config', '/v1/env', '/v1/files']) {
    const response = await originalFetch(base + route, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 404); await response.text();
  }
  assert.equal(forwarded, 0);
  const response = await originalFetch(base + '/v1/responses', { method: 'POST', headers,
    body: JSON.stringify({ model: 'FW-DeepSeek-V4.1-Flash', reasoning: { effort: 'low' },
      base_url: 'https://attacker.invalid', url: 'https://attacker.invalid', headers: { Authorization: 'attacker-supplied-key' } }) });
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.ok(!text.includes(key));
  assert.match(text, /Model request failed at the server proxy/);
  assert.equal(forwarded, 1);
});

test('concurrent account proxy streams keep effort, cancellation and token revocation independent', async t => {
  const originalFetch = global.fetch;
  const names = ['AZURE_OPENAI_API_KEY', 'deepmath_model_proxy_port', 'deepmath_model_proxy_host'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const key = 'synthetic-concurrent-account-key';
  process.env.AZURE_OPENAI_API_KEY = key;
  process.env.deepmath_model_proxy_port = '0';
  process.env.deepmath_model_proxy_host = '127.0.0.1';
  const broker = new ModelBroker(), pending = new Map(), abortA = new AbortController();
  t.after(() => {
    abortA.abort();
    for (const entry of pending.values()) try { entry.controller.close(); } catch {}
    global.fetch = originalFetch; broker.close();
    for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  });
  await broker.start();
  broker.tokens.add('token-a'); broker.tokens.add('token-b');
  const base = 'http://127.0.0.1:' + broker.server.address().port;
  const encoder = new TextEncoder(), expectedEfforts = { A: 'low', B: 'high' };
  global.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.reasoning.effort, expectedEfforts[payload.input]);
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    return new Response(new ReadableStream({ start(controller) {
      pending.set(payload.input, { controller, signal: options.signal });
      controller.enqueue(encoder.encode(`data: FIRST_${payload.input}\n\n`));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const post = (owner, signal) => originalFetch(base + '/v1/responses', { method: 'POST', signal,
    headers: { Authorization: 'Bearer token-' + owner.toLowerCase(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'FW-DeepSeek-V4.1-Flash', input: owner, stream: true, reasoning: { effort: expectedEfforts[owner] } }) });
  const [a, b] = await Promise.all([post('A', abortA.signal), post('B')]);
  const readerA = a.body.getReader(), readerB = b.body.getReader();
  // These reads complete while both upstream streams remain open.
  const first = await Promise.all([readerA.read(), readerB.read()]);
  assert.equal(new TextDecoder().decode(first[0].value), 'data: FIRST_A\n\n');
  assert.equal(new TextDecoder().decode(first[1].value), 'data: FIRST_B\n\n');
  assert.ok(first.every(chunk => !chunk.done));
  broker.tokens.delete('token-a');
  const revoked = await post('A');
  assert.equal(revoked.status, 401); await revoked.text();
  abortA.abort();
  for (let i = 0; i < 100 && !pending.get('A').signal.aborted; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(pending.get('A').signal.aborted);
  assert.equal(pending.get('B').signal.aborted, false);
  const [prefix, suffix] = [key.slice(0, 14), key.slice(14)];
  pending.get('B').controller.enqueue(encoder.encode(`data: NEXT_B ${prefix}`));
  const second = new TextDecoder().decode((await readerB.read()).value);
  assert.equal(second, 'data: NEXT_B ');
  pending.get('B').controller.enqueue(encoder.encode(`${suffix}\n\n`));
  pending.get('B').controller.close(); pending.delete('B');
  let tail = '';
  for (;;) { const chunk = await readerB.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); }
  assert.equal(tail, '[REDACTED]\n\n');
  assert.ok(broker.tokens.has('token-b'));
});

test('proxy network exhaustion is terminal after five 60-second retries and hides transport details', async t => {
  const saved = Object.fromEntries(['AZURE_OPENAI_API_KEY', 'deepmath_model_proxy_port', 'deepmath_model_proxy_host'].map(name => [name, process.env[name]]));
  process.env.AZURE_OPENAI_API_KEY = 'synthetic-retry-private-key';
  process.env.deepmath_model_proxy_port = '0'; process.env.deepmath_model_proxy_host = '127.0.0.1';
  let calls = 0; const waits = [];
  const broker = new ModelBroker({ waitForRetry: async delay => { waits.push(delay); },
    fetchUpstream: async () => { calls++; throw Object.assign(new Error('synthetic-retry-private-key'), { code: 'ECONNRESET' }); } });
  t.after(() => { broker.close(); for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  await broker.start(); broker.tokens.add('network-retry-token');
  const response = await fetch(`http://127.0.0.1:${broker.server.address().port}/v1/responses`, { method: 'POST',
    headers: { Authorization: 'Bearer network-retry-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'FW-DeepSeek-V4.1-Flash', reasoning: { effort: 'low' } }) });
  assert.equal(response.status, 422); const body = await response.json();
  assert.equal(body.error.code, 'deepmath_network_retries_exhausted');
  assert.match(body.error.message, /已重试 5 次/);
  assert.ok(!JSON.stringify(body).includes('synthetic-retry-private-key'));
  assert.equal(calls, 6); assert.deepEqual(waits, Array(5).fill(60000));
});

test('revoking an account token interrupts its retry wait while other account streams continue', async t => {
  const { setTimeout: wait } = require('node:timers/promises');
  const saved = Object.fromEntries(['AZURE_OPENAI_API_KEY', 'deepmath_model_proxy_port', 'deepmath_model_proxy_host'].map(name => [name, process.env[name]]));
  process.env.AZURE_OPENAI_API_KEY = 'synthetic-cancellable-key';
  process.env.deepmath_model_proxy_port = '0'; process.env.deepmath_model_proxy_host = '127.0.0.1';
  let entered, attemptsA = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const broker = new ModelBroker({ waitForRetry: (...args) => { entered(args[0]); return wait(...args); },
    fetchUpstream: async (url, options) => {
      if (JSON.parse(options.body).input === 'A') { attemptsA++; throw Object.assign(new Error('offline'), { code: 'ENETUNREACH' }); }
      return new Response('ACCOUNT_B_OK');
    } });
  t.after(() => { broker.close(); for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  await broker.start(); broker.tokens.add('token-a'); broker.tokens.add('token-b');
  const statuses = []; broker.retryHandlers.set('token-a', event => statuses.push(event));
  const post = owner => fetch(`http://127.0.0.1:${broker.server.address().port}/v1/responses`, { method: 'POST',
    headers: { Authorization: 'Bearer token-' + owner.toLowerCase(), 'Content-Type': 'application/json',
      'x-codex-turn-metadata': JSON.stringify({ thread_id: 'thread-' + owner, turn_id: 'turn-' + owner, unrelated: 'MUST_NOT_BE_FORWARDED' }) },
    body: JSON.stringify({ model: 'FW-DeepSeek-V4.1-Flash', input: owner, reasoning: { effort: 'high' } }) });
  const a = post('A'); assert.equal(await waiting, 60000);
  assert.equal(statuses.length, 1); assert.equal(statuses[0].retrying, true);
  assert.equal(statuses[0].threadId, 'thread-A'); assert.equal(statuses[0].turnId, 'turn-A');
  const b = await post('B'); assert.equal(await b.text(), 'ACCOUNT_B_OK');
  broker.revoke('token-a');
  const cancelled = await a; assert.equal(cancelled.status, 502); await cancelled.text();
  assert.equal(attemptsA, 1);
  assert.ok(broker.tokens.has('token-b'));
  assert.equal(statuses.length, 2); assert.equal(statuses[1].retrying, false);
  assert.equal(statuses[0].requestId, statuses[1].requestId);
  assert.ok(!JSON.stringify(statuses).includes('synthetic-cancellable-key'));
  assert.ok(!JSON.stringify(statuses).includes('MUST_NOT_BE_FORWARDED'));
});

test('proxy rate-limit exhaustion returns a terminal error after five delayed retries', async t => {
  const names = ['AZURE_OPENAI_API_KEY', 'deepmath_model_proxy_port', 'deepmath_model_proxy_host'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { AZURE_OPENAI_API_KEY: 'synthetic-rate-limit-key', deepmath_model_proxy_port: '0', deepmath_model_proxy_host: '127.0.0.1' });
  const waits = [], requests = [], notifications = [];
  const broker = new ModelBroker({
    waitForRetry: async delay => waits.push(delay),
    fetchUpstream: async (url, options) => {
      requests.push(options.body);
      return new Response('synthetic-rate-limit-key', { status: 429 });
    }
  });
  t.after(() => {
    broker.close();
    for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  });
  await broker.start();
  broker.tokens.add('limited-owner');
  broker.retryHandlers.set('limited-owner', event => notifications.push(event));
  const response = await fetch(`http://127.0.0.1:${broker.server.address().port}/v1/responses`, {
    method: 'POST', headers: { Authorization: 'Bearer limited-owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'FW-DeepSeek-V4.1-Flash', reasoning: { effort: 'high' } })
  });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error.code, 'deepmath_network_retries_exhausted');
  assert.match(body.error.message, /持续限流.*已重试 5 次/);
  assert.doesNotMatch(JSON.stringify(body), /synthetic-rate-limit-key/);
  assert.equal(requests.length, 6);
  assert.equal(new Set(requests).size, 1);
  assert.equal(waits.length, 5);
  assert.ok(waits.every(delay => delay >= 60000 && delay <= 65000));
  assert.deepEqual(notifications.map(event => event.retrying), [true, true, true, true, true, false]);
});

test('concurrent account HTTP 200 capacity-error waits, notifications and cancellation remain independent', { timeout: 5000 }, async t => {
  const names = ['AZURE_OPENAI_API_KEY', 'deepmath_model_proxy_port', 'deepmath_model_proxy_host'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { AZURE_OPENAI_API_KEY: 'synthetic-concurrent-key', deepmath_model_proxy_port: '0', deepmath_model_proxy_host: '127.0.0.1' });
  const pending = new Map(), requests = { A: [], B: [] }, notifications = { A: [], B: [] };
  let entered;
  const bothWaiting = new Promise(resolve => { entered = resolve; });
  const broker = new ModelBroker({
    waitForRetry: (delay, value, { signal }) => new Promise((resolve, reject) => {
      assert.ok(delay >= 90000 && delay <= 95000);
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      const entry = [...broker.activeRequests].find(([, requests]) => [...requests].some(request => request.signal === signal));
      const owner = entry?.[0].slice('token-'.length); assert.ok(owner === 'A' || owner === 'B');
      pending.set(owner, { signal, finish() { signal.removeEventListener('abort', onAbort); resolve(); } });
      if (pending.size === 2) entered();
    }),
    fetchUpstream: async (url, options) => {
      const owner = JSON.parse(options.body).input;
      requests[owner].push(options.body);
      return requests[owner].length === 1
        ? new Response('data: {"type":"response.created","response":{"output":[]}}\n\ndata: {"type":"error","error":{"type":"too_many_requests","code":"no_capacity","message":"Peak capacity temporarily unavailable"}}\n\n', { headers: { 'Content-Type': 'text/event-stream', 'retry-after-ms': '90000' } })
        : new Response(`RECOVERED_${owner}`);
    }
  });
  t.after(() => {
    broker.close();
    for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  });
  await broker.start();
  for (const owner of ['A', 'B']) {
    broker.tokens.add(`token-${owner}`);
    broker.retryHandlers.set(`token-${owner}`, event => notifications[owner].push(event));
  }
  const post = owner => fetch(`http://127.0.0.1:${broker.server.address().port}/v1/responses`, {
    method: 'POST', headers: {
      Authorization: `Bearer token-${owner}`, 'Content-Type': 'application/json',
      'x-codex-turn-metadata': JSON.stringify({ thread_id: `thread-${owner}`, turn_id: `turn-${owner}` })
    },
    body: JSON.stringify({ model: 'FW-DeepSeek-V4.1-Flash', input: owner, reasoning: { effort: 'high' } })
  });
  const a = post('A'), b = post('B');
  await bothWaiting;
  broker.revoke('token-A');
  const cancelled = await a;
  assert.equal(cancelled.status, 502);
  await cancelled.text();
  assert.equal(pending.get('B').signal.aborted, false);
  assert.deepEqual(notifications.B.map(event => event.retrying), [true]);
  pending.get('B').finish();
  const recovered = await b;
  assert.equal(await recovered.text(), 'RECOVERED_B');
  assert.equal(requests.A.length, 1);
  assert.equal(requests.B.length, 2);
  assert.equal(new Set(requests.B).size, 1);
  for (const owner of ['A', 'B']) {
    assert.deepEqual(notifications[owner].map(event => event.retrying), [true, false]);
    assert.ok(notifications[owner].every(event => event.threadId === `thread-${owner}` && event.turnId === `turn-${owner}`));
  }
  assert.notEqual(notifications.A[0].requestId, notifications.B[0].requestId);
});

test('Flash stream-level rate limits end with terminal 422 only after five waits, without leaking failed prelude or secret', async t => {
  const names = ['AZURE_OPENAI_API_KEY', 'deepmath_models', 'deepmath_default_model', 'deepmath_model_proxy_port', 'deepmath_model_proxy_host'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { AZURE_OPENAI_API_KEY: 'synthetic-stream-rate-key', deepmath_default_model: 'flash',
    deepmath_models: JSON.stringify([{ id: 'flash', apiModel: 'FW-DeepSeek-V4.1-Flash' }]),
    deepmath_model_proxy_port: '0', deepmath_model_proxy_host: '127.0.0.1' });
  let calls = 0; const waits = [], notifications = [];
  const broker = new ModelBroker({ waitForRetry: async delay => waits.push(delay), fetchUpstream: async () => {
    calls++;
    return new Response('data: {"type":"response.in_progress","response":{"output":[]}}\n\ndata: {"type":"error","error":{"type":"too_many_requests","code":"no_capacity","message":"synthetic-stream-rate-key"}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  t.after(() => { broker.close(); for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; });
  await broker.start(); broker.tokens.add('owner'); broker.retryHandlers.set('owner', value => notifications.push(value));
  const response = await fetch(`http://127.0.0.1:${broker.server.address().port}/v1/responses`, { method: 'POST',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json', 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'original-thread', turn_id: 'original-turn' }) },
    body: JSON.stringify({ model: 'FW-DeepSeek-V4.1-Flash', stream: true, reasoning: { effort: 'high' } }) });
  assert.equal(response.status, 422); const body = await response.text();
  assert.match(body, /持续限流.*已重试 5 次/); assert.doesNotMatch(body, /synthetic-stream-rate-key|response.in_progress|no_capacity/);
  assert.equal(calls, 6); assert.equal(waits.length, 5); assert.ok(waits.every(delay => delay >= 60000 && delay <= 65000));
  assert.deepEqual(notifications.map(event => event.retrying), [true, true, true, true, true, false]);
  assert.ok(notifications.every(event => event.threadId === 'original-thread' && event.turnId === 'original-turn'));
});

