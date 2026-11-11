'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict'), http = require('node:http'), zlib = require('node:zlib');
const { sendJson } = require('../src/http-json');
const server = http.createServer((req, res) => sendJson(res, 200,
  JSON.stringify({ account: req.url, text: (`Private ${req.url}: 完整历史🙂\n`).repeat(300) })));
before(() => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)));
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
function request(account, encoding) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/' + account,
      headers: { 'Accept-Encoding': encoding } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
test('private JSON is compressed losslessly and simultaneous account responses never share content or caching', async () => {
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => request('account-' + i, 'gzip')));
  for (let i = 0; i < responses.length; i++) {
    const { headers, body } = responses[i];
    assert.equal(headers['content-encoding'], 'gzip');
    assert.equal(headers['cache-control'], 'no-store');
    assert.equal(headers.vary, 'Accept-Encoding');
    assert.equal(Number(headers['content-length']), body.length);
    const raw = zlib.gunzipSync(body), value = JSON.parse(raw);
    assert.equal(value.account, '/account-' + i);
    assert.equal(value.text, (`Private /account-${i}: 完整历史🙂\n`).repeat(300));
    assert.ok(body.length < raw.length / 10);
  }
});
test('clients disabling gzip receive complete identity JSON', async () => {
  const response = await request('identity', 'gzip;q=0, *;q=1');
  assert.equal(response.headers['content-encoding'], undefined);
  assert.equal(JSON.parse(response.body).account, '/identity');
});
