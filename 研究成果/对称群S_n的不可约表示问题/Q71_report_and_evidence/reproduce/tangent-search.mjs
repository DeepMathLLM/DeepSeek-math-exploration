// Branch and bound with integer log enclosures. Adapted from the fourth
// GPT audit's compute/certify_q71.mjs (see code/README.md).
import { balancedDegree as degree, legalHooks as legal, recordMaxima, sum } from './hooks.mjs';

const MAX = 350;
const S = 2 ** 34;
const Q = 2 ** 20;
const M = 24;
const NONE = -Infinity;

function requireThat(ok, what) {
  if (!ok) throw new Error(what);
}

const upperDiv = (a, b) => (a + b - 1n) / b; // a >= 0, b > 0

function logSeries(a, b) {
  // Exact integers for S*2*atanh(a/b), 0 <= a/b <= 1/3.
  let lo = 0n, hi = 0n, p = a, q = b;
  const aa = a * a, bb = b * b, twiceScale = BigInt(2 * S);
  for (let j = 0; j < M; ++j) {
    const den = BigInt(2 * j + 1) * q;
    lo += twiceScale * p / den;
    hi += upperDiv(twiceScale * p, den);
    p *= aa;
    q *= bb;
  }
  hi += upperDiv(twiceScale * p * bb, BigInt(2 * M + 1) * q * (bb - aa));
  return [Number(lo), Number(hi)];
}

// q is a signed coefficient in units 1/Q. l is a nonnegative integer log
// endpoint. Both products below are exact integers in the supported range.
function mulFloor(q, l) {
  const a = Math.floor(l / Q), b = l - a * Q;
  return q * a + Math.floor(q * b / Q);
}
function mulCeil(q, l) { return -mulFloor(-q, l); }

function tables(top) {
  const w = top + 1;
  const lo = new Float64Array(2 * top + 2), hi = new Float64Array(lo.length);
  const [l2, u2] = logSeries(1n, 3n);
  for (let k = 1, p = 1, j = 0; k < lo.length; ++k) {
    if (k === 2 * p) { p *= 2; ++j; }
    const [l, u] = logSeries(BigInt(k - p), BigInt(k + p));
    lo[k] = l + j * l2;
    hi[k] = u + j * u2;
    requireThat(hi[k] < 11 * S && hi[k] - lo[k] <= 250, `log enclosure for ${k}`);
  }
  const factLo = new Float64Array(w), factHi = new Float64Array(w);
  const oneLo = new Float64Array(w), oneHi = new Float64Array(w);
  const pairLo = new Float64Array(w * w), pairHi = new Float64Array(w * w);
  for (let x = 1; x <= top; ++x) {
    factLo[x] = factLo[x - 1] + lo[x];
    factHi[x] = factHi[x - 1] + hi[x];
    const a = x >> 1, b = (x - 1) >> 1;
    oneLo[x] = -hi[x] - factHi[a] - factHi[b];
    oneHi[x] = -lo[x] - factLo[a] - factLo[b];
    for (let y = 1; y + 2 <= x; ++y) {
      const d = x - y, s = x + y, e = d & 1;
      const k = x * w + y;
      pairLo[k] = lo[d - e] + lo[d + e] - hi[s - e] - hi[s + e];
      pairHi[k] = hi[d - e] + hi[d + e] - lo[s - e] - lo[s + e];
    }
  }
  return {top, w, lo, hi, oneLo, oneHi, pairLo, pairHi};
}

function logWeight(h, tab, upper) {
  const {w} = tab, one = upper ? tab.oneHi : tab.oneLo, pair = upper ? tab.pairHi : tab.pairLo;
  let result = 0;
  for (let i = 0; i < h.length; ++i) {
    result += one[h[i]];
    for (let j = 0; j < i; ++j) result += pair[h[j] * w + h[i]];
  }
  return result;
}

// Incumbents and pivots are selected heuristically. No claim is based on
// their presumed optimality. Even a poor pivot gives a valid upper bound.
function choosePivot(n, r, gap, base, N, previous, supplied, tab) {
  const isCandidate = h => h && h.length === r && legal(h, n, gap);
  let best = base.map((x, i) => x + Math.floor(N / r) + Number(i < N % r));
  let bestLog = logWeight(best, tab, true);
  function consider(h) {
    if (!isCandidate(h)) return;
    const v = logWeight(h, tab, true);
    if (v > bestLog) { best = h; bestLog = v; }
  }
  for (const h of supplied) consider(h);
  if (previous) {
    for (let i = 0; i < r; ++i) {
      const h = previous.slice();
      ++h[i];
      consider(h);
    }
  }
  for (const power of [1, 2, 3]) {
    const wt = base.map((_, i) => (r - i) ** power), total = wt.reduce((s, x) => s + x, 0);
    const extras = wt.map(x => Math.floor(x * N / total));
    const left = N - extras.reduce((s, x) => s + x, 0);
    consider(base.map((x, i) => x + extras[i] + Number(i < left)));
  }

  if (r <= 1) return best;
  const {oneHi, pairHi, w} = tab;
  let h = best.slice();
  function pair(x, y) { return x > y ? pairHi[x * w + y] : pairHi[y * w + x]; }
  // Fixed-rank ascent is for speed only. There is no exhaustive-neighborhood claim.
  for (;;) {
    let improvement = 0, p = -1, q = -1, step = 0;
    for (let i = 0; i < r; ++i) for (let j = 0; j < r; ++j) {
      if (i === j) continue;
      for (let d = 1; d <= 2; ++d) {
        const x = h[i] + d, y = h[j] - d;
        if (y < 1) continue;
        if (i > 0 && (i - 1 === j ? y : h[i-1]) - x < gap) continue;
        if (i + 1 < r && x - (i + 1 === j ? y : h[i+1]) < gap) continue;
        if (j > 0 && (j - 1 === i ? x : h[j-1]) - y < gap) continue;
        if (j + 1 < r && y - (j + 1 === i ? x : h[j+1]) < gap) continue;
        let delta = oneHi[x] + oneHi[y] - oneHi[h[i]] - oneHi[h[j]] + pair(x, y) - pair(h[i], h[j]);
        for (let k = 0; k < r; ++k) {
          if (k === i || k === j) continue;
          delta += pair(x, h[k]) + pair(y, h[k]) - pair(h[i], h[k]) - pair(h[j], h[k]);
        }
        if (delta > improvement) { improvement = delta; p = i; q = j; step = d; }
      }
    }
    if (p < 0) break;
    h[p] += step; h[q] -= step;
  }
  requireThat(isCandidate(h), 'invalid pivot');
  return h;
}

function countTables(top, maxRank) {
  const stride = top + 1, out = [];
  // k remaining slots, nonincreasing nonnegative entries with cap b, sum s.
  const empty = new Float64Array(stride * stride);
  for (let b = 0; b <= top; ++b) empty[b * stride] = 1;
  out.push(empty);
  const independent = [Array.from({length: stride}, (_, s) => s === 0 ? 1n : 0n)];
  for (let k = 1; k <= maxRank; ++k) {
    const prev = out[k - 1], cur = new Float64Array(stride * stride);
    cur[0] = 1;
    for (let b = 1; b <= top; ++b) {
      const off = b * stride;
      cur.set(cur.subarray(off - stride, off), off);
      for (let s = b; s <= Math.min(top, k * b); ++s) {
        const c = cur[off + s] + prev[off + s - b];
        requireThat(Number.isSafeInteger(c), 'completion count exceeds integer precision');
        cur[off + s] = c;
      }
    }
    out.push(cur);
    const p = independent[k - 1].slice();
    for (let s = k; s <= top; ++s) p[s] += p[s-k];
    independent.push(p);
  }
  return {out, stride, independent};
}

function tangent(pivot, base, N, tab) {
  const {lo, hi, oneHi} = tab, r = pivot.length;
  const linHi = new Float64Array(r), logHi = new Float64Array(r);
  const linLoPair = new Float64Array(r*r), logUpPair = new Float64Array(r*r);
  const logVpPair = new Float64Array(r*r);
  const interceptLo = new Float64Array(r * r);
  let interceptHi = 0;
  function rationalBounds(num, den) {
    const a = BigInt(num) * BigInt(Q), b = BigInt(den);
    return [Number(a/b), Number(upperDiv(a,b))];
  }
  for (let i = 0; i < r; ++i) for (let j = i+1; j < r; ++j) {
    const a = pivot[i], b = pivot[j], d = a-b, s = a+b, ij = i*r+j;
    const [kl, ku] = rationalBounds(2, d);
    const [al, au] = rationalBounds(2*a, s);
    const [bl, bu] = rationalBounds(2*b, s);
    linHi[i] += ku; linHi[j] -= kl;
    logHi[i] -= al; logHi[j] -= bl;
    linLoPair[ij] = kl; logUpPair[ij] = au; logVpPair[ij] = bu;
    interceptLo[ij] = 2*(lo[d] - hi[s]) - 2*S + mulFloor(al, lo[a]) + mulFloor(bl, lo[b]);
    interceptHi += 2*(hi[d] - lo[s]) - 2*S + mulCeil(au, hi[a]) + mulCeil(bu, hi[b]);
  }
  const caps = Array.from({length: r}, (_, i) => Math.floor(N / (i + 1)));
  const weights = caps.map((cap, i) => {
    const arr = new Float64Array(cap + 1);
    for (let v = 0; v <= cap; ++v) {
      const x = base[i] + v;
      arr[v] = oneHi[x] + linHi[i] * x * (S/Q) + mulCeil(logHi[i], lo[x]);
    }
    return arr;
  });
  return {interceptHi, interceptLo, linLoPair, logUpPair, logVpPair, caps, weights};
}

function suffixUpper(r, N, caps, weights) {
  const width = N + 1, ans = [];
  for (let i = r - 1; i >= 0; --i) {
    const cap = caps[i], a = new Float64Array((cap + 1) * width).fill(NONE);
    const next = ans[i+1];
    const k = r - i;
    for (let b = 0; b <= cap; ++b) {
      const off = b * width, val = weights[i][b];
      if (b > 0) a.set(a.subarray(off - width, off), off);
      if (k === 1) {
        a[off + b] = val;
      } else {
        const nextOff = Math.min(b, caps[i+1]) * width;
        for (let s = b; s <= Math.min(N, k * b); ++s) {
          const v = val + next[nextOff + s - b];
          if (v > a[off + s]) a[off + s] = v;
        }
      }
    }
    ans[i] = a;
  }
  return ans;
}

function certifyRank(n, gap, base, N, pivot, context, tab, counts) {
  const r = pivot.length, width = N + 1, {lo, hi, pairHi, w} = tab;
  const {interceptHi, interceptLo, linLoPair, logUpPair, logVpPair, caps, weights} = tangent(pivot, base, N, tab);
  const suffix = suffixUpper(r, N, caps, weights);
  const domain = counts.out[r][N * counts.stride + N];
  requireThat(BigInt(domain) === counts.independent[r][N], 'independent domain counts differ');
  let pruned = 0, exactLeaves = 0, nodes = 0;
  const h = new Array(r);
  function visit(i, s, b, fixed) {
    ++nodes;
    const k = r - i;
    if (i === r) {
      requireThat(s === 0, 'leaf sum mismatch');
      const up = logWeight(h, tab, true);
      if (up < context.lower) { ++pruned; return; }
      ++exactLeaves;
      const d = degree(h, n);
      const lower = logWeight(h, tab, false);
      if (lower > context.lower) context.lower = lower;
      if (d > context.best) { context.best = d; context.ties.length = 0; }
      if (d === context.best) context.ties.push(h.slice());
      return;
    }
    const cap = Math.min(b, caps[i], s);
    const off = cap * width;
    if (fixed + suffix[i][off + s] < context.lower) {
      pruned += counts.out[k][Math.min(b, s) * counts.stride + s];
      return;
    }
    for (let v = cap, end = Math.ceil(s / k); v >= end; --v) {
      const x = base[i] + v;
      h[i] = x;
      let f = fixed + weights[i][v];
      for (let j = 0; j < i; ++j) {
        const y = h[j], p = j * r + i;
        const tangLo = interceptLo[p] + linLoPair[p] * (y-x) * (S/Q)
          - mulCeil(logUpPair[p], hi[y]) - mulCeil(logVpPair[p], hi[x]);
        f -= Math.max(0, tangLo - pairHi[y * w + x]);
      }
      visit(i + 1, s - v, v, f);
    }
  }
  visit(0, N, N, interceptHi);
  requireThat(pruned + exactLeaves === domain, `coverage failure for n=${n}, r=${r}, gap=${gap}`);
  return {rank:r, domain_count:domain, strictly_pruned:pruned, exact_leaves:exactLeaves, nodes};
}

function contextFor(h, n, tab) {
  return {lower:logWeight(h, tab, false), best:degree(h, n), ties:[]};
}

export function tangentSearch(first, last, gap, scope, seeds = {}, {weakPivot = false} = {}) {
  requireThat(Number.isInteger(first) && Number.isInteger(last) && first >= 1 && first <= last && last <= MAX, 'invalid target range');
  requireThat([2, 4].includes(gap) && ['global', 'rank'].includes(scope), 'invalid gap or scope');
  const tab = tables(last);
  let maxRank = 1;
  while ((maxRank+1) + gap * (maxRank+1) * maxRank / 2 <= last) ++maxRank;
  const counts = countTables(last, maxRank), rows = {}, previous = [];
  for (let n = first; n <= last; ++n) {
    const work = [], supplied = weakPivot ? [] : (seeds[n] || []);
    for (const h of supplied) requireThat(legal(h, n, 2), `invalid supplied seed at n=${n}`);
    for (let r = 1; r <= maxRank; ++r) {
      const N = n - r - gap*r*(r-1)/2;
      if (N < 0) break;
      const base = Array.from({length:r}, (_, i) => 1 + gap*(r-1-i));
      const pivot = weakPivot ? [base[0] + N, ...base.slice(1)] :
        choosePivot(n, r, gap, base, N, previous[r], supplied, tab);
      work.push({r, N, base, pivot, l:logWeight(pivot, tab, false)});
    }
    // The incumbent comparison is safe across ranks only in global mode.
    if (scope === 'global') {
      work.sort((a,b) => b.l-a.l);
      const context = contextFor(weakPivot ? [n] : work[0].pivot, n, tab), stats = [];
      const candidates = weakPivot ? [] : [...work.map(w => w.pivot), ...supplied.filter(h => legal(h, n, gap))];
      for (const h of candidates) {
        const lower = logWeight(h, tab, false), d = degree(h,n);
        if (lower > context.lower) context.lower = lower;
        if (d > context.best) context.best = d;
      }
      for (const w of work) {
        stats.push(certifyRank(n, gap, w.base, w.N, w.pivot, context, tab, counts));
        previous[w.r] = context.ties.find(h => h.length === w.r) || w.pivot;
      }
      const row = recordMaxima(context.ties, n, gap, context.best);
      for (const key of ['domain_count', 'strictly_pruned', 'exact_leaves', 'nodes']) {
        row[key] = stats.reduce((s, r) => s + r[key], 0);
        requireThat(Number.isSafeInteger(row[key]), `unsafe aggregate ${key}`);
      }
      row.rank_coverage = stats.sort((a, b) => a.rank - b.rank);
      rows[n] = row;
    } else {
      const ranks = [];
      for (const w of work) {
        const context = contextFor(w.pivot, n, tab);
        const stat = certifyRank(n, gap, w.base, w.N, w.pivot, context, tab, counts);
        const max = recordMaxima(context.ties, n, gap, context.best);
        previous[w.r] = max.maximizing_h[0];
        ranks.push({...stat, ...max});
      }
      const d = ranks.map(x => BigInt(x.max_degree)), peak = d.indexOf(d.reduce((a, b) => a > b ? a : b));
      const strictly_unimodal = d.every((v, i) => i === 0 || (i <= peak ? v > d[i-1] : v < d[i-1]));
      const strictly_log_concave = d.every((v, i) => i === 0 || i === d.length - 1 || v*v > d[i-1]*d[i+1]);
      rows[n] = {peak_ranks:ranks.filter((_, i) => d[i] === d[peak]).map(x => x.rank),
        strictly_unimodal, strictly_log_concave, ranks};
    }
  }
  return {first, last, gap, scope, rows};
}


export function certifyTieFixture(n, domains) {
  // Each fixture supplies disjoint bounded rank domains and feasible pivots.
  const gap = 2;
  const tab = tables(n);
  const counts = countTables(n, Math.max(...domains.map(([base]) => base.length)));
  const context = contextFor(domains[0][2], n, tab);
  const stats = domains.map(([base, slack, pivot]) => {
    requireThat(legal(base, n - slack, gap) && legal(pivot, n, gap) &&
      sum(pivot.map((h, i) => h - base[i])) === slack &&
      pivot.every((h, i) => h >= base[i] && (i === 0 || pivot[i - 1] - base[i - 1] >= h - base[i])),
      'infeasible fixture pivot');
    return certifyRank(n, gap, base, slack, pivot, context, tab, counts);
  });
  return {stats, ...recordMaxima(context.ties, n, gap, context.best)};
}
