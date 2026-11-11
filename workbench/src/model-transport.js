'use strict';
const { setTimeout: wait } = require('node:timers/promises');
const { randomInt, randomUUID } = require('node:crypto');

const RETRY_DELAY_MS = 60000;
const MAX_NETWORK_RETRIES = 5;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_TIMER_MS = 2147483647;
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  'ENETDOWN', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
const PUBLIC_CAPACITY_CODES = new Set(['rate_limit_exceeded', 'rate_limit_error', 'too_many_requests', 'no_capacity', '429']);
const TRANSIENT_API_CODES = new Set(['server_error', 'internal_server_error', 'service_unavailable', 'overloaded_error', 'timeout_error', 'request_timeout', '500', '502', '503', '504']);
const TLS_CODES = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);
const streamDiagnostics = new WeakMap();
const streamPermits = new WeakMap();

function keepResponseAlive(res, intervalMs = 15000) {
  if (res.headersSent) return;
  const rawHead = res.writeHead.bind(res), rawWrite = res.write.bind(res), rawEnd = res.end.bind(res);
  let status = 200, bytes = 0; const errorBody = [];
  rawHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
  rawWrite(': internal processing\n\n');
  const stop = () => clearInterval(timer);
  const timer = setInterval(() => {
    if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) rawWrite(': internal processing\n\n');
  }, intervalMs); timer.unref?.(); res.once('close', stop);
  res.writeHead = code => { status = code; return res; };
  res.write = (chunk, encoding, callback) => {
    if (status >= 400) { bytes += Buffer.byteLength(chunk); if (bytes <= 65536) errorBody.push(Buffer.from(chunk)); callback?.(); return true; }
    return rawWrite(chunk, encoding, callback);
  };
  res.end = (chunk, encoding, callback) => {
    stop(); res.off('close', stop);
    let failure;
    if (status >= 400) {
      if (chunk && bytes + Buffer.byteLength(chunk) <= 65536) errorBody.push(Buffer.from(chunk));
      try { failure = JSON.parse(Buffer.concat(errorBody)).error; } catch {}
      failure ||= { code: 'upstream_http_' + status, message: '模型接口请求未完成。' };
    } else if (typeof chunk === 'string' && chunk.startsWith('{"error":')) {
      try { failure = JSON.parse(chunk).error; } catch {}
    }
    if (failure) return rawEnd('event: response.failed\ndata: ' + JSON.stringify({ type: 'response.failed', response: {
      id: 'resp_deepmath_pending_error', status: 'failed', error: failure } }) + '\n\n', encoding, callback);
    return rawEnd(chunk, encoding, callback);
  };
}

function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Canceled', 'AbortError'));
    if (signal.aborted) { Promise.resolve(operation).catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function progressDeadline(callerSignal, overrides = {}) {
  const controller = new AbortController(), signal = AbortSignal.any([callerSignal, controller.signal]);
  const limits = { headers: 120000, prelude: 300000, idle: 180000, ...overrides };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid model transport timeout');
  let timer;
  const clear = () => { clearTimeout(timer); timer = null; };
  const watch = phase => {
    clear(); timer = setTimeout(() => controller.abort(Object.assign(new Error('Model response made no progress'), {
      name: 'TimeoutError', code: 'DEEPMATH_MODEL_STALLED', phase, retryableResponse: true
    })), limits[phase]); timer.unref?.();
  };
  signal.addEventListener('abort', clear, { once: true });
  return { signal, watch, clear, reason: () => controller.signal.reason,
    wrap(reader) { return reader && { read: () => abortable(reader.read(), signal), cancel: () => reader.cancel(), releaseLock: () => reader.releaseLock() }; } };
}
function streamProgress(response, deadline) {
  const streaming = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/event-stream';
  const decoder = new TextDecoder(); let pending = '', terminal = false, failed = false;
  const progress = chunk => {
    if (!chunk?.byteLength) return;
    if (!streaming) { deadline.watch('idle'); return; }
    pending += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length);
      const value = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!value) continue; // Heartbeats alone do not prove model progress.
      try {
        const data = value === '[DONE]' ? null : JSON.parse(value);
        if (value === '[DONE]' || ['response.completed', 'response.failed', 'response.incomplete'].includes(data?.type)) terminal = true;
        if (['response.failed', 'response.incomplete', 'error'].includes(data?.type)) failed = true;
        if (value === '[DONE]' || !emptyPrelude(data)) deadline.watch('idle');
      } catch { deadline.watch('idle'); }
    }
    if (pending.length > 8 * 1024 * 1024) pending = pending.slice(-65536);
  };
  progress.terminal = () => terminal; progress.failed = () => failed;
  return progress;
}
async function errorPrefix(reader) {
  if (!reader) return { first: { done: true }, permanent: false };
  const chunks = []; let size = 0, value, last;
  do {
    last = await reader.read(); if (!last.done) { chunks.push(last.value); size += last.value.byteLength; }
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
  } while (!last.done && size < 65536 && value === undefined);
  const error = value?.error || value;
  const codes = [error?.code, error?.type, error?.innererror?.code].map(value => String(value || '').toLowerCase());
  const permanent = codes.some(code => /^(?:insufficient_quota|billing_hard_limit_reached|account_deactivated|invalid_api_key|authentication_error|permission_denied|content_filter|context_length_exceeded)$/.test(code));
  return { first: size ? { done: false, value: Buffer.concat(chunks) } : { done: true }, permanent };
}

// Inspect usage metadata without changing a byte of the delivered response.
function usageObserver(permit) {
  if (!permit?.observe) return null;
  const decoder = new (require('node:string_decoder').StringDecoder)('utf8');
  let pending = '', disabled = false;
  const inspect = value => {
    const usage = value?.usage || value?.response?.usage;
    if (usage) permit.observe(usage);
  };
  return (chunk, final = false) => {
    if (disabled) return;
    pending += final ? decoder.end() : decoder.write(Buffer.from(chunk));
    if (pending.length > 8 * 1024 * 1024) { disabled = true; pending = ''; return; }
    if (pending.trimStart().startsWith('{')) {
      try { inspect(JSON.parse(pending)); pending = ''; } catch {}
      return;
    }
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1);
      if (!line.startsWith('data:')) continue;
      try { inspect(JSON.parse(line.slice(5).trim())); } catch {}
    }
    if (final && pending.startsWith('data:')) { try { inspect(JSON.parse(pending.slice(5).trim())); } catch {} }
  };
}

function diagnosticCode(error) {
  const pending = [error], seen = new Set();
  while (pending.length && seen.size < 32) {
    const item = pending.pop();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    if (NETWORK_CODES.has(item.code) || TLS_CODES.has(item.code)) return item.code;
    pending.push(item.cause, ...(Array.isArray(item.errors) ? item.errors : []));
  }
  return error?.name === 'AbortError' ? 'ABORTED' : error?.name === 'TimeoutError' ? 'TIMEOUT' : 'UNKNOWN';
}
function diagnosticDetails(response, error) {
  const httpStatus = Number.isInteger(response?.status) ? response.status : null;
  const apiCode = PUBLIC_CAPACITY_CODES.has(error?.diagnosticApiCode) || TRANSIENT_API_CODES.has(error?.diagnosticApiCode) ? error.diagnosticApiCode : null;
  const networkCode = error ? diagnosticCode(error) : null;
  const category = !error && httpStatus !== null && httpStatus < 400 ? 'ok'
    : apiCode === 'no_capacity' ? 'capacity' : error?.rateLimited || httpStatus === 429 ? 'rate_limit'
    : TRANSIENT_API_CODES.has(apiCode) ? 'upstream_temporary'
    : networkCode && TLS_CODES.has(networkCode) ? 'tls'
      : ['ENOTFOUND', 'EAI_AGAIN'].includes(networkCode) ? 'dns'
        : networkCode?.includes('TIMEOUT') || networkCode === 'ETIMEDOUT' || httpStatus === 408 ? 'timeout'
          : httpStatus !== null && httpStatus >= 400 ? 'upstream_http' : 'network';
  return { category, httpStatus, apiCode, networkCode };
}
function writeDiagnostic(record) {
  // No URL, headers, raw error messages, prompts or provider body enter this log.
  console.warn('[deepmath-model] ' + JSON.stringify(record));
}
function diagnosticWriter(upstream, report) {
  const traceId = randomUUID(), started = Date.now();
  let route = 'other';
  try { route = new URL(upstream).pathname.endsWith('/chat/completions') ? 'chat/completions'
    : new URL(upstream).pathname.endsWith('/responses') ? 'responses' : 'other'; } catch {}
  return (event, response, error, extra = {}) => {
    try { report({ at: new Date().toISOString(), traceId, event, route,
      ...diagnosticDetails(response, error), ...extra, elapsedMs: Math.max(0, Date.now() - started) }); } catch {}
  };
}

function networkError(error) {
  const pending = [error], seen = new Set();
  let retryable = false;
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const code = String(current.code || '');
    // Certificate failures and caller aborts require intervention, not retries.
    if (current.name === 'AbortError' || /CERT|ERR_TLS|VERIFY_LEAF|SELF_SIGNED/.test(code)) return false;
    if (NETWORK_CODES.has(code) || (current.name === 'TypeError' && current.message === 'fetch failed')) retryable = true;
    pending.push(current.cause, ...(Array.isArray(current.errors) ? current.errors : []));
  }
  return retryable;
}

function assertAuthorized(signal, authorized) {
  signal.throwIfAborted();
  if (!authorized()) throw Object.assign(new Error('Model proxy authorization revoked'), { code: 'ABORT_ERR' });
}

async function cancel(reader, response) {
  let timer;
  try { await Promise.race([reader ? reader.cancel() : response?.body?.cancel(), new Promise(resolve => { timer = setTimeout(resolve, 1000); timer.unref?.(); })]); } catch {}
  finally { clearTimeout(timer); }
  try { reader?.releaseLock(); } catch {}
}

function retryDelay(response, rateLimited = response?.status === 429, eventHeaders, minimum = RETRY_DELAY_MS, jitter = 5000) {
  if (!rateLimited) return minimum;
  const headers = new Headers(response?.headers);
  for (const [name, value] of Object.entries(eventHeaders || {})) {
    if (['retry-after', 'retry-after-ms', 'x-ms-retry-after-ms'].includes(name.toLowerCase())) headers.set(name, String(value));
  }
  const delays = [minimum];
  for (const name of ['retry-after-ms', 'x-ms-retry-after-ms']) {
    const milliseconds = Number(headers.get(name));
    if (Number.isFinite(milliseconds) && milliseconds >= 0) delays.push(milliseconds);
  }
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(milliseconds) && milliseconds >= 0) delays.push(milliseconds);
  }
  return Math.ceil(Math.max(...delays)) + randomInt(0, jitter + 1);
}

function rateLimitEvent(data) {
  const error = data?.error || (data?.type === 'response.failed' ? data.response?.error : null)
    || (data?.type === 'error' && (data.code || data.message) ? data : null);
  if (!error || typeof error !== 'object') return null;
  const codes = [error.code, error.type].map(value => String(value || '').toLowerCase());
  if (codes.some(code => /content_filter|invalid|authentication|unauthorized|forbidden|insufficient_quota/.test(code))) return null;
  return codes.some(code => ['rate_limit_exceeded', 'rate_limit_error', 'too_many_requests', 'no_capacity', '429'].includes(code))
    || /^rate[ _-]limit (?:exceeded|reached)\b|^too many requests\b/i.test(error.message || '') ? error : null;
}
function emptyPrelude(data) {
  if (!data || typeof data !== 'object') return false;
  if (['response.created', 'response.in_progress', 'response.queued'].includes(data.type)) return !(data.response?.output?.length);
  if (data.type === 'response.output_item.added') {
    const item = data.item;
    return ['message', 'reasoning'].includes(item?.type) && !(item.content || []).some(part => part.text || part.refusal)
      && !(item.summary || []).some(part => part.text);
  }
  if (['response.content_part.added', 'response.reasoning_summary_part.added'].includes(data.type)) {
    return ['output_text', 'reasoning_text', 'summary_text'].includes(data.part?.type) && !data.part.text;
  }
  if (['response.output_text.delta', 'response.reasoning_text.delta', 'response.reasoning_summary_text.delta'].includes(data.type)) return !data.delta;
  return Array.isArray(data.choices) && data.choices.length > 0 && data.choices.every(part => !part.finish_reason
    && Object.keys(part.delta || {}).every(name => name === 'role'));
}
// Azure can send HTTP 200, response.created, then a no_capacity error event.
// Hold only the empty protocol prelude, up to 64 KiB. Once any model content,
// tool event or unknown event is present, commit the stream and never replay it.
async function inspectPrelude(response, reader, first, signal, authorized) {
  const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const streaming = mediaType === 'text/event-stream';
  if (!reader || [401, 403, 404, 422].includes(response.status)) return first;
  const decoder = new TextDecoder(), chunks = []; let bytes = 0, pending = '', next = first;
  const inspect = data => {
    const limited = rateLimitEvent(data);
    const failure = data?.error || (data?.type === 'response.failed' ? data.response?.error : null)
      || (data?.type === 'error' ? data : null);
    const codes = [failure?.code, failure?.type].map(value => String(value || '').toLowerCase());
    const transient = !codes.some(code => /content_filter|invalid|authentication|unauthorized|forbidden|insufficient_quota/.test(code))
      && codes.find(code => TRANSIENT_API_CODES.has(code));
    const error = limited || (transient && failure);
    if (error) throw Object.assign(new Error('Upstream model capacity temporarily unavailable'), {
      retryableResponse: true, rateLimited: Boolean(limited), retryHeaders: error.headers,
      diagnosticApiCode: transient || [error.code, error.type].map(value => String(value || '').toLowerCase()).find(value => PUBLIC_CAPACITY_CODES.has(value))
    });
    return emptyPrelude(data);
  };
  for (;;) {
    assertAuthorized(signal, authorized);
    if (!next.done) { chunks.push(next.value); bytes += next.value.byteLength; pending += decoder.decode(next.value, { stream: true }); }
    else pending += decoder.decode();
    let commit = false;
    if (streaming) {
      let match;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length);
        const value = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!value) continue;
        if (value === '[DONE]') { commit = true; break; }
        let data; try { data = JSON.parse(value); } catch { commit = true; break; }
        if (!inspect(data)) { commit = true; break; }
      }
      if (next.done && pending.startsWith('data:')) { try { inspect(JSON.parse(pending.slice(5).trim())); } catch (error) { if (error.rateLimited) throw error; } }
    } else {
      if (!pending.trimStart().startsWith('{')) commit = true;
      else { try { const data = JSON.parse(pending); inspect(data); commit = true; } catch (error) { if (error.rateLimited) throw error; if (!(error instanceof SyntaxError)) throw error; } }
    }
    if (commit || next.done || bytes >= 64 * 1024) return bytes ? { done: false, value: Buffer.concat(chunks) } : { done: true };
    next = await reader.read();
  }
}

// Retry a single immutable model request, never a whole research turn.
// Read the first body bytes before committing downstream headers; a broken
// stream that has delivered anything must not be replayed (tools may execute).
async function requestModel({ upstream, credential, body, signal, authorized = () => true,
  fetchUpstream = fetch, waitForRetry = wait, onRetry, onDiagnostic = writeDiagnostic, schedule, timeouts }) {
  const diagnose = diagnosticWriter(upstream, onDiagnostic);
  let failures = 0, capacityDeferrals = 0;
  for (let attempt = 0; ; attempt++) {
    assertAuthorized(signal, authorized);
    let response, reader, permit, deadline;
    try {
      permit = await schedule?.acquire(body);
      assertAuthorized(signal, authorized);
      deadline = progressDeadline(signal, timeouts); deadline.watch('headers');
      response = await abortable(fetchUpstream(upstream, { method: 'POST', redirect: 'error', signal: deadline.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` }, body }), deadline.signal);
      deadline.watch('prelude'); reader = deadline.wrap(response.body?.getReader());
      let prefetched;
      if (response.status === 429 && /json/i.test(response.headers.get('content-type') || '')) prefetched = await errorPrefix(reader);
      if (RETRYABLE_STATUS.has(response.status) && !prefetched?.permanent) {
        throw Object.assign(new Error('Upstream request temporarily unavailable'), { retryableResponse: true });
      }
      if (prefetched?.permanent) permit?.rejectedBeforeGeneration?.();
      if (!response.ok) diagnose('http_error', response, null, { requestAttempt: attempt + 1 });
      let first = prefetched?.first || (reader ? await reader.read() : { done: true });
      while (!first.done && !first.value?.byteLength) first = await reader.read();
      if (!prefetched?.permanent) first = await inspectPrelude(response, reader, first, deadline.signal, authorized);
      assertAuthorized(signal, authorized);
      if (attempt > 0 && response.ok) diagnose('recovered', response, null, { retriesUsed: attempt });
      const result = { response, reader, first };
      if (response.ok) permit?.accepted?.();
      streamDiagnostics.set(result, diagnose);
      const progress = streamProgress(response, deadline); if (!first.done) progress(first.value);
      streamPermits.set(result, { permit, observe: usageObserver(permit), deadline, progress });
      if (!reader) { deadline.clear(); permit?.completed?.(); permit?.release(); streamPermits.delete(result); }
      return result;
    } catch (error) {
      if (deadline?.reason() && !signal.aborted) error = deadline.reason();
      deadline?.clear();
      await cancel(reader, response);
      try { assertAuthorized(signal, authorized); } catch (cancelled) { permit?.release(); throw cancelled; }
      if ((response && !response.ok && !error.retryableResponse) || (!error.retryableResponse && !networkError(error))) {
        permit?.release();
        diagnose('failed', response, error, { requestAttempt: attempt + 1 });
        throw error;
      }
      const limited = response?.status === 429 || error.rateLimited;
      if (limited) permit?.rejectedBeforeGeneration?.();
      if (!response && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(diagnosticCode(error))) permit?.notSent?.();
      // Provider capacity deferrals are scheduling, not an account failure.
      // Keep the immutable HTTP request and the logical turn until canceled.
      const deferred = Boolean(schedule);
      if (!deferred && failures === MAX_NETWORK_RETRIES) {
        permit?.release();
        diagnose('exhausted', response, error, { retriesUsed: failures });
        const message = response?.status === 429 || error.rateLimited
          ? '模型接口持续限流，已重试 5 次，请稍后再试。'
          : '模型网络连接失败，已重试 5 次，请稍后再试。';
        // Preserve the terminal code consumed by both proxy response adapters.
        throw Object.assign(new Error(message), { code: 'DEEPMATH_NETWORK_RETRIES_EXHAUSTED' });
      }
      const minimum = deferred ? Math.min(limited ? 60000 : 30000, (limited ? 2000 : 1000) * 2 ** Math.min(capacityDeferrals, 5)) : RETRY_DELAY_MS;
      const delayMs = retryDelay(response, deferred || limited, error.retryHeaders, minimum, deferred ? 1000 : 5000);
      if (deferred) { capacityDeferrals++; if (limited) schedule.throttle(delayMs); }
      else failures++;
      permit?.release();
      const state = error.code !== 'DEEPMATH_MODEL_STALLED' && !response && networkError(error) ? 'network' : 'internal';
      diagnose(deferred ? 'scheduled_again' : 'retry', response, error,
        { retry: failures, capacityDeferrals, maxRetries: MAX_NETWORK_RETRIES, waitMs: delayMs });
      onRetry?.(failures, { state, category: diagnosticDetails(response, error).category, capacityDeferrals, deferred });
      // Node timers overflow above this limit. Split long Retry-After values
      // so an upstream cooldown cannot accidentally become an immediate retry.
      for (let remaining = delayMs; remaining > 0; remaining -= MAX_TIMER_MS) {
        assertAuthorized(signal, authorized);
        await waitForRetry(Math.min(remaining, MAX_TIMER_MS), undefined, { signal });
      }
    }
  }
}

async function* responseChunks(result) {
  const { reader, first } = result;
  const scheduled = streamPermits.get(result);
  if (!reader) { scheduled?.deadline?.clear(); scheduled?.permit?.completed?.(); scheduled?.permit?.release(); return; }
  try {
    if (!first.done) { scheduled?.observe?.(first.value); yield first.value; }
    for (let next = first; !next.done && !scheduled?.progress?.terminal();) {
      next = await reader.read();
      if (!next.done) { scheduled?.progress?.(next.value); scheduled?.observe?.(next.value); yield next.value; }
    }
    scheduled?.observe?.(null, true);
    if (!scheduled?.progress?.failed()) scheduled?.permit?.completed?.();
  } catch (error) {
    streamDiagnostics.get(result)?.('stream_failed', result.response, error);
    throw error;
  } finally { scheduled?.deadline?.clear(); await cancel(reader); scheduled?.permit?.release(); streamPermits.delete(result); }
}

module.exports = { requestModel, responseChunks, keepResponseAlive, networkError, RETRY_DELAY_MS, MAX_NETWORK_RETRIES };
