'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ModelBroker } = require('../src/agent-runtime');
const { toolMap, toMessages, seal, unseal, expandForResponses, responsesReasoningInput } = require('../src/hybrid-responses');
const { normalizeModelConfig } = require('../src/model-config');
function chatStream({ reasoning = '真实推理🙂', content = 'FINAL_OK', calls = [], finish = calls.length ? 'tool_calls' : 'stop', tokens = 15 } = {}) {
  const chunks = [];
  for (const part of reasoning) chunks.push({ choices: [{ delta: { reasoning_content: part }, finish_reason: null }] });
  for (const part of content) chunks.push({ choices: [{ delta: { content: part }, finish_reason: null }] });
  for (const [index, call] of calls.entries()) chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: 'upstream-id', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) } }] }, finish_reason: null }] });
  chunks.push({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: tokens, completion_tokens: 4, total_tokens: tokens + 4 } });
  const bytes = new TextEncoder().encode(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n');
  return new Response(new ReadableStream({ start(controller) { for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
async function fixture(t, fetchUpstream) {
  const names = ['AZURE_OPENAI_API_KEY', 'deepmath_models', 'deepmath_default_model', 'deepmath_model_proxy_host', 'deepmath_model_proxy_port'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { AZURE_OPENAI_API_KEY: 'synthetic-secret-123456789', deepmath_default_model: 'pro',
    deepmath_models: JSON.stringify([{ id: 'pro', apiModel: 'DeepSeek-V4-Pro', apiMode: 'azure-deepseek-pro-hybrid', webSearch: true }, { id: 'flash', apiModel: 'FW-DeepSeek-V4.1-Flash' }]),
    deepmath_model_proxy_host: '127.0.0.1', deepmath_model_proxy_port: '0' });
  const key = crypto.randomBytes(32), broker = new ModelBroker({ fetchUpstream, hybridKey: key });
  await broker.start(); broker.tokens.add('owner-a'); broker.tokens.add('owner-b');
  broker.tokenScopes.set('owner-a', 'project-a'); broker.tokenScopes.set('owner-b', 'project-b');
  t.after(() => { broker.close(); for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; });
  const request = (body, token = 'owner-a', thread = 'thread-a') => fetch(`http://127.0.0.1:${broker.server.address().port}/v1/responses`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-codex-turn-metadata': JSON.stringify({ thread_id: thread }) },
    body: JSON.stringify({ model: 'DeepSeek-V4-Pro', reasoning: { effort: 'high' }, input: 'hello', stream: false, ...body }) });
  return { broker, key, request };
}
test('hybrid config is opt-in per model with high and max request choices', () => {
  const catalog = normalizeModelConfig({ models: [{ id: 'pro', apiModel: 'DeepSeek-V4-Pro', apiMode: 'azure-deepseek-pro-hybrid' }, { id: 'flash', apiModel: 'FW-DeepSeek-V4.1-Flash' }] });
  assert.equal(catalog.models[0].reasoningEffort, 'high'); assert.deepEqual(catalog.models[0].reasoningEfforts, ['high', 'max']);
  assert.equal(catalog.models[1].apiMode, 'responses');
  assert.equal(normalizeModelConfig({ models: [{ id: 'pro', apiModel: 'Pro', apiMode: 'azure-deepseek-pro-hybrid', reasoningEffort: 'max' }] }).models[0].reasoningEffort, 'max');
  assert.throws(() => normalizeModelConfig({ models: [{ id: 'pro', apiModel: 'Pro', apiMode: 'azure-deepseek-pro-hybrid', reasoningEfforts: ['high', 'medium'] }] }));
});

test('invalid custom-tool arguments are immediately fed back to the model before any tool executes', async t => {
  const sent = [];
  const { request } = await fixture(t, async (url, options) => {
    const body = JSON.parse(options.body); sent.push(body);
    if (sent.length === 1) return chatStream({ content: '', calls: [{ name: 'apply_patch', arguments: {} }] });
    const feedback = JSON.parse(body.messages.at(-1).content);
    assert.equal(feedback.executed, false); assert.match(feedback.error, /input.*required/);
    assert.equal(body.messages.at(-1).tool_call_id, body.messages.at(-2).tool_calls[0].id);
    return chatStream({ content: '', calls: [{ name: 'apply_patch', arguments: { input: 'VALID_PATCH' } }] });
  });
  const response = await request({ tools: [{ type: 'custom', name: 'apply_patch' }] });
  assert.equal(response.status, 200); const value = await response.json();
  const calls = value.output.filter(item => item.type === 'custom_tool_call');
  assert.equal(calls.length, 1); assert.equal(calls[0].input, 'VALID_PATCH'); assert.equal(sent.length, 2);
});

test('unknown tool aliases return declared names to the model without enabling an unknown tool', async t => {
  let count = 0;
  const { request } = await fixture(t, async (url, options) => {
    const body = JSON.parse(options.body); count++;
    if (count === 1) return chatStream({ content: '', calls: [{ name: 'apply_patch', arguments: { input: 'patch' } }] });
    const feedback = JSON.parse(body.messages.at(-1).content);
    assert.equal(feedback.executed, false); assert.ok(feedback.available_tools.includes(body.tools[0].function.name));
    return chatStream({ content: '', calls: [{ name: body.tools[0].function.name, arguments: { input: 'CORRECTED' } }] });
  });
  const response = await request({ tools: [{ type: 'namespace', name: 'editing', tools: [{ type: 'custom', name: 'apply_patch' }] }] });
  assert.equal(response.status, 200); const value = await response.json();
  const call = value.output.find(item => item.type === 'custom_tool_call');
  assert.equal(call.namespace, 'editing'); assert.equal(call.name, 'apply_patch'); assert.equal(call.input, 'CORRECTED'); assert.equal(count, 2);
});

test('a malformed batch sends a result for every call ID and never partially executes its valid siblings', async t => {
  let count = 0;
  const { request } = await fixture(t, async (url, options) => {
    const body = JSON.parse(options.body); count++;
    if (count === 1) return chatStream({ content: '', calls: [{ name: 'inspect', arguments: {} }, { name: 'apply_patch', arguments: {} }] });
    const feedback = body.messages.slice(-2);
    assert.ok(feedback.every(item => item.role === 'tool' && JSON.parse(item.content).executed === false));
    assert.equal(new Set(feedback.map(item => item.tool_call_id)).size, 2);
    return chatStream({ content: 'Corrected response' });
  });
  const response = await request({ tools: [{ type: 'function', name: 'inspect', parameters: { type: 'object' } }, { type: 'custom', name: 'apply_patch' }] });
  assert.equal(response.status, 200); const value = await response.json();
  assert.ok(!value.output.some(item => /tool_call|function_call/.test(item.type))); assert.equal(count, 2);
});
test('hybrid translates namespaces, custom tools, images and IDs without injecting routing messages', () => {
  const mapping = toolMap([{ type: 'namespace', name: 'research', tools: [{ type: 'function', name: 'inspect', parameters: { type: 'object', properties: {} } }] }, { type: 'custom', name: 'apply_patch' }]);
  const key = crypto.randomBytes(32);
  const messages = toMessages({ instructions: 'policy', input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'trusted guidance' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'task' }, { type: 'input_image', image_url: 'https://example.com/image.png' }] },
    { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'reason' }] },
    { type: 'function_call', namespace: 'research', name: 'inspect', call_id: 'call-one', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-one', output: 'result' },
    { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call-two', input: 'patch' },
    { type: 'custom_tool_call_output', call_id: 'call-two', output: 'done' }
  ] }, mapping, key, 'scope');
  assert.equal(messages[0].role, 'system'); assert.equal(messages[0].content, 'policy\n\ntrusted guidance'); assert.equal(messages[1].content[1].type, 'image_url');
  assert.equal(messages[2].reasoning_content, 'reason'); assert.equal(messages[2].tool_calls[0].id, 'call-one');
  assert.equal(messages[3].tool_call_id, 'call-one'); assert.deepEqual(JSON.parse(messages[4].tool_calls[0].function.arguments), { input: 'patch' });
  const carried = seal({ version: 1, messages, toolIdentities: [...mapping.byAlias.values()].map(({ alias, name, namespace, type }) => ({ alias, name, namespace, type })) }, key, 'scope');
  const expanded = expandForResponses({ tools: [], input: [{ type: 'reasoning', encrypted_content: carried }] }, key, 'scope');
  assert.ok(expanded.input.some(item => item.type === 'custom_tool_call_output' && item.call_id === 'call-two'));
  assert.ok(expanded.input.some(item => item.type === 'function_call' && item.namespace === 'research' && item.name === 'inspect'));
});
test('hybrid preserves native tool-loop context across token renewal and rejects other projects and tampering before inference', async t => {
  const received = [];
  const { request, broker } = await fixture(t, async (url, options) => {
    const body = JSON.parse(options.body); received.push(body);
    assert.equal(new URL(url).pathname, '/openai/v1/chat/completions'); assert.equal(body.reasoning_effort, 'high');
    return received.length === 1 ? chatStream({ calls: [{ name: 'inspect', arguments: { task: 'check' } }], content: 'checking' }) : chatStream();
  });
  const tools = [{ type: 'function', name: 'inspect', parameters: { type: 'object', properties: { task: { type: 'string' } } } }];
  const first = await (await request({ tools })).json();
  assert.equal(first.status, 'completed'); assert.equal(first.output[1].phase, 'commentary');
  const call = first.output.find(item => item.type === 'function_call'); assert.equal(call.name, 'inspect');
  const input = [{ type: 'message', role: 'user', content: 'original' }, ...first.output, { type: 'function_call_output', call_id: call.call_id, output: 'verified' }];
  broker.tokens.add('renewed'); broker.tokenScopes.set('renewed', 'project-a'); broker.revoke('owner-a');
  const final = await (await request({ tools, input }, 'renewed')).json();
  assert.equal(final.output[1].phase, 'final_answer');
  const assistant = received[1].messages.find(message => message.tool_calls);
  assert.equal(assistant.reasoning_content, '真实推理🙂'); assert.equal(assistant.tool_calls[0].id, call.call_id);
  assert.equal(received[1].messages.filter(message => message.role === 'assistant').length, 1);
  assert.equal((await request({ tools, input }, 'owner-b')).status, 400);
  assert.equal((await request({ tools, input }, 'renewed', 'other-thread')).status, 400);
  const tampered = structuredClone(input); tampered[1].encrypted_content = tampered[1].encrypted_content.slice(0, -8) + 'AAAAAAAA';
  assert.equal((await request({ tools, input: tampered }, 'renewed')).status, 400);
  assert.equal(received.length, 2);
});
test('hybrid hosted search stays in the proxy and returns to the thinking model; context usage uses the latest chat prompt', async t => {
  const received = [];
  const { request } = await fixture(t, async (url, options) => {
    const body = JSON.parse(options.body); received.push({ route: new URL(url).pathname, body });
    if (new URL(url).pathname.endsWith('/responses')) {
      assert.equal(body.tools[0].type, 'web_search'); assert.equal(body.reasoning, undefined);
      return Response.json({ status: 'completed', output: [{ type: 'web_search_call', status: 'completed' }, { type: 'message', content: [{ type: 'output_text', text: 'source https://python.org', annotations: [{ type: 'url_citation', url: 'https://python.org', title: 'Python' }] }] }] });
    }
    if (received.length === 1) return chatStream({ content: '', calls: [{ name: 'deepmath_hosted_web_search', arguments: { action: 'search', query: 'Python' } }] });
    assert.ok(body.messages.some(message => message.role === 'tool' && message.content.includes('python.org')));
    return chatStream({ content: 'https://python.org', tokens: 31 });
  });
  const response = await (await request({ tools: [{ type: 'web_search' }] })).json();
  assert.equal(response.status, 'completed'); assert.equal(response.output.find(item => item.type === 'web_search_call').status, 'completed');
  assert.equal(response.usage.input_tokens, 31); assert.equal(received.length, 3);
  assert.ok(!response.output.some(item => item.type === 'function_call'));
});
test('hybrid streams all received reasoning and redacts a key split across semantic deltas', async t => {
  const key = 'synthetic-secret-123456789';
  const { request } = await fixture(t, async () => chatStream({ reasoning: 'reason🙂' + key + 'end', content: 'body ' + key + ' end' }));
  const response = await request({ stream: true }); const wire = await response.text();
  assert.doesNotMatch(wire, new RegExp(key));
  const events = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.equal(events.filter(event => event.type === 'response.reasoning_text.delta').map(event => event.delta).join(''), 'reason🙂[REDACTED]end');
  assert.equal(events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta).join(''), 'body [REDACTED] end');
  assert.equal(events.at(-1).type, 'response.completed');
});
test('hybrid reports output limits as failure and retains partial output', async t => {
  const { request } = await fixture(t, async () => chatStream({ finish: 'length', content: 'partial' }));
  const wire = await (await request({ stream: true })).text();
  assert.match(wire, /response.failed/); assert.match(wire, /model_output_limit/); assert.match(wire, /partial/);
});
test('hybrid context ciphertext is authenticated and scoped', () => {
  const key = crypto.randomBytes(32), blob = seal({ version: 1, messages: [{ role: 'tool', content: 'private project result' }] }, key, 'account/project/thread');
  assert.ok(!blob.includes('private project result')); assert.equal(unseal(blob, key, 'account/project/thread').messages.length, 1);
  assert.throws(() => unseal(blob, key, 'another/project/thread'));
});

test('switching to the original Responses path restores carried history without sending private ciphertext', async t => {
  let history; const chats = [];
  const { request } = await fixture(t, async (url, options) => {
    const body = JSON.parse(options.body);
    if (new URL(url).pathname.endsWith('/chat/completions')) { chats.push(body); return chatStream(); }
    history = body;
    assert.ok(!body.input.some(item => item.type === 'reasoning' && item.content?.length), 'Azure rejects nonempty reasoning.content in input');
    return Response.json({ status: 'completed', output: [] });
  });
  const first = await (await request({})).json();
  const response = await request({ model: 'FW-DeepSeek-V4.1-Flash', input: first.output, tools: [{ type: 'web_search' }] });
  assert.equal(response.status, 200); await response.text();
  assert.ok(history.input.some(item => item.type === 'message' && item.content === 'FINAL_OK'));
  assert.ok(history.input.some(item => item.type === 'reasoning' && item.summary.some(part => part.type === 'summary_text' && part.text === '真实推理🙂')));
  assert.ok(!JSON.stringify(history).includes('dmhy1.')); assert.deepEqual(history.tools, []);
  const back = await request({ input: [...first.output, { role: 'user', content: 'continue' }] }); await back.json();
  assert.equal(chats[1].messages.find(message => message.role === 'assistant').reasoning_content, '真实推理🙂');
  assert.equal(first.output[0].content[0].text, '真实推理🙂', 'Provider conversion must not overwrite saved raw reasoning');
});

test('Responses reasoning input accepts old raw items without changing messages, opaque state or saved data', () => {
  const input = [
    { type: 'reasoning', id: 'old', content: [{ type: 'reasoning_text', text: 'full reasoning' }], summary: [{ type: 'summary_text', text: 'summary' }], encrypted_content: 'opaque-provider-state' },
    { type: 'message', role: 'assistant', content: 'visible answer' },
    { type: 'function_call_output', call_id: 'original-call', output: 'original-result' }
  ];
  const saved = structuredClone(input), payload = { input };
  const normalized = responsesReasoningInput(payload);
  assert.deepEqual(input, saved);
  assert.equal(normalized.input[0].content, undefined);
  assert.deepEqual(normalized.input[0].summary.map(part => part.text), ['summary', 'full reasoning']);
  assert.equal(normalized.input[0].encrypted_content, 'opaque-provider-state');
  assert.equal(normalized.input[1], input[1]); assert.equal(normalized.input[2], input[2]);
  assert.equal(responsesReasoningInput(normalized), normalized);
  assert.equal(responsesReasoningInput({ input: [{ type: 'reasoning', content: [{ text: 'same' }], summary: [{ type: 'summary_text', text: 'same' }] }] }).input[0].summary.length, 1);
});

test('hybrid network retries use the original 60-second/five-retry policy and exact request body', async t => {
  const sent = [], waits = [], notifications = [];
  const { request, broker } = await fixture(t, async (url, options) => {
    sent.push(options.body);
    if (sent.length < 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return chatStream();
  });
  broker.waitForRetry = async delay => { waits.push(delay); };
  broker.retryHandlers.set('owner-a', event => notifications.push(event));
  const response = await request({}); assert.equal(response.status, 200); await response.json();
  assert.deepEqual(waits, [60000, 60000]); assert.equal(new Set(sent).size, 1);
  assert.deepEqual(notifications.map(event => event.retrying), [true, true, false]);
  assert.ok(notifications.every(event => event.threadId === 'thread-a'));
});

test('hybrid chat rate limits wait for the provider cooldown and preserve the submitted request', async t => {
  const sent = [], waits = [], notifications = [];
  const { request, broker } = await fixture(t, async (url, options) => {
    sent.push(options.body);
    return sent.length < 3
      ? new Response('Limited', { status: 429, headers: { 'retry-after': '90' } })
      : chatStream();
  });
  broker.waitForRetry = async delay => waits.push(delay);
  broker.retryHandlers.set('owner-a', event => notifications.push(event));
  const response = await request({});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'completed');
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent).size, 1);
  assert.equal(waits.length, 2);
  assert.ok(waits.every(delay => delay >= 90000 && delay <= 95000));
  assert.deepEqual(notifications.map(event => event.retrying), [true, true, false]);
});

test('hybrid rate-limit exhaustion remains terminal with both streaming and JSON responses', async t => {
  const requests = [], waits = [];
  const { request, broker } = await fixture(t, async (url, options) => {
    requests.push(options.body);
    return new Response('Limited', { status: 429 });
  });
  broker.waitForRetry = async delay => waits.push(delay);
  for (const stream of [false, true]) {
    const response = await request({ stream });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error.code, 'deepmath_network_retries_exhausted');
    assert.match(body.error.message, /持续限流.*已重试 5 次/);
  }
  assert.equal(requests.length, 12);
  assert.equal(waits.length, 10);
  assert.ok(waits.every(delay => delay >= 60000 && delay <= 65000));
});

test('hybrid Chat capacity errors inside HTTP 200 streams retry before empty metadata becomes output', async t => {
  let calls = 0; const waits = [];
  const { request, broker } = await fixture(t, async () => ++calls === 1
    ? new Response('data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\ndata: {"error":{"code":"rate_limit_exceeded","message":"Limited"}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    : chatStream());
  broker.waitForRetry = async delay => waits.push(delay);
  const response = await request({ stream: true }); const wire = await response.text();
  assert.equal(response.status, 200); assert.match(wire, /response.completed/); assert.doesNotMatch(wire, /response.failed|rate_limit_exceeded/);
  assert.equal(calls, 2); assert.ok(waits[0] >= 60000 && waits[0] <= 65000);
});

test('hybrid does not replay a broken stream after partial reasoning has been delivered', async t => {
  let calls = 0;
  const { request } = await fixture(t, async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"partial reasoning"}}]}\n\n'));
      setTimeout(() => controller.error(new TypeError('fetch failed')), 10);
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const wire = await (await request({ stream: true })).text();
  assert.match(wire, /partial reasoning/); assert.match(wire, /response.failed/); assert.equal(calls, 1);
});

test('revoking one project cancels its nested search without interrupting another project', async t => {
  let started, aborted;
  const searchStarted = new Promise(resolve => { started = resolve; });
  const searchAborted = new Promise(resolve => { aborted = resolve; });
  let first = true;
  const { request, broker } = await fixture(t, async (url, options) => {
    if (new URL(url).pathname.endsWith('/responses')) return new Promise((resolve, reject) => {
      started(); options.signal.addEventListener('abort', () => { aborted(); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
    if (first) { first = false; return chatStream({ content: '', calls: [{ name: 'deepmath_hosted_web_search', arguments: { action: 'search', query: 'check' } }] }); }
    return chatStream();
  });
  const own = await request({ stream: true, tools: [{ type: 'web_search' }] });
  const reading = own.text().catch(() => 'closed');
  await searchStarted;
  const other = await request({}, 'owner-b', 'thread-b'); assert.equal(other.status, 200); await other.json();
  broker.revoke('owner-a'); await searchAborted;
  await reading;
  assert.ok(broker.tokens.has('owner-b'));
});

test('Azure SSE-formatted content-filter errors remain clear and are not retried', async t => {
  let calls = 0;
  const { request, broker } = await fixture(t, async () => {
    calls++;
    return new Response('data: {"choices":[{"delta":{},"finish_reason":"content_filter","content_filter_results":{"error":{"code":"content_filter","message":"Response blocked by Jailbreak"}}}]}\n\n', { status: 400, headers: { 'Content-Type': 'text/event-stream' } });
  });
  broker.waitForRetry = async () => { assert.fail('Content filters must not be retried'); };
  const response = await request({}); assert.equal(response.status, 400);
  const body = await response.json(); assert.equal(body.error.code, 'content_filter'); assert.match(body.error.message, /Azure 内容筛选/); assert.equal(calls, 1);
});

test('reasoning-only completion is explicitly failed rather than shown as a final answer', async t => {
  const { request } = await fixture(t, async () => chatStream({ content: '' }));
  const wire = await (await request({ stream: true })).text();
  assert.match(wire, /response.failed/); assert.match(wire, /empty_model_answer/); assert.match(wire, /真实推理/);
});

test('a streamed policy rejection retains the failure state and cannot execute partial tool calls', async t => {
  let calls = 0;
  const { request, broker } = await fixture(t, async () => {
    calls++;
    return chatStream({ content: 'partial response', finish: 'content_filter', calls: [
      { name: 'deepmath_hosted_web_search', arguments: { action: 'search', query: 'test' } },
      { name: 'inspect', arguments: {} }
    ] });
  });
  broker.waitForRetry = async () => assert.fail('Policy errors cannot be retried');
  const tools = [{ type: 'web_search' }, { type: 'function', name: 'inspect', parameters: { type: 'object', properties: {} } }];
  const wire = await (await request({ stream: true, tools })).text();
  const events = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.equal(events.at(-1).type, 'response.failed');
  assert.equal(events.at(-1).response.error.code, 'content_filter');
  assert.match(events.at(-1).response.error.message, /Azure 内容筛选/);
  assert.equal(events.at(-1).response.output[0].content[0].text, '真实推理🙂');
  assert.equal(events.at(-1).response.output[1].phase, 'commentary');
  assert.ok(!events.some(event => event.item?.type === 'function_call' || event.item?.type === 'web_search_call'));
  assert.equal(calls, 1);
  const response = await request({ tools }); assert.equal(response.status, 400); await response.json();
  assert.equal(calls, 2);
});

test('search mixed with native tool calls retains all tool IDs and results on the next native request', async t => {
  let step = 0;
  const { request } = await fixture(t, async (url, options) => {
    const body = JSON.parse(options.body);
    if (new URL(url).pathname.endsWith('/responses')) return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'SEARCH_RESULT' }] }] });
    if (step++ === 0) return chatStream({ content: 'both actions', calls: [{ name: 'deepmath_hosted_web_search', arguments: { action: 'search', query: 'test' } }, { name: 'inspect', arguments: {} }] });
    const assistant = body.messages.find(message => message.tool_calls);
    assert.equal(assistant.tool_calls.length, 2);
    for (const call of assistant.tool_calls) assert.ok(body.messages.some(message => message.role === 'tool' && message.tool_call_id === call.id));
    assert.equal(body.messages.filter(message => message.content === 'both actions').length, 1);
    return chatStream();
  });
  const tools = [{ type: 'web_search' }, { type: 'function', name: 'inspect', parameters: { type: 'object', properties: {} } }];
  const first = await (await request({ tools })).json(), external = first.output.find(item => item.type === 'function_call');
  assert.equal(external.name, 'inspect');
  const last = await request({ tools, input: [...first.output, { type: 'function_call_output', call_id: external.call_id, output: 'NATIVE_RESULT' }] });
  assert.equal(last.status, 200); assert.equal((await last.json()).status, 'completed');
});

test('a failed hosted search returns tool feedback and the same model round continues', async t => {
  let step = 0, searches = 0;
  const { request } = await fixture(t, async (url, options) => {
    if (new URL(url).pathname.endsWith('/responses')) { searches++; return Response.json({ status: 'incomplete', output: [] }); }
    const body = JSON.parse(options.body);
    if (step++ === 0) return chatStream({ content: 'checking sources', calls: [{ name: 'deepmath_hosted_web_search', arguments: { action: 'search', query: 'synthetic' } }] });
    const feedback = body.messages.filter(message => message.role === 'tool');
    assert.equal(feedback.length, 1); assert.equal(JSON.parse(feedback[0].content).code, 'web_search_error');
    return chatStream({ content: 'Continuing with existing evidence.' });
  });
  const response = await request({ tools: [{ type: 'web_search' }] });
  assert.equal(response.status, 200); assert.equal((await response.json()).status, 'completed');
  assert.equal(step, 2); assert.equal(searches, 1);
});
