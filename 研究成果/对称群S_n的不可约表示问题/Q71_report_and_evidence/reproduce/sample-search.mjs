// Exercise the production search against small and explicitly bounded domains.
import fs from 'node:fs';
import { certifyTieFixture, tangentSearch } from './tangent-search.mjs';

const small = [];
for (const weakPivot of [false, true]) {
  for (const [gap, scope] of [[2, 'global'], [2, 'rank'], [4, 'rank']]) {
    small.push(tangentSearch(1, 35, gap, scope, {}, {weakPivot}));
  }
}
const fixtures = JSON.parse(fs.readFileSync(new URL('inputs/ties.json', import.meta.url), 'utf8'));
const ties = fixtures.map(({n, domains}) => certifyTieFixture(n, domains));
process.stdout.write(JSON.stringify({small, ties}));
