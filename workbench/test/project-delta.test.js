'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { diff, apply } = require('../public/project-delta');
const clone = value => JSON.parse(JSON.stringify(value));
test('incremental text preserves appended Unicode, phase boundaries and authoritative corrections without resending history', () => {
  const before = { runs: [{ id: 'current', text: '旧段落🙂\n\n'.repeat(300), status: 'running' }, { id: 'history', text: 'PRIVATE_HISTORY'.repeat(500) }] };
  const after = clone(before); after.runs[0].text += '\n\n工具之后的新段落。'; after.runs[0].status = 'completed';
  const ops = diff(before, after);
  assert.deepEqual(apply(before, ops), after); assert.ok(ops.some(op => op.op === 'text'));
  assert.doesNotMatch(JSON.stringify(ops), /PRIVATE_HISTORY/); assert.ok(JSON.stringify(ops).length < 300);
  const correction = clone(after); correction.runs[0].text = after.runs[0].text.replace('旧段落🙂', '修正🙂');
  assert.deepEqual(apply(after, diff(after, correction)), correction);
  assert.deepEqual(before.runs[0].status, 'running');
});
test('new runs, reordering and retirement of old entries preserve unchanged run content by identity', () => {
  const before = { runs: Array.from({ length: 50 }, (_, i) => ({ id: 'r' + i, text: 'HISTORY_' + i + '_'.repeat(3000) })) };
  const after = { runs: [{ id: 'new', text: 'New task' }, ...clone(before.runs.slice(0, 49))] };
  after.runs[2].text += 'delta';
  const ops = diff(before, after); assert.deepEqual(apply(before, ops), after);
  assert.ok(ops.some(op => op.op === 'order')); assert.doesNotMatch(JSON.stringify(ops), /HISTORY_0/);
  const reordered = { runs: [after.runs[2], after.runs[0]] };
  assert.deepEqual(apply(after, diff(after, reordered)), reordered);
});
test('mixed arrays, nested deletions, nulls and primitive replacements round-trip exactly', () => {
  const values = [null, false, 'abc', { id: 'p', a: [1, 2, null], gone: true }, { id: 'p', a: [2, { x: 'value' }], nested: { summary: ['one', 'two'] } }, []];
  for (const a of values) for (const b of values) assert.deepEqual(apply(clone(a), diff(a, b)), b);
});
test('JSON prototype-shaped keys remain ordinary own data and malformed patches cannot mutate the base', () => {
  const before = JSON.parse('{"nested":{"__proto__":{"safe":"old"}},"constructor":{"prototype":{"polluted":false}}}');
  const after = JSON.parse('{"nested":{"__proto__":{"safe":"new","extra":true}},"constructor":{"prototype":{"polluted":true}}}');
  assert.deepEqual(apply(before, diff(before, after)), after); assert.equal({}.polluted, undefined);
  assert.throws(() => apply({}, [{ op: 'set', path: ['__proto__', 'polluted'], value: true }]));
  const original = { text: 'unchanged', items: [{ id: 'a', value: 1 }] };
  assert.throws(() => apply(original, [{ op: 'set', path: ['text'], value: 'changed' }, { op: 'text', path: ['text'], start: -1, remove: 0, text: 'invalid' }]));
  assert.equal(original.text, 'unchanged');
  assert.throws(() => apply(original, [{ op: 'order', path: ['items'], ids: ['missing'], added: [] }]));
});
