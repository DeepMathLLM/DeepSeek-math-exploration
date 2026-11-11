// Exact arithmetic and conversions for positive principal hooks.
import assert from 'node:assert/strict';

export const sum = values => values.reduce((total, value) => total + value, 0);

export function isPartition(shape) {
  return Array.isArray(shape) && shape.every((part, i) =>
    Number.isSafeInteger(part) && part > 0 && (i === 0 || shape[i - 1] >= part));
}

export function legalHooks(hooks, n, gap = 2) {
  return Number.isSafeInteger(n) && n >= 0 && Number.isSafeInteger(gap) && gap >= 2 &&
    Array.isArray(hooks) && hooks.every((hook, i) =>
      Number.isSafeInteger(hook) && hook > 0 && (i === 0 || hooks[i - 1] - hook >= gap)) &&
    sum(hooks) === n;
}

const factorials = [1n];
export function factorial(n) {
  assert(Number.isSafeInteger(n) && n >= 0, 'invalid factorial index');
  for (let k = factorials.length; k <= n; ++k) {
    factorials.push(BigInt(k) * factorials[k - 1]);
  }
  return factorials[n];
}

export function transpose(shape) {
  assert(isPartition(shape), 'invalid partition');
  const columns = new Array(shape[0] ?? 0);
  let height = shape.length;
  for (let column = 1; column <= columns.length; ++column) {
    while (shape[height - 1] < column) --height;
    columns[column - 1] = height;
  }
  return columns;
}

export function principalHooks(shape) {
  const columns = transpose(shape);
  const hooks = [];
  for (let i = 0; i < shape.length && shape[i] > i; ++i) {
    hooks.push(shape[i] + columns[i] - 2 * i - 1);
  }
  return hooks;
}

export function fromFrobenius(arms, legs) {
  const decreasing = sequence => sequence.every((value, i) =>
    Number.isSafeInteger(value) && value >= 0 && (i === 0 || sequence[i - 1] > value));
  assert(arms.length === legs.length && decreasing(arms) && decreasing(legs),
    'invalid Frobenius coordinates');
  const rows = arms.map((value, i) => i + 1 + value);
  const columns = legs.map((value, i) => i + 1 + value);
  let width = columns.length;
  for (let row = rows.length + 1; row <= columns[0]; ++row) {
    while (columns[width - 1] < row) --width;
    rows.push(width);
  }
  return rows;
}

export function balanced(hooks) {
  assert(legalHooks(hooks, sum(hooks)), 'invalid principal hooks');
  return fromFrobenius(hooks.map(h => Math.floor(h / 2)), hooks.map(h => Math.floor((h - 1) / 2)));
}

export function ordinaryDegree(shape) {
  const columns = transpose(shape);
  let hookProduct = 1n;
  for (let row = 0; row < shape.length; ++row) {
    for (let column = 0; column < shape[row]; ++column) {
      const hook = shape[row] - column + columns[column] - row - 1;
      hookProduct *= BigInt(hook);
    }
  }
  const numerator = factorial(sum(shape));
  assert(numerator % hookProduct === 0n, 'ordinary hook formula was not integral');
  return numerator / hookProduct;
}

export function ratio(numerator, denominator) {
  assert(numerator >= 0n && denominator > 0n, 'invalid nonnegative ratio');
  let a = numerator, b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return [numerator / a, denominator / a];
}

export function ratioText(numerator, denominator) {
  const [a, b] = ratio(numerator, denominator);
  return b === 1n ? String(a) : `${a}/${b}`;
}

function weightProducts(hooks, n) {
  assert(legalHooks(hooks, n), 'invalid principal hooks');
  let numerator = 1n, denominator = 1n;
  for (let i = 0; i < hooks.length; ++i) {
    const v = hooks[i];
    denominator *= BigInt(v) * factorial(Math.floor(v / 2)) * factorial(Math.floor((v - 1) / 2));
    for (let j = 0; j < i; ++j) {
      const d = BigInt(hooks[j] - v), s = BigInt(hooks[j] + v), parity = d % 2n;
      numerator *= (d - parity) * (d + parity);
      denominator *= (s - parity) * (s + parity);
    }
  }
  return [numerator, denominator];
}

export function weight(hooks) {
  return ratio(...weightProducts(hooks, sum(hooks)));
}

export function balancedDegree(hooks, n = sum(hooks)) {
  const [productNumerator, denominator] = weightProducts(hooks, n);
  const numerator = factorial(n) * productNumerator;
  assert(numerator > 0n && numerator % denominator === 0n, 'Frobenius formula was not integral');
  return numerator / denominator;
}

export function lex(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); ++i) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export function recordMaxima(hooks, n, gap, degree) {
  assert(hooks.length > 0 && new Set(hooks.map(String)).size === hooks.length,
    'empty or duplicate maximizing hooks');
  const shapes = new Map();
  let minGap = Infinity;
  for (const h of hooks) {
    assert(legalHooks(h, n, gap), 'invalid maximum');
    for (let i = 1; i < h.length; ++i) minGap = Math.min(minGap, h[i - 1] - h[i]);
    const shape = balanced(h);
    for (const p of [shape, transpose(shape)]) {
      assert(sum(p) === n && String(principalHooks(p)) === String(h) && ordinaryDegree(p) === degree,
        'shape or degree disagrees with the ordinary hook formula');
      shapes.set(String(p), p);
    }
  }
  return {
    max_degree: String(degree),
    maximizing_h: hooks.slice().sort(lex),
    maximizing_partitions: [...shapes.values()].sort(lex),
    conjugacy_classes: hooks.length,
    partition_count: shapes.size,
    min_gap: Number.isFinite(minGap) ? minGap : null,
  };
}
