'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { once } = require('events');
const { postJson } = require('../src/services/bridge-client');

async function withServer(handler, run) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    await run(`http://127.0.0.1:${port}/api/agent.php`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('HTTP/1.1 transport posts JSON and bearer token without fetch', async () => {
  await withServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, 'Bearer nexa_test');
      assert.match(String(req.headers['user-agent']), /Nexa-AI-Local-Bridge\/1\.2\.1/);
      assert.equal(req.headers.connection, 'close');
      assert.deepEqual(JSON.parse(body), { action: 'heartbeat' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  }, async endpoint => {
    const result = await postJson(endpoint, 'nexa_test', { action: 'heartbeat' }, 2000);
    assert.equal(result.ok, true);
  });
});

test('HTTP/1.1 transport maps a 401 response to AUTH_REJECTED', async () => {
  await withServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized agent' }));
    });
  }, async endpoint => {
    await assert.rejects(
      () => postJson(endpoint, 'bad', { action: 'heartbeat' }, 2000),
      error => error && error.code === 'AUTH_REJECTED'
    );
  });
});

test('HTTP/1.1 transport reports deterministic timeout diagnostics', async () => {
  await withServer((req) => {
    req.resume();
    // Intentionally never respond within the client timeout.
  }, async endpoint => {
    await assert.rejects(
      () => postJson(endpoint, 'nexa_test', { action: 'heartbeat' }, 120),
      error => error && /timed out/i.test(error.message)
    );
  });
});
