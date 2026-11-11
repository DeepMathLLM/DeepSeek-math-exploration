'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { Readable } = require('node:stream');
const { crc32 } = require('node:zlib');
const files = require('../src/project-files');
const transfers = require('../src/project-transfers');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmath-transfers-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, project: files.createProject(root), other: files.createProject(root) };
}
function request(chunks, headers = {}) { const req = Readable.from(chunks); req.headers = headers; return req; }
function zipEntries(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10), entries = new Map();
  let position = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(position), 0x02014b50);
    const length = bytes.readUInt16LE(position + 28), size = bytes.readUInt32LE(position + 24);
    const name = bytes.subarray(position + 46, position + 46 + length).toString('utf8');
    const local = bytes.readUInt32LE(position + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt16LE(local + 8), 0);
    assert.ok(bytes.readUInt16LE(local + 6) & 0x800, 'UTF-8 filenames');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const content = bytes.subarray(start, start + size);
    assert.equal(crc32(content), bytes.readUInt32LE(position + 16));
    if (!name.endsWith('/')) {
      assert.equal(bytes.readUInt32LE(start + size), 0x08074b50);
      assert.equal(bytes.readUInt32LE(start + size + 4), crc32(content));
      assert.equal(bytes.readUInt32LE(start + size + 8), size);
    }
    assert.ok(!name.startsWith('/') && !name.split('/').includes('..'));
    entries.set(name, content);
    position += 46 + length + bytes.readUInt16LE(position + 30) + bytes.readUInt16LE(position + 32);
  }
  assert.equal(position, end);
  return entries;
}
test('streamed uploads use upload/, retain binary bytes, publish without overwrites and clean rejected bodies', async t => {
  const { project } = fixture(t);
  const data = Buffer.from([0, 255, 128, 1]);
  assert.equal((await transfers.upload(project, '资料.bin', request([data.subarray(0, 2), data.subarray(2)]))).path, 'upload/资料.bin');
  assert.deepEqual(files.readFile(project, 'upload/资料.bin'), data);
  await assert.rejects(transfers.upload(project, '资料.bin', request([Buffer.from('replace')])), { statusCode: 409 });
  for (const name of ['../escape', '/escape', 'C:\\escape', 'sub/file', '..', '', 'a\0b', 'a\nb', 'a:b', 'a.', 'COM1', '.deepmath-upload-x', '文'.repeat(100)]) {
    await assert.rejects(transfers.upload(project, name, request([])), { statusCode: 400 });
  }
  await assert.rejects(transfers.upload(project, 'header.bin', request([], { 'content-length': '20' }), 5), { statusCode: 413 });
  await assert.rejects(transfers.upload(project, 'chunked.bin', request([Buffer.alloc(3), Buffer.alloc(3)]), 5), { statusCode: 413 });
  const broken = request((async function* () { yield Buffer.from('partial'); throw new Error('connection lost'); })());
  await assert.rejects(transfers.upload(project, 'broken.bin', broken), /connection lost/);
  assert.deepEqual(fs.readdirSync(path.join(project, 'upload')), ['资料.bin']);
  assert.deepEqual(files.readFile(project, 'upload/资料.bin'), data);
});
test('upload refuses linked upload folders, hardlinked existing names and simultaneous same-name replacement', async t => {
  const { project, other } = fixture(t);
  fs.writeFileSync(path.join(other, 'secret'), 'private');
  fs.symlinkSync(other, path.join(project, 'upload'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(transfers.upload(project, 'new.txt', request([Buffer.from('no')])));
  assert.deepEqual(fs.readdirSync(other), ['secret']);
  if (process.platform === 'win32') fs.rmdirSync(path.join(project, 'upload'));
  else fs.unlinkSync(path.join(project, 'upload'));
  fs.mkdirSync(path.join(project, 'upload'));
  fs.linkSync(path.join(other, 'secret'), path.join(project, 'upload', 'secret'));
  await assert.rejects(transfers.upload(project, 'secret', request([Buffer.from('no')])), { statusCode: 409 });
  const results = await Promise.allSettled(['first', 'second'].map(text => transfers.upload(project, 'race.txt', request([Buffer.from(text)]))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 409);
  assert.equal(fs.readFileSync(path.join(other, 'secret'), 'utf8'), 'private');
  assert.equal(fs.readdirSync(path.join(project, 'upload')).filter(name => name.startsWith('.deepmath-upload-')).length, 0);
});
test('project ZIP preserves Unicode, binary and empty entries while excluding links, other projects and partial uploads', async t => {
  const { project, other } = fixture(t);
  fs.mkdirSync(path.join(project, '空文件夹')); fs.mkdirSync(path.join(project, 'upload'));
  const binary = Buffer.from(Array.from({ length: 65537 }, (_, index) => index & 255));
  fs.writeFileSync(path.join(project, 'upload', '资料.bin'), binary);
  fs.writeFileSync(path.join(project, 'empty.txt'), '');
  fs.writeFileSync(path.join(project, '.deepmath-upload-partial'), 'partial');
  fs.writeFileSync(path.join(other, 'secret.txt'), 'DO_NOT_EXPORT');
  fs.linkSync(path.join(other, 'secret.txt'), path.join(project, 'hardlink.txt'));
  fs.symlinkSync(other, path.join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const archive = await transfers.buildArchive(project);
  try {
    const entries = zipEntries(fs.readFileSync(archive.path));
    assert.deepEqual([...entries.keys()].sort(), ['empty.txt', 'upload/', 'upload/资料.bin', '空文件夹/'].sort());
    assert.deepEqual(entries.get('upload/资料.bin'), binary);
    assert.equal(entries.get('empty.txt').length, 0);
    assert.equal(archive.size, fs.statSync(archive.path).size);
  } finally { archive.cleanup(); }
  assert.equal(fs.existsSync(archive.path), false);
  await assert.rejects(transfers.buildArchive(project, { maxBytes: 100 }), { statusCode: 413 });
  await assert.rejects(transfers.buildArchive(project, { maxFiles: 1 }), { statusCode: 413 });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(transfers.buildArchive(project, { signal: abort.signal }), { name: 'AbortError' });
});
