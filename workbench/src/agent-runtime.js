'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { Readable, Transform, pipeline } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const { resolveCodexLaunch } = require('./codex-launch');
const output = require('./run-output');
const modelConfig = require('./model-config');
const hybrid = require('./hybrid-responses');
const { requestModel, responseChunks, keepResponseAlive } = require('./model-transport');
const { ModelRequestScheduler } = require('./model-request-scheduler');

// Defence in depth for an upstream error that accidentally echoes its request
// credential. Hold a possible secret prefix across chunks, before any bytes
// reach the native runtime; preserve UTF-8 and SSE/JSON framing without buffering
// the whole response. This does not attempt to decode arbitrary encodings.
function credentialResponseFilter(secret) {
  const patterns = [...new Set([secret, JSON.stringify(secret).slice(1, -1)])].filter(Boolean);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  function consume(text, final = false) {
    pending += text;
    for (const pattern of patterns) pending = pending.split(pattern).join('[REDACTED]');
    let keep = 0;
    if (!final) for (const pattern of patterns) {
      for (let size = Math.min(pattern.length - 1, pending.length); size > keep; size--) {
        if (pending.endsWith(pattern.slice(0, size))) { keep = size; break; }
      }
    }
    const visible = pending.slice(0, pending.length - keep);
    pending = keep ? pending.slice(-keep) : '';
    return visible;
  }
  return new Transform({
    transform(chunk, encoding, done) { done(null, consume(decoder.write(chunk))); },
    flush(done) { done(null, consume(decoder.end(), true)); }
  });
}

// Model requests use a project-scoped local proxy token. The upstream key is
// held by the broker, and each project has its own native session directory.
class ModelBroker {
  constructor({ waitForRetry, fetchUpstream, hybridKey, scheduler, schedulerFactory } = {}) {
    this.tokens = new Set(); this.activeRequests = new Map(); this.retryHandlers = new Map(); this.server = null; this.starting = null;
    this.waitForRetry = waitForRetry; this.fetchUpstream = fetchUpstream;
    this.hybridKey = hybridKey; this.tokenScopes = new Map();
    this.tokenOwners = new Map(); this.tokenTurns = new Map(); this.scheduler = scheduler; this.schedulerFactory = schedulerFactory;
    this.canceledTurns = new Map();
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!process.env.AZURE_OPENAI_API_KEY) throw new Error('服务器尚未配置 AZURE_OPENAI_API_KEY');
      const upstream = new URL((process.env.deepmath_model_base_url || 'https://your-resource.services.ai.azure.com/openai/v1').replace(/\/$/, '') + '/responses');
      const allowedDeployments = new Map(modelConfig.fromEnvironment().models.map(model => [model.apiModel, model]));
      if ([...allowedDeployments.values()].some(model => model.apiMode === 'azure-deepseek-pro-hybrid')) {
        this.hybridKey ||= hybrid.loadKey(process.env.deepmath_app_data || path.join(require('node:os').homedir(), '.deepmath', 'research-workbench-v3-server'));
      }
      if (upstream.protocol !== 'https:') throw new Error('模型上游必须使用 HTTPS');
      this.scheduler ||= this.schedulerFactory?.();
      this.server = http.createServer(this.createHandler(upstream, allowedDeployments));
      await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(Number(process.env.deepmath_model_proxy_port || 0), process.env.deepmath_model_proxy_host || '127.0.0.1', resolve); });
    })();
    try { await this.starting; } catch (error) { this.starting = null; throw error; }
  }
  createHandler(upstream = new URL((process.env.deepmath_model_base_url || 'https://your-resource.services.ai.azure.com/openai/v1').replace(/\/$/, '') + '/responses'),
    allowedDeployments = new Map(modelConfig.fromEnvironment().models.map(model => [model.apiModel, model]))) {
    return async (req, res) => {
        const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
        if (!this.tokens.has(token)) { res.writeHead(401).end(); return; }
        if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404).end(); return; }
        const abort = new AbortController();
        const active = this.activeRequests.get(token) || new Set();
        active.add(abort); this.activeRequests.set(token, active);
        // Normal response completion is only one step of a native turn.
        // A client disconnect cancels transport; a fully delivered response
        // retains continuation priority until the native terminal event.
        const onClose = () => { if (!res.writableFinished) abort.abort(); };
        res.on('close', onClose);
        const retryHandler = this.retryHandlers.get(token);
        let metadata = {};
        try { metadata = JSON.parse(req.headers['x-codex-turn-metadata'] || '{}') || {}; } catch {}
        const requestId = crypto.randomUUID();
        const routing = {
          threadId: typeof metadata.thread_id === 'string' ? metadata.thread_id.slice(0, 128) : '',
          turnId: typeof metadata.turn_id === 'string' ? metadata.turn_id.slice(0, 128) : ''
        };
        abort.modelRouting = routing;
        let retrying = false;
        const notifyRetry = (value, attempt, state = 'network') => {
          retrying = value;
          // Only routing IDs and state cross this bridge, never credentials,
          // request contents or raw network errors. UI failures cannot fail inference.
          try { retryHandler?.({ ...routing, requestId, retrying: value, attempt, state: value ? state : null }); } catch {}
        };
        let schedule;
        try {
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) { res.writeHead(413).end(); return; } chunks.push(chunk); }
          let body = Buffer.concat(chunks).toString('utf8');
          let payload = JSON.parse(body);
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { res.writeHead(400).end('Invalid request body'); return; }
          const model = allowedDeployments.get(payload.model);
          if (!model) { res.writeHead(400).end('Invalid deployment'); return; }
          // An explicit model budget is authoritative for both Responses and
          // hybrid Chat requests. With no override, preserve the CLI's value
          // (or its omission) rather than inventing an upstream default.
          if (model.maxOutputTokens !== undefined) {
            payload = { ...payload, max_output_tokens: model.maxOutputTokens };
            body = JSON.stringify(payload);
          }
          const scope = `${this.tokenScopes.get(token) || token}\0${routing.threadId}`;
          if (model.apiMode !== 'azure-deepseek-pro-hybrid' && Array.isArray(payload.input)
              && payload.input.some(item => item.type === 'reasoning' && item.encrypted_content?.startsWith(hybrid.CARRY_PREFIX))) {
            this.hybridKey ||= hybrid.loadKey(process.env.deepmath_app_data || path.join(require('node:os').homedir(), '.deepmath', 'research-workbench-v3-server'));
            payload = hybrid.expandForResponses(payload, this.hybridKey, scope); body = JSON.stringify(payload);
          }
          if (model.apiMode !== 'azure-deepseek-pro-hybrid') {
            const normalized = hybrid.responsesReasoningInput(payload);
            if (normalized !== payload) { payload = normalized; body = JSON.stringify(payload); }
          }
          if (!model.webSearch && payload.tools?.some(tool => /^web_search/.test(tool.type))) {
            payload.tools = payload.tools.filter(tool => !/^web_search/.test(tool.type)); body = JSON.stringify(payload);
          }
          if (model.reasoningEffortSupported === false) {
            // Codex can retain the preceding turn's effort even when turn/start
            // receives null. This deployment must never receive that field.
            if (payload.reasoning && typeof payload.reasoning === 'object') {
              delete payload.reasoning.effort;
              if (!Object.keys(payload.reasoning).length) delete payload.reasoning;
            }
            body = JSON.stringify(payload);
          } else if (!model.reasoningEfforts.includes(payload.reasoning?.effort)) {
            res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Missing or invalid reasoning.effort; request was not sent upstream', type: 'invalid_request_error', param: 'reasoning.effort' } })); return;
          }
          const credential = process.env.AZURE_OPENAI_API_KEY;
          const turnKey = this.turnKey(token, routing.threadId, routing.turnId || requestId);
          if (this.canceledTurns.get(token)?.has(turnKey)) {
            res.writeHead(422, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'deepmath_turn_canceled', message: '任务已停止。' } })); return;
          }
          const accountId = this.tokenOwners.get(token) || this.tokenScopes.get(token) || token;
          if (this.scheduler) {
            const turns = this.tokenTurns.get(token) || new Map(); turns.set(turnKey, accountId); this.tokenTurns.set(token, turns);
            schedule = this.scheduler.ticket({ model: payload.model, accountId, turnKey, signal: abort.signal,
              onState: state => notifyRetry(Boolean(state), undefined, state) });
            // Queueing and provider recovery may outlive a client's idle
            // timeout. Protocol comments preserve the same native request.
            if (payload.stream === true) keepResponseAlive(res);
          }
          if (model.apiMode === 'azure-deepseek-pro-hybrid') {
            await hybrid.respond({ payload, model, upstream, credential, signal: abort.signal, authorized: () => this.tokens.has(token), res,
              key: this.hybridKey, scope,
              schedule, waitForRetry: this.waitForRetry, fetchUpstream: this.fetchUpstream, onRetry: (attempt, details) => notifyRetry(true, attempt, details?.state),
              onConnected: () => { if (retrying) notifyRetry(false); } }); return;
          }
          const result = await requestModel({ upstream, credential, body, signal: abort.signal,
            authorized: () => this.tokens.has(token), waitForRetry: this.waitForRetry, fetchUpstream: this.fetchUpstream,
            schedule, onRetry: (attempt, details) => notifyRetry(true, attempt, details?.state) });
          if (retrying) notifyRetry(false);
          const { response } = result;
          const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
          const headers = { 'Content-Type': mediaType === 'text/event-stream' ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
          if (response.headers.has('retry-after')) headers['Retry-After'] = output.redact(response.headers.get('retry-after'));
          res.writeHead(response.status, headers);
          if (response.body) await new Promise(resolve => pipeline(Readable.from(responseChunks(result), { objectMode: false }), credentialResponseFilter(credential), res, resolve)); else res.end();
        } catch (error) {
          const exhausted = error.code === 'DEEPMATH_NETWORK_RETRIES_EXHAUSTED';
          const badRequest = error instanceof SyntaxError || error.statusCode === 400;
          // Terminal 422 prevents the CLI from starting another retry cycle
          // after this proxy has already spent the five-retry budget.
          if (!res.headersSent) res.writeHead(badRequest ? 400 : exhausted ? 422 : 502, { 'Content-Type': 'application/json' });
          if (!res.destroyed) res.end(JSON.stringify({ error: { message: exhausted || badRequest ? output.redact(error.message) : 'Model request failed at the server proxy',
            ...(exhausted ? { code: 'deepmath_network_retries_exhausted' } : {}) } }));
        } finally {
          schedule?.done();
          if (retrying) notifyRetry(false);
          res.off('close', onClose); active.delete(abort);
          if (!active.size && this.activeRequests.get(token) === active) this.activeRequests.delete(token);
        }
      };
  }
  turnKey(token, threadId, turnId) { return `${this.tokenScopes.get(token) || token}\0${threadId || ''}\0${turnId || ''}`; }
  finishTurn(token, threadId, turnId) {
    const key = this.turnKey(token, threadId, turnId), turns = this.tokenTurns.get(token), owner = turns?.get(key);
    if (owner) { this.scheduler?.finishTurn(owner, key); turns.delete(key); }
    if (turns && !turns.size) this.tokenTurns.delete(token);
  }
  cancelTurn(token, threadId, turnId) {
    const stopped = this.canceledTurns.get(token) || new Set();
    stopped.add(this.turnKey(token, threadId, turnId)); this.canceledTurns.set(token, stopped);
    for (const abort of this.activeRequests.get(token) || []) if (abort.modelRouting?.threadId === threadId && abort.modelRouting?.turnId === turnId) abort.abort();
    this.finishTurn(token, threadId, turnId);
  }
  revoke(token) {
    this.tokens.delete(token); for (const abort of this.activeRequests.get(token) || []) abort.abort();
    for (const [key, owner] of this.tokenTurns.get(token) || []) this.scheduler?.finishTurn(owner, key);
    this.tokenTurns.delete(token); this.tokenOwners.delete(token); this.tokenScopes.delete(token); this.retryHandlers.delete(token);
    this.canceledTurns.delete(token);
  }
  close() {
    this.tokens.clear(); this.tokenScopes.clear();
    for (const active of this.activeRequests.values()) for (const abort of active) abort.abort();
    this.activeRequests.clear(); this.retryHandlers.clear(); this.server?.closeAllConnections(); this.server?.close(); this.server = null; this.starting = null;
    this.tokenOwners.clear(); this.tokenTurns.clear(); this.scheduler?.close(); if (this.schedulerFactory) this.scheduler = null;
    this.canceledTurns.clear();
  }
}
const broker = new ModelBroker({ schedulerFactory: () => new ModelRequestScheduler() });
function runtimeOptions(catalog) {
  const model = modelConfig.requireModel(catalog, '');
  return [`model_context_window = ${require('./context-window').CONTEXT_WINDOW_TOKENS}`, model.reasoningEffort ? `model_reasoning_effort = ${JSON.stringify(model.reasoningEffort)}` : '',
    `web_search = ${JSON.stringify(catalog.models.some(model => model.webSearch) ? 'live' : 'disabled')}`].filter(Boolean).join('\n') + '\n';
}
async function prepareRuntime(context, launch = resolveCodexLaunch()) {
  if (!context?.workspace || !context?.codexHome) throw new Error('Agent 缺少项目工作目录或会话目录');
  const workspace = path.resolve(context.workspace);
  const home = path.resolve(context.codexHome);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const catalog = modelConfig.fromEnvironment();
  const model = modelConfig.requireModel(catalog, '').apiModel;
  await broker.start();
  const token = crypto.randomBytes(32).toString('hex');
  const port = broker.server.address().port;
  const configuration = [
    `model = ${JSON.stringify(model)}`,
    'model_supports_reasoning_summaries = true',
    'model_reasoning_summary = "auto"',
    'model_provider = "deepmath"',
    runtimeOptions(catalog).trimEnd(),
    'project_root_markers = []',
    '[model_providers.deepmath]',
    'name = "DeepMath local model proxy"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'env_key = "deepmath_agent_token"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(home, 'config.toml'), configuration, { mode: 0o600 });
  const scope = crypto.createHash('sha256').update(fs.realpathSync(workspace)).digest('hex');
  broker.tokens.add(token);
  broker.tokenScopes.set(token, scope);
  broker.tokenOwners.set(token, context.ownerId || scope);
  if (typeof context.onNetworkRetry === 'function') broker.retryHandlers.set(token, context.onNetworkRetry);
  output.registerSecret(token);
  const env = { ...process.env, CODEX_HOME: home, deepmath_agent_token: token };
  for (const name of ['AZURE_OPENAI_API_KEY', 'OPENAI_API_KEY', 'deepmath_admin_password', process.env.deepmath_local_api_key_env].filter(Boolean)) delete env[name];
  return {
    ...launch,
    env,
    source: `${launch.source} (native project process)`,
    finishTurn: (threadId, turnId) => broker.finishTurn(token, threadId, turnId),
    cancelTurn: (threadId, turnId) => broker.cancelTurn(token, threadId, turnId),
    dispose: () => broker.revoke(token)
  };
}
module.exports = { getBroker: () => broker, prepareRuntime, ModelBroker, close: () => broker.close() };
