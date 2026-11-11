import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

function gcd(a, b) {
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

function ratio(numerator, denominator = 1n) {
  assert(numerator > 0n && denominator > 0n);
  const divisor = gcd(numerator, denominator);
  return [numerator / divisor, denominator / divisor];
}

function multiply(a, b) {
  return ratio(a[0] * b[0], a[1] * b[1]);
}

function divide(a, b) {
  return ratio(a[0] * b[1], a[1] * b[0]);
}

function compare(a, b) {
  const difference = a[0] * b[1] - a[1] * b[0];
  return difference < 0n ? -1 : Number(difference > 0n);
}

function factorial(n) {
  let value = 1n;
  for (let i = 2n; i <= n; i += 1n) value *= i;
  return value;
}

function oneHook(x) {
  const h = BigInt(x);
  return ratio(1n, h * factorial(h / 2n) * factorial((h - 1n) / 2n));
}

function interaction(x, y) {
  const a = BigInt(x);
  const b = BigInt(y);
  const parity = (a + b) % 2n;
  return ratio((a - b) ** 2n - parity, (a + b) ** 2n - parity);
}

function hookProduct(hooks) {
  const rank = hooks.length;
  const arms = hooks.map(h => Math.floor(h / 2));
  const legs = hooks.map(h => Math.floor((h - 1) / 2));
  const rows = Array.from({length: legs[0] + 1}, (_, i) =>
    i < rank ? i + 1 + arms[i] : legs.filter((leg, j) => j + leg >= i).length
  );
  assert.equal(rows.reduce((sum, length) => sum + length, 0), hooks.reduce((sum, h) => sum + h, 0));
  let product = 1n;
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < rows[i]; j++) {
      const below = rows.slice(i + 1).filter(row => row > j).length;
      product *= BigInt(rows[i] - j + below);
    }
  }
  return product;
}

function weight(hooks) {
  let value = ratio(1n);
  for (let i = 0; i < hooks.length; i++) {
    value = multiply(value, oneHook(hooks[i]));
    for (let j = i + 1; j < hooks.length; j++) {
      value = multiply(value, interaction(hooks[i], hooks[j]));
    }
  }
  return value;
}

function verifyMoveFixtures() {
  const path = new URL('structural_fixtures.json', import.meta.url);
  const {cases} = JSON.parse(readFileSync(path, 'utf8'));
  for (const fixture of cases) {
    const {id, h, h_prime: target, ratio: expected} = fixture;
    for (const hooks of [h, target]) {
      assert(hooks.at(-1) > 0 && hooks.slice(1).every((x, i) => hooks[i] - x >= 2), id);
    }
    assert.equal(h.reduce((sum, x) => sum + x, 0), target.reduce((sum, x) => sum + x, 0), id);
    assert.equal(ratio(hookProduct(h), hookProduct(target)).join('/'), expected, id);
    assert.equal(divide(weight(target), weight(h)).join('/'), expected, id);
  }
  return cases.length;
}

function measureTransfer(hooks) {
  const first = hooks[0];
  const last = hooks.at(-1);
  const target = [first + 1, ...hooks.slice(1, -1), last - 1];
  assert(target.at(-1) > 0 && target.slice(1).every((x, i) => target[i] - x >= 2));
  const single = multiply(divide(oneHook(first + 1), oneHook(first)), divide(oneHook(last - 1), oneHook(last)));
  const movedPair = divide(interaction(first + 1, last - 1), interaction(first, last));
  const outer = hooks.slice(1, -1).map(z => multiply(
    divide(interaction(first + 1, z), interaction(first, z)),
    divide(interaction(last - 1, z), interaction(last, z))
  ));
  const smallestOuter = outer.reduce((a, b) => compare(a, b) <= 0 ? a : b);
  const power = BigInt(outer.length);
  const conservative = multiply(multiply(single, movedPair), ratio(smallestOuter[0] ** power, smallestOuter[1] ** power));
  const exact = outer.reduce(multiply, multiply(single, movedPair));
  assert.equal(compare(exact, ratio(hookProduct(hooks), hookProduct(target))), 0);
  assert(compare(exact, conservative) >= 0);
  return {hooks, target, exact, conservative};
}

function countClassG(maxN, minimumRank = 3, restricted = false) {
  const counts = Array(maxN + 1).fill(0n);
  for (let rank = minimumRank; rank + 3 * rank * (rank - 1) / 2 <= maxN; rank++) {
    const base = rank + 3 * rank * (rank - 1) / 2;
    const maxSlack = maxN - base;
    // Gap i is 3 + slack_i for i < rank. The bottom hook is 1 + slack_rank.
    // The rank-and-gap constraints give n = base + sum(i * slack_i).
    // The third state coordinate records whether the zero count is 0, 1, or at least 2.
    let states = Array.from({length: maxSlack + 1}, () => [0n, 0n, 0n]);
    states[0][0] = 1n;
    for (let i = 1; i <= rank; i++) {
      const next = Array.from({length: maxSlack + 1}, () => [0n, 0n, 0n]);
      const minVariable = restricted && i === 1 ? 1 : 0;
      const maxVariable = restricted && i === rank ? 4 : maxSlack;
      for (let s = 0; s <= maxSlack; s++) {
        for (let z = 0; z <= 2; z++) {
          if (states[s][z] === 0n) continue;
          for (let x = minVariable; x <= maxVariable && s + i * x <= maxSlack; x++) {
            const zeros = Math.min(2, z + Number(i < rank && x === 0));
            next[s + i * x][zeros] += states[s][z];
          }
        }
      }
      states = next;
    }
    for (let s = 0; s <= maxSlack; s++) counts[base + s] += states[s][2];
  }
  return counts;
}

function cumulative(counts, n) {
  return counts.slice(0, n + 1).reduce((sum, value) => sum + value, 0n);
}

const counts = countClassG(350);
const atLeastRankFour = countClassG(350, 4);
const restricted = countClassG(350, 4, true);
assert.equal(cumulative(counts, 100), 60_912n);
assert.equal(cumulative(counts, 120), 284_944n);
assert.equal(cumulative(counts, 200), 44_838_202n);
assert.equal(cumulative(counts, 300), 6_352_849_322n);
assert.equal(cumulative(restricted, 300), 5_141_846_762n);

const templates = [];
for (let rank = 4; rank <= 9; rank++) {
  for (let mask = 0; mask < 2 ** (rank - 1); mask++) {
    const gaps = Array.from({length: rank - 1}, (_, i) => (mask & (1 << i)) ? 3 : 4);
    if (gaps.filter(gap => gap === 3).length < 2) continue;
    const hooks = [34];
    for (const gap of gaps) hooks.push(hooks.at(-1) - gap);
    templates.push(measureTransfer(hooks));
  }
}
assert.equal(templates.length, 465);

function minimum(field) {
  const value = templates.map(t => t[field]).reduce((a, b) => compare(a, b) <= 0 ? a : b);
  return {ratio: value.join('/'), hooks: templates.filter(t => compare(t[field], value) === 0).map(t => t.hooks)};
}

const minimumExact = minimum('exact');
const minimumConservative = minimum('conservative');
assert.equal(minimumExact.ratio, '1332045/489056');
assert.equal(minimumConservative.ratio, '16599265906765726789632/11564567872159680156625');
assert.equal(minimumConservative.hooks.length, 6);
const sizes = templates.map(t => t.hooks.reduce((sum, h) => sum + h, 0));
assert.deepEqual([Math.min(...sizes), Math.max(...sizes)], [115, 198]);

const step = [[80, 77, 74, 70], [81, 78, 75, 71]].map(measureTransfer);
assert(compare(step[0].conservative, step[1].conservative) > 0);
assert(compare(step[0].exact, step[1].exact) > 0);

console.log(JSON.stringify({
  exact_move_fixtures: verifyMoveFixtures(),
  count_scope: 'all adjacent gaps >= 3, at least two equal to 3, positive bottom hook',
  counts: [50, 60, 100, 120, 125, 150, 200, 300, 350].map(n => ({
    max_n: n,
    count: cumulative(counts, n).toString(),
    count_rank_at_least_four: cumulative(atLeastRankFour, n).toString(),
    count_rank_at_least_four_top_gap_at_least_four_bottom_at_most_five: cumulative(restricted, n).toString()
  })),
  fixed_templates: {
    scope: 'first hook 34, rank 4..9, all adjacent gaps 3 or 4 with at least two 3s',
    count: templates.length,
    n_min: Math.min(...sizes),
    n_max: Math.max(...sizes),
    minimum_exact_ratio: minimumExact,
    minimum_conservative_ratio: minimumConservative
  },
  translated_counterexample: step.map(t => ({
    hooks: t.hooks,
    target: t.target,
    exact_ratio: t.exact.join('/'),
    conservative_ratio: t.conservative.join('/')
  }))
}, null, 2));
