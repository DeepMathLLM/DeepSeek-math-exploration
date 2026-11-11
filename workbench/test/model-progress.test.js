'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { requestModel, responseChunks, keepResponseAlive } = require('../src/model-transport');
const { ModelRequestScheduler } = require('../src/model-request-scheduler');
const frame = data => 'data: ' + JSON.stringify(data) + '\n\n';
const wire = '{"input":"synthetic","max_output_tokens":4096}';
async function text(result) { let output = ''; for await (const chunk of responseChunks(result)) output += Buffer.from(chunk).toString(); return output; }
function fixture(t) {
  const keepAlive = setInterval(() => {}, 50); t.after(() => clearInterval(keepAlive));
  const scheduler = new ModelRequestScheduler({ settings: { defaults: { maxConcurrent: 1, maxPerAccount: 1, continuationBurst: 2, agingMs: 15000 }, models: {} } });
  t.after(() => scheduler.close());
  const abort = new AbortController(), ticket = scheduler.ticket({ model: 'synthetic', accountId: 'A', turnKey: 'same-turn', signal: abort.signal });
  return { scheduler, ticket, abort, options: { upstream: new URL('https://synthetic.invalid/responses'), credential: 'synthetic', body: wire,
    signal: abort.signal, schedule: ticket, onDiagnostic() {}, timeouts: { headers: 30, prelude: 30, idle: 30 } } };
}
test('a send with no headers is canceled and rescheduled without failing the logical turn', async t => {
  const { ticket, options } = fixture(t); let calls = 0; const states = [];
  const result = await requestModel({ ...options, waitForRetry: async () => {}, onRetry: (failures, details) => states.push({ failures, ...details }),
    fetchUpstream: async () => ++calls === 1 ? new Promise(() => {}) : new Response('RECOVERED') });
  assert.equal(await text(result), 'RECOVERED'); assert.equal(calls, 2); assert.equal(ticket.turn.finished, false);
  assert.ok(states.every(state => state.failures === 0 && state.state === 'internal'));
});
test('heartbeats without model content cannot hold a response slot forever; other accounts run during recovery', async t => {
  const { scheduler, ticket, options } = fixture(t); let calls = 0, heartbeat, original;
  t.after(() => clearInterval(heartbeat));
  const result = await requestModel({ ...options, waitForRetry: async () => {
    const other = scheduler.ticket({ model: 'synthetic', accountId: 'B', turnKey: 'healthy', signal: new AbortController().signal });
    const permit = await other.acquire(wire); permit.release(); other.done(); scheduler.finishTurn('B', 'healthy');
  }, fetchUpstream: async () => {
    if (++calls > 1) return new Response('RECOVERED');
    return new Response(new ReadableStream({ start(controller) { original = controller; controller.enqueue(Buffer.from(frame({ type: 'response.created', response: { output: [] } })));
      heartbeat = setInterval(() => controller.enqueue(Buffer.from(': heartbeat\n\n')), 5); }, cancel() { clearInterval(heartbeat); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  assert.equal(await text(result), 'RECOVERED'); assert.equal(calls, 2); assert.equal(ticket.turn.finished, false); assert.ok(original);
});
test('a stalled delivered stream frees the slot without replaying text or tool events', async t => {
  const { scheduler, options } = fixture(t); let calls = 0;
  const result = await requestModel({ ...options, fetchUpstream: async () => {
    calls++; return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(frame({ type: 'response.output_text.delta', delta: 'PRESERVED' }))); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  const chunks = responseChunks(result); assert.match(Buffer.from((await chunks.next()).value).toString(), /PRESERVED/);
  await assert.rejects(chunks.next(), error => error.code === 'DEEPMATH_MODEL_STALLED');
  assert.equal(calls, 1); assert.equal(scheduler.pool('synthetic').active, 0);
});
test('canceling during a stalled send prevents every later send', async t => {
  const { abort, options } = fixture(t); let calls = 0;
  await assert.rejects(requestModel({ ...options, waitForRetry: async () => abort.abort(), fetchUpstream: async () => { calls++; return new Promise(() => {}); } }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('an explicit stream completion releases the slot even if the provider keeps HTTP open', async t => {
  const { scheduler, options } = fixture(t); let canceled = false;
  const completed = frame({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 4, output_tokens: 1 } } });
  const result = await requestModel({ ...options, fetchUpstream: async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from(completed));
  }, cancel() { canceled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }) });
  assert.equal(await text(result), completed); assert.equal(canceled, true); assert.equal(scheduler.pool('synthetic').active, 0);
});

test('background processing sends repeated empty comments and forwards a later error once', async t => {
  const server = require('node:http').createServer((req, res) => {
    keepResponseAlive(res, 5);
    setTimeout(() => res.writeHead(403).end('{"error":{"code":"permission_denied","message":"Denied"}}'), 30);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch('http://127.0.0.1:' + server.address().port);
  const wire = await response.text();
  assert.ok(wire.split(': internal processing').length >= 3); assert.equal(wire.split('event: response.failed').length, 2); assert.match(wire, /permission_denied/);
});
