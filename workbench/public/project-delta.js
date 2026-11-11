(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeepMathDelta = api;
})(globalThis, function () {
  'use strict';
  const protocol = 'deepmath-project-delta-v1';
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const object = value => value !== null && typeof value === 'object';
  const keyed = value => Array.isArray(value) && value.every(item => object(item) && !Array.isArray(item) && typeof item.id === 'string')
    && new Set(value.map(item => item.id)).size === value.length;
  function diff(before, after) {
    const ops = [];
    const add = op => { if (ops.length >= 4096) throw new Error('Snapshot required'); ops.push(op); };
    function visit(left, right, path) {
      if (left === right) return;
      if (typeof left === 'string' && typeof right === 'string' && right.length > 96) {
        let start = 0, end = 0;
        while (start < left.length && start < right.length && left[start] === right[start]) start++;
        while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
        const text = right.slice(start, right.length - end);
        if (text.length + 32 < right.length) { add({ op: 'text', path, start, remove: left.length - start - end, text }); return; }
      }
      if (Array.isArray(left) && Array.isArray(right)) {
        if (keyed(left) && keyed(right)) {
          const old = new Map(left.map(item => [item.id, item]));
          if (left.length !== right.length || right.some((item, index) => item.id !== left[index]?.id)) {
            add({ op: 'order', path, ids: right.map(item => item.id), added: right.filter(item => !old.has(item.id)) });
          }
          right.forEach((item, index) => { if (old.has(item.id)) visit(old.get(item.id), item, [...path, index]); });
          return;
        }
        if (left.length === right.length) { right.forEach((item, index) => visit(left[index], item, [...path, index])); return; }
      } else if (object(left) && object(right) && !Array.isArray(left) && !Array.isArray(right)) {
        for (const key of Object.keys(left)) if (!own(right, key)) add({ op: 'delete', path: [...path, key] });
        for (const key of Object.keys(right)) {
          if (own(left, key)) visit(left[key], right[key], [...path, key]);
          else add({ op: 'set', path: [...path, key], value: right[key] });
        }
        return;
      }
      add({ op: 'set', path, value: right });
    }
    visit(before, after, []); return ops;
  }
  // Copy only modified branches. Own-property traversal and defineProperty
  // keep JSON keys such as __proto__ from accessing or changing prototypes.
  function apply(before, ops) {
    if (!Array.isArray(ops) || ops.length > 4096) throw new Error('Invalid patch');
    let result = before;
    for (const op of ops) {
      if (!op || !Array.isArray(op.path) || op.path.length > 64 || op.path.some(key => typeof key !== 'string' && !Number.isSafeInteger(key))) throw new Error('Invalid patch path');
      function change(value, depth) {
        if (depth === op.path.length) {
          if (op.op === 'set') return op.value;
          if (op.op === 'text') {
            if (typeof value !== 'string' || typeof op.text !== 'string' || !Number.isSafeInteger(op.start) || !Number.isSafeInteger(op.remove)
              || op.start < 0 || op.remove < 0 || op.start + op.remove > value.length) throw new Error('Invalid text patch');
            return value.slice(0, op.start) + op.text + value.slice(op.start + op.remove);
          }
          if (op.op === 'order') {
            if (!keyed(value) || !keyed(op.added) || !Array.isArray(op.ids) || op.ids.some(id => typeof id !== 'string') || new Set(op.ids).size !== op.ids.length) throw new Error('Invalid array patch');
            const entries = new Map(value.map(item => [item.id, item]));
            for (const item of op.added) { if (entries.has(item.id)) throw new Error('Duplicate added item'); entries.set(item.id, item); }
            return op.ids.map(id => { if (!entries.has(id)) throw new Error('Missing array item'); return entries.get(id); });
          }
          throw new Error('Invalid operation');
        }
        const key = op.path[depth], last = depth === op.path.length - 1;
        if (!object(value) || (Array.isArray(value) && (!Number.isSafeInteger(key) || key < 0 || key >= value.length))) throw new Error('Invalid patch target');
        if (!own(value, key) && !(last && op.op === 'set' && !Array.isArray(value))) throw new Error('Missing patch target');
        const next = Array.isArray(value) ? value.slice() : { ...value };
        if (last && op.op === 'delete') { if (Array.isArray(value)) throw new Error('Invalid array deletion'); delete next[key]; }
        else Object.defineProperty(next, key, { value: change(own(value, key) ? value[key] : undefined, depth + 1), enumerable: true, configurable: true, writable: true });
        return next;
      }
      result = change(result, 0);
    }
    return result;
  }
  return { protocol, diff, apply };
});
