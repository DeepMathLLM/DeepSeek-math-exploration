'use strict';
const fs = require('node:fs');
const path = require('node:path');
const files = require('./project-files');
const megabytes = Number(process.env.deepmath_max_project_mb || 100);
if (!Number.isSafeInteger(megabytes) || megabytes < 1 || megabytes > 100) throw new Error('deepmath_max_project_mb 必须为 1–100 的整数');
const limitBytes = megabytes * 1024 * 1024;
function fullError() { return Object.assign(new Error(`项目空间不足（上限 ${megabytes} MiB），请缩小文件或清理后重试。`), { statusCode: 413, code: 'PROJECT_STORAGE_LIMIT' }); }
function usage(root) {
  let logicalBytes = 0, allocatedBytes = 0, count = 0;
  const seen = new Set();
  function walk(relative, depth) {
    if (depth > 64 || count > 20000) throw Object.assign(new Error('项目文件过多或层级过深，请先整理文件'), { statusCode: 413 });
    const opened = files.openChecked(root, relative, true);
    try {
      allocatedBytes += (opened.stat.blocks || 0) * 512;
      const parent = process.platform === 'linux' ? `/proc/self/fd/${opened.fd}` : opened.actual;
      for (const name of fs.readdirSync(parent)) {
        if (++count > 20000) throw Object.assign(new Error('项目文件过多，请先整理文件'), { statusCode: 413 });
        let stat;
        try { stat = fs.lstatSync(path.join(parent, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (stat.isDirectory()) walk(relative ? `${relative}/${name}` : name, depth + 1);
        else {
          const id = `${stat.dev}:${stat.ino}`;
          if (!seen.has(id)) {
            seen.add(id); allocatedBytes += (stat.blocks || 0) * 512;
            // Include hidden files and in-progress uploads, without following links.
            logicalBytes += stat.size;
          }
        }
      }
    } finally { fs.closeSync(opened.fd); }
  }
  walk('', 0);
  const usedBytes = process.platform === 'linux' && process.env.deepmath_codex_mode !== 'simulated'
    ? allocatedBytes : Math.max(logicalBytes, allocatedBytes);
  return { usedBytes, logicalBytes, allocatedBytes, limitBytes, remainingBytes: Math.max(0, limitBytes - usedBytes) };
}
function assertCanAdd(root, bytes) {
  const current = usage(root);
  if (current.usedBytes + bytes > limitBytes) throw fullError();
  return current;
}
module.exports = { limitBytes, usage, assertCanAdd, fullError };
