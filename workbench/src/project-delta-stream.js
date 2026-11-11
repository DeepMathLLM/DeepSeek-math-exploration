'use strict';
const delta = require('../public/project-delta');

// One coalesced update every 500 ms, with at most one socket write pending.
// Snapshots must already be sanitized before entering the diff or its baseline.
function projectDeltaStream(res, { snapshot, authorized = () => true, sanitizeNotice = value => value, delay = 500 }) {
  let view, version = 0, blocked = false, closed = false, dirty = false, timer = null;
  const notices = new Map();
  const usable = () => {
    if (closed || res.destroyed || res.writableEnded) return false;
    if (!authorized()) { close(); res.end(); return false; }
    return true;
  };
  function write(type, value) {
    if (!usable()) return false;
    blocked = !res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
    return true;
  }
  function schedule() {
    if (!timer && !blocked && usable()) { timer = setTimeout(flush, delay); timer.unref?.(); }
  }
  function flush() {
    clearTimeout(timer); timer = null;
    if (blocked || !usable()) return;
    if (dirty) {
      dirty = false;
      const next = snapshot(); let ops;
      try { ops = delta.diff(view, next); } catch { ops = null; }
      if (ops === null || ops.length) {
        const baseVersion = version;
        version++;
        if (ops === null) write('snapshot', { protocol: delta.protocol, version, project: next });
        else write('project.delta', { protocol: delta.protocol, projectId: next?.id || '', baseVersion, version, ops });
        view = next;
      }
    }
    if (!blocked) for (const [key, notice] of notices) {
      notices.delete(key); write(notice.type, notice);
      if (blocked) break;
    }
  }
  function event(value) {
    if (!usable()) return;
    dirty = true;
    if (value.type === 'research.changed' || value.type === 'files.changed') notices.set(value.type, { type: value.type });
    // The authoritative state contains compaction status; retaining its latest
    // notification per target also preserves the existing completion toast.
    if (value.type === 'context.compaction') notices.set(`compaction:${value.target}`, sanitizeNotice(value));
    schedule();
  }
  function ping() { if (usable() && !blocked) blocked = !res.write(': ping\n\n'); }
  function onDrain() { blocked = false; if (dirty || notices.size) schedule(); }
  function close() { closed = true; clearTimeout(timer); timer = null; notices.clear(); view = null; res.off('drain', onDrain); }
  res.on('drain', onDrain);
  view = snapshot(); write('snapshot', { protocol: delta.protocol, version, project: view });
  return { event, ping, close, flush };
}
module.exports = { projectDeltaStream };
