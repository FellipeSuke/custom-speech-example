const assert = require('node:assert/strict');
const {test} = require('node:test');
const {resamplePcm16Mono, createWavPcm16Mono, parseWavPcm16Mono} = require('../lib/audio/pcm');

test('resamples 24 kHz PCM16 to 8 kHz with complete samples', () => {
  const input = Buffer.alloc(6);
  input.writeInt16LE(300, 0);
  input.writeInt16LE(600, 2);
  input.writeInt16LE(900, 4);
  const output = resamplePcm16Mono(input, 24000, 8000);
  assert.equal(output.length, 2);
  assert.equal(output.readInt16LE(0), 600);
});

test('writes a mono PCM16 WAV header', () => {
  const wav = createWavPcm16Mono(Buffer.alloc(4), 8000);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 8000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 4);
});

test('parses a provider WAV and preserves its source rate', () => {
  const pcm = Buffer.alloc(8);
  const parsed = parseWavPcm16Mono(createWavPcm16Mono(pcm, 24000));
  assert.equal(parsed.sampleRate, 24000);
  assert.deepEqual(parsed.pcm, pcm);
});

test('parses WAV payloads with unknown RIFF/data sizes', () => {
  const pcm = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);
  const wav = createWavPcm16Mono(pcm, 24000);
  wav.writeUInt32LE(0xffffffff, 4);
  wav.writeUInt32LE(0xffffffff, 40);
  const parsed = parseWavPcm16Mono(wav);
  assert.equal(parsed.sampleRate, 24000);
  assert.deepEqual(parsed.pcm, pcm);
});
