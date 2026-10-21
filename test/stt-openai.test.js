const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {test} = require('node:test');
const {
  transcribeOpenAI,
  buildSessionUpdate,
  createCognigyTranscription,
  getPcmStats
} = require('../lib/stt/openai');

class FakeProvider extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = FakeProvider.CONNECTING;
    this.sent = [];
    FakeProvider.instances.push(this);
    setImmediate(() => {
      this.readyState = FakeProvider.OPEN;
      this.emit('open');
    });
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = 3;
  }
}

class FakeCognigySocket extends EventEmitter {
  static OPEN = 1;

  constructor() {
    super();
    this.readyState = FakeCognigySocket.OPEN;
    this.sent = [];
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = 3;
  }
}

const pcmFrame = (sample, samples = 160) => {
  const frame = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) frame.writeInt16LE(sample, index * 2);
  return frame;
};

test('builds an OpenAI transcription session for Cognigy audio', () => {
  const session = buildSessionUpdate({language: 'pt-BR', model: 'gpt-4o-mini-transcribe'});
  assert.equal(session.type, 'session.update');
  assert.equal(session.session.type, 'transcription');
  assert.equal(session.session.audio.input.transcription.language, 'pt');
  assert.equal(session.session.audio.input.transcription.delay, undefined);
  assert.equal(session.session.audio.input.format.rate, 24000);
  assert.equal(session.session.audio.input.turn_detection, null);
});

test('uses language hints and low delay for the live transcription model', () => {
  const session = buildSessionUpdate({language: 'pt-BR', model: 'gpt-live-transcribe'});
  assert.deepEqual(session.session.audio.input.transcription.languages, ['pt']);
  assert.equal(session.session.audio.input.transcription.delay, 'low');
});

test('creates Cognigy final transcription messages', () => {
  const message = createCognigyTranscription({transcript: 'Jéssica identificada', isFinal: true, language: 'pt-BR'});
  assert.deepEqual(message, {
    type: 'transcription',
    is_final: true,
    alternatives: [{confidence: 0, transcript: 'Jéssica identificada'}],
    channel: 1,
    language: 'pt-BR'
  });
});

test('detects a Cognigy turn and commits it to OpenAI', async () => {
  const previous = {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_STT_MODEL,
    silence: process.env.OPENAI_STT_SILENCE_MS,
    minimum: process.env.OPENAI_STT_MIN_SPEECH_MS,
    vad: process.env.OPENAI_STT_VAD_RMS
  };
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_STT_MODEL = 'gpt-4o-mini-transcribe';
  process.env.OPENAI_STT_SILENCE_MS = '700';
  process.env.OPENAI_STT_MIN_SPEECH_MS = '100';
  process.env.OPENAI_STT_VAD_RMS = '400';
  FakeProvider.instances = [];

  try {
    const socket = new FakeCognigySocket();
    await transcribeOpenAI({info() {}, error() {}}, socket, {WebSocketImpl: FakeProvider});
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'start', language: 'pt-BR', sampleRateHz: 8000, interimResults: true
    })), false);
    await new Promise((resolve) => setImmediate(resolve));

    const provider = FakeProvider.instances[0];
    assert.match(provider.url, /realtime\?intent=transcription$/);
    for (let index = 0; index < 5; index++) socket.emit('message', pcmFrame(2000), true);
    for (let index = 0; index < 40; index++) socket.emit('message', pcmFrame(0), true);
    provider.emit('message', Buffer.from(JSON.stringify({type: 'session.updated'})));

    assert.ok(provider.sent.some((event) => event.type === 'input_audio_buffer.append'));
    assert.ok(provider.sent.some((event) => event.type === 'input_audio_buffer.commit'));

    provider.emit('message', Buffer.from(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.delta', delta: 'Jéssica'
    })));
    provider.emit('message', Buffer.from(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed', transcript: 'Jéssica identificada'
    })));
    assert.equal(socket.sent.at(-1).is_final, true);
    assert.equal(socket.sent.at(-1).alternatives[0].transcript, 'Jéssica identificada');
  } finally {
    if (previous.apiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.apiKey;
    if (previous.model === undefined) delete process.env.OPENAI_STT_MODEL;
    else process.env.OPENAI_STT_MODEL = previous.model;
    if (previous.silence === undefined) delete process.env.OPENAI_STT_SILENCE_MS;
    else process.env.OPENAI_STT_SILENCE_MS = previous.silence;
    if (previous.minimum === undefined) delete process.env.OPENAI_STT_MIN_SPEECH_MS;
    else process.env.OPENAI_STT_MIN_SPEECH_MS = previous.minimum;
    if (previous.vad === undefined) delete process.env.OPENAI_STT_VAD_RMS;
    else process.env.OPENAI_STT_VAD_RMS = previous.vad;
  }
});

test('calculates PCM duration from the sample count', () => {
  const stats = getPcmStats(pcmFrame(0));
  assert.equal(stats.sampleCount, 160);
  assert.equal(stats.rms, 0);
});
