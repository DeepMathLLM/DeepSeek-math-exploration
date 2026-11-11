'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function denied(message = '只能访问当前项目文件夹内的普通文件') {
  const error = new Error(message); error.statusCode = 403; return error;
}
function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
function parts(value = '') {
  if (typeof value !== 'string' || /[\\:\x00-\x1f]/.test(value) || value.startsWith('/')) throw denied();
  const names = value ? value.split('/') : [];
  if (names.some((name) => !name || name === '.' || name === '..')) throw denied();
  return names;
}
function rootPath(root) {
  const resolved = fs.realpathSync.native(root);
  if (fs.lstatSync(root).isSymbolicLink()) throw denied('项目根目录不能是符号链接');
  return resolved;
}
function checkedPath(root, relative) {
  const base = rootPath(root);
  let target = base;
  for (const name of parts(relative)) {
    target = path.join(target, name);
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink() || !inside(fs.realpathSync.native(target), base)) throw denied();
  }
  return { base, target };
}
function openChecked(root, relative, directory = false) {
  const { base, target } = checkedPath(root, relative);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)
    | (directory ? (fs.constants.O_DIRECTORY || 0) : 0);
  const fd = fs.openSync(target, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (directory ? !stat.isDirectory() : (!stat.isFile() || stat.nlink !== 1)) throw denied();
    // Linux fd resolution validates what was actually opened, after path races,
    // before reading or listing any bytes. O_NOFOLLOW rejects the final symlink.
    const actual = process.platform === 'linux' ? fs.realpathSync(`/proc/self/fd/${fd}`) : fs.realpathSync.native(target);
    if (!inside(actual, base)) throw denied();
    const current = fs.statSync(actual);
    if (current.dev !== stat.dev || current.ino !== stat.ino) throw denied();
    return { fd, stat, target, actual };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function createProject(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const base = rootPath(root);
  const folder = path.join(base, `project-${crypto.randomUUID()}`);
  fs.mkdirSync(folder, { mode: 0o700 });
  return folder;
}
function list(root, relative = '') {
  const opened = openChecked(root, relative, true);
  try {
    const directory = process.platform === 'linux' ? `/proc/self/fd/${opened.fd}` : opened.actual;
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name.startsWith('.deepmath-upload-') || entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) return [];
      const full = path.join(directory, entry.name);
      try {
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) return [];
        return [{ name: entry.name, path: [...parts(relative), entry.name].join('/'),
          type: stat.isDirectory() ? 'directory' : 'file', size: stat.isFile() ? stat.size : null }];
      } catch { return []; }
    }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  } finally { fs.closeSync(opened.fd); }
}
function readFile(root, relative, maxBytes = 20 * 1024 * 1024) {
  const opened = openChecked(root, relative);
  try {
    if (opened.stat.size > maxBytes) throw denied(`文件不能超过 ${maxBytes} 字节`);
    // Read at most maxBytes+1 even if a concurrent writer grows the file.
    const bytes = Buffer.alloc(Math.min(opened.stat.size + 1, maxBytes + 1));
    let count = 0, read;
    while (count < bytes.length && (read = fs.readSync(opened.fd, bytes, count, bytes.length - count, count))) count += read;
    if (count > maxBytes) throw denied('文件过大');
    return bytes.subarray(0, count);
  } finally { fs.closeSync(opened.fd); }
}
function writeSnapshot(root, bytes, name = 'evidence') {
  require('./project-storage').assertCanAdd(root, bytes.length);
  const base = rootPath(root);
  let opened = openChecked(root, '', true);
  try {
    for (const component of ['.deepmath', 'evidence']) {
      const parent = process.platform === 'linux' ? `/proc/self/fd/${opened.fd}` : opened.actual;
      const child = path.join(parent, component);
      try { fs.mkdirSync(child, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const fd = fs.openSync(child, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
      try {
        const actual = fs.realpathSync(process.platform === 'linux' ? `/proc/self/fd/${fd}` : child);
        if (!inside(actual, base) || fs.lstatSync(child).isSymbolicLink()) throw denied();
        fs.closeSync(opened.fd); opened = { fd, actual };
      } catch (error) { fs.closeSync(fd); throw error; }
    }
    const safeName = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'evidence';
    const filename = `${crypto.randomUUID()}-${safeName}`;
    const parent = process.platform === 'linux' ? `/proc/self/fd/${opened.fd}` : opened.actual;
    require('./project-storage').assertCanAdd(root, bytes.length);
    const fd = fs.openSync(path.join(parent, filename), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeFileSync(fd, bytes); require('./project-storage').assertCanAdd(root, 0); }
    catch (error) {
      try { fs.unlinkSync(path.join(parent, filename)); } catch {}
      if (error.code === 'EDQUOT') throw require('./project-storage').fullError();
      throw error;
    }
    finally { fs.closeSync(fd); }
    return `.deepmath/evidence/${filename}`;
  } finally { fs.closeSync(opened.fd); }
}
function download(root, relative, req, res) {
  if (!relative) throw denied('请指定当前项目内的文件');
  const { fd, stat } = openChecked(root, relative);
  const name = parts(relative).at(-1);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, '%27')}`,
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  if (!stat.size) { fs.closeSync(fd); res.end(); return; }
  const stream = fs.createReadStream(null, { fd, autoClose: true, end: stat.size - 1 });
  res.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
function removeFile(root, relative) {
  const names = parts(relative);
  if (!names.length) throw denied('请选择一个文件');
  const opened = openChecked(root, relative);
  let parent;
  try {
    parent = openChecked(root, names.slice(0, -1).join('/'), true);
    const base = process.platform === 'linux' ? `/proc/self/fd/${parent.fd}` : parent.actual;
    const target = path.join(base, names.at(-1)), current = fs.lstatSync(target);
    if (!current.isFile() || current.nlink !== 1 || current.dev !== opened.stat.dev || current.ino !== opened.stat.ino) throw denied('文件已变更，请刷新后重试');
    fs.unlinkSync(target);
  } finally { fs.closeSync(opened.fd); if (parent) fs.closeSync(parent.fd); }
}
module.exports = { inside, createProject, list, download, checkedPath, openChecked, readFile, writeSnapshot, removeFile };
