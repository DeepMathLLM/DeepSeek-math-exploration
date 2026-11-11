'use strict';

// Keep provider-visible output as structured items; do not replace it with a
// synthesized summary. Stream deltas are reconciled with authoritative items.
const runtimeSecrets = new Set();
function registerSecret(secret) { if (secret?.length >= 8) runtimeSecrets.add(secret); }
function redact(value) {
  if (value === undefined) return undefined;
  let serialized = JSON.stringify(value);
  for (const secret of runtimeSecrets) serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
  for (const name of ['AZURE_OPENAI_API_KEY', 'deepmath_azure_probe_key', 'OPENAI_API_KEY', 'deepmath_admin_password']) {
    const secret = process.env[name];
    if (secret && secret.length >= 8) serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
  }
  return JSON.parse(serialized);
}

function outputItem(run, event, type) {
  run.outputItems ||= [];
  const source = event.item || {};
  const id = source.id || event.itemId || event.callId || `${type}:${event.turnId || run.id}`;
  let item = run.outputItems.find((entry) => entry.id === id || (event.callId && entry.data?.callId === event.callId));
  if (!item) {
    item = { id, type: source.type || type, status: 'inProgress', startedAt: new Date().toISOString(), data: {} };
    run.outputItems.push(item);
  }
  item.updatedAt = new Date().toISOString();
  return item;
}

function syncMessages(run) {
  const messages = (run.outputItems || []).filter((item) => item.type === 'agentMessage');
  if (messages.some((item) => typeof item.data.text === 'string' && item.data.text.length)) {
    run.finalOutput = messages.map((item) => item.data.text || '').filter(Boolean).join('\n\n');
  }
}

function recordItem(run, event) {
  const source = event.item || {};
  if (source.type === 'userMessage') return;
  const item = outputItem(run, event, source.type || 'runtime');
  const previousMessage = item.type === 'agentMessage' ? { text: item.data.text, phase: item.data.phase } : null;
  const previousReasoning = item.type === 'reasoning' ? { summary: item.data.summary, content: item.data.content } : null;
  item.type = source.type || item.type;
  Object.assign(item.data, redact(source));
  if (previousMessage) {
    if (!item.data.text?.trim() && previousMessage.text) item.data.text = previousMessage.text;
    if (!item.data.phase && previousMessage.phase) item.data.phase = previousMessage.phase;
  }
  // Some providers send empty final reasoning fields after already streaming
  // readable text. Preserve those received deltas rather than erase them.
  if (previousReasoning) for (const field of ['summary', 'content']) {
    const hasText = value => typeof value === 'string' ? Boolean(value) : Array.isArray(value) ? value.some(hasText) : Boolean(value?.text);
    if (!hasText(item.data[field]) && hasText(previousReasoning[field])) item.data[field] = previousReasoning[field];
  }
  if (event.method === 'item/completed') item.status = source.status || 'completed';
  else if (source.status) item.status = source.status;
  if (item.type === 'agentMessage') syncMessages(run);
  return item;
}

function recordText(run, event) {
  const item = outputItem(run, event, 'agentMessage');
  // A few app-server providers reuse one message item id around a tool turn.
  // Keep the second text segment readable instead of joining it directly to
  // the text that preceded the tool call.
  const itemIndex = run.outputItems.indexOf(item);
  const boundaryItems = itemIndex >= 0 ? run.outputItems.slice(itemIndex + 1).filter((entry) => isToolItem(entry)) : [];
  const boundaryToken = boundaryItems.map((entry) => entry.id).join('|');
  if (item.data.text && boundaryToken && item.__lastTextBoundary !== boundaryToken) {
    if (!/\n\s*$/.test(item.data.text)) item.data.text += '\n\n';
    Object.defineProperty(item, '__lastTextBoundary', { value: boundaryToken, writable: true, configurable: true, enumerable: false });
  }
  item.data.text = redact(`${item.data.text || ''}${event.delta || ''}`);
  if (event.phase) item.data.phase = event.phase;
  syncMessages(run);
}

function recordDelta(run, event) {
  const method = event.method || '';
  const type = /reasoning/.test(method) ? 'reasoning' : /commandExecution/.test(method) ? 'commandExecution'
    : /fileChange/.test(method) ? 'fileChange' : /mcpToolCall/.test(method) ? 'mcpToolCall'
      : /plan/.test(method) ? 'plan' : 'runtime';
  const item = outputItem(run, event, type);
  const delta = redact(event.delta ?? event.text ?? event.message ?? '');
  if (/summaryTextDelta/.test(method)) {
    item.data.summary ||= [];
    const index = Number(event.summaryIndex || 0);
    item.data.summary[index] = redact(`${item.data.summary[index] || ''}${delta}`);
  } else if (/reasoning\/textDelta/.test(method)) {
    item.data.content ||= [];
    const index = Number(event.contentIndex || 0);
    item.data.content[index] = redact(`${item.data.content[index] || ''}${delta}`);
  } else if (/outputDelta/.test(method)) item.data.aggregatedOutput = redact(`${item.data.aggregatedOutput || ''}${delta}`);
  else if (/plan/.test(method)) item.data.text = `${item.data.text || ''}${delta}`;
  else {
    item.data.progress ||= [];
    item.data.progress.push(redact({ method, ...event }));
  }
  return item;
}

function recordTool(run, event, result = false) {
  const item = outputItem(run, event, 'dynamicToolCall');
  Object.assign(item.data, redact({ tool: event.tool || event.name, callId: event.callId,
    ...(result ? { success: event.success, contentItems: event.contentItems } : { arguments: event.arguments }) }));
  if (result) item.status = event.success ? 'completed' : 'failed';
  return item;
}

const isToolItem = (item) => /tool|commandExecution|fileChange|webSearch|imageView|imageGeneration|codeExecution/i.test(item?.type || '');
function completionInfo(run, runtimeStatus = run.status) {
  const items = run.outputItems || [];
  const messages = items.filter(item => item.type === 'agentMessage' && item.data?.text?.trim());
  const finalMessages = messages.filter(item => item.data.phase === 'final_answer');
  const commentaryMessages = messages.filter(item => item.data.phase === 'commentary');
  const unmarkedMessages = messages.filter(item => !['final_answer', 'commentary'].includes(item.data.phase));
  // A provider without phase metadata is not evidence that a reply is missing.
  const legacyText = !messages.length && Boolean(run.finalOutput?.trim());
  return { runtimeStatus, finalAnswer: finalMessages.length ? 'received' : unmarkedMessages.length || legacyText ? 'unknown' : 'missing',
    finalMessages: finalMessages.length, commentaryMessages: commentaryMessages.length, unmarkedMessages: unmarkedMessages.length,
    itemCount: items.length, lastItemType: items.at(-1)?.type || null };
}
function toolName(item) {
  const labels = { commandExecution: '终端', fileChange: '文件编辑', webSearch: '网页检索', imageView: '图片查看', imageGeneration: '图片生成', codeExecution: '代码执行' };
  if (labels[item.type]) return labels[item.type];
  const data = item.data || {};
  const name = typeof data.tool === 'string' ? data.tool : typeof data.name === 'string' ? data.name : '';
  return name || '研究工具';
}
// Keep full results in research state, while every browser transport and export
// uses names only. A collapsed element must not carry hidden result payloads.
function forDisplay(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value, (key, entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    if (entry.type === 'reasoning') {
      const { encrypted_content, ...visible } = entry;
      if (visible.data && typeof visible.data === 'object') { const { encrypted_content: hiddenState, ...data } = visible.data; visible.data = data; }
      return visible;
    }
    if (entry.data && isToolItem(entry)) return { id: entry.id, type: entry.type, status: entry.status,
      startedAt: entry.startedAt, updatedAt: entry.updatedAt, data: { tool: toolName(entry) } };
    if (typeof entry.id === 'string' && typeof entry.finalOutput === 'string') {
      const { diff, ...run } = entry;
      if (Array.isArray(run.events)) run.events = run.events.filter((event) => !/^(output|stdout|stderr|toolResult|tool\.result|command\.output|file\.diff)$/.test(event.kind || ''));
      return run;
    }
    return entry;
  }));
}

module.exports = { recordItem, recordText, recordDelta, recordTool, completionInfo, redact, registerSecret, forDisplay, isToolItem, toolName };
