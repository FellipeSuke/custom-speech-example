const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {AdminStore, hashPassword, verifyPassword} = require('../lib/admin/store');

test('persists speech configuration and stores only hashed Cognigy tokens', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-admin-'));
  const store = new AdminStore(path.join(directory, 'adapter.sqlite'));
  try {
    assert.equal(verifyPassword('correct', hashPassword('correct')), true);
    assert.equal(verifyPassword('wrong', hashPassword('correct')), false);
    const created = store.createSpeechToken('test');
    assert.match(created.token, /^cgv_/);
    assert.equal(store.validateSpeechToken(created.token), true);
    assert.equal(store.validateSpeechToken('cgv_invalid'), false);
    assert.equal(store.listSpeechTokens()[0].prefix, created.prefix);
    assert.equal(store.updateSettings({stt_model: 'gpt-4o-transcribe'}).stt_model, 'gpt-4o-transcribe');
    assert.equal(store.getSettings().stt_model, 'gpt-4o-transcribe');
    assert.equal(store.revokeSpeechToken(1), true);
    assert.equal(store.validateSpeechToken(created.token), false);
  } finally {
    store.close();
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
