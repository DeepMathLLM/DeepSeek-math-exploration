'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { gzip } = require('node:zlib');
const { promisify } = require('node:util');
const compress = promisify(gzip);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function acceptsGzip(header = '') {
  const weights = new Map(String(header).toLowerCase().split(',').map(part => {
    const [name, ...parameters] = part.trim().split(';');
    const q = parameters.find(value => /^\s*q\s*=/.test(value));
    const weight = q === undefined ? 1 : Number(q.split('=')[1]);
    return [name, Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0];
  }));
  return (weights.has('gzip') ? weights.get('gzip') : weights.get('*') || 0) > 0;
}

// Only public application assets pass through here. Private APIs, SSE and
// project transfers retain their existing authentication and streaming paths.
function createStaticAssets(publicDir, sendError) {
  const compressed = new Map();
  return async function serveStatic(req, res, pathname) {
    const file = pathname === '/' ? path.join(publicDir, 'index.html') : path.join(publicDir, pathname.replace(/^\//, ''));
    const relative = path.relative(publicDir, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return sendError(res, 403, 'Forbidden');
    if (!['GET', 'HEAD'].includes(req.method)) return sendError(res, 405, 'Method not allowed');
    try {
      const data = await fs.promises.readFile(file);
      const extension = path.extname(file);
      const hash = crypto.createHash('sha256').update(data).digest('hex');
      const useGzip = Boolean(MIME[extension]) && data.length >= 1024 && data.length <= 2 * 1024 * 1024 && acceptsGzip(req.headers['accept-encoding']);
      const etag = `"${hash}${useGzip ? '-gzip' : ''}"`;
      const headers = { 'Content-Type': MIME[extension] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=0, must-revalidate', ETag: etag, Vary: 'Accept-Encoding' };
      const matches = String(req.headers['if-none-match'] || '').split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);
      if (matches) { res.writeHead(304, headers); res.end(); return; }
      let body = data;
      if (useGzip) {
        let cached = compressed.get(file);
        if (!cached || cached.hash !== hash) {
          // Bounded cache: at most 16 public assets of at most 2 MiB each.
          // Sharing promises prevents repeated compression on simultaneous loads.
          if (compressed.size >= 16) compressed.delete(compressed.keys().next().value);
          cached = { hash, body: compress(data) }; compressed.set(file, cached);
        }
        body = await cached.body;
        headers['Content-Encoding'] = 'gzip';
      }
      if (res.destroyed || res.writableEnded) return;
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      compressed.delete(file);
      if (!res.destroyed && !res.writableEnded) sendError(res, 404, 'Not found');
    }
  };
}
module.exports = { createStaticAssets, acceptsGzip };
