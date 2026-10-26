const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {after, before, test} = require('node:test');
const {getOpenAiApiKeyStatus, readOpenAiApiKey, validateOpenAiApiKey, writeOpenAiApiKey} = require('../lib/openai-config');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-openai-key-'));
const keyFile = path.join(directory, 'openai-api-key');
let previousKeyFile;
let previousKey;

before(() => {
  previousKeyFile = process.env.OPENAI_API_KEY_FILE;
  previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY_FILE = keyFile;
  delete process.env.OPENAI_API_KEY;
});

after(() => {
  if (previousKeyFile === undefined) delete process.env.OPENAI_API_KEY_FILE;
  else process.env.OPENAI_API_KEY_FILE = previousKeyFile;
  if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousKey;
  fs.rmSync(directory, {recursive: true, force: true});
});

test('stores and reads the OpenAI key only from a server-side file', () => {
  assert.equal(validateOpenAiApiKey('not-a-key'), false);
  assert.equal(getOpenAiApiKeyStatus().configured, false);
  const key = 'sk-test-server-side-key-1234567890';
  writeOpenAiApiKey(key);
  assert.equal(readOpenAiApiKey(), key);
  assert.deepEqual(getOpenAiApiKeyStatus(), {configured: true, source: 'managed_file', storage: 'server_side'});
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), key);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
});
