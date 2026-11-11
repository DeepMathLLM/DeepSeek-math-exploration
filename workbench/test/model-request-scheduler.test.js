'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { ModelRequestScheduler, estimateCost } = require('../src/model-request-scheduler');
const { requestModel, responseChunks } = require('../src/model-transport');
function clock() {
  let at = 0; const timers = new Set();
  return { now: () => at, setTimer(fn, ms) { const timer = { at: at + ms, fn, unref() {} }; timers.add(timer); return timer; },
    clearTimer: timer => timers.delete(timer), advance(ms) {
      const until = at + ms; let n = 0;
      for (;;) { const next = [...timers].filter(timer => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break; if (++n > 1000) throw Error('Timer loop'); timers.delete(next); at = next.at; next.fn(); }
      at = until;
    } };
}
const body = JSON.stringify({ model: 'pro', input: 'Synthetic prompt', max_output_tokens: 4096 });
function setup(t, model = {}) {
  const time = clock();
  const scheduler = new ModelRequestScheduler({ ...time, settings: {
    defaults: { maxConcurrent: 1, maxPerAccount: 1, continuationBurst: 2, agingMs: 15000 }, models: { pro: model } } });
  t.after(() => scheduler.close());
  const make = (accountId, turnKey, modelName = 'pro') => {
    const abort = new AbortController();
    const ticket = scheduler.ticket({ model: modelName, accountId, turnKey, signal: abort.signal });
    return { abort, ticket, take: (wire = body) => { const pending = ticket.acquire(wire); pending.catch(() => {}); return pending; } };
  };
  return { scheduler, time, make };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function consume(result) { let value = ''; for await (const chunk of responseChunks(result)) value += Buffer.from(chunk).toString(); return value; }

test('light traffic is admitted immediately; a whole response retains its permit', async t => {
  const { make, time } = setup(t);
  const a = make('A', 'turn-a'), b = make('B', 'turn-b');
  const first = await a.take(); let second;
  const pending = b.take().then(permit => { second = permit; });
  await flush(); assert.equal(second, undefined); assert.equal(time.now(), 0);
  first.release(); await pending; assert.ok(second); assert.equal(time.now(), 0); second.release();
});

test('all projects of one account share their debit; many Agents cannot bypass another account', async t => {
  const { make } = setup(t); const order = [];
  const first = await make('A', 'project-one').take();
  const pending = [make('A', 'project-two'), make('A', 'project-three'), make('B', 'project-four'), make('C', 'project-five')]
    .map((request, i) => request.take().then(permit => { order.push(['A2', 'A3', 'B', 'C'][i]); permit.release(); }));
  first.release(); await Promise.all(pending);
  assert.deepEqual(order, ['B', 'C', 'A2', 'A3']);
});

test('minute reservations survive response completion and wake exactly when enough budget returns', async t => {
  const cost = estimateCost(body), { make, time } = setup(t, { tpm: cost * 2, utilization: 1 });
  (await make('A', 'a').take()).release(); time.advance(20000);
  (await make('B', 'b').take()).release();
  let permit; const pending = make('C', 'c').take().then(value => { permit = value; });
  await flush(); assert.equal(permit, undefined);
  time.advance(39999); await flush(); assert.equal(permit, undefined);
  time.advance(1); await pending; assert.equal(time.now(), 60000); permit.release();
});

test('ten accounts can each progress within a minute when the budget permits, without fixed waits', async t => {
  const { make, time } = setup(t, { tpm: estimateCost(body) * 10, utilization: 1 });
  const ran = [];
  await Promise.all(Array.from({ length: 10 }, (_, i) => make('account-' + i, 'turn').take().then(permit => { ran.push(i); permit.release(); })));
  assert.equal(new Set(ran).size, 10); assert.equal(time.now(), 0);
});

test('throttled turns retain recovery priority across HTTP responses and tool gaps until explicit completion', async t => {
  const { make, time, scheduler } = setup(t);
  const a = make('A', 'logical-turn'), first = await a.take();
  let bPermit; const b = make('B', 'b').take().then(permit => { bPermit = permit; });
  a.ticket.throttle(2000); first.release();
  let retryPermit; const retry = a.take().then(permit => { retryPermit = permit; });
  time.advance(1999); await flush(); assert.equal(bPermit, undefined); assert.equal(retryPermit, undefined);
  time.advance(1); await retry; assert.ok(retryPermit); assert.equal(bPermit, undefined);
  a.ticket.done(); assert.equal(a.ticket.turn.finished, false);
  const continuation = make('A', 'logical-turn'); let continued;
  const next = continuation.take().then(permit => { continued = permit; });
  retryPermit.release(); await next; assert.ok(continued); assert.equal(bPermit, undefined);
  assert.equal(continuation.ticket.turn.limited, true);
  scheduler.finishTurn('A', 'logical-turn'); continued.release(); await b; bPermit.release();
  assert.equal(continuation.ticket.turn.finished, true);
});

test('tools do not occupy a model slot, and separate deployments do not block each other', async t => {
  const { make } = setup(t);
  const a = await make('A', 'a').take();
  const flash = await make('B', 'b', 'flash').take(); flash.release();
  a.release(); // A's tool now runs, no terminal turn event has happened.
  const b = await make('B', 'new-turn').take(); b.release();
});

test('canceling a queued account removes its request, without blocking or canceling others', async t => {
  const { make } = setup(t);
  const held = await make('A', 'a').take(), canceled = make('B', 'b');
  const canceledResult = assert.rejects(canceled.take(), { name: 'AbortError' });
  let c; const next = make('C', 'c').take().then(permit => { c = permit; });
  canceled.abort.abort(); await canceledResult;
  held.release(); await next; c.release(); assert.equal(canceled.ticket.turn.finished, true);
});

test('canceling during provider cooldown clears the owner reservation; provider cooldown still applies', async t => {
  const { make, time } = setup(t);
  const a = make('A', 'a'), held = await a.take(); a.ticket.throttle(2000); held.release();
  a.abort.abort(); a.ticket.done(); assert.equal(a.ticket.turn.recovering, false);
  let b; const pending = make('B', 'b').take().then(permit => { b = permit; });
  time.advance(2000); await pending; b.release();
});

test('actual usage corrects fair account debit and calibrates future input estimates', async t => {
  const { make, scheduler } = setup(t), a = await make('A', 'a').take();
  a.observe({ input_tokens: 100, output_tokens: 12, input_tokens_details: { cached_tokens: 98 } }); a.release();
  const pool = scheduler.pool('pro');
  assert.equal(pool.ledger[0].fairCost, 112); assert.ok(Number.isFinite(pool.inputRatio));
  assert.ok(pool.ledger[0].cost >= estimateCost(body));
});

test('more than five quota deferrals use background scheduling, preserve the body and never consume failure retries', async t => {
  const { make, time } = setup(t), a = make('A', 'a'); const notifications = [], sent = [];
  const result = await requestModel({ upstream: new URL('https://synthetic.invalid/responses'), credential: 'synthetic-secret',
    body, signal: a.abort.signal, schedule: a.ticket, onDiagnostic() {}, onRetry: (failures, details) => notifications.push({ failures, ...details }),
    waitForRetry: async delay => time.advance(delay), fetchUpstream: async (url, options) => {
      sent.push(options.body); return sent.length <= 8 ? new Response('Limited', { status: 429, headers: { 'Retry-After': '2' } }) : new Response('RECOVERED');
    } });
  assert.equal(await consume(result), 'RECOVERED'); a.ticket.done();
  assert.equal(sent.length, 9); assert.equal(new Set(sent).size, 1);
  assert.ok(notifications.every(item => item.failures === 0 && item.state === 'internal' && item.deferred));
  assert.equal(a.ticket.turn.finished, false);
});

test('recoverable connection errors also return to scheduling, with only the network UI state', async t => {
  const { make, time } = setup(t), a = make('A', 'a'); let calls = 0; const states = [];
  const result = await requestModel({ upstream: new URL('https://synthetic.invalid/responses'), credential: 'synthetic-secret', body,
    signal: a.abort.signal, schedule: a.ticket, onDiagnostic() {}, onRetry: (failures, details) => states.push({ failures, ...details }),
    waitForRetry: async delay => time.advance(delay), fetchUpstream: async () => {
      if (++calls <= 7) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }); return new Response('OK');
    } });
  assert.equal(await consume(result), 'OK'); assert.equal(calls, 8);
  assert.ok(states.every(state => state.failures === 0 && state.state === 'network'));
});

test('user cancellation during background deferral prevents every later send', async t => {
  const { make } = setup(t), a = make('A', 'a'); let calls = 0;
  await assert.rejects(requestModel({ upstream: new URL('https://synthetic.invalid/responses'), credential: 'synthetic-secret', body,
    signal: a.abort.signal, schedule: a.ticket, onDiagnostic() {}, waitForRetry: async () => a.abort.abort(),
    fetchUpstream: async () => { calls++; return new Response('Limited', { status: 429 }); } }), { name: 'AbortError' });
  a.ticket.done(); assert.equal(calls, 1); assert.equal(a.ticket.turn.finished, true);
});

test('partial delivered output is never replayed, and cancellation of its stream releases the permit', async t => {
  const { make } = setup(t), a = make('A', 'a'); let stream, calls = 0;
  const result = await requestModel({ upstream: new URL('https://synthetic.invalid/responses'), credential: 'synthetic-secret', body,
    signal: a.abort.signal, schedule: a.ticket, onDiagnostic() {}, fetchUpstream: async () => {
      calls++; return new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(Buffer.from('PARTIAL')); } }));
    } });
  const chunks = responseChunks(result); assert.equal(Buffer.from((await chunks.next()).value).toString(), 'PARTIAL');
  let b; const pending = make('B', 'b').take().then(permit => { b = permit; });
  stream.error(Object.assign(new Error('socket lost'), { code: 'ECONNRESET' }));
  await assert.rejects(chunks.next()); await pending; b.release(); assert.equal(calls, 1);
});

test('permanent authentication errors pass through once instead of occupying the background queue forever', async t => {
  const { make } = setup(t), a = make('A', 'a'); let calls = 0;
  const result = await requestModel({ upstream: new URL('https://synthetic.invalid/responses'), credential: 'synthetic-secret', body,
    signal: a.abort.signal, schedule: a.ticket, onDiagnostic() {}, fetchUpstream: async () => { calls++; return new Response('Denied', { status: 401 }); } });
  assert.equal(result.response.status, 401); assert.equal(await consume(result), 'Denied'); assert.equal(calls, 1);
});

test('six accounts with three Agents each share by account, and canceling one Agent does not remove its siblings', async t => {
  const { make } = setup(t, { maxConcurrent: 2 });
  const a0 = await make('A', 'agent-0').take(), a1 = await make('A', 'agent-1').take();
  const order = [];
  const a2 = make('A', 'agent-2').take().then(permit => { order.push('A'); permit.release(); });
  const all = [];
  for (const owner of ['B', 'C', 'D', 'E', 'F']) for (let agent = 0; agent < 3; agent++) {
    const request = make(owner, 'agent-' + agent);
    if (owner === 'B' && agent === 1) {
      all.push(assert.rejects(request.take(), { name: 'AbortError' })); request.abort.abort();
    } else all.push(request.take().then(permit => { order.push(owner); permit.release(); }));
  }
  a0.release(); a1.release(); await Promise.all([a2, ...all]);
  assert.equal(order.filter(owner => owner === 'B').length, 2);
  assert.deepEqual(new Set(order.slice(0, 5)), new Set(['B', 'C', 'D', 'E', 'F']));
  for (const owner of ['C', 'D', 'E', 'F']) assert.equal(order.filter(item => item === owner).length, 3);
});

test('an aged large request can accumulate quota instead of being starved by small requests', async t => {
  const small = estimateCost(body), largeBody = JSON.stringify({ model: 'pro', input: 'x'.repeat(9000), max_output_tokens: 4096 });
  const large = estimateCost(largeBody), { make, time } = setup(t, { tpm: large + small, maxConcurrent: 1 });
  (await make('used', 'one').take()).release();
  (await make('used', 'two').take()).release();
  let big; const largeRequest = make('new-account', 'large').take(largeBody).then(permit => { big = permit; });
  time.advance(15000);
  let tiny; const smallRequest = make('busy-account', 'small').take().then(permit => { tiny = permit; });
  await flush(); assert.equal(big, undefined); assert.equal(tiny, undefined);
  time.advance(45000); await largeRequest; assert.ok(big); assert.equal(tiny, undefined);
  big.release(); await smallRequest; tiny.release();
});

test('rate feedback reduces concurrent sends and sustained complete responses reopen spare capacity', async t => {
  const { make, scheduler, time } = setup(t, { maxConcurrent: 8 });
  const request = make('A', 'turn'); const permit = await request.take(); request.ticket.throttle(2000);
  assert.equal(scheduler.pool('pro').dynamicMax, 4); permit.release(); time.advance(2000);
  for (let i = 0; i < 4; i++) { const next = await request.take(); next.accepted(); next.completed(); next.release(); }
  assert.equal(scheduler.pool('pro').dynamicMax, 5);
});

test('a throttled Controller shares continuation priority with its account Agents instead of starving a dependency', async t => {
  const { make, time } = setup(t);
  const controller = make('A', 'controller'), first = await controller.take();
  controller.ticket.throttle(1000); first.release(); time.advance(1000);
  const retry = await controller.take();
  let childPermit, parentPermit, otherPermit;
  const child = make('A', 'dependent-agent').take().then(permit => { childPermit = permit; });
  const parent = controller.take().then(permit => { parentPermit = permit; });
  const other = make('B', 'controller').take().then(permit => { otherPermit = permit; });
  retry.release(); await child;
  assert.ok(childPermit); assert.equal(parentPermit, undefined); assert.equal(otherPermit, undefined);
  childPermit.release(); await parent; assert.ok(parentPermit);
  parentPermit.release(); await other; otherPermit.release();
});

test('a missing retry retains its logical round but cannot reserve the pool indefinitely', async t => {
  const { make, time } = setup(t);
  const a = make('A', 'recovering'), first = await a.take(); a.ticket.throttle(2000); first.release();
  let admitted; const b = make('B', 'healthy').take().then(permit => { admitted = permit; });
  time.advance(2000); await flush(); assert.equal(admitted, undefined);
  time.advance(1000); await b; admitted.release();
  assert.equal(a.ticket.turn.finished, false); assert.equal(a.ticket.turn.limited, true);
  const continuation = await a.take(); continuation.release();
});

test('an old account receives service even when another account continuously continues a throttled round', async t => {
  const { make, time } = setup(t), a = make('A', 'long-round'); let held = await a.take();
  a.ticket.throttle(1); time.advance(1);
  let other; const b = make('B', 'old-request').take().then(permit => { other = permit; });
  for (let index = 0; index < 4; index++) {
    const next = a.take(); held.release(); held = await next; time.advance(10000);
  }
  const next = a.take(); held.release(); held = await next;
  time.advance(5000); let continued; const following = a.take().then(permit => { continued = permit; });
  held.release(); await b; assert.ok(other); assert.equal(continued, undefined);
  assert.equal(a.ticket.turn.finished, false); other.release(); await following; continued.release();
});

test('a tool continuation keeps its round identity after another account uses the model slot', async t => {
  const { make } = setup(t), a = make('A', 'one-native-turn'); (await a.take()).release();
  const sibling = await make('B', 'uses-tool-gap').take();
  let fresh; const freshRequest = make('C', 'new-task').take().then(permit => { fresh = permit; });
  const previous = a.ticket.turn; a.ticket.done();
  const continuation = make('A', 'one-native-turn'); let continued;
  const pending = continuation.take().then(permit => { continued = permit; });
  sibling.release(); await pending;
  assert.equal(continuation.ticket.turn, previous); assert.equal(fresh, undefined);
  continued.release(); await freshRequest; fresh.release();
});

test('all long-pending accounts rotate by their last opportunity, including multiple Agents', async t => {
  const { make, time } = setup(t), held = await make('busy', 'held').take(), order = [];
  const requests = [];
  for (const account of ['A', 'B', 'C']) for (let index = 0; index < 3; index++) {
    requests.push(make(account, 'agent-' + index).take().then(permit => { order.push(account); permit.release(); }));
  }
  time.advance(45000); held.release(); await Promise.all(requests);
  assert.deepEqual(order.slice(0, 3), ['A', 'B', 'C']);
});

test('permanent quota errors carried by HTTP 429 leave the scheduler instead of cooling down all accounts', async t => {
  const { make, scheduler } = setup(t), request = make('A', 'permanent'); let sent = 0;
  const result = await requestModel({ upstream: new URL('https://synthetic.invalid/responses'), credential: 'synthetic', body, signal: request.abort.signal,
    schedule: request.ticket, onDiagnostic() {}, waitForRetry: async () => assert.fail('Permanent quota was deferred'),
    fetchUpstream: async () => { sent++; return Response.json({ error: { code: 'insufficient_quota', message: 'Billing quota exhausted' } }, { status: 429 }); } });
  assert.equal(result.response.status, 429); assert.match(await consume(result), /insufficient_quota/); request.ticket.done();
  assert.equal(sent, 1); assert.equal(scheduler.pool('pro').cooldown, 0);
  (await make('B', 'healthy').take()).release();
});

test('HTTP 500 and pre-content server-error events keep the same round and return through the scheduler', async t => {
  const { make, time } = setup(t), request = make('A', 'same-round'); let sent = 0; const states = [];
  const result = await requestModel({ upstream: new URL('https://synthetic.invalid/responses'), credential: 'synthetic', body, signal: request.abort.signal,
    schedule: request.ticket, onDiagnostic() {}, onRetry: (failures, details) => states.push({ failures, ...details }), waitForRetry: async delay => time.advance(delay),
    fetchUpstream: async () => {
      sent++;
      if (sent === 1) return new Response('Temporary upstream error', { status: 500 });
      if (sent === 2) return new Response('data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"temporary"}}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response('RECOVERED');
    } });
  assert.equal(await consume(result), 'RECOVERED'); assert.equal(sent, 3); assert.equal(request.ticket.turn.finished, false);
  assert.ok(states.every(value => value.failures === 0 && value.state === 'internal'));
});

test('one old Agent request cannot be starved by newly created Agents in the same protected account', async t => {
  const { make, time } = setup(t), controller = make('A', 'controller'); let held = await controller.take();
  controller.ticket.throttle(1); time.advance(1);
  const recovery = controller.take(); held.release(); held = await recovery;
  const old = make('A', 'existing-agent'); old.ticket.turn.calls = 1; old.ticket.turn.lastGranted = 100;
  let oldPermit; const oldRequest = old.take().then(permit => { oldPermit = permit; });
  for (let index = 0; index < 4; index++) {
    const fresh = make('A', 'new-agent-' + index).take(); held.release(); held = await fresh; time.advance(10000);
  }
  assert.equal(oldPermit, undefined); time.advance(5000);
  let freshPermit; const fresh = make('A', 'new-agent-after-45s').take().then(permit => { freshPermit = permit; });
  held.release(); await oldRequest; assert.ok(oldPermit); assert.equal(freshPermit, undefined);
  oldPermit.release(); await fresh; freshPermit.release();
});
