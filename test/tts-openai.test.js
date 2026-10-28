const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {test} = require('node:test');
const {
  synthesizeText,
  buildSessionUpdate,
  buildResponseCreate,
  getSpeechInstructions,
  REALTIME_VOICES,
  LIVE_VOICES,
  REALTIME_MODELS,
  synthesizeSpeechHttp,
  streamSpeechHttp,
  streamRealtimeTts,
  streamLiveTts,
  prewarmLiveTtsConnection,
  closeWarmLiveTtsConnection
} = require('../lib/tts/openai');
const {createWavPcm16Mono, parseWavPcm16Mono} = require('../lib/audio/pcm');

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;

  constructor() {
    super();
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    setImmediate(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open');
    });
  }

  send(payload) {
    const event = JSON.parse(payload);
    this.sent.push(event);
    if (event.type !== 'response.create') return;
    const audio = Buffer.alloc(12);
    audio.writeInt16LE(1000, 0);
    audio.writeInt16LE(-1000, 2);
    setImmediate(() => {
      this.emit('message', Buffer.from(JSON.stringify({
        type: 'response.output_audio.delta',
        delta: audio.toString('base64')
      })));
      this.emit('message', Buffer.from(JSON.stringify({
        type: 'response.done',
        response: {status: 'completed'}
      })));
    });
  }

  close() {
    this.readyState = 3;
  }
}

class StreamingFakeWebSocket extends FakeWebSocket {
  send(payload) {
    const event = JSON.parse(payload);
    this.sent.push(event);
    if (event.type === 'session.update') {
      setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({type: 'session.updated'}))));
      return;
    }
    if (event.type !== 'response.create') return;
    const audio = Buffer.alloc(18);
    [2000, -2000, 5000, -5000, 9000, -9000, 11000, -11000, 13000].forEach((sample, index) => audio.writeInt16LE(sample, index * 2));
    setImmediate(() => {
      this.emit('message', Buffer.from(JSON.stringify({type: 'response.output_audio.delta', delta: audio.subarray(0, 5).toString('base64')})));
      this.emit('message', Buffer.from(JSON.stringify({type: 'response.output_audio.delta', delta: audio.subarray(5, 12).toString('base64')})));
      this.emit('message', Buffer.from(JSON.stringify({type: 'response.output_audio.delta', delta: audio.subarray(12).toString('base64')})));
      this.emit('message', Buffer.from(JSON.stringify({type: 'response.done', response: {status: 'completed'}})));
    });
  }
}

class LiveFakeWebSocket extends FakeWebSocket {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    LiveFakeWebSocket.lastInstance = this;
  }

  send(payload) {
    const event = JSON.parse(payload);
    this.sent.push(event);
    if (event.type === 'session.start') {
      setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({type: 'session.started'}))));
    }
    if (event.type === 'session.instructions.append') {
      setImmediate(() => {
        this.emit('message', Buffer.from(JSON.stringify({type: 'session.output_transcript.delta', delta: 'Olá, este é um teste sintético.'})));
        this.emit('message', Buffer.from(JSON.stringify({type: 'session.output_audio.delta', delta: Buffer.alloc(12).toString('base64')})));
      });
    }
    if (event.type === 'session.close') {
      setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({type: 'session.closed'}))));
    }
  }
}

class StreamingLiveFakeWebSocket extends LiveFakeWebSocket {
  send(payload) {
    const event = JSON.parse(payload);
    this.sent.push(event);
    if (event.type === 'session.start') {
      setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({type: 'session.started'}))));
    }
    if (event.type === 'session.instructions.append') {
      const audio = Buffer.alloc(18);
      [2000, -2000, 5000, -5000, 9000, -9000, 11000, -11000, 13000].forEach((sample, index) => audio.writeInt16LE(sample, index * 2));
      setImmediate(() => {
        this.emit('message', Buffer.from(JSON.stringify({type: 'session.output_transcript.delta', delta: 'Olá, este é um teste sintético de voz em português brasileiro.'})));
        this.emit('message', Buffer.from(JSON.stringify({type: 'session.output_audio.delta', delta: audio.subarray(0, 5).toString('base64')})));
        this.emit('message', Buffer.from(JSON.stringify({type: 'session.output_audio.delta', delta: audio.subarray(5).toString('base64')})));
      });
    }
    if (event.type === 'session.close') {
      setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({type: 'session.closed'}))));
    }
  }
}

class UnexpectedPrefixLiveFakeWebSocket extends StreamingLiveFakeWebSocket {
  send(payload) {
    const event = JSON.parse(payload);
    if (event.type !== 'session.instructions.append') return super.send(payload);
    this.sent.push(event);
    setImmediate(() => {
      this.emit('message', Buffer.from(JSON.stringify({type: 'session.output_transcript.delta', delta: 'Unexpected extra words. Olá, este é um teste sintético de voz em português brasileiro.'})));
      this.emit('message', Buffer.from(JSON.stringify({type: 'session.output_audio.delta', delta: Buffer.alloc(12).toString('base64')})));
    });
  }
}

class DelayedTailLiveFakeWebSocket extends LiveFakeWebSocket {
  send(payload) {
    const event = JSON.parse(payload);
    this.sent.push(event);
    if (event.type === 'session.start') {
      setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({type: 'session.started'}))));
    }
    if (event.type === 'session.instructions.append') {
      const audio = Buffer.alloc(18);
      setImmediate(() => {
        DelayedTailLiveFakeWebSocket.lastTranscriptAt = Date.now();
        this.emit('message', Buffer.from(JSON.stringify({type: 'session.output_transcript.delta', delta: 'Olá, este é um teste sintético de voz em português brasileiro.'})));
        this.emit('message', Buffer.from(JSON.stringify({type: 'session.output_audio.delta', delta: audio.subarray(0, 6).toString('base64')})));
        setTimeout(() => {
          DelayedTailLiveFakeWebSocket.lastAudioAt = Date.now();
          this.emit('message', Buffer.from(JSON.stringify({type: 'session.output_audio.delta', delta: audio.subarray(6).toString('base64')})));
        }, 40);
      });
    }
    if (event.type === 'session.close') {
      DelayedTailLiveFakeWebSocket.closeAfterTranscriptMs = Date.now() - DelayedTailLiveFakeWebSocket.lastTranscriptAt;
      DelayedTailLiveFakeWebSocket.closeAfterLastAudioMs = Date.now() - DelayedTailLiveFakeWebSocket.lastAudioAt;
      setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({type: 'session.closed'}))));
    }
  }
}

test('builds the current Realtime TTS events', () => {
  const session = buildSessionUpdate('gpt-realtime-2.1-mini', 'marin');
  assert.equal(session.type, 'session.update');
  assert.equal(session.session.model, 'gpt-realtime-2.1-mini');
  assert.equal(session.session.reasoning.effort, 'minimal');
  assert.deepEqual(session.session.output_modalities, ['audio']);
  assert.equal(session.session.audio.output.format.rate, 24000);

  const response = buildResponseCreate('A resposta exata.');
  assert.equal(response.type, 'response.create');
  assert.equal(response.response.conversation, 'none');
  assert.equal(response.response.max_output_tokens, 4096);
  assert.equal(response.response.input[0].content[0].text, 'A resposta exata.');

  const brazilianPortugueseResponse = buildResponseCreate('Olá, tudo bem?', 'pt-BR');
  assert.match(brazilianPortugueseResponse.response.instructions, /Brazilian Portuguese/);
  assert.match(getSpeechInstructions('pt_BR'), /Brazilian Portuguese/);
});

test('collects mocked Realtime audio without contacting OpenAI', async () => {
  const result = await synthesizeText({
    apiKey: 'test-key',
    text: 'CNPJ três quatro.',
    voice: 'marin',
    WebSocketImpl: FakeWebSocket
  });
  assert.equal(result.pcm.length, 12);
  assert.ok(result.durationMs >= 0);
  assert.ok(REALTIME_VOICES.includes('marin'));
});

test('collects mocked GPT-Live audio with the Marin voice', async () => {
  let firstAudioMs;
  const result = await synthesizeText({
    apiKey: 'test-key',
    model: 'gpt-live-1',
    transport: 'gpt_live',
    voice: 'marin',
    text: 'Olá, este é um teste sintético.',
    language: 'pt-BR',
    readingInstructions: 'Fale somente o texto fornecido, exatamente uma vez.',
    WebSocketImpl: LiveFakeWebSocket,
    onFirstAudio: (value) => { firstAudioMs = value; }
  });
  assert.equal(result.pcm.length, 12);
  assert.equal(result.sampleRate, 24000);
  assert.ok(firstAudioMs >= 0);
  assert.match(LiveFakeWebSocket.lastInstance.url, /\/live\/sessions$/);
  assert.equal(LiveFakeWebSocket.lastInstance.options.headers.Authorization, 'Bearer test-key');
  const start = LiveFakeWebSocket.lastInstance.sent[0];
  assert.equal(start.session.model, 'gpt-live-1');
  assert.equal(start.session.audio.output.voice, 'marin');
  assert.equal(start.session.audio.format.rate, 24000);
  assert.equal(start.session.input.length, 1);
  assert.match(start.session.input[0].content[0].text, /Brazilian Portuguese/);
  const speechCommand = LiveFakeWebSocket.lastInstance.sent.find((event) => event.type === 'session.instructions.append');
  assert.equal(speechCommand.delegation_id, null);
  assert.match(speechCommand.content, /Fale somente o texto fornecido, exatamente uma vez/);
  assert.match(speechCommand.content, /TEXTO PARA FALAR/);
  assert.match(speechCommand.content, /Olá, este é um teste sintético\./);
  const silence = LiveFakeWebSocket.lastInstance.sent.find((event) => event.type === 'session.input_audio.append');
  assert.equal(Buffer.from(silence.audio, 'base64').length, 48000);
  assert.ok(LIVE_VOICES.includes('marin'));
});

test('streams mocked GPT-Live audio to Cognigy as chunked 8 kHz WAV', async () => {
  const written = [];
  const headers = {};
  let ended = false;
  let firstAudioMs;
  const response = {
    writableEnded: false,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    removeHeader(name) { delete headers[name.toLowerCase()]; },
    flushHeaders() {},
    write(chunk) { written.push(Buffer.from(chunk)); return true; },
    end() { ended = true; this.writableEnded = true; },
    destroy(error) { throw error; }
  };
  const result = await streamLiveTts({
    apiKey: 'test-key',
    voice: 'bossa',
    text: 'Olá, este é um teste sintético de voz em português brasileiro.',
    language: 'pt-BR',
    readingInstructions: 'Não acrescente nenhuma fala.',
    response,
    WebSocketImpl: StreamingLiveFakeWebSocket,
    onFirstAudio: (value) => { firstAudioMs = value; }
  });
  const wav = parseWavPcm16Mono(Buffer.concat(written));
  assert.equal(headers['content-type'], 'audio/wav');
  assert.equal(headers['content-length'], undefined);
  assert.equal(wav.sampleRate, 8000);
  assert.deepEqual(Array.from({length: 3}, (_, index) => wav.pcm.readInt16LE(index * 2)), [1667, -1667, 4333]);
  assert.equal(result.bytes, 6);
  assert.equal(result.transcriptMatchesTargetExactly, true);
  const speechCommand = StreamingLiveFakeWebSocket.lastInstance.sent.find((event) => event.type === 'session.instructions.append');
  assert.match(speechCommand.content, /Não acrescente nenhuma fala/);
  assert.match(speechCommand.content, /TEXTO PARA FALAR/);
  assert.ok(result.firstAudioMs >= 0);
  assert.ok(result.transcriptMatchedMs >= 0);
  assert.ok(result.lastAudioChunkMs >= result.transcriptMatchedMs);
  assert.ok(result.closeRequestedMs >= result.transcriptMatchedMs);
  assert.ok(result.audioDurationMs >= 0);
  assert.ok(written.length >= 2);
  assert.ok(firstAudioMs >= 0);
  assert.equal(ended, true);
});

test('reuses a preconnected idle GPT-Live websocket for the next speech request', async () => {
  closeWarmLiveTtsConnection();
  await prewarmLiveTtsConnection({apiKey: 'test-key', WebSocketImpl: LiveFakeWebSocket});
  const socket = LiveFakeWebSocket.lastInstance;
  assert.equal(socket.readyState, LiveFakeWebSocket.OPEN);
  assert.equal(socket.options.perMessageDeflate, false);

  const response = {
    writableEnded: false,
    setHeader() {},
    removeHeader() {},
    flushHeaders() {},
    write() { return true; },
    end() { this.writableEnded = true; },
    destroy(error) { throw error; }
  };
  const streamed = await streamLiveTts({
    apiKey: 'test-key',
    voice: 'bossa',
    text: 'Olá, este é um teste sintético.',
    language: 'pt-BR',
    response,
    WebSocketImpl: LiveFakeWebSocket
  });

  assert.equal(LiveFakeWebSocket.lastInstance, socket);
  assert.equal(streamed.socketWasWarm, true);
  assert.equal(streamed.socketOpenMs, 0);
  assert.equal(streamed.transcriptMatchesTargetExactly, true);
  closeWarmLiveTtsConnection();
});

test('does not reuse a preconnected GPT-Live socket after the API key changes', async () => {
  closeWarmLiveTtsConnection();
  await prewarmLiveTtsConnection({apiKey: 'first-test-key', WebSocketImpl: LiveFakeWebSocket});
  const oldSocket = LiveFakeWebSocket.lastInstance;
  const response = {
    writableEnded: false,
    setHeader() {},
    removeHeader() {},
    flushHeaders() {},
    write() { return true; },
    end() { this.writableEnded = true; },
    destroy(error) { throw error; }
  };
  const streamed = await streamLiveTts({
    apiKey: 'rotated-test-key',
    voice: 'bossa',
    text: 'Olá, este é um teste sintético.',
    language: 'pt-BR',
    response,
    WebSocketImpl: LiveFakeWebSocket,
    closeQuietMs: 5
  });
  assert.notEqual(LiveFakeWebSocket.lastInstance, oldSocket);
  assert.equal(streamed.socketWasWarm, false);
  closeWarmLiveTtsConnection();
});

test('detects text that surrounds the requested GPT-Live transcript without logging it', async () => {
  const response = {
    writableEnded: false,
    setHeader() {},
    removeHeader() {},
    flushHeaders() {},
    write() { return true; },
    end() { this.writableEnded = true; },
    destroy(error) { throw error; }
  };
  const streamed = await streamLiveTts({
    apiKey: 'test-key',
    voice: 'bossa',
    text: 'Olá, este é um teste sintético de voz em português brasileiro.',
    language: 'pt-BR',
    response,
    WebSocketImpl: UnexpectedPrefixLiveFakeWebSocket,
    closeQuietMs: 5
  });
  assert.equal(streamed.transcriptContainsTarget, true);
  assert.equal(streamed.transcriptMatchesTargetExactly, false);
  assert.equal(streamed.transcriptPrefixMatchesTarget, false);
  assert.equal('transcript' in streamed, false);
});

test('bounds the GPT-Live audio tail after the transcript matches', async () => {
  const response = {
    writableEnded: false,
    setHeader() {},
    removeHeader() {},
    flushHeaders() {},
    write() { return true; },
    end() { this.writableEnded = true; },
    destroy(error) { throw error; }
  };

  await streamLiveTts({
    apiKey: 'test-key',
    voice: 'bossa',
    text: 'Olá, este é um teste sintético de voz em português brasileiro.',
    language: 'pt-BR',
    response,
    WebSocketImpl: DelayedTailLiveFakeWebSocket,
    closeQuietMs: 60,
    fallbackCloseQuietMs: 80
  });

  assert.ok(DelayedTailLiveFakeWebSocket.closeAfterTranscriptMs >= 90);
  assert.ok(DelayedTailLiveFakeWebSocket.closeAfterTranscriptMs < 170);
  assert.ok(DelayedTailLiveFakeWebSocket.closeAfterLastAudioMs >= 50);
  assert.ok(DelayedTailLiveFakeWebSocket.closeAfterLastAudioMs < 150);
});

test('reports only safe timing and transcript match diagnostics when a GPT-Live stream is cancelled', async () => {
  const controller = new AbortController();
  const response = {
    writableEnded: false,
    setHeader() {},
    removeHeader() {},
    flushHeaders() {},
    write() { return true; },
    end() { this.writableEnded = true; },
    destroy(error) { this.destroyedWithCode = error.code; }
  };
  const abortTimer = setTimeout(() => controller.abort(), 20);

  await assert.rejects(streamLiveTts({
    apiKey: 'test-key',
    voice: 'bossa',
    text: 'Olá, este é um teste sintético.',
    language: 'pt-BR',
    signal: controller.signal,
    response,
    WebSocketImpl: LiveFakeWebSocket
  }), (error) => {
    assert.equal(error.code, 'cancelled');
    assert.ok(error.ttsDiagnostics.firstAudioMs >= 0);
    assert.equal(error.ttsDiagnostics.transcriptContainsTarget, true);
    assert.equal(error.ttsDiagnostics.transcriptMatchesTargetExactly, true);
    assert.equal('transcript' in error.ttsDiagnostics, false);
    return true;
  });

  clearTimeout(abortTimer);
  assert.equal(response.destroyedWithCode, 'cancelled');
});

test('streams mocked Realtime audio as chunked 8 kHz WAV', async () => {
  const written = [];
  const headers = {};
  let ended = false;
  let firstAudioMs;
  const response = {
    writableEnded: false,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    removeHeader(name) { delete headers[name.toLowerCase()]; },
    flushHeaders() {},
    write(chunk) { written.push(Buffer.from(chunk)); },
    end() { ended = true; this.writableEnded = true; },
    destroy(error) { throw error; }
  };

  const result = await streamRealtimeTts({
    apiKey: 'test-key',
    model: 'gpt-realtime-2.1-mini',
    voice: 'marin',
    text: 'Texto de teste.',
    response,
    WebSocketImpl: StreamingFakeWebSocket,
    onFirstAudio: (value) => { firstAudioMs = value; }
  });

  const wav = parseWavPcm16Mono(Buffer.concat(written));
  assert.equal(REALTIME_MODELS.length, 2);
  assert.equal(headers['content-type'], 'audio/wav');
  assert.equal(headers['content-length'], undefined);
  assert.equal(wav.sampleRate, 8000);
  assert.deepEqual(Array.from({length: 3}, (_, index) => wav.pcm.readInt16LE(index * 2)), [1667, -1667, 4333]);
  assert.equal(result.bytes, 6);
  assert.equal(ended, true);
  assert.ok(firstAudioMs >= 0);
});

test('rejects a non-Realtime model before opening a Realtime stream', async () => {
  await assert.rejects(
    streamRealtimeTts({
      apiKey: 'test-key',
      model: 'gpt-4o-mini-tts',
      voice: 'marin',
      text: 'teste',
      response: {write() {}, end() {}}
    }),
    (error) => error.code === 'invalid_tts_configuration'
  );
});

test('rejects an unallowlisted voice before opening a provider connection', async () => {
  await assert.rejects(
    synthesizeText({apiKey: 'test-key', text: 'teste', voice: 'arbitrary-voice', WebSocketImpl: FakeWebSocket}),
    (error) => error.code === 'invalid_voice'
  );
});

test('supports the temporary HTTP Speech API transport with mocked fetch', async () => {
  const expectedWav = createWavPcm16Mono(Buffer.alloc(6), 24000);
  let request;
  const result = await synthesizeSpeechHttp({
    apiKey: 'test-key',
    model: 'gpt-4o-mini-tts',
    voice: 'marin',
    text: 'Texto de teste.',
    language: 'pt-BR',
    fetchImpl: async (url, options) => {
      request = {url, options, body: JSON.parse(options.body)};
      return {ok: true, status: 200, arrayBuffer: async () => expectedWav};
    }
  });
  assert.match(request.url, /\/audio\/speech$/);
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.equal(request.body.model, 'gpt-4o-mini-tts');
  assert.equal(request.body.response_format, 'wav');
  assert.match(request.body.instructions, /Brazilian Portuguese/);
  assert.equal(result.sampleRate, 24000);
  assert.equal(result.pcm.length, 6);
});

test('streams Speech API PCM as chunked 8 kHz WAV and preserves split samples', async () => {
  const source = Buffer.alloc(18);
  [1000, 2000, 3000, -1000, -2000, -3000, 4000, 5000, 6000].forEach((sample, index) => source.writeInt16LE(sample, index * 2));
  const chunks = [source.subarray(0, 1), source.subarray(1, 6), source.subarray(6, 11), source.subarray(11)];
  const written = [];
  const headers = {};
  let ended = false;
  let request;
  let firstAudioMs;
  const response = {
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    removeHeader(name) { delete headers[name.toLowerCase()]; },
    flushHeaders() {},
    write(chunk) { written.push(Buffer.from(chunk)); },
    end() { ended = true; }
  };

  const result = await streamSpeechHttp({
    apiKey: 'test-key',
    model: 'gpt-4o-mini-tts',
    voice: 'marin',
    text: 'Texto de teste.',
    language: 'pt-BR',
    response,
    onFirstAudio: (value) => { firstAudioMs = value; },
    fetchImpl: async (url, options) => {
      request = {url, body: JSON.parse(options.body)};
      return {ok: true, status: 200, body: (async function*() { for (const chunk of chunks) yield chunk; })()};
    }
  });

  const wav = parseWavPcm16Mono(Buffer.concat(written));
  assert.match(request.url, /\/audio\/speech$/);
  assert.equal(request.body.response_format, 'pcm');
  assert.equal(request.body.stream_format, 'audio');
  assert.match(request.body.instructions, /Brazilian Portuguese/);
  assert.equal(headers['content-type'], 'audio/wav');
  assert.equal(headers['content-length'], undefined);
  assert.equal(wav.sampleRate, 8000);
  assert.deepEqual(Array.from({length: 3}, (_, index) => wav.pcm.readInt16LE(index * 2)), [2000, -2000, 5000]);
  assert.equal(result.bytes, 6);
  assert.equal(ended, true);
  assert.ok(firstAudioMs >= 0);
});
