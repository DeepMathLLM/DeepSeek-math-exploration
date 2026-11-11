'use strict';
// One process-wide scheduler, partitioned by the provider's quota pool.
// A permit covers a complete HTTP response. A logical turn can own many
// permits; only the runtime's terminal turn event ends continuation priority.
const fs = require('node:fs'), path = require('node:path');
function loadSettings(env = process.env) {
  let value = {};
  if (env.deepmath_model_limits) value = JSON.parse(env.deepmath_model_limits);
  else if (env.deepmath_models_file) {
    const catalog = JSON.parse(fs.readFileSync(path.resolve(env.deepmath_models_file), 'utf8'));
    value = catalog.scheduler === undefined ? {} : catalog.scheduler;
  }
  const object = item => item !== null && typeof item === 'object' && !Array.isArray(item);
  if (!object(value) || (value.defaults !== undefined && !object(value.defaults))
      || (value.models !== undefined && !object(value.models))) throw Error('Invalid model scheduler configuration');
  const defaults = { maxConcurrent: 8, maxPerAccount: 1, continuationBurst: 2, agingMs: 15000, starvationMs: 45000, ...value.defaults };
  const models = value.models || {};
  for (const config of [defaults, ...Object.values(models)]) {
    if (!object(config)) throw Error('Invalid model scheduler limit configuration');
    for (const name of ['maxConcurrent', 'maxPerAccount', 'continuationBurst', 'agingMs', 'starvationMs', 'tpm', 'rpm']) {
      if (config[name] !== undefined && (!Number.isSafeInteger(config[name]) || config[name] < (['tpm', 'rpm'].includes(name) ? 0 : 1))) throw Error('Invalid model scheduler limit: ' + name);
    }
    if (config.utilization !== undefined && !(config.utilization > 0 && config.utilization <= 1)) throw Error('Invalid scheduler utilization');
    if (config.outputAccounting && !['maximum', 'observed'].includes(config.outputAccounting)) throw Error('Invalid output accounting');
  }
  return { defaults, models };
}
function inputBytes(body) {
  let payload; try { payload = JSON.parse(body); } catch { payload = {}; }
  return Buffer.byteLength(JSON.stringify({ input: payload.input, messages: payload.messages, instructions: payload.instructions, tools: payload.tools }));
}
function estimateCost(body, config = {}, ratio = 1 / 3) {
  let payload; try { payload = JSON.parse(body); } catch { payload = {}; }
  // Count the final wire representation, including tools and repeated history.
  // This is an estimate, not the model tokenizer or a billing measurement.
  const input = Math.ceil(inputBytes(body) * ratio * 1.1);
  const requested = Number(payload.max_output_tokens || payload.max_tokens || 8192);
  const output = config.outputAccounting === 'observed' ? 4096
    : Math.max(4096, Number.isSafeInteger(requested) && requested > 0 ? requested : 8192);
  return input + output;
}
class ModelRequestScheduler {
  constructor({ settings = loadSettings(), now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.settings = settings; this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.pools = new Map(); this.closed = false; this.sequence = 0;
  }
  pool(model) {
    const config = { ...this.settings.defaults, ...this.settings.models[model] };
    const id = config.pool || model;
    if (!this.pools.has(id)) this.pools.set(id, { id, config, queue: [], turns: new Map(), ledger: [], active: 0,
      byAccount: new Map(), timer: null, cooldown: 0, lastAccount: null, burst: 0,
      dynamicMax: config.maxConcurrent, successful: 0, lastAdmission: new Map() });
    return this.pools.get(id);
  }
  ticket({ model, accountId, turnKey, signal, onState = () => {} }) {
    const pool = this.pool(model);
    const identity = accountId + '\0' + turnKey;
    let turn = pool.turns.get(identity);
    if (!turn) { turn = { identity, accountId, key: turnKey, calls: 0, limited: false, recovering: false, finished: false, tickets: 0 }; pool.turns.set(identity, turn); }
    turn.tickets++;
    let ended = false;
    const state = value => { try { onState(value); } catch {} };
    const canceled = () => this.finishTurn(accountId, turnKey);
    signal.addEventListener('abort', canceled, { once: true });
    return {
      acquire: body => this.acquire(pool, turn, body, signal, state),
      throttle: delayMs => {
        turn.limited = true; turn.recovering = true;
        // Retain the round, with a short timer-race grace after the provider's
        // cooldown. A missing continuation must not lock the whole pool.
        turn.recoveryHoldUntil = this.now() + delayMs + 1000;
        pool.dynamicMax = Math.max(1, Math.floor(pool.dynamicMax / 2)); pool.successful = 0;
        pool.cooldown = Math.max(pool.cooldown, this.now() + delayMs);
        this.pump(pool);
      },
      done: () => { if (ended) return; ended = true; signal.removeEventListener('abort', canceled); turn.tickets--; if (signal.aborted) canceled(); if (turn.finished && !turn.tickets) pool.turns.delete(identity); },
      // Exposed only to tests/metadata; never contains a provider key or prompt.
      turn
    };
  }
  acquire(pool, turn, body, signal, state) {
    if (this.closed || turn.finished || signal.aborted) return Promise.reject(signal.reason || new DOMException('Request canceled', 'AbortError'));
    return new Promise((resolve, reject) => {
      turn.roundOrder ||= ++this.sequence;
      const job = { turn, signal, state, resolve, reject, inputBytes: inputBytes(body), cost: estimateCost(body, pool.config, pool.inputRatio), at: this.now(), order: ++this.sequence };
      job.abort = () => {
        const index = pool.queue.indexOf(job); if (index < 0) return;
        pool.queue.splice(index, 1); signal.removeEventListener('abort', job.abort);
        turn.recovering = false; reject(signal.reason || new DOMException('Request canceled', 'AbortError')); this.pump(pool);
      };
      signal.addEventListener('abort', job.abort, { once: true });
      pool.queue.push(job); state('internal'); this.pump(pool);
    });
  }
  prune(pool) { const cutoff = this.now() - 60000; pool.ledger = pool.ledger.filter(item => item.at > cutoff); }
  available(pool, job) {
    const config = pool.config, utilization = config.utilization || 1;
    const tokenLimit = config.tpm ? Math.floor(config.tpm * utilization) : Infinity;
    const requestLimit = config.rpm ? Math.max(1, Math.floor(config.rpm * utilization)) : Infinity;
    // A conservative estimate larger than the local minute budget may run
    // alone; it must never deadlock the entire queue or split the request.
    const charged = Math.min(job.cost, tokenLimit);
    return pool.ledger.length < requestLimit && pool.ledger.reduce((sum, entry) => sum + entry.cost, 0) + charged <= tokenLimit;
  }
  pick(pool) {
    const waiting = pool.queue.filter(job => !job.signal.aborted && !job.turn.finished);
    const candidates = waiting.filter(job => (pool.byAccount.get(job.turn.accountId) || 0) < pool.config.maxPerAccount
      || !waiting.some(other => other.turn.accountId !== job.turn.accountId && this.available(pool, other)));
    const lastAdmission = pool.lastAdmission ||= new Map();
    const overdue = candidates.filter(job => this.now() - job.at >= (pool.config.starvationMs || 45000))
      .sort((a, b) => Math.max(a.at, lastAdmission.get(a.turn.accountId) ?? a.at) - Math.max(b.at, lastAdmission.get(b.turn.accountId) ?? b.at)
        || a.order - b.order);
    // Protect an account that has not received an opportunity for a while,
    // even when another account retains a quota-recovery round. Keep the
    // original round active; a fairness grant never marks it completed.
    if (overdue.length) return this.available(pool, overdue[0]) ? overdue[0] : null;
    const recovering = [...pool.turns.values()].filter(turn => turn.recovering && !turn.finished);
    const resumed = candidates.filter(job => recovering.includes(job.turn));
    if (!resumed.length && recovering.some(turn => (turn.recoveryHoldUntil || 0) > this.now())) return null;
    const ready = resumed.length ? resumed : candidates;
    const protectedAccounts = new Set([...pool.turns.values()].filter(turn => turn.limited && !turn.finished).map(turn => turn.accountId));
    const protectedTurn = ready.filter(job => protectedAccounts.has(job.turn.accountId))
      .sort((a, b) => (a.turn.lastGranted || 0) - (b.turn.lastGranted || 0) || a.order - b.order);
    if (protectedTurn.length) return this.available(pool, protectedTurn[0]) ? protectedTurn[0] : null;
    const used = account => pool.ledger.filter(entry => entry.accountId === account).reduce((sum, entry) => sum + (entry.fairCost ?? entry.cost), 0);
    const old = ready.filter(job => this.now() - job.at >= pool.config.agingMs);
    if (old.length) {
      const next = old.sort((a, b) => used(a.turn.accountId) - used(b.turn.accountId) || a.order - b.order)[0];
      // Let budget accumulate for an old large request, rather than allow a
      // stream of small requests to keep it below the admission threshold.
      return this.available(pool, next) ? next : null;
    }
    const fitting = ready.filter(job => this.available(pool, job));
    if (!fitting.length) return null;
    const continuation = fitting.filter(job => job.turn.calls > 0
      && (job.turn.accountId !== pool.lastAccount || pool.burst < pool.config.continuationBurst))
      .sort((a, b) => (a.turn.lastGranted || 0) - (b.turn.lastGranted || 0)
        || (a.turn.roundOrder || a.order) - (b.turn.roundOrder || b.order));
    if (continuation.length) return continuation[0];
    // All projects/Agents of an account share the same recent token debit.
    return fitting.sort((a, b) => used(a.turn.accountId) - used(b.turn.accountId) || a.order - b.order)[0];
  }
  pump(pool) {
    if (pool.timer) { this.clearTimer(pool.timer); pool.timer = null; }
    if (this.closed) return;
    this.prune(pool);
    while (pool.active < pool.dynamicMax && this.now() >= pool.cooldown) {
      const job = this.pick(pool); if (!job) break;
      pool.queue.splice(pool.queue.indexOf(job), 1); job.signal.removeEventListener('abort', job.abort);
      const turn = job.turn;
      turn.lastGranted = ++this.sequence;
      (pool.lastAdmission ||= new Map()).set(turn.accountId, this.now());
      turn.calls++; turn.recovering = false;
      pool.active++; pool.byAccount.set(turn.accountId, (pool.byAccount.get(turn.accountId) || 0) + 1);
      pool.burst = pool.lastAccount === turn.accountId ? pool.burst + 1 : 1; pool.lastAccount = turn.accountId;
      const limit = pool.config.tpm ? Math.floor(pool.config.tpm * (pool.config.utilization || 1)) : Infinity;
      const entry = { at: this.now(), cost: Math.min(job.cost, limit), accountId: turn.accountId };
      pool.ledger.push(entry);
      let observedInput = 0, observedOutput = 0;
      let released = false, accepted = false, completed = false;
      job.state(null);
      job.resolve({ accepted: () => { accepted = true; }, completed: () => { completed = true; }, notSent: () => {
        const index = pool.ledger.indexOf(entry); if (index >= 0) pool.ledger.splice(index, 1);
      }, rejectedBeforeGeneration: () => {
        // A confirmed quota rejection produced no model content. Keep its
        // request-count entry, without charging a full prompt per deferral.
        entry.cost = 0; entry.fairCost = 0;
      }, observe: usage => {
        const input = Number(usage.input_tokens ?? usage.prompt_tokens), output = Number(usage.output_tokens ?? usage.completion_tokens);
        if (Number.isFinite(input)) observedInput = Math.max(observedInput, input);
        if (Number.isFinite(output)) observedOutput = Math.max(observedOutput, output);
        if (observedInput) {
          entry.fairCost = observedInput + observedOutput;
          // Never refund a provider's estimated reservation on stream close.
          entry.cost = Math.max(entry.cost, Math.min(limit, observedInput + observedOutput));
        }
      }, release: () => {
        if (released) return; released = true;
        if (observedInput && job.inputBytes) {
          const measured = Math.max(0.05, Math.min(2, observedInput / job.inputBytes));
          pool.inputRatio = (pool.inputRatio || 1 / 3) * 0.8 + measured * 0.2;
        }
        if (accepted && completed && !job.signal.aborted && ++pool.successful >= 4) {
          pool.dynamicMax = Math.min(pool.config.maxConcurrent, pool.dynamicMax + 1); pool.successful = 0;
        }
        pool.active--; const count = (pool.byAccount.get(turn.accountId) || 1) - 1;
        if (count) pool.byAccount.set(turn.accountId, count); else pool.byAccount.delete(turn.accountId);
        this.pump(pool);
      } });
    }
    if (!pool.queue.length || pool.active >= pool.dynamicMax) return;
    // Wake at the actual next eligibility time, never a fixed per-account delay.
    // A periodic reconciliation is deliberate: a lost callback or a recovery
    // turn without an HTTP request must never leave the queue without a timer.
    const events = [this.now() + 5000, pool.cooldown, ...pool.ledger.map(entry => entry.at + 60000),
      ...pool.queue.map(job => job.at + pool.config.agingMs),
      ...Array.from(pool.turns.values(), turn => turn.recoveryHoldUntil || 0)]
      .filter(at => at > this.now());
    if (events.length) { pool.timer = this.setTimer(() => { pool.timer = null; this.pump(pool); }, Math.max(1, Math.min(...events) - this.now())); pool.timer?.unref?.(); }
  }
  finishTurn(accountId, turnKey) {
    for (const pool of this.pools.values()) {
      const identity = accountId + '\0' + turnKey, turn = pool.turns.get(identity);
      if (!turn) continue;
      turn.finished = true; turn.recovering = false; turn.limited = false;
      for (const job of [...pool.queue]) if (job.turn === turn) {
        pool.queue.splice(pool.queue.indexOf(job), 1); job.signal.removeEventListener('abort', job.abort);
        job.reject(new DOMException('Turn ended', 'AbortError'));
      }
      if (!turn.tickets) pool.turns.delete(identity);
      this.pump(pool);
    }
  }
  close() {
    this.closed = true;
    for (const pool of this.pools.values()) {
      if (pool.timer) this.clearTimer(pool.timer);
      for (const job of pool.queue.splice(0)) { job.signal.removeEventListener('abort', job.abort); job.reject(new DOMException('Scheduler closed', 'AbortError')); }
      pool.turns.clear();
    }
  }
}
module.exports = { ModelRequestScheduler, estimateCost, loadSettings };
