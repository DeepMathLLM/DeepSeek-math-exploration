'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const files = require('./project-files');
const storage = require('./project-storage');

function fail(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
function setting(name, fallback, ceiling) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new Error(`${name} 必须为 1–${ceiling} 的整数`);
  return value;
}
const limits = Object.freeze({
  uploadBytes: setting('deepmath_max_upload_mb', 100, 1024) * 1024 * 1024,
  archiveBytes: setting('deepmath_max_archive_mb', 256, 1024) * 1024 * 1024,
  archiveFiles: setting('deepmath_max_archive_files', 5000, 60000),
  projectBytes: storage.limitBytes,
});
let uploads = 0, archives = 0;
const uploadingProjects = new Set();
function parentPath(opened) { return process.platform === 'linux' ? `/proc/self/fd/${opened.fd}` : opened.actual; }
function uploadName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..'
      || /[\\/:<>"|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
      || name.startsWith('.deepmath-upload-') || Buffer.byteLength(name, 'utf8') > 255) {
    throw fail(400, '文件名无效，请使用不含路径的普通文件名');
  }
  return name;
}
function uploadDirectory(root) {
  const opened = files.openChecked(root, '', true);
  try { fs.mkdirSync(path.join(parentPath(opened), 'upload'), { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { fs.closeSync(opened.fd); }
  return files.openChecked(root, 'upload', true);
}
function assertUploadDirectory(root, opened) {
  const current = files.openChecked(root, 'upload', true);
  try {
    if (current.stat.dev !== opened.stat.dev || current.stat.ino !== opened.stat.ino) throw fail(409, '上传目录已变更，请重试');
  } finally { fs.closeSync(current.fd); }
}
async function upload(root, name, req, maxBytes = limits.uploadBytes) {
  let opened, handle, temporary, temporaryStat;
  let reserved = false;
  let projectKey;
  try {
    name = uploadName(name);
    if (uploads >= 4) throw fail(429, '当前上传较多，请稍后重试');
    projectKey = fs.realpathSync.native(root);
    if (uploadingProjects.has(projectKey)) throw fail(409, '此项目已有文件正在上传，请稍后重试');
    uploadingProjects.add(projectKey);
    uploads++; reserved = true;
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw fail(413, `单个文件不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB`);
    opened = uploadDirectory(root);
    const remaining = storage.usage(root).remainingBytes;
    if (length !== undefined && Number(length) > remaining) throw storage.fullError();
    const target = path.join(parentPath(opened), name);
    try { fs.lstatSync(target); throw fail(409, `upload 中已存在“${name}”，请重命名后上传`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    temporary = path.join(parentPath(opened), `.deepmath-upload-${crypto.randomUUID()}`);
    handle = await fs.promises.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    temporaryStat = await handle.stat();
    let size = 0;
    // Stream bytes with bounded memory. Early rejection still allows an HTTP error response.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > maxBytes) throw fail(413, `单个文件不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB`);
      if (size > remaining) throw storage.fullError();
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw fail(500, '文件写入失败');
        offset += bytesWritten;
      }
    }
    if (req.aborted || (length !== undefined && size !== Number(length))) throw fail(400, '上传未完成，请重试');
    await handle.sync();
    await handle.close(); handle = null;
    if (storage.usage(root).usedBytes > storage.limitBytes) throw storage.fullError();
    assertUploadDirectory(root, opened);
    const stat = fs.lstatSync(temporary);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== temporaryStat.dev || stat.ino !== temporaryStat.ino) throw fail(409, '上传文件已变更，请重试');
    // link is an atomic no-overwrite publish. rename would overwrite an existing file on Linux.
    try { fs.linkSync(temporary, target); }
    catch (error) { if (error.code === 'EEXIST') throw fail(409, `upload 中已存在“${name}”，请重命名后上传`); throw error; }
    fs.unlinkSync(temporary); temporary = null;
    return { name, path: `upload/${name}`, size, type: 'file' };
  } catch (error) {
    req.resume();
    if (['EACCES', 'EPERM', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw fail(403, '无法写入当前项目的 upload 文件夹');
    if (error.code === 'ENOSPC') throw fail(507, '服务器存储空间不足，请联系管理员');
    if (error.code === 'EDQUOT') throw storage.fullError();
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (temporary && temporaryStat) {
      try {
        const current = fs.lstatSync(temporary);
        if (current.dev === temporaryStat.dev && current.ino === temporaryStat.ino) fs.unlinkSync(temporary);
      } catch {}
    }
    if (opened) fs.closeSync(opened.fd);
    if (reserved) { uploads--; uploadingProjects.delete(projectKey); }
  }
}

// ZIP32 stored entries, streamed to a private temporary file. No shell, external
// archiver, path-based bulk reads or runtime package installation is involved.
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crcUpdate(crc, bytes) { for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]; return crc >>> 0; }
function zipTime(date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1), date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() };
}
async function buildArchive(root, options = {}) {
  const maxBytes = options.maxBytes ?? limits.archiveBytes, maxFiles = options.maxFiles ?? limits.archiveFiles;
  const signal = options.signal;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmath-project-zip-'));
  fs.chmodSync(directory, 0o700);
  const output = path.join(directory, 'project.zip');
  let handle;
  const cleanup = () => {
    // The generated directory is outside the project and never exposed to an Agent.
    if (path.dirname(directory) !== fs.realpathSync(os.tmpdir()) && path.dirname(directory) !== path.resolve(os.tmpdir())) throw new Error('Invalid archive cleanup path');
    fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    const entries = [];
    let estimated = 22;
    function walk(relative, depth) {
      if (depth > 64) throw fail(413, '文件夹层级过深，无法打包');
      signal?.throwIfAborted();
      for (const entry of files.list(root, relative)) {
        const name = entry.path + (entry.type === 'directory' ? '/' : '');
        estimated += 30 + 46 + 2 * Buffer.byteLength(name) + (entry.type === 'file' ? entry.size + 16 : 0);
        if (entries.length >= maxFiles || estimated > maxBytes) throw fail(413, '项目超过打包下载的大小或文件数量限制，请下载单个文件');
        entries.push({ ...entry, name });
        if (entry.type === 'directory') walk(entry.path, depth + 1);
      }
    }
    walk('', 0);
    handle = await fs.promises.open(output, 'wx', 0o600);
    let position = 0;
    async function write(bytes) {
      signal?.throwIfAborted();
      if (position + bytes.length > maxBytes) throw fail(413, '项目超过打包下载的大小限制，请下载单个文件');
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
        if (!bytesWritten) throw fail(500, '项目打包失败');
        offset += bytesWritten; position += bytesWritten;
      }
    }
    const central = [], buffer = Buffer.alloc(64 * 1024);
    for (const entry of entries) {
      signal?.throwIfAborted();
      const directoryEntry = entry.type === 'directory';
      const opened = files.openChecked(root, entry.path, directoryEntry);
      try {
        const name = Buffer.from(entry.name, 'utf8');
        if (name.length > 65535) throw fail(413, '文件路径过长，无法打包');
        const flags = directoryEntry ? 0x800 : 0x808, date = zipTime(opened.stat.mtime);
        const offset = position, local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(date.time, 10); local.writeUInt16LE(date.date, 12); local.writeUInt16LE(name.length, 26);
        await write(local); await write(name);
        let crc = 0xffffffff, size = 0;
        if (!directoryEntry) {
          while (size < opened.stat.size) {
            signal?.throwIfAborted();
            const count = await new Promise((resolve, reject) => fs.read(opened.fd, buffer, 0, Math.min(buffer.length, opened.stat.size - size), size, (error, read) => error ? reject(error) : resolve(read)));
            if (!count) throw fail(409, '项目文件正在变化，请稍后重新打包');
            const chunk = buffer.subarray(0, count); crc = crcUpdate(crc, chunk); size += count; await write(chunk);
          }
          const latest = fs.fstatSync(opened.fd);
          if (latest.nlink !== 1 || latest.size !== opened.stat.size || latest.mtimeMs !== opened.stat.mtimeMs || latest.ctimeMs !== opened.stat.ctimeMs) throw fail(409, '项目文件正在变化，请稍后重新打包');
          crc = (crc ^ 0xffffffff) >>> 0;
          const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12); await write(descriptor);
        } else crc = 0;
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50); header.writeUInt16LE(0x314, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(flags, 8);
        header.writeUInt16LE(date.time, 12); header.writeUInt16LE(date.date, 14); header.writeUInt32LE(crc, 16);
        header.writeUInt32LE(size, 20); header.writeUInt32LE(size, 24); header.writeUInt16LE(name.length, 28);
        header.writeUInt32LE(directoryEntry ? ((0o40700 << 16) | 0x10) >>> 0 : (0o100600 << 16) >>> 0, 38);
        header.writeUInt32LE(offset, 42); central.push(header, name);
      } finally { fs.closeSync(opened.fd); }
    }
    const centralOffset = position;
    for (const bytes of central) await write(bytes);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(position - centralOffset, 12); end.writeUInt32LE(centralOffset, 16); await write(end);
    await handle.close(); handle = null;
    return { path: output, size: position, cleanup };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    cleanup();
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw fail(409, '项目文件正在变化，请稍后重新打包');
    if (error.code === 'ENOSPC') throw fail(507, '服务器存储空间不足，请联系管理员');
    throw error;
  }
}
async function downloadArchive(root, projectName, req, res) {
  if (archives >= 2) throw fail(429, '当前打包下载较多，请稍后重试');
  archives++;
  const abort = new AbortController();
  const onClose = () => { if (!res.writableFinished) abort.abort(); };
  res.on('close', onClose);
  let archive;
  try {
    archive = await buildArchive(root, { signal: abort.signal });
    const name = String(projectName || 'project').replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 100) + '.zip';
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': archive.size,
      'Content-Disposition': `attachment; filename="project.zip"; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, '%27')}`,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    await pipeline(fs.createReadStream(archive.path), res, { signal: abort.signal });
  } finally {
    res.off('close', onClose);
    archive?.cleanup(); archives--;
  }
}
module.exports = { limits, upload, uploadName, buildArchive, downloadArchive };
