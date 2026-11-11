'use strict';
// Codex remains the agent/runtime. This adapter translates only model traffic;
// it never executes terminal commands, project file tools or research actions.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { once } = require('node:events');
const { requestModel, responseChunks } = require('./model-transport');
const { redact } = require('./run-output');
const CARRY_PREFIX = 'dmhy1.';
const SEARCH = 'deepmath_hosted_web_search';
const uid = prefix => prefix + crypto.randomUUID().replaceAll('-', '');
function textFilter(secret) {
  let pending = '';
  return (value = '', final = false) => {
    pending += value;
    if (secret) pending = pending.split(secret).join('[REDACTED]');
    let hold = 0;
    if (!final && secret) for (let size = Math.min(secret.length - 1, pending.length); size > 0; size--) if (pending.endsWith(secret.slice(0, size))) { hold = size; break; }
    const visible = pending.slice(0, pending.length - hold); pending = hold ? pending.slice(-hold) : '';
    return visible;
  };
}
function invalid(message) { return Object.assign(new Error(message), { statusCode: 400 }); }
const { schemaError } = require('./tool-arguments');
function toolError(call, descriptor) {
  if (!descriptor) return 'The tool name is not registered. Use exactly a declared tool name.';
  let args; try { args = JSON.parse(call.function.arguments || '{}'); } catch { return 'Tool arguments must be a complete JSON object.'; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Tool arguments must be a JSON object.';
  return schemaError(args, descriptor.schema.function.parameters);
}
function loadKey(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, '.hybrid-context-key');
  try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Invalid hybrid context key');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { if (!fs.fstatSync(fd).isFile()) throw new Error('Invalid hybrid context key'); const key = fs.readFileSync(fd); if (key.length !== 32) throw new Error('Invalid hybrid context key'); return key; }
  finally { fs.closeSync(fd); }
}
function seal(value, key, scope) {
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(scope));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return CARRY_PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url');
}
function unseal(value, key, scope) {
  try {
    const bytes = Buffer.from(value.slice(CARRY_PREFIX.length), 'base64url');
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(scope)); cipher.setAuthTag(bytes.subarray(12, 28));
    const result = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
    if (result.version !== 1 || !Array.isArray(result.messages)) throw new Error('Invalid carry');
    return result;
  } catch { throw invalid('无法恢复此对话的混合模式上下文，请检查服务器数据和当前项目；没有发送模型请求。'); }
}
function text(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => typeof item === 'string' ? item : item.text || '').join('');
}
function chatContent(content) {
  if (typeof content === 'string') return content;
  const parts = [];
  for (const item of content || []) {
    if (typeof item === 'string') parts.push({ type: 'text', text: item });
    else if (['input_text', 'output_text', 'text', 'refusal'].includes(item.type)) parts.push({ type: 'text', text: item.text || item.refusal || '' });
    else if (item.type === 'input_image') {
      if (!item.image_url) throw invalid('此混合模式需要图片内容或图片 URL，暂不支持 Files API 的 file_id');
      parts.push({ type: 'image_url', image_url: { url: item.image_url, ...(item.detail ? { detail: item.detail } : {}) } });
    } else throw invalid(`混合模式暂不支持输入内容类型 ${String(item.type).slice(0, 80)}`);
  }
  return parts.every(part => part.type === 'text') ? parts.map(part => part.text).join('') : parts;
}
function toolMap(tools = [], webSearch = false) {
  const byAlias = new Map(), byIdentity = new Map(); let hosted;
  function add(tool, namespace = '') {
    if (tool.type === 'namespace') { for (const nested of tool.tools || []) add(nested, namespace ? `${namespace}.${tool.name}` : tool.name); return; }
    if (/^web_search/.test(tool.type)) { if (webSearch) hosted ||= tool; return; }
    if (!['function', 'custom'].includes(tool.type)) throw invalid(`混合模式暂不支持工具类型 ${String(tool.type).slice(0, 80)}`);
    const name = tool.name || tool.function?.name;
    if (typeof name !== 'string' || !name) throw invalid('工具名称无效');
    const identity = `${namespace}\0${name}`;
    const alias = !namespace && /^[A-Za-z0-9_-]{1,64}$/.test(name) && name !== SEARCH ? name : 'dm_' + crypto.createHash('sha256').update(identity).digest('hex').slice(0, 48);
    if (byAlias.has(alias) && byAlias.get(alias).identity !== identity) throw invalid('工具名称映射冲突');
    const descriptor = { identity, alias, name, namespace: namespace || null, type: tool.type,
      schema: { type: 'function', function: { name: alias, description: tool.description || tool.function?.description || name,
        parameters: tool.type === 'custom' ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false }
          : tool.parameters || tool.function?.parameters || { type: 'object', properties: {} } } } };
    byAlias.set(alias, descriptor); byIdentity.set(identity, descriptor);
  }
  for (const tool of tools) add(tool);
  if (hosted) byAlias.set(SEARCH, { alias: SEARCH, type: 'search', name: SEARCH, namespace: null,
    schema: { type: 'function', function: { name: SEARCH, description: 'Search the public web, open a web page, or find text on a page. Returns cited web content.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['search', 'open', 'find'] }, query: { type: 'string' }, queries: { type: 'array', items: { type: 'string' } }, url: { type: 'string' }, pattern: { type: 'string' } }, required: ['action'], additionalProperties: false } } } });
  return { byAlias, byIdentity, hosted, tools: [...byAlias.values()].map(item => item.schema) };
}
function toMessages(payload, mapping, key, scope) {
  const input = typeof payload.input === 'string' ? [{ type: 'message', role: 'user', content: payload.input }] : payload.input || [];
  if (!Array.isArray(input)) throw invalid('模型输入无效');
  const carries = new Map(), skip = new Set(), skipCalls = new Set(), skipIndexes = new Set();
  for (const [index, item] of input.entries()) if (item.type === 'reasoning' && item.encrypted_content?.startsWith(CARRY_PREFIX)) {
    const value = unseal(item.encrypted_content, key, scope); carries.set(index, value);
    for (const id of value.itemIds || []) skip.add(id);
    for (const id of value.callIds || []) skipCalls.add(id);
    // Some providers/CLI versions omit assistant item IDs when replaying.
    // Match only this response block, never an earlier conversation segment.
    let left = index, right = index;
    const boundary = it => !it || ['function_call_output', 'custom_tool_call_output'].includes(it.type)
      || (it.type === 'message' && it.role !== 'assistant') || (it.type === 'reasoning' && it.encrypted_content?.startsWith(CARRY_PREFIX));
    while (left > 0 && !boundary(input[left - 1])) left--;
    while (right + 1 < input.length && !boundary(input[right + 1])) right++;
    const wanted = [...(value.publicTexts || [])];
    for (let pos = left; pos <= right; pos++) {
      const it = input[pos];
      if ((it.type === 'message' || !it.type) && it.role === 'assistant') {
        const match = wanted.indexOf(text(it.content));
        if (match !== -1) { skipIndexes.add(pos); wanted.splice(match, 1); }
      }
      if (it.type === 'web_search_call') skipIndexes.add(pos);
    }
  }
  const messages = []; let pendingReasoning = '';
  if (payload.instructions) messages.push({ role: 'system', content: payload.instructions });
  for (const [index, item] of input.entries()) {
    if (carries.has(index)) { messages.push(...carries.get(index).messages); pendingReasoning = ''; continue; }
    if (skipIndexes.has(index) || (item.id && skip.has(item.id)) || (item.call_id && skipCalls.has(item.call_id) && ['function_call', 'custom_tool_call'].includes(item.type))) continue;
    if (item.type === 'reasoning') { pendingReasoning += text(item.content) || text(item.summary); continue; }
    if (item.type === 'web_search_call') continue;
    if (item.type === 'message' || (!item.type && item.role)) {
      // The target's Chat format uses system for trusted developer guidance.
      // Preserve its content and position; do not turn it into user input.
      const role = item.role === 'developer' ? 'system' : item.role;
      const content = chatContent(item.content);
      if (role === 'system' && messages.at(-1)?.role === 'system' && typeof content === 'string' && typeof messages.at(-1).content === 'string') messages.at(-1).content += '\n\n' + content;
      else messages.push({ role, content, ...(role === 'assistant' && pendingReasoning ? { reasoning_content: pendingReasoning } : {}) });
      pendingReasoning = ''; continue;
    }
    if (['function_call', 'custom_tool_call'].includes(item.type)) {
      const descriptor = mapping.byIdentity.get(`${item.namespace || ''}\0${item.name}`);
      const alias = descriptor?.alias || (!item.namespace && /^[A-Za-z0-9_-]{1,64}$/.test(item.name || '') ? item.name : 'dm_' + crypto.createHash('sha256').update(`${item.namespace || ''}\0${item.name}`).digest('hex').slice(0, 48));
      let assistant = messages.at(-1);
      if (assistant?.role !== 'assistant' || !assistant.tool_calls) { assistant = { role: 'assistant', content: null, tool_calls: [], reasoning_content: pendingReasoning }; messages.push(assistant); }
      assistant.reasoning_content ||= pendingReasoning; pendingReasoning = '';
      assistant.tool_calls.push({ id: item.call_id, type: 'function', function: { name: alias,
        arguments: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : item.arguments || '{}' } }); continue;
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) { messages.push({ role: 'tool', tool_call_id: item.call_id, content: chatContent(item.output) }); continue; }
    throw invalid(`混合模式暂不支持输入项目类型 ${String(item.type).slice(0, 80)}`);
  }
  for (const message of messages) if (message.role === 'assistant' && message.tool_calls) message.reasoning_content ??= '';
  return redact(messages);
}
async function* sse(result) {
  const decoder = new TextDecoder(); let pending = '';
  for await (const chunk of responseChunks(result)) {
    pending += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1);
      if (!line.startsWith('data:')) continue;
      const value = line.slice(5).trim();
      if (value && value !== '[DONE]') yield JSON.parse(value);
    }
  }
  pending += decoder.decode();
  if (pending.startsWith('data:') && pending.slice(5).trim() !== '[DONE]') yield JSON.parse(pending.slice(5));
}
async function readText(result) {
  const decoder = new TextDecoder(); let value = '';
  for await (const chunk of responseChunks(result)) value += decoder.decode(chunk, { stream: true });
  return value + decoder.decode();
}
function usage(value) {
  if (!value) return null;
  return { input_tokens: value.prompt_tokens || 0, output_tokens: value.completion_tokens || 0,
    total_tokens: value.total_tokens ?? ((value.prompt_tokens || 0) + (value.completion_tokens || 0)),
    ...(value.prompt_tokens_details ? { input_tokens_details: value.prompt_tokens_details } : {}),
    ...(value.completion_tokens_details ? { output_tokens_details: value.completion_tokens_details } : {}) };
}
function responsesReasoningInput(payload) {
  if (!Array.isArray(payload.input)) return payload;
  let changed = false;
  const input = payload.input.map(item => {
    if (item.type !== 'reasoning' || !Array.isArray(item.content) || !item.content.length) return item;
    // Raw reasoning_text is an output field on this Azure Responses route.
    // Preserve the received text in its accepted input summary structure;
    // never inject it as a new user/system message or alter saved history.
    const { content, ...rest } = item, raw = text(content);
    const summary = Array.isArray(item.summary) ? [...item.summary] : [];
    if (raw && !summary.some(part => part.text === raw)) summary.push({ type: 'summary_text', text: raw });
    changed = true;
    return { ...rest, summary };
  });
  return changed ? { ...payload, input } : payload;
}
function expandForResponses(payload, key, scope) {
  const mapping = toolMap(payload.tools, true);
  for (const item of payload.input || []) if (item.type === 'reasoning' && item.encrypted_content?.startsWith(CARRY_PREFIX)) {
    for (const descriptor of unseal(item.encrypted_content, key, scope).toolIdentities || []) mapping.byAlias.set(descriptor.alias, descriptor);
  }
  const messages = toMessages({ ...payload, instructions: undefined }, mapping, key, scope), input = [], callKinds = new Map();
  const parts = content => typeof content === 'string' ? content : (content || []).map(part => part.type === 'image_url'
    ? { type: 'input_image', image_url: part.image_url.url, ...(part.image_url.detail ? { detail: part.image_url.detail } : {}) }
    : { type: 'input_text', text: part.text || '' });
  for (const message of messages) {
    if (message.role === 'tool') { input.push({ type: callKinds.get(message.tool_call_id) === 'custom' ? 'custom_tool_call_output' : 'function_call_output', call_id: message.tool_call_id, output: parts(message.content) }); continue; }
    if (message.reasoning_content) input.push({ type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: message.reasoning_content }] });
    if (message.content) input.push({ type: 'message', role: message.role, content: parts(message.content) });
    for (const call of message.tool_calls || []) {
      const descriptor = mapping.byAlias.get(call.function.name);
      callKinds.set(call.id, descriptor?.type || 'function');
      if (descriptor?.type === 'custom') input.push({ type: 'custom_tool_call', call_id: call.id, name: descriptor.name,
        ...(descriptor.namespace ? { namespace: descriptor.namespace } : {}), input: JSON.parse(call.function.arguments).input });
      else input.push({ type: 'function_call', call_id: call.id, name: descriptor?.name || call.function.name,
        ...(descriptor?.namespace ? { namespace: descriptor.namespace } : {}), arguments: call.function.arguments });
    }
  }
  return responsesReasoningInput({ ...payload, input });
}
async function respond({ payload, model, upstream, credential, signal, authorized, res, key, scope, fetchUpstream, waitForRetry, onRetry, onConnected, schedule }) {
  const mapping = toolMap(payload.tools, model.webSearch);
  const messages = toMessages(payload, mapping, key, scope);
  const generated = [], items = [], publicTexts = [], callIds = [];
  const responseId = uid('resp_dm_'), reasoning = { id: uid('rs_'), type: 'reasoning', summary: [], content: [] };
  let reasoningText = '', sequence = 0, started = false, lastUsage = null, stageMessage = null, terminal = false;
  const streaming = payload.stream !== false;
  const baseResponse = () => ({ id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), model: payload.model,
    status: 'in_progress', output: items, usage: lastUsage, error: null, incomplete_details: null });
  async function event(type, data = {}) {
    signal.throwIfAborted();
    if (!streaming) return;
    if (res.destroyed) throw Object.assign(new Error('Client disconnected'), { name: 'AbortError' });
    if (!res.write(`event: ${type}\ndata: ${JSON.stringify(redact({ type, ...data, sequence_number: sequence++ }))}\n\n`)) await once(res, 'drain', { signal });
  }
  async function add(item) { const index = items.push(item) - 1; await event('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress' } }); return index; }
  async function start() {
    if (started) return; started = true;
    if (streaming) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
    await event('response.created', { response: { ...baseResponse(), output: [] } });
    await event('response.in_progress', { response: { ...baseResponse(), output: [] } });
    await add(reasoning);
    await event('response.content_part.added', { item_id: reasoning.id, output_index: 0, content_index: 0, part: { type: 'reasoning_text', text: '' } });
  }
  async function upstreamRequest(route, body) {
    const result = await requestModel({ upstream: new URL(route, upstream), credential, body: JSON.stringify(redact(body)), signal, authorized, fetchUpstream, waitForRetry, onRetry, schedule });
    onConnected?.();
    if (!result.response.ok) {
      const bytes = await readText(result);
      let error;
      try { const json = JSON.parse(bytes); error = redact(json.error || (json.message ? json : null)); } catch {}
      if (!error) for (const line of bytes.split('\n')) if (line.startsWith('data:')) {
        try {
          const data = JSON.parse(line.slice(5));
          error = redact(data.error || data.choices?.[0]?.content_filter_results?.error);
          if (!error && data.choices?.[0]?.finish_reason === 'content_filter') error = { code: 'content_filter', message: 'Azure 内容策略拦截了本次请求。' };
        } catch {}
        if (error) break;
      }
      throw Object.assign(new Error(error?.message || 'Azure 模型请求失败'), { statusCode: result.response.status, upstreamError: error });
    }
    return result;
  }
  try {
    let searches = 0, finishReason, terminalToolCalls = 0, toolRepairs = 0;
    for (let round = 0; round < 6; round++) {
      signal.throwIfAborted();
      const availableTools = mapping.tools.filter(tool => searches < 4 || tool.function.name !== SEARCH);
      let choice = payload.tool_choice;
      if (choice && typeof choice === 'object') {
        if (/^web_search/.test(choice.type)) choice = { type: 'function', function: { name: SEARCH } };
        else if (choice.type === 'function') {
          const descriptor = mapping.byIdentity.get(`${choice.namespace || ''}\0${choice.name}`);
          choice = { type: 'function', function: { name: descriptor?.alias || choice.name } };
        }
      }
      const body = { model: payload.model, messages, reasoning_effort: payload.reasoning?.effort || model.reasoningEffort,
        stream: true, stream_options: { include_usage: true },
        ...(availableTools.length ? { tools: availableTools, ...(choice ? { tool_choice: round ? 'auto' : choice } : {}) } : {}),
        ...(model.maxOutputTokens ? { max_tokens: model.maxOutputTokens } : payload.max_output_tokens ? { max_tokens: payload.max_output_tokens } : {}),
        ...(payload.parallel_tool_calls !== undefined ? { parallel_tool_calls: payload.parallel_tool_calls } : {}) };
      if (payload.text?.format?.type === 'json_object') body.response_format = { type: 'json_object' };
      else if (payload.text?.format?.type === 'json_schema') { const { type, ...schema } = payload.text.format; body.response_format = { type, json_schema: schema }; }
      const result = await upstreamRequest('chat/completions', body);
      await start();
      let content = '', rawReasoning = ''; const calls = new Map(); stageMessage = null; finishReason = null;
      const filterReasoning = textFilter(credential), filterContent = textFilter(credential);
      async function reasoningDelta(delta) {
        if (!delta) return;
        rawReasoning += delta; reasoningText += delta;
        await event('response.reasoning_text.delta', { item_id: reasoning.id, output_index: 0, content_index: 0, delta });
      }
      async function contentDelta(delta) {
        if (!delta) return;
        if (!stageMessage) {
          stageMessage = { id: uid('msg_'), type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] };
          await add(stageMessage);
          await event('response.content_part.added', { item_id: stageMessage.id, output_index: items.indexOf(stageMessage), content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        }
        content += delta; stageMessage.content[0].text = content;
        await event('response.output_text.delta', { item_id: stageMessage.id, output_index: items.indexOf(stageMessage), content_index: 0, delta });
      }
      for await (const chunk of sse(result)) {
        if (chunk.error) throw Object.assign(new Error(redact(chunk.error.message) || '模型流返回错误'), { upstreamError: redact(chunk.error) });
        if (chunk.usage) lastUsage = usage(chunk.usage);
        const part = chunk.choices?.[0]; if (!part) continue;
        const delta = part.delta || {};
        if (delta.reasoning_content) {
          await reasoningDelta(filterReasoning(delta.reasoning_content));
        }
        if (delta.content || delta.refusal) {
          await contentDelta(filterContent(delta.content || delta.refusal));
        }
        for (const call of delta.tool_calls || []) {
          let saved = calls.get(call.index || 0);
          if (!saved) { saved = { id: uid('call_dm_'), type: 'function', function: { name: '', arguments: '' } }; calls.set(call.index || 0, saved); }
          saved.function.name += call.function?.name || ''; saved.function.arguments += call.function?.arguments || '';
        }
        if (part.finish_reason) finishReason = part.finish_reason;
      }
      await reasoningDelta(filterReasoning('', true)); await contentDelta(filterContent('', true));
      if (!finishReason) throw new Error('模型流提前结束，未收到完成状态');
      const assistant = { role: 'assistant', content: content || null, reasoning_content: rawReasoning,
        ...(calls.size ? { tool_calls: [...calls.values()] } : {}) };
      generated.push(assistant); messages.push(assistant);
      if (stageMessage) {
        stageMessage.phase = calls.size || finishReason !== 'stop' ? 'commentary' : 'final_answer'; stageMessage.status = 'completed'; publicTexts.push(content);
        await event('response.output_text.done', { item_id: stageMessage.id, output_index: items.indexOf(stageMessage), content_index: 0, text: content });
        await event('response.content_part.done', { item_id: stageMessage.id, output_index: items.indexOf(stageMessage), content_index: 0, part: stageMessage.content[0] });
        await event('response.output_item.done', { output_index: items.indexOf(stageMessage), item: stageMessage });
      }
      // A rejected/truncated completion cannot authorize tool execution, even
      // if the provider already streamed some tool-call argument fragments.
      if (finishReason === 'content_filter') throw Object.assign(new Error('模型响应被上游内容策略拦截。'), { publicCode: 'content_filter', statusCode: 400 });
      if (finishReason === 'length') throw Object.assign(new Error('模型输出达到本次长度上限，请缩小任务或调整模型输出上限后继续。'), { publicCode: 'model_output_limit', statusCode: 422 });
      const invalidCalls = [...calls.values()].map(call => ({ call, error: toolError(call, mapping.byAlias.get(call.function.name)) })).filter(item => item.error);
      if (invalidCalls.length) {
        // No call from a malformed batch executes, including otherwise valid
        // siblings. Resolve every call ID before asking the model to repair it.
        if (++toolRepairs > 8) throw Object.assign(new Error('模型连续未能修正工具参数；本轮记录已保留，可直接发送新指令继续。'), { publicCode: 'tool_arguments_not_corrected', statusCode: 422 });
        for (const call of calls.values()) {
          const error = invalidCalls.find(item => item.call === call)?.error || 'This batch was not executed because another tool call had invalid arguments. Resubmit the required calls with corrected arguments.';
          const message = { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, executed: false, code: 'invalid_tool_call', error,
            guidance: 'Correct the arguments or tool name and continue the same task. No tool from this batch has executed.',
            ...(mapping.byAlias.has(call.function.name) ? {} : { available_tools: [...mapping.byAlias.keys()] }) }) };
          generated.push(message); messages.push(message);
        }
        round--; continue;
      }
      const external = [];
      for (const call of calls.values()) {
        const descriptor = mapping.byAlias.get(call.function.name);
        if (!descriptor) throw invalid(`模型返回了未注册的工具 ${String(call.function.name).slice(0, 80)}`);
        if (descriptor.type !== 'search') { external.push([call, descriptor]); continue; }
        let args; try { args = JSON.parse(call.function.arguments); } catch { throw invalid('模型返回了无效的搜索参数'); }
        let resultText;
        const action = args.action || 'search';
        const web = { id: uid('ws_'), type: 'web_search_call', status: 'in_progress', action: action === 'search'
          ? { type: 'search', query: args.query || args.queries?.join(' ') || '' } : action === 'open' ? { type: 'open_page', url: args.url } : { type: 'find', url: args.url, pattern: args.pattern } };
        const index = await add(web); await event('response.web_search_call.in_progress', { item_id: web.id, output_index: index });
        if (++searches > 4) resultText = '搜索次数已达本次请求上限，请根据已有资料回答。';
        else {
          await event('response.web_search_call.searching', { item_id: web.id, output_index: index });
          try {
          const response = await upstreamRequest('responses', { model: payload.model, input: `Use the hosted web search tool for this operation: ${JSON.stringify(args)}. Return the relevant findings with source URLs.`,
            tools: [mapping.hosted], tool_choice: 'required', max_output_tokens: 2048, stream: false });
          const bytes = await readText(response);
          const data = redact(JSON.parse(bytes));
          if (data.status !== 'completed') throw new Error('网页搜索未完成');
          const parts = (data.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []);
          resultText = JSON.stringify({ text: parts.map(item => item.text || '').join('\n'), sources: parts.flatMap(item => item.annotations || []).filter(item => item.type === 'url_citation').map(item => ({ url: item.url, title: item.title })) });
          } catch (error) {
            if (signal.aborted || !authorized()) throw error;
            resultText = JSON.stringify(redact({ ok: false, code: 'web_search_error', error: error.upstreamError?.message || error.message,
              guidance: 'This search did not complete. Correct the search or continue using existing evidence. Do not treat this error as a search finding.' }));
          }
        }
        web.status = 'completed'; await event('response.web_search_call.completed', { item_id: web.id, output_index: index });
        await event('response.output_item.done', { output_index: index, item: web });
        const message = { role: 'tool', tool_call_id: call.id, content: resultText }; generated.push(message); messages.push(message);
      }
      for (const [call, descriptor] of external) {
        let item;
        if (descriptor.type === 'custom') {
          let value; try { value = JSON.parse(call.function.arguments).input; } catch {}
          if (typeof value !== 'string') throw invalid('自定义工具参数无效');
          item = { id: uid('ct_'), type: 'custom_tool_call', call_id: call.id, name: descriptor.name, ...(descriptor.namespace ? { namespace: descriptor.namespace } : {}), input: value, status: 'completed' };
        } else item = { id: uid('fc_'), type: 'function_call', call_id: call.id, name: descriptor.name, ...(descriptor.namespace ? { namespace: descriptor.namespace } : {}), arguments: call.function.arguments || '{}', status: 'completed' };
        callIds.push(call.id); const index = await add(item);
        const kind = item.type === 'custom_tool_call' ? 'custom_tool_call_input' : 'function_call_arguments';
        await event(`response.${kind}.delta`, { item_id: item.id, output_index: index, delta: item.input ?? item.arguments });
        await event(`response.${kind}.done`, { item_id: item.id, output_index: index, ...(item.type === 'custom_tool_call' ? { input: item.input } : { arguments: item.arguments }) });
        await event('response.output_item.done', { output_index: index, item });
      }
      terminalToolCalls = external.length;
      if (external.length || !calls.size) break;
      if (round === 5) throw new Error('搜索未能在限定步骤内结束');
    }
    reasoning.content = reasoningText ? [{ type: 'reasoning_text', text: reasoningText }] : [];
    reasoning.encrypted_content = seal(redact({ version: 1, messages: generated, itemIds: items.map(item => item.id), callIds, publicTexts,
      toolIdentities: [...mapping.byAlias.values()].filter(item => item.type !== 'search').map(({ alias, name, namespace, type }) => ({ alias, name, namespace, type })) }), key, scope);
    reasoning.status = 'completed';
    await event('response.reasoning_text.done', { item_id: reasoning.id, output_index: 0, content_index: 0, text: reasoningText });
    await event('response.content_part.done', { item_id: reasoning.id, output_index: 0, content_index: 0, part: { type: 'reasoning_text', text: reasoningText } });
    await event('response.output_item.done', { output_index: 0, item: reasoning });
    const completed = { ...baseResponse(), status: 'completed' };
    if (!terminalToolCalls && !generated.at(-1)?.content?.trim()) throw Object.assign(new Error('模型本次没有返回最终正文，请检查已显示的推理内容后重试。'), { publicCode: 'empty_model_answer' });
    await event('response.completed', { response: completed }); terminal = true;
    if (streaming) res.end(); else res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(redact(completed)));
  } catch (error) {
    if (signal.aborted || res.destroyed) { if (!res.destroyed) res.destroy(); return; }
    reasoning.content = reasoningText ? [{ type: 'reasoning_text', text: reasoningText }] : [];
    reasoning.status = 'incomplete';
    const exhausted = error.code === 'DEEPMATH_NETWORK_RETRIES_EXHAUSTED';
    const details = redact(error.upstreamError || { message: exhausted || error.statusCode === 400 || error.publicCode ? error.message : '混合模型请求未完成，请稍后重试或联系管理员。', code: error.publicCode || (exhausted ? 'deepmath_network_retries_exhausted' : 'hybrid_model_error') });
    if (details.code === 'content_filter') details.message = 'Azure 内容筛选拦截了本次请求，请管理员检查该部署的内容筛选日志。';
    if (!started || !streaming) {
      res.writeHead(error.statusCode || (exhausted ? 422 : 502), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ error: details }));
    } else if (!terminal) { await event('response.failed', { response: { ...baseResponse(), status: 'failed', error: details } }); res.end(); }
  }
}
module.exports = { respond, toolMap, toMessages, seal, unseal, loadKey, expandForResponses, responsesReasoningInput, CARRY_PREFIX };
