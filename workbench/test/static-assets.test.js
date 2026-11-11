'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), zlib = require('node:zlib');
const { createStaticAssets } = require('../src/static-assets');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deepmath-static-assets-'));
const text = 'const example = "Chinese text 中文 and long repeated public asset";\n'.repeat(100);
fs.writeFileSync(path.join(root, 'app.js'), text); fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><p>Public login page</p>');
const serve = createStaticAssets(root, (res, status, message) => { res.writeHead(status); res.end(message); });
const server = http.createServer((req, res) => serve(req, res, req.url));
before(() => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)));
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
function request(route, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port: server.address().port, path: route, headers, method }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
}
test('simultaneous public assets compress losslessly, with exact wire lengths and separate validators', async () => {
  const plain = await request('/app.js'); assert.equal(plain.body.toString(), text);
  const results = await Promise.all(Array.from({ length: 20 }, () => request('/app.js', { 'Accept-Encoding': 'gzip' })));
  for (const result of results) {
    assert.equal(result.status, 200); assert.equal(result.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(result.body).toString(), text);
    assert.equal(Number(result.headers['content-length']), result.body.length);
    assert.ok(result.body.length < plain.body.length / 4);
    assert.notEqual(result.headers.etag, plain.headers.etag);
    assert.equal(result.headers.vary, 'Accept-Encoding');
  }
  const disabled = await request('/app.js', { 'Accept-Encoding': 'gzip;q=0, *;q=1' });
  assert.equal(disabled.headers['content-encoding'], undefined); assert.equal(disabled.body.toString(), text);
});
test('revalidation saves body bytes and in-place deployment invalidates both cached representations', async () => {
  const original = await request('/app.js', { 'Accept-Encoding': 'gzip' });
  const unchanged = await request('/app.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': `W/${original.headers.etag}` });
  assert.equal(unchanged.status, 304); assert.equal(unchanged.body.length, 0);
  assert.match(unchanged.headers['cache-control'], /must-revalidate/);
  const updated = text.replace('example', 'changed');
  fs.writeFileSync(path.join(root, 'app.js'), updated);
  const changed = await request('/app.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': original.headers.etag });
  assert.equal(changed.status, 200); assert.notEqual(changed.headers.etag, original.headers.etag);
  assert.equal(zlib.gunzipSync(changed.body).toString(), updated);
});
test('HEAD and small identity files work while paths outside the public root remain blocked', async () => {
  const head = await request('/app.js', { 'Accept-Encoding': 'gzip' }, 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.ok(Number(head.headers['content-length']) > 0);
  const home = await request('/', { 'Accept-Encoding': 'gzip' });
  assert.equal(home.status, 200); assert.equal(home.headers['content-encoding'], undefined);
  assert.equal((await request('/../private.env')).status, 403);
  assert.equal((await request('/.env')).status, 404);
});
