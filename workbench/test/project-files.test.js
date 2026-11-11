'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const files = require('../src/project-files');
test('project files reject traversal, absolute paths, symlinks, hardlinks and special files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmath-file-boundary-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const project = files.createProject(root), other = files.createProject(root);
  fs.writeFileSync(path.join(project, 'valid.txt'), 'owned bytes');
  fs.writeFileSync(path.join(other, 'private.txt'), 'foreign bytes');
  assert.equal(files.readFile(project, 'valid.txt').toString(), 'owned bytes');
  for (const value of ['../private.txt', '/etc/passwd', 'C:/secret', 'foo\\bar', './valid.txt', 'foo//bar', 'valid.txt\0']) {
    assert.throws(() => files.readFile(project, value), { statusCode: 403 });
  }
  assert.throws(() => files.readFile(project, 'valid.txt', 2), { statusCode: 403 });
  fs.linkSync(path.join(other, 'private.txt'), path.join(project, 'hardlink.txt'));
  assert.throws(() => files.readFile(project, 'hardlink.txt'), { statusCode: 403 });
  assert.throws(() => files.removeFile(project, 'hardlink.txt'), { statusCode: 403 });
  // Directory junctions need no Windows developer-mode symlink privilege.
  fs.symlinkSync(other, path.join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => files.readFile(project, 'linked/private.txt'), { statusCode: 403 });
  assert.throws(() => files.removeFile(project, 'linked/private.txt'), { statusCode: 403 });
  assert.equal(fs.readFileSync(path.join(other, 'private.txt'), 'utf8'), 'foreign bytes');
  assert.deepEqual(files.list(project).map((entry) => entry.name), ['valid.txt']);
  const snapshot = files.writeSnapshot(project, Buffer.from('verified binary bytes'), 'diagram.png');
  assert.equal(files.readFile(project, snapshot).toString(), 'verified binary bytes');
  files.removeFile(project, snapshot); assert.equal(fs.existsSync(path.join(project, snapshot)), false);
  assert.throws(() => files.removeFile(project, '../private.txt'), { statusCode: 403 });
  assert.throws(() => files.removeFile(project, '.deepmath'), { statusCode: 403 });
  const hostile = files.createProject(root);
  fs.symlinkSync(other, path.join(hostile, '.deepmath'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => files.writeSnapshot(hostile, Buffer.from('must stay inside'), 'copy.bin'));
  assert.deepEqual(fs.readdirSync(other), ['private.txt']);
  if (process.platform === 'linux') {
    const fifo = path.join(project, 'pipe');
    require('node:child_process').execFileSync('mkfifo', [fifo]);
    assert.throws(() => files.readFile(project, 'pipe'), { statusCode: 403 });
  }
});
test('native runtime requires a project directory and a separate session directory', async () => {
  const runtime = require('../src/agent-runtime');
  const launch = { command: 'fixture-codex', args: ['app-server'], source: 'test' };
  await assert.rejects(runtime.prepareRuntime(undefined, launch), /项目工作目录或会话目录/);
  await assert.rejects(runtime.prepareRuntime({ workspace: '/fixture' }, launch), /项目工作目录或会话目录/);
});
