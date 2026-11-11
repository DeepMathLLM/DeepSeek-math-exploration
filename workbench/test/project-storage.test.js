'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Readable } = require('node:stream');
process.env.deepmath_max_project_mb = '1';
const files = require('../src/project-files'), storage = require('../src/project-storage'), transfers = require('../src/project-transfers');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmath-storage-limit-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, project: files.createProject(root), other: files.createProject(root) };
}
function request(bytes) { const req = Readable.from([bytes]); req.headers = {}; return req; }
test('total capacity includes generated files, nested and hidden files; links never add outside target bytes', t => {
  const { project, other } = fixture(t);
  fs.mkdirSync(path.join(project, '.hidden'));
  fs.writeFileSync(path.join(project, 'generated.bin'), Buffer.alloc(600000));
  fs.writeFileSync(path.join(project, '.hidden', 'evidence.bin'), Buffer.alloc(250000));
  fs.writeFileSync(path.join(other, 'private.bin'), Buffer.alloc(2 * 1024 * 1024));
  fs.symlinkSync(other, path.join(project, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  const usage = storage.usage(project);
  assert.equal(usage.limitBytes, 1024 * 1024);
  assert.ok(usage.logicalBytes >= 850000 && usage.logicalBytes < 860000);
  assert.ok(usage.usedBytes >= usage.logicalBytes);
  assert.equal(usage.remainingBytes, usage.limitBytes - usage.usedBytes);
  assert.throws(() => storage.assertCanAdd(project, 300000), { statusCode: 413 });
});
test('project total rejects otherwise-small uploads, removes partial files and recovers after files are removed', async t => {
  const { project } = fixture(t);
  const generated = path.join(project, 'agent-generated.bin');
  fs.writeFileSync(generated, Buffer.alloc(900000));
  await assert.rejects(transfers.upload(project, 'extra.bin', request(Buffer.alloc(200000))), { statusCode: 413 });
  assert.deepEqual(fs.readdirSync(path.join(project, 'upload')), []);
  assert.equal(fs.statSync(generated).size, 900000);
  fs.unlinkSync(generated);
  await transfers.upload(project, 'extra.bin', request(Buffer.alloc(200000)));
  assert.equal(files.readFile(project, 'upload/extra.bin').length, 200000);
  assert.throws(() => files.writeSnapshot(project, Buffer.alloc(900000), 'too-big.bin'), { statusCode: 413 });
  assert.ok(storage.usage(project).usedBytes <= storage.limitBytes);
});
test('parallel upload requests cannot each spend the same project remaining space', async t => {
  const { project } = fixture(t);
  let release, reached;
  const started = new Promise(resolve => { reached = resolve; });
  const req = Readable.from((async function* () {
    yield Buffer.alloc(32); reached();
    await new Promise(resolve => { release = resolve; });
    yield Buffer.alloc(32);
  })()); req.headers = {};
  const first = transfers.upload(project, 'one.bin', req);
  await started;
  try { await assert.rejects(transfers.upload(project, 'two.bin', request(Buffer.alloc(64))), { statusCode: 409 }); }
  finally { release(); }
  await first;
  assert.deepEqual(fs.readdirSync(path.join(project, 'upload')), ['one.bin']);
});
