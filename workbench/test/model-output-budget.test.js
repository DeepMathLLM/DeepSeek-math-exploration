'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { ModelBroker } = require('../src/agent-runtime');
async function fixture(t, models, fetchUpstream, waitForRetry) {
  const names = ['AZURE_OPENAI_API_KEY', 'deepmath_models', 'deepmath_default_model', 'deepmath_model_proxy_port', 'deepmath_model_proxy_host'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { AZURE_OPENAI_API_KEY: 'synthetic-output-budget-key', deepmath_models: JSON.stringify(models),
    deepmath_default_model: models[0].id, deepmath_model_proxy_port: '0', deepmath_model_proxy_host: '127.0.0.1' });
  const broker = new ModelBroker({ fetchUpstream, waitForRetry, hybridKey: crypto.randomBytes(32) });
  t.after(() => { broker.close(); for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; });
  await broker.start(); broker.tokens.add('budget-owner');
  return body => fetch(`http://127.0.0.1:${broker.server.address().port}/v1/responses`, { method: 'POST',
    headers: { Authorization: 'Bearer budget-owner', 'Content-Type': 'application/json' }, body: JSON.stringify({
      model: models[0].apiModel, input: 'synthetic', reasoning: { effort: 'high' }, ...body }) });
}
test('Flash model budget reaches every Responses request and overrides a stale lower CLI value without changing reasoning', async t => {
  const sent = [];
  const request = await fixture(t, [{ id: 'flash', apiModel: 'FW-DeepSeek-V4.1-Flash', maxOutputTokens: 262144 }], async (url, options) => {
    sent.push(JSON.parse(options.body)); return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
  });
  for (const max_output_tokens of [undefined, null, 4096]) {
    const response = await request({ max_output_tokens }); assert.equal(response.status, 200); await response.text();
  }
  for (const body of sent) { assert.equal(body.max_output_tokens, 262144); assert.equal(body.reasoning.effort, 'high'); assert.equal(body.input, 'synthetic'); }
});
test('an unconfigured model preserves omitted and explicit caller budgets without changing upstream defaults', async t => {
  const sent = [];
  const request = await fixture(t, [{ id: 'flash', apiModel: 'FW-DeepSeek-V4.1-Flash' }], async (url, options) => {
    sent.push(JSON.parse(options.body)); return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
  });
  for (const max_output_tokens of [undefined, 2048]) await (await request({ max_output_tokens })).text();
  assert.equal(Object.hasOwn(sent[0], 'max_output_tokens'), false); assert.equal(sent[1].max_output_tokens, 2048);
});
test('a configured Pro budget maps to Chat max_tokens with the same precedence as Responses', async t => {
  let sent;
  const request = await fixture(t, [{ id: 'pro', apiModel: 'DeepSeek-V4-Pro', apiMode: 'azure-deepseek-pro-hybrid', maxOutputTokens: 32768 }], async (url, options) => {
    assert.ok(new URL(url).pathname.endsWith('/chat/completions')); sent = JSON.parse(options.body);
    return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const response = await request({ max_output_tokens: 128, stream: false }); assert.equal(response.status, 200); await response.text();
  assert.equal(sent.max_tokens, 32768); assert.equal(sent.reasoning_effort, 'high');
});
test('network retries keep the configured budget immutable and output-limit responses are never retried', async t => {
  const bodies = [], waits = [];
  const request = await fixture(t, [{ id: 'flash', apiModel: 'FW-DeepSeek-V4.1-Flash', maxOutputTokens: 262144 }], async (url, options) => {
    bodies.push(options.body);
    if (bodies.length === 1) return new Response('{"error":{"code":"too_many_requests"}}', { status: 429 });
    return new Response('data: {"type":"response.reasoning_text.delta","delta":"partial reasoning"}\n\ndata: {"type":"response.incomplete","response":{"status":"incomplete","max_output_tokens":262144,"incomplete_details":{"reason":"max_output_tokens"}}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  }, async delay => waits.push(delay));
  const response = await request({ max_output_tokens: 128, stream: true }); const wire = await response.text();
  assert.equal(bodies.length, 2); assert.equal(new Set(bodies).size, 1); assert.equal(JSON.parse(bodies[0]).max_output_tokens, 262144);
  assert.equal(waits.length, 1); assert.match(wire, /partial reasoning/); assert.match(wire, /response.incomplete/);
});
