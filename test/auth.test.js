const assert = require('node:assert/strict');
const http = require('node:http');
const {after, before, test} = require('node:test');
const WebSocket = require('ws');
const {createApp, createServer, isValidApiKey} = require('../app');

let server;

before(() => {
  process.env.API_KEY = 'test-token';
  server = createServer({app: createApp(), port: 0});
});

after(async () => {
  delete process.env.API_KEY;
  await new Promise((resolve) => server.close(resolve));
});

const request = (authorization) => new Promise((resolve, reject) => {
  const port = server.address().port;
  const req = http.request({
    port,
    path: '/synthesize/openai',
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...(authorization ? {Authorization: authorization} : {})}
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({statusCode: res.statusCode, body: Buffer.concat(chunks).toString()}));
  });
  req.on('error', reject);
  req.end(JSON.stringify({text: 'teste', type: 'text'}));
});

test('rejects missing and invalid HTTP bearer credentials', async () => {
  assert.equal(isValidApiKey(undefined, 'test-token'), false);
  assert.equal(isValidApiKey('Bearer ', 'test-token'), false);
  assert.equal(isValidApiKey('Bearer wrong', 'test-token'), false);
  assert.equal(isValidApiKey('Bearer test-token', 'test-token'), true);
  assert.equal((await request()).statusCode, 403);
  assert.equal((await request('Bearer wrong')).statusCode, 403);
});

test('rejects missing and invalid WebSocket bearer credentials during upgrade', async () => {
  const connect = (headers) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/transcribe/openai`, {headers});
    ws.on('unexpected-response', (req, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    ws.on('open', () => reject(new Error('unauthenticated WebSocket unexpectedly opened')));
    ws.on('error', () => {});
  });
  assert.equal(await connect({}), 403);
  assert.equal(await connect({Authorization: 'Bearer wrong'}), 403);
});
