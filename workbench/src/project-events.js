'use strict';

// One socket write may be outstanding. While the socket is congested, keep
// only the need for a fresh snapshot and cache-invalidating notifications,
// never an unbounded queue of full runs or streamed output events.
function projectEventStream(res, { snapshot, encode, authorized = () => true }) {
  let blocked = false, closed = false, pendingSnapshot = false;
  const invalidations = new Set();
  const usable = () => {
    if (closed || res.destroyed || res.writableEnded) return false;
    if (!authorized()) { res.end(); return false; }
    return true;
  };
  function write(type, value) {
    if (!usable()) return;
    blocked = !res.write(`event: ${type}\ndata: ${encode(value)}\n\n`);
  }
  function flush() {
    blocked = false;
    if (!usable()) return;
    if (pendingSnapshot) {
      pendingSnapshot = false;
      write('snapshot', snapshot());
    }
    if (!blocked) for (const type of invalidations) {
      invalidations.delete(type);
      write(type, {});
      if (blocked) break;
    }
  }
  function event(value) {
    if (!usable()) return;
    // Invalidations already waiting behind a snapshot must not be bypassed
    // by the next live event, including a drain with no project changes.
    if (blocked || pendingSnapshot || invalidations.size) {
      pendingSnapshot = true;
      if (value.type === 'research.changed' || value.type === 'files.changed') invalidations.add(value.type);
      if (!blocked) flush();
    } else write(value.type, value);
  }
  function ping() { if (usable() && !blocked) blocked = !res.write(': ping\n\n'); }
  function close() { closed = true; invalidations.clear(); res.off('drain', flush); }
  res.on('drain', flush);
  write('snapshot', snapshot());
  return { event, ping, close };
}
module.exports = { projectEventStream };
