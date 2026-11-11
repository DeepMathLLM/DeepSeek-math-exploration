'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { projectDeltaStream } = require('../src/project-delta-stream'), delta = require('../public/project-delta');
const output = require('../src/run-output');
class Client extends EventEmitter {
  constructor() { super(); this.frames = []; this.congested = false; this.destroyed = false; this.writableEnded = false; }
  write(frame) { this.frames.push(frame); return !this.congested; }
  end() { this.writableEnded = true; }
}
const data = frame => JSON.parse(frame.split('\ndata: ')[1]);
test('a burst of events becomes one sanitized delta with final state, compaction and file notifications retained', t => {
  const client = new Client(), state = { id: 'p', runs: [{ id: 'r', text: 'old'.repeat(200), status: 'running' }] };
  const stream = projectDeltaStream(client, { snapshot: () => JSON.parse(JSON.stringify(state)) }); t.after(stream.close);
  for (let i = 0; i < 10000; i++) { state.runs[0].text += i % 1000 ? '' : '增量'; stream.event({ type: 'run.output', run: state.runs[0] }); }
  state.runs[0].status = 'completed'; stream.event({ type: 'run.updated' });
  stream.event({ type: 'context.compaction', target: 'controller', status: 'completed' });
  stream.event({ type: 'files.changed' }); stream.flush();
  assert.equal(client.frames.length, 4);
  const patch = data(client.frames[1]); assert.equal(patch.baseVersion, 0); assert.equal(patch.version, 1);
  assert.deepEqual(delta.apply(data(client.frames[0]).project, patch.ops), state);
  assert.match(client.frames[2], /context.compaction/); assert.match(client.frames[3], /files.changed/);
});
test('backpressure keeps the last transmitted baseline and coalesces slow readers without repeatedly serializing snapshots', t => {
  const client = new Client(); client.congested = true;
  let value = 0, reads = 0;
  const stream = projectDeltaStream(client, { snapshot: () => { reads++; return { id: 'p', value }; } }); t.after(stream.close);
  for (let i = 0; i < 10000; i++) { value++; stream.event({ type: 'run.updated' }); }
  assert.equal(reads, 1); assert.equal(client.frames.length, 1);
  client.congested = false; client.emit('drain'); stream.flush();
  assert.equal(reads, 2); assert.equal(client.frames.length, 2);
  assert.equal(delta.apply(data(client.frames[0]).project, data(client.frames[1]).ops).value, 10000);
  stream.flush(); assert.equal(reads, 2);
});
test('authorization is rechecked before a pending update; closing releases timers and the baseline', () => {
  const client = new Client(); let authorized = true, reads = 0;
  const stream = projectDeltaStream(client, { snapshot: () => { reads++; return { id: 'p' }; }, authorized: () => authorized });
  stream.event({ type: 'run.updated' }); authorized = false; stream.flush();
  assert.equal(reads, 1); assert.equal(client.writableEnded, true); assert.equal(client.listenerCount('drain'), 0);
  stream.event({ type: 'run.updated' }); stream.ping(); assert.equal(client.frames.length, 1);
});
test('tool results, ciphertext and credentials are removed before diffing or emitting compaction notices', t => {
  output.registerSecret('SYNTHETIC_PRIVATE_KEY');
  const client = new Client(), state = { id: 'p', runs: [{ id: 'r', finalOutput: 'old', outputItems: [
    { id: 'tool', type: 'dynamicToolCall', data: { tool: 'read', contentItems: [{ text: 'PRIVATE_TOOL_RESULT' }] } },
    { id: 'think', type: 'reasoning', data: { encrypted_content: 'PRIVATE_CIPHER', summary: ['summary'] } }
  ] }] };
  const sanitize = value => output.redact(output.forDisplay(value));
  const stream = projectDeltaStream(client, { snapshot: () => sanitize(state), sanitizeNotice: sanitize }); t.after(stream.close);
  state.runs[0].finalOutput = 'SYNTHETIC_PRIVATE_KEY';
  stream.event({ type: 'run.output' }); stream.event({ type: 'context.compaction', target: 'controller', status: 'failed', error: 'SYNTHETIC_PRIVATE_KEY' }); stream.flush();
  assert.doesNotMatch(client.frames.join(''), /PRIVATE_TOOL_RESULT|PRIVATE_CIPHER|SYNTHETIC_PRIVATE_KEY/);
  assert.match(client.frames.join(''), /REDACTED/);
});
