'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { projectEventStream } = require('../src/project-events');
class Client extends EventEmitter {
  constructor() { super(); this.frames = []; this.congested = false; this.destroyed = false; this.writableEnded = false; }
  write(frame) { this.frames.push(frame); return !this.congested; }
  end() { this.writableEnded = true; }
}

test('slow SSE readers retain one latest snapshot instead of serializing an unbounded output queue', () => {
  const res = new Client(); res.congested = true;
  let revision = 0, encodings = 0;
  const stream = projectEventStream(res, { snapshot: () => ({ revision }), encode(value) { encodings++; return JSON.stringify(value); } });
  for (let i = 0; i < 10000; i++) {
    revision++;
    stream.event({ type: 'run.output', text: 'SYNTHETIC_OUTPUT', revision });
    stream.ping();
  }
  stream.event({ type: 'research.changed' }); stream.event({ type: 'files.changed' });
  assert.equal(res.frames.length, 1); assert.equal(encodings, 1);
  res.congested = false; res.emit('drain');
  assert.equal(res.frames.length, 4);
  assert.match(res.frames[1], /event: snapshot[\s\S]*"revision":10000/);
  assert.match(res.frames[2], /event: research.changed/);
  assert.match(res.frames[3], /event: files.changed/);
  assert.equal(encodings, 4);
  stream.close(); assert.equal(res.listenerCount('drain'), 0);
});

test('SSE invalidations survive multiple congested drains without repeatedly writing snapshots', () => {
  const res = new Client(); res.congested = true;
  const stream = projectEventStream(res, { snapshot: () => ({ latest: true }), encode: JSON.stringify });
  stream.event({ type: 'files.changed' }); stream.event({ type: 'research.changed' });
  res.emit('drain'); // The snapshot itself is still too much for this socket.
  assert.equal(res.frames.length, 2);
  res.emit('drain'); // No new events: proceed to one invalidation, not a snapshot loop.
  assert.equal(res.frames.length, 3); assert.match(res.frames[2], /files.changed/);
  res.congested = false; res.emit('drain');
  assert.equal(res.frames.length, 4); assert.match(res.frames[3], /research.changed/);
  res.emit('drain'); assert.equal(res.frames.length, 4);
  stream.close();
});

test('SSE flushes check authorization again and a closed connection stops evaluating snapshots', () => {
  const res = new Client(); res.congested = true;
  let authorized = true, snapshots = 0;
  const stream = projectEventStream(res, { snapshot: () => { snapshots++; return {}; }, encode: JSON.stringify, authorized: () => authorized });
  stream.event({ type: 'run.updated' }); authorized = false; res.emit('drain');
  assert.equal(res.writableEnded, true); assert.equal(res.frames.length, 1);
  stream.close(); stream.event({ type: 'run.updated' }); stream.ping();
  assert.equal(snapshots, 1);
});
