'use strict';
const { gzip } = require('node:zlib');
const { acceptsGzip } = require('./static-assets');

// Compress private responses independently; never cache account data or buffer
// the live event stream. Large history reads remain lossless.
function sendJson(res, status, serialized) {
  const body = Buffer.from(serialized);
  const headers = { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  function send(data, compressed = false) {
    if (res.destroyed || res.writableEnded) return;
    if (compressed) headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = data.length;
    res.writeHead(status, headers);
    res.end(res.req?.method === 'HEAD' ? undefined : data);
  }
  if (body.length < 2048 || !acceptsGzip(res.req?.headers?.['accept-encoding'])) {
    send(body); return;
  }
  gzip(body, { level: 4 }, (error, result) => {
    if (error || result.length >= body.length) send(body);
    else send(result, true);
  });
}
module.exports = { sendJson };
