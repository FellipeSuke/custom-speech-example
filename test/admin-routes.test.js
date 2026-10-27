const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {after, before, test} = require('node:test');
const {createApp} = require('../app');
const {AdminStore, hashPassword} = require('../lib/admin/store');
const {runSyntheticSttTest} = require('../lib/admin/routes');
const {EventEmitter} = require('node:events');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-admin-routes-'));
let server;
let store;
let oldEnvironment;

const request = (method, requestPath, body, cookie) => new Promise((resolve, reject) => {
  const requestOptions = {port: server.address().port, path: requestPath, method, headers: {}};
  if (body !== undefined) {
    requestOptions.headers['Content-Type'] = 'application/json';
  }
  if (cookie) requestOptions.headers.Cookie = cookie;
  const req = http.request(requestOptions, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString()}));
  });
  req.on('error', reject);
  req.end(body === undefined ? undefined : JSON.stringify(body));
});

before(() => {
  oldEnvironment = {...process.env};
  process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret';
  process.env.ADMIN_COOKIE_SECURE = 'false';
  process.env.ADMIN_PASSWORD_HASH = hashPassword('test-password');
  process.env.ADMIN_USERNAME = 'admin';
  process.env.OPENAI_API_KEY_FILE = path.join(directory, 'openai-api-key');
  store = new AdminStore(path.join(directory, 'adapter.sqlite'));
  server = require('../app').createServer({app: createApp({adminStore: store}), port: 0});
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(directory, {recursive: true, force: true});
  for (const key of Object.keys(process.env)) {
    if (!(key in oldEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, oldEnvironment);
});

test('admin portal authenticates and manages runtime configuration and tokens', async () => {
  const login = await request('POST', '/admin/api/login', {username: 'admin', password: 'test-password'});
  assert.equal(login.statusCode, 200);
  assert.equal(login.headers['cache-control'], 'no-store');
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request('GET', '/admin/api/config', undefined, cookie)).statusCode, 200);
  const initialConfig = JSON.parse((await request('GET', '/admin/api/config', undefined, cookie)).body);
  assert.ok(initialConfig.endpoints.some((endpoint) => endpoint.url.endsWith('/synthesize/openai')));
  assert.ok(initialConfig.ttsOptions.some((option) => option.model === 'gpt-live-1' && option.transport === 'gpt_live'));
  assert.ok(initialConfig.voices.includes('bossa'));
  assert.ok(initialConfig.voices.includes('tempo'));
  assert.equal(initialConfig.openai.configured, false);
  const openaiKey = await request('POST', '/admin/api/openai-key', {apiKey: 'sk-test-server-side-key-1234567890'}, cookie);
  assert.equal(openaiKey.statusCode, 200);
  assert.doesNotMatch(openaiKey.body, /sk-test-server-side-key/);
  assert.equal(JSON.parse(openaiKey.body).openai.source, 'managed_file');
  const config = await request('PUT', '/admin/api/config', {stt_model: 'gpt-4o-transcribe'}, cookie);
  assert.equal(config.statusCode, 200);
  assert.equal(JSON.parse(config.body).settings.stt_model, 'gpt-4o-transcribe');
  const liveConfig = await request('PUT', '/admin/api/config', {tts_model: 'gpt-live-1', tts_transport: 'gpt_live', tts_voice: 'bossa'}, cookie);
  assert.equal(liveConfig.statusCode, 200);
  assert.equal(JSON.parse(liveConfig.body).settings.tts_voice, 'bossa');
  const invalidLiveConfig = await request('PUT', '/admin/api/config', {tts_model: 'gpt-live-1', tts_transport: 'gpt_live', tts_voice: 'marin'}, cookie);
  assert.equal(invalidLiveConfig.statusCode, 400);
  const tempoConfig = await request('PUT', '/admin/api/config', {tts_model: 'gpt-live-1', tts_transport: 'gpt_live', tts_voice: 'tempo'}, cookie);
  assert.equal(tempoConfig.statusCode, 200);
  assert.equal(JSON.parse(tempoConfig.body).settings.tts_voice, 'tempo');
  const token = await request('POST', '/admin/api/tokens', {label: 'automated test'}, cookie);
  assert.equal(token.statusCode, 201);
  assert.equal(store.validateSpeechToken(JSON.parse(token.body).token), true);
});

test('synthetic STT probe uses mocked WebSocket events offline', async () => {
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;

    constructor() {
      super();
      this.readyState = FakeWebSocket.CONNECTING;
      setImmediate(() => { this.readyState = FakeWebSocket.OPEN; this.emit('open'); });
    }

    send(payload) {
      const event = JSON.parse(payload);
      if (event.type === 'session.update') setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({type: 'session.updated'}))));
      if (event.type === 'input_audio_buffer.commit') setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({type: 'conversation.item.input_audio_transcription.completed', transcript: 'teste sintético'}))));
    }

    close() { this.readyState = 3; }
  }

  const result = await runSyntheticSttTest({apiKey: 'test-key', model: 'gpt-4o-mini-transcribe', pcm: Buffer.alloc(12), sampleRate: 24000, WebSocketImpl: FakeWebSocket});
  assert.equal(result.transcriptLength, 15);
  assert.ok(result.providerReadyMs >= 0);
});
