'use strict';

const CONTEXT_WINDOW_TOKENS = 128000;
const threadConfig = () => ({ model_context_window: CONTEXT_WINDOW_TOKENS });
function contextTokens(usage) {
  const last = usage?.last || usage?.lastTokenUsage;
  const total = last?.totalTokens ?? last?.total_tokens;
  if (Number.isFinite(total) && total >= 0) return total;
  const input = last?.inputTokens ?? last?.input_tokens, output = last?.outputTokens ?? last?.output_tokens;
  return Number.isFinite(input) && input >= 0 ? input + (Number.isFinite(output) && output >= 0 ? output : 0) : null;
}

// A loaded native thread ignores resume config overrides. Unsubscribe, confirm
// thread/closed, and cold-resume its existing history; never restart the CLI.
class ContextWindowPolicy {
  constructor(client) {
    this.client = client;
    this.process = client.process;
    this.applied = new Set();
    this.usage = new Map();
    this.operations = new Map();
  }
  syncProcess() {
    if (this.process === this.client.process) return;
    this.process = this.client.process; this.applied.clear(); this.usage.clear();
  }
  markApplied(threadId) {
    this.syncProcess(); this.applied.add(threadId);
    this.client.contextWindowApplied?.(threadId, CONTEXT_WINDOW_TOKENS);
  }
  record(threadId, usage) { this.syncProcess(); this.usage.set(threadId, usage); }
  invalidate(threadId) { this.usage.set(threadId, null); }
  snapshot(threadId) { return this.usage.has(threadId) ? this.usage.get(threadId) : this.client.contextUsageProvider?.(threadId); }
  decorate(threadId, usage) {
    const limit = usage?.modelContextWindow ?? usage?.model_context_window;
    // Keep native usable capacity intact, including its safety reserve. Never
    // label an old, still-running 272K/500K session as a 128K session.
    if (!this.applied.has(threadId)) return usage;
    if (Number.isFinite(limit) && limit > CONTEXT_WINDOW_TOKENS) {
      // Cold resume can replay the previous turn's old window before the next
      // inference. Its token counts are historical; its capacity is stale.
      return { ...usage, modelContextWindow: null, model_context_window: null, configuredContextWindow: CONTEXT_WINDOW_TOKENS };
    }
    return { ...usage, configuredContextWindow: CONTEXT_WINDOW_TOKENS };
  }
  busy(threadId) { return [...this.client.turns.values()].includes(threadId); }
  async unload(threadId) {
    const client = this.client;
    if (!client.threads.has(threadId)) return;
    await new Promise((resolve, reject) => {
      let timer, settled = false;
      const finish = error => {
        if (settled) return; settled = true; clearTimeout(timer);
        client.off('notification', closed); client.off('runtime.error', failed);
        error ? reject(error) : resolve();
      };
      const closed = message => { if (message.method === 'thread/closed' && message.params?.threadId === threadId) finish(); };
      const failed = error => finish(error);
      client.on('notification', closed); client.on('runtime.error', failed);
      timer = setTimeout(() => finish(new Error('会话窗口更新未得到运行器确认，请稍后继续。')), client.contextUnloadTimeoutMs || 90000);
      Promise.resolve(client.request('thread/unsubscribe', { threadId })).then(result => {
        if (result?.status === 'notLoaded') { client.threads.delete(threadId); finish(); }
      }, finish);
    });
  }
  ensure(threadId, instructions = '') {
    this.syncProcess();
    if (!threadId || this.client.simulated) return Promise.resolve();
    if (this.operations.has(threadId)) return this.operations.get(threadId);
    const usage = this.snapshot(threadId), used = contextTokens(usage);
    const needsWindow = !this.applied.has(threadId);
    // This is the one-time transition for oversized history, not a new 95%
    // automatic compaction rule. Native regular auto-compaction stays intact.
    const oversized = used !== null && used >= CONTEXT_WINDOW_TOKENS;
    if (!needsWindow && !oversized) {
      this.client.contextWindowApplied?.(threadId, CONTEXT_WINDOW_TOKENS);
      return Promise.resolve();
    }
    if (this.busy(threadId)) return Promise.reject(new Error('当前轮次仍在运行，窗口将在本轮结束后更新。'));
    const operation = Promise.resolve().then(async () => {
      const release = this.client.reserveContextMaintenance?.() || (() => {});
      try {
        if (this.busy(threadId)) throw new Error('当前轮次仍在运行，窗口将在本轮结束后更新。');
        this.client.contextMaintenance?.(threadId, 'running');
        if (needsWindow) {
          await this.unload(threadId);
          await this.client.resumeThread(threadId, instructions);
        }
        if (oversized || contextTokens(this.snapshot(threadId)) >= CONTEXT_WINDOW_TOKENS) {
          await this.client.compactThread(threadId);
          // Only a confirmed compaction may unblock the next user request.
          if (contextTokens(this.snapshot(threadId)) >= CONTEXT_WINDOW_TOKENS) throw new Error('上下文整理后仍超出 128K，尚未发送新的任务。');
        }
        this.client.contextMaintenance?.(threadId, 'completed');
      } catch (error) {
        this.client.contextMaintenance?.(threadId, 'failed', error);
        throw error;
      } finally { release(); }
    });
    this.operations.set(threadId, operation);
    operation.finally(() => { if (this.operations.get(threadId) === operation) this.operations.delete(threadId); }).catch(() => {});
    return operation;
  }
}
module.exports = { CONTEXT_WINDOW_TOKENS, threadConfig, contextTokens, ContextWindowPolicy };
