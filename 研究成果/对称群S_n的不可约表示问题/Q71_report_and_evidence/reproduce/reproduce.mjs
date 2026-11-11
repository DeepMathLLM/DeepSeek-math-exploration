// Run the reported finite searches with no external packages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { tangentSearch } from './tangent-search.mjs';

const tasks = [
  [1, 200, 2, 'global', 'seeds_1_200.json'],
  [201, 270, 2, 'global', 'seeds_200_350.json'],
  [271, 305, 2, 'global', 'seeds_200_350.json'],
  [306, 332, 2, 'global', 'seeds_200_350.json'],
  [333, 350, 2, 'global', 'seeds_200_350.json'],
  [1, 350, 4, 'rank', 'seeds_200_350.json'],
];
const here = new URL('.', import.meta.url);

function writeTable(file, metadata, rows) {
  // Keep each degree as decimal text and each n on its own line.
  const header = JSON.stringify(metadata, null, 2).slice(0, -2);
  const body = Object.entries(rows).map(([n, row]) => `    "${n}": ${JSON.stringify(row)}`).join(',\n');
  fs.writeFileSync(file, `${header},\n  "rows": {\n${body}\n  }\n}\n`, 'utf8');
}

function startTask(task, noSeeds) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {workerData: {task, noSeeds}});
    worker.on('message', resolve);
    worker.on('error', reject);
    worker.on('exit', code => {
      if (code !== 0) reject(new Error(`Search worker exited with status ${code}`));
    });
  });
}

function runTask() {
  const {task: [first, last, gap, scope, seedFile], noSeeds} = workerData;
  const seeds = noSeeds ? {} : JSON.parse(fs.readFileSync(new URL(`inputs/${seedFile}`, here), 'utf8')).seeds;
  parentPort.postMessage(tangentSearch(first, last, gap, scope, seeds));
}

async function main() {
  const {values: options} = parseArgs({options: {
    'out-dir': {type:'string', default:'reproduced-tables'},
    jobs: {type:'string', default:'5'},
    'no-seeds': {type:'boolean', default:false},
  }});
  const jobs = Number(options.jobs);
  assert(Number.isSafeInteger(jobs) && jobs >= 1, '--jobs must be a positive integer');
  const out = path.resolve(options['out-dir']);
  fs.mkdirSync(out, {recursive: true});

  const parts = [];
  let nextTask = 0;
  await Promise.all(Array.from({length: Math.min(jobs, tasks.length)}, async () => {
    while (nextTask < tasks.length) {
      const index = nextTask++;
      const part = await startTask(tasks[index], options['no-seeds']);
      parts[index] = part;
    }
  }));

  const rank = parts.at(-1);
  const natural = Object.assign({}, ...parts.slice(0, -1).map(part => part.rows));
  assert.equal(Object.keys(natural).length, 350);
  assert.equal(Object.keys(rank.rows).length, 350);
  for (let n = 1; n <= 350; ++n) {
    const row = natural[n], profile = rank.rows[n];
    const peak = profile.ranks[profile.peak_ranks[0] - 1].max_degree;
    assert(BigInt(peak) <= BigInt(row.max_degree), `restricted maximum exceeds natural maximum at n=${n}`);
    if (peak === row.max_degree) {
      const rankHooks = profile.ranks.filter(r => r.max_degree === peak).flatMap(r => r.maximizing_h);
      const naturalHooks = row.maximizing_h.filter(h => h.every((v, i) => !i || h[i - 1] - v >= 4));
      assert.deepEqual(rankHooks.map(String).sort(), naturalHooks.map(String).sort());
    }
  }

  const filenames = ['natural_maxima_1_350.json', 'rank_profile_gap4_1_350.json'];
  writeTable(path.join(out, filenames[0]), {first:1, last:350, gap:2, scope:'global'}, natural);
  writeTable(path.join(out, filenames[1]), {first:1, last:350, gap:4, scope:'rank'}, rank.rows);

}

if (isMainThread) await main();
else runTask();
