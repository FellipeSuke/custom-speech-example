const crypto = require('node:crypto');
const WebSocket = require('ws');
const {resamplePcm16Mono, createWavPcm16Mono, parseWavPcm16Mono} = require('../audio/pcm');
const {readOpenAiApiKey} = require('../openai-config');

const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
const LIVE_URL = 'wss://api.openai.com/v1/live/sessions';
const OPENAI_PCM_RATE = 24000;
const MAX_TEXT_LENGTH = 4096;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_REALTIME_EVENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_TTS = 8;
const REALTIME_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const LIVE_VOICES = ['bossa', 'tempo'];
const REALTIME_MODELS = ['gpt-realtime-2.1-mini', 'gpt-realtime-2.1'];
const LIVE_MODEL = 'gpt-live-1';
const REALTIME_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

const normalizeSpeechLanguage = (language) => String(language || '').trim().replace('_', '-').toLowerCase();

const getSpeechInstructions = (language) => {
  switch (normalizeSpeechLanguage(language)) {
    case 'pt-br':
      return 'Speak in Brazilian Portuguese with a natural neutral Brazilian accent, clear articulation, moderate pace, and a professional, welcoming tone. Read the input text exactly. Do not add, omit, translate, summarize, or explain.';
    case 'pt':
      return 'Speak in Portuguese with clear articulation and a natural conversational pace. Read the input text exactly. Do not add, omit, translate, summarize, or explain.';
    default:
      return 'Read the input text exactly. Do not add, omit, translate, summarize, or explain.';
  }
};

const getAllowedVoices = (transport = 'realtime') => {
  const configured = process.env.OPENAI_TTS_ALLOWED_VOICES;
  if (!configured) return transport === 'gpt_live' ? LIVE_VOICES : REALTIME_VOICES;
  return configured.split(',').map((value) => value.trim()).filter(Boolean);
};

const getRealtimeUrl = (model) => {
  const base = process.env.OPENAI_REALTIME_URL || REALTIME_URL;
  const url = new URL(base);
  url.searchParams.set('model', model);
  return url.toString();
};

const getTtsModel = (config) => config?.tts_model || process.env.OPENAI_TTS_MODEL || 'gpt-realtime-2.1';
const getTtsTransport = (config) => config?.tts_transport || process.env.OPENAI_TTS_TRANSPORT || 'realtime';
const isTtsStreamingEnabled = () => process.env.TTS_STREAMING_ENABLED === 'true';
const getTtsReasoningEffort = (config) => REALTIME_REASONING_EFFORTS.includes(config?.tts_reasoning_effort) ? config.tts_reasoning_effort : REALTIME_REASONING_EFFORTS.includes(process.env.OPENAI_TTS_REASONING_EFFORT) ? process.env.OPENAI_TTS_REASONING_EFFORT : 'minimal';
const getMaxConcurrentTts = () => {
  const configured = Number(process.env.OPENAI_TTS_MAX_CONCURRENCY);
  return Number.isInteger(configured) ? Math.max(1, Math.min(64, configured)) : DEFAULT_MAX_CONCURRENT_TTS;
};

let activeTtsRequests = 0;

const validateTtsConfiguration = (transport, model) => {
  if (transport === 'gpt_live' && model !== LIVE_MODEL) {
    return Object.assign(new Error('Unsupported GPT-Live model'), {code: 'invalid_tts_configuration'});
  }
  if (transport !== 'gpt_live' && model === LIVE_MODEL) {
    return Object.assign(new Error('GPT-Live requires the GPT-Live transport'), {code: 'invalid_tts_configuration'});
  }
  if (!['realtime', 'audio_speech', 'gpt_live'].includes(transport)) {
    return Object.assign(new Error('Unsupported TTS transport'), {code: 'invalid_tts_configuration'});
  }
  if (transport === 'audio_speech' && REALTIME_MODELS.includes(model)) {
    return Object.assign(new Error('Realtime models require the Realtime transport'), {code: 'invalid_tts_configuration'});
  }
  if (transport === 'realtime' && !REALTIME_MODELS.includes(model)) {
    return Object.assign(new Error('Unsupported Realtime model'), {code: 'invalid_tts_configuration'});
  }
  return null;
};

const synthesizeLiveTts = ({apiKey, voice, text, language, timeoutMs, signal, WebSocketImpl = WebSocket, onFirstAudio}) => new Promise((resolve, reject) => {
  const chunks = [];
  const startedAt = process.hrtime.bigint();
  let firstAudioAt;
  let settled = false;
  let idleTimer;
  let ws;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', abort);
    ws?.removeAllListeners();
    if (ws && (ws.readyState === WebSocketImpl.OPEN || ws.readyState === WebSocketImpl.CONNECTING)) ws.close();
    if (error) return reject(error);
    const pcm = Buffer.concat(chunks);
    if (!pcm.length) return reject(Object.assign(new Error('GPT-Live returned no audio'), {code: 'provider_no_audio'}));
    resolve({pcm, sampleRate: OPENAI_PCM_RATE, durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6, firstAudioMs: firstAudioAt});
  };
  const abort = () => finish(Object.assign(new Error('TTS request cancelled'), {code: 'cancelled'}));
  const timer = setTimeout(() => finish(Object.assign(new Error('OpenAI request timed out'), {code: 'timeout'})), timeoutMs);
  const closeAfterQuiet = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (ws?.readyState === WebSocketImpl.OPEN) ws.send(JSON.stringify({type: 'session.close'}));
    }, 1200);
  };
  if (signal?.aborted) return abort();
  signal?.addEventListener('abort', abort, {once: true});
  try {
    ws = new WebSocketImpl(LIVE_URL, {headers: {Authorization: `Bearer ${apiKey}`}, handshakeTimeout: timeoutMs, maxPayload: MAX_REALTIME_EVENT_BYTES});
  } catch {
    return finish(Object.assign(new Error('OpenAI connection failed'), {code: 'provider_connection_error'}));
  }
  ws.on('open', () => {
    const instructions = `${getSpeechInstructions(language)} This is a one-shot speech rendering request. Immediately read aloud the user text exactly, without greeting or adding any words.`;
    ws.send(JSON.stringify({type: 'session.start', session: {model: LIVE_MODEL, instructions, delegation: {type: 'client'}, input: [
      {type: 'message', role: 'developer', content: [{type: 'input_text', text: instructions}]},
      {type: 'message', role: 'user', content: [{type: 'input_text', text}]}
    ], audio: {format: {type: 'audio/pcm', rate: OPENAI_PCM_RATE}, output: {voice}}}}));
  });
  ws.on('message', (raw) => {
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return finish(Object.assign(new Error('Invalid event from OpenAI'), {code: 'provider_protocol_error'})); }
    if (event.type === 'error') return finish(safeProviderError(event));
    if (event.type === 'session.started') {
      const instruction = `Speak the following text aloud in Brazilian Portuguese, exactly as written. Do not add, omit, translate, or answer anything: ${text}`;
      ws.send(JSON.stringify({type: 'session.commentary.append', event_id: crypto.randomUUID(), delegation_id: null, content: instruction}));
    }
    if (event.type === 'session.output_audio.delta') {
      if (firstAudioAt === undefined) {
        firstAudioAt = Number(process.hrtime.bigint() - startedAt) / 1e6;
        onFirstAudio?.(firstAudioAt);
      }
      try { chunks.push(Buffer.from(event.delta, 'base64')); } catch { return finish(Object.assign(new Error('Invalid audio event from OpenAI'), {code: 'provider_protocol_error'})); }
      closeAfterQuiet();
    }
    if (event.type === 'session.closed') return finish();
  });
  ws.on('error', () => finish(Object.assign(new Error('OpenAI connection failed'), {code: 'provider_connection_error'})));
  ws.on('close', () => { if (!settled) finish(Object.assign(new Error('OpenAI connection closed before completion'), {code: 'provider_connection_closed'})); });
});

const safeProviderError = (event) => {
  const providerCode = event?.error?.code;
  const code = typeof providerCode === 'string' && /^[a-z0-9_.:-]{1,64}$/i.test(providerCode) ? providerCode : 'provider_error';
  const error = new Error('OpenAI Realtime request failed');
  error.code = code;
  return error;
};

const buildSessionUpdate = (model, voice, reasoningEffort = getTtsReasoningEffort()) => ({
  type: 'session.update',
  session: {
    type: 'realtime',
    model,
    reasoning: {effort: reasoningEffort},
    output_modalities: ['audio'],
    audio: {
      output: {
        format: {type: 'audio/pcm', rate: OPENAI_PCM_RATE},
        voice
      }
    }
  }
});

const buildResponseCreate = (text, language) => ({
  type: 'response.create',
  response: {
    conversation: 'none',
    output_modalities: ['audio'],
    instructions: getSpeechInstructions(language),
    max_output_tokens: MAX_OUTPUT_TOKENS,
    input: [{
      type: 'message',
      role: 'user',
      content: [{type: 'input_text', text}]
    }]
  }
});

const synthesizeSpeechHttp = async ({apiKey, model, voice, text, language, signal, fetchImpl = fetch}) => {
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const response = await fetchImpl(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({model, input: text, voice, response_format: 'wav', instructions: getSpeechInstructions(language)}),
    signal
  });
  if (!response.ok) {
    const error = new Error(`OpenAI speech request returned ${response.status}`);
    error.code = response.status === 401 ? 'invalid_api_key' : response.status === 404 ? 'model_not_found' : 'provider_http_error';
    throw error;
  }
  return parseWavPcm16Mono(Buffer.from(await response.arrayBuffer()));
};

const createStreamingWavHeader = (sampleRate) => {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(0xffffffff, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(0xffffffff, 40);
  return header;
};

const createPcm24To8StreamResampler = () => {
  let carry = Buffer.alloc(0);

  const process = (chunk, flush = false) => {
    if (!Buffer.isBuffer(chunk)) throw new Error('provider returned invalid PCM16 audio');
    const input = Buffer.concat([carry, chunk]);
    const completeBytes = input.length - (input.length % 6);
    const output = Buffer.alloc((completeBytes / 6) * 2);

    for (let inputOffset = 0, outputOffset = 0; inputOffset < completeBytes; inputOffset += 6, outputOffset += 2) {
      const average = (input.readInt16LE(inputOffset) + input.readInt16LE(inputOffset + 2) + input.readInt16LE(inputOffset + 4)) / 3;
      output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(average))), outputOffset);
    }

    carry = input.subarray(completeBytes);
    if (flush && carry.length) {
      /* A provider should end on a sample boundary. Drop incomplete samples rather than corrupting the WAV. */
      carry = Buffer.alloc(0);
    }
    return output;
  };

  return {process};
};

const responseChunks = async function* (body) {
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) yield chunk;
    return;
  }
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) return;
        yield item.value;
      }
    } finally {
      reader.releaseLock?.();
    }
    return;
  }
  throw new Error('OpenAI returned no streaming audio body');
};

const streamSpeechHttp = async ({apiKey, model, voice, text, language, signal, sampleRate = 8000, response, fetchImpl = fetch, onFirstAudio}) => {
  if (!apiKey) throw Object.assign(new Error('OpenAI is not configured'), {code: 'not_configured'});
  if (sampleRate !== 8000) throw Object.assign(new Error('streaming TTS requires an 8000 Hz response'), {code: 'invalid_sample_rate'});
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const startedAt = process.hrtime.bigint();
  const upstream = await fetchImpl(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({model, input: text, voice, response_format: 'pcm', stream_format: 'audio', instructions: getSpeechInstructions(language)}),
    signal
  });
  if (!upstream.ok) {
    const error = new Error(`OpenAI speech request returned ${upstream.status}`);
    error.code = upstream.status === 401 ? 'invalid_api_key' : upstream.status === 404 ? 'model_not_found' : 'provider_http_error';
    throw error;
  }

  const resampler = createPcm24To8StreamResampler();
  let firstAudioMs;
  let bytes = 0;
  response.statusCode = 200;
  response.setHeader('Content-Type', 'audio/wav');
  response.removeHeader?.('Content-Length');
  response.flushHeaders?.();
  response.write(createStreamingWavHeader(sampleRate));

  for await (const rawChunk of responseChunks(upstream.body)) {
    const chunk = Buffer.from(rawChunk);
    if (!chunk.length) continue;
    const pcm = resampler ? resampler.process(chunk) : chunk;
    if (!pcm.length) continue;
    if (firstAudioMs === undefined) {
      firstAudioMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      onFirstAudio?.(firstAudioMs);
    }
    bytes += pcm.length;
    response.write(pcm);
  }

  const tail = resampler?.process(Buffer.alloc(0), true);
  if (tail?.length) {
    bytes += tail.length;
    response.write(tail);
  }
  response.end();
  return {durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6, firstAudioMs, bytes};
};

const streamRealtimeTts = ({
  apiKey,
  model,
  voice,
  text,
  language,
  signal,
  response,
  sampleRate = 8000,
  reasoningEffort = getTtsReasoningEffort(),
  timeoutMs = Number(process.env.OPENAI_TTS_TIMEOUT_MS) || 60000,
  WebSocketImpl = WebSocket,
  onFirstAudio
}) => new Promise((resolve, reject) => {
  if (!apiKey) return reject(Object.assign(new Error('OpenAI is not configured'), {code: 'not_configured'}));
  if (sampleRate !== 8000) return reject(Object.assign(new Error('streaming TTS requires an 8000 Hz response'), {code: 'invalid_sample_rate'}));
  const configurationError = validateTtsConfiguration('realtime', model);
  if (configurationError) return reject(configurationError);
  if (signal?.aborted) return reject(Object.assign(new Error('TTS request cancelled'), {code: 'cancelled'}));

  const startedAt = process.hrtime.bigint();
  const resampler = createPcm24To8StreamResampler();
  let ws;
  let settled = false;
  let responseStarted = false;
  let responseRequested = false;
  let firstAudioAt;
  let bytes = 0;
  const timer = setTimeout(() => finish(Object.assign(new Error('OpenAI request timed out'), {code: 'timeout'})), timeoutMs);

  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    ws?.removeAllListeners();
    if (ws && (ws.readyState === WebSocketImpl.OPEN || ws.readyState === WebSocketImpl.CONNECTING)) ws.close();
  };

  const finish = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) {
      if (responseStarted && !response.writableEnded) response.destroy();
      reject(error);
      return;
    }
    if (!responseStarted) {
      return reject(Object.assign(new Error('OpenAI returned no audio'), {code: 'provider_no_audio'}));
    }
    if (!response.writableEnded) response.end();
    resolve({durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6, firstAudioMs: firstAudioAt, bytes});
  };

  const abort = () => finish(Object.assign(new Error('TTS request cancelled'), {code: 'cancelled'}));
  const startResponse = () => {
    if (responseStarted) return;
    responseStarted = true;
    response.statusCode = 200;
    response.setHeader('Content-Type', 'audio/wav');
    response.removeHeader?.('Content-Length');
    response.flushHeaders?.();
    response.write(createStreamingWavHeader(sampleRate));
  };
  const handleMessage = (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return finish(Object.assign(new Error('Invalid event from OpenAI'), {code: 'provider_protocol_error'}));
    }
    if (event.type === 'error') return finish(safeProviderError(event));
    if (event.type === 'session.updated') {
      if (responseRequested) return;
      responseRequested = true;
      try {
        ws.send(JSON.stringify(buildResponseCreate(text, language)));
      } catch {
        finish(Object.assign(new Error('OpenAI connection failed'), {code: 'provider_connection_error'}));
      }
      return;
    }
    if (event.type === 'response.output_audio.delta') {
      if (typeof event.delta !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.delta)) {
        return finish(Object.assign(new Error('Invalid audio event from OpenAI'), {code: 'provider_protocol_error'}));
      }
      const audio = Buffer.from(event.delta, 'base64');
      const pcm = resampler.process(audio);
      if (!pcm.length) return;
      startResponse();
      if (firstAudioAt === undefined) {
        firstAudioAt = Number(process.hrtime.bigint() - startedAt) / 1e6;
        onFirstAudio?.(firstAudioAt);
      }
      bytes += pcm.length;
      try {
        response.write(pcm);
      } catch {
        finish(Object.assign(new Error('TTS response stream failed'), {code: 'response_stream_error'}));
      }
    }
    if (event.type === 'response.done') {
      if (event.response?.status === 'failed') return finish(safeProviderError(event.response.status_details));
      const tail = resampler.process(Buffer.alloc(0), true);
      if (tail.length) {
        bytes += tail.length;
        if (!responseStarted) startResponse();
        try {
          response.write(tail);
        } catch {
          return finish(Object.assign(new Error('TTS response stream failed'), {code: 'response_stream_error'}));
        }
      }
      finish(null);
    }
  };

  signal?.addEventListener('abort', abort, {once: true});
  try {
    ws = new WebSocketImpl(getRealtimeUrl(model), {
      headers: {Authorization: `Bearer ${apiKey}`},
      handshakeTimeout: timeoutMs,
      maxPayload: MAX_REALTIME_EVENT_BYTES
    });
  } catch (error) {
    finish(Object.assign(new Error('OpenAI connection failed'), {code: 'provider_connection_error', cause: error}));
    return;
  }
  ws.on('open', () => {
    try {
      ws.send(JSON.stringify(buildSessionUpdate(model, voice, reasoningEffort)));
    } catch {
      finish(Object.assign(new Error('OpenAI connection failed'), {code: 'provider_connection_error'}));
    }
  });
  ws.on('message', handleMessage);
  ws.on('error', () => finish(Object.assign(new Error('OpenAI connection failed'), {code: 'provider_connection_error'})));
  ws.on('close', () => {
    if (!settled) finish(Object.assign(new Error('OpenAI connection closed before completion'), {code: 'provider_connection_closed'}));
  });
});

const synthesizeText = ({
  apiKey = readOpenAiApiKey(),
  model = process.env.OPENAI_TTS_MODEL || 'gpt-realtime-2.1',
  transport = getTtsTransport(),
  voice = process.env.OPENAI_TTS_VOICE || 'marin',
  reasoningEffort = getTtsReasoningEffort(),
  text,
  language,
  timeoutMs = Number(process.env.OPENAI_TTS_TIMEOUT_MS) || 60000,
  signal,
  WebSocketImpl = WebSocket,
  onFirstAudio
}) => new Promise((resolve, reject) => {
  if (!apiKey) return reject(Object.assign(new Error('OpenAI is not configured'), {code: 'not_configured'}));
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH) {
    return reject(Object.assign(new Error('text must contain 1 to 4096 characters'), {code: 'invalid_text'}));
  }
  if (!getAllowedVoices(transport).includes(voice)) {
    return reject(Object.assign(new Error('voice is not allowed'), {code: 'invalid_voice'}));
  }
  const configurationError = validateTtsConfiguration(transport, model);
  if (configurationError) return reject(configurationError);

  if (transport === 'gpt_live') {
    return synthesizeLiveTts({apiKey, voice, text, language, timeoutMs, signal, WebSocketImpl, onFirstAudio}).then(resolve, reject);
  }

  if (transport === 'audio_speech') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    if (signal?.aborted) return reject(Object.assign(new Error('TTS request cancelled'), {code: 'cancelled'}));
    signal?.addEventListener('abort', abort, {once: true});
    const startedAt = process.hrtime.bigint();
    synthesizeSpeechHttp({apiKey, model, voice, text, language, signal: controller.signal})
      .then((audio) => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        onFirstAudio?.(durationMs);
        resolve({pcm: audio.pcm, sampleRate: audio.sampleRate, durationMs, firstAudioMs: durationMs});
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          const code = signal?.aborted ? 'cancelled' : 'timeout';
          return reject(Object.assign(new Error(code === 'timeout' ? 'OpenAI request timed out' : 'TTS request cancelled'), {code}));
        }
        reject(error);
      })
      .finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      });
    return;
  }

  const audioChunks = [];
  let settled = false;
  let firstAudioAt;
  const startedAt = process.hrtime.bigint();
  const ws = new WebSocketImpl(getRealtimeUrl(model), {
    headers: {Authorization: `Bearer ${apiKey}`},
    handshakeTimeout: timeoutMs
  });

  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    ws.removeAllListeners();
    if (ws.readyState === WebSocketImpl.OPEN || ws.readyState === WebSocketImpl.CONNECTING) ws.close();
    if (error) reject(error);
    else resolve({pcm: Buffer.concat(audioChunks), durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6, firstAudioMs: firstAudioAt});
  };
  const abort = () => {
    const error = new Error('request cancelled');
    error.code = 'cancelled';
    finish(error);
  };
  const timer = setTimeout(() => {
    const error = new Error('OpenAI request timed out');
    error.code = 'timeout';
    finish(error);
  }, timeoutMs);

  if (signal?.aborted) return abort();
  signal?.addEventListener('abort', abort, {once: true});

  ws.on('open', () => {
    ws.send(JSON.stringify(buildSessionUpdate(model, voice, reasoningEffort)));
    ws.send(JSON.stringify(buildResponseCreate(text, language)));
  });
  ws.on('message', (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return finish(Object.assign(new Error('Invalid event from OpenAI'), {code: 'provider_protocol_error'}));
    }
    if (event.type === 'error') return finish(safeProviderError(event));
    if (event.type === 'response.output_audio.delta') {
      if (firstAudioAt === undefined) {
        firstAudioAt = Number(process.hrtime.bigint() - startedAt) / 1e6;
        onFirstAudio?.(firstAudioAt);
      }
      try {
        audioChunks.push(Buffer.from(event.delta, 'base64'));
      } catch {
        finish(Object.assign(new Error('Invalid audio event from OpenAI'), {code: 'provider_protocol_error'}));
      }
    }
    if (event.type === 'response.done') {
      if (event.response?.status === 'failed') return finish(safeProviderError(event.response.status_details));
      finish(null);
    }
  });
  ws.on('error', () => finish(Object.assign(new Error('OpenAI connection failed'), {code: 'provider_connection_error'})));
  ws.on('close', () => {
    if (!settled) finish(Object.assign(new Error('OpenAI connection closed before completion'), {code: 'provider_connection_closed'}));
  });
});

const routes = require('express').Router();

routes.post('/', async (req, res) => {
  const {logger} = req.app.locals;
  const runtimeConfig = req.app.locals.getRuntimeConfig?.() || {};
  const configuredModel = getTtsModel(runtimeConfig);
  const configuredTransport = getTtsTransport(runtimeConfig);
  const configuredReasoningEffort = getTtsReasoningEffort(runtimeConfig);
  const correlationId = req.get('x-correlation-id') || crypto.randomUUID();
  const {text, type, language, voice, encoding, sample_rate: requestedSampleRate} = req.body || {};
  const normalizedType = type === undefined ? 'text' : String(type).toLowerCase();
  const targetSampleRate = requestedSampleRate === undefined ? 8000 : Number(requestedSampleRate);
  const normalizedEncoding = encoding === undefined ? 'linear16' : String(encoding).toLowerCase();

  if (normalizedType === 'ssml') return res.status(400).json({error: 'SSML is not supported by this adapter'});
  if (normalizedType !== 'text') return res.status(400).json({error: 'only plain text is supported'});
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH) return res.status(400).json({error: 'text must contain 1 to 4096 characters'});
  if (!['linear16', 'pcm_s16le', 'pcm'].includes(normalizedEncoding)) return res.status(400).json({error: 'only linear16 audio is supported'});
  if (![8000, 16000, 24000].includes(targetSampleRate)) return res.status(400).json({error: 'sample_rate must be 8000, 16000, or 24000'});

  const selectedVoice = voice || runtimeConfig.tts_voice || process.env.OPENAI_TTS_VOICE || 'marin';
  if (activeTtsRequests >= getMaxConcurrentTts()) {
    res.set('Retry-After', '1');
    return res.status(429).json({error: 'TTS temporarily busy'});
  }
  activeTtsRequests += 1;
  const controller = new AbortController();
  let completed = false;
  const cancel = () => { if (!completed) controller.abort(); };
  req.once('aborted', cancel);
  res.once('close', cancel);

  try {
    const configurationError = validateTtsConfiguration(configuredTransport, configuredModel);
    if (configurationError) throw configurationError;
    if (configuredTransport === 'realtime' && isTtsStreamingEnabled() && targetSampleRate === 8000) {
      const streamed = await streamRealtimeTts({
        apiKey: readOpenAiApiKey(),
        model: configuredModel,
        voice: selectedVoice,
        text,
        language,
        signal: controller.signal,
        response: res,
        reasoningEffort: configuredReasoningEffort,
        onFirstAudio: (firstAudioMs) => logger.info({correlationId, operation: 'tts', model: configuredModel, transport: 'realtime_stream', firstAudioMs}, 'first TTS audio received')
      });
      completed = true;
      logger.info({correlationId, operation: 'tts', model: configuredModel, transport: 'realtime_stream', language: language || 'pt-BR', durationMs: Math.round(streamed.durationMs), firstAudioMs: Math.round(streamed.firstAudioMs || 0), bytes: streamed.bytes}, 'TTS completed');
      return;
    }
    if (configuredTransport === 'audio_speech' && isTtsStreamingEnabled() && targetSampleRate === 8000) {
      const streamed = await streamSpeechHttp({
        apiKey: readOpenAiApiKey(),
        model: configuredModel,
        voice: selectedVoice,
        text,
        language,
        signal: controller.signal,
        response: res,
        onFirstAudio: (firstAudioMs) => logger.info({correlationId, operation: 'tts', model: configuredModel, transport: 'audio_speech_stream', firstAudioMs}, 'first TTS audio received')
      });
      completed = true;
      logger.info({correlationId, operation: 'tts', model: configuredModel, transport: 'audio_speech_stream', language: language || 'pt-BR', durationMs: Math.round(streamed.durationMs), firstAudioMs: Math.round(streamed.firstAudioMs || 0), bytes: streamed.bytes}, 'TTS completed');
      return;
    }
    const result = await synthesizeText({
      text,
      voice: selectedVoice,
      model: configuredModel,
      transport: configuredTransport,
      reasoningEffort: configuredReasoningEffort,
      language,
      signal: controller.signal,
      onFirstAudio: (firstAudioMs) => logger.info({correlationId, operation: 'tts', model: configuredModel, transport: configuredTransport, firstAudioMs}, 'first TTS audio received')
    });
    const pcm = resamplePcm16Mono(result.pcm, result.sampleRate || OPENAI_PCM_RATE, targetSampleRate);
    const wav = createWavPcm16Mono(pcm, targetSampleRate);
    completed = true;
    logger.info({correlationId, operation: 'tts', model: configuredModel, transport: configuredTransport, language: language || 'pt-BR', durationMs: Math.round(result.durationMs), bytes: wav.length}, 'TTS completed');
    res.status(200).type('audio/wav').set('Content-Length', String(wav.length)).send(wav);
  } catch (error) {
    completed = true;
    const status = error.code === 'not_configured' ? 503 : error.code === 'timeout' ? 504 : error.code === 'cancelled' ? 499 : error.code === 'invalid_tts_configuration' ? 500 : 502;
    logger.error({correlationId, operation: 'tts', errorCode: error.code || 'unknown'}, 'TTS failed');
    if (!res.headersSent) res.status(status).json({error: status === 503 ? 'OpenAI is not configured' : status === 504 ? 'TTS request timed out' : 'TTS provider request failed'});
    else res.destroy();
  } finally {
    activeTtsRequests -= 1;
    req.removeListener('aborted', cancel);
    res.removeListener('close', cancel);
  }
});

module.exports = routes;
module.exports.synthesizeText = synthesizeText;
module.exports.buildSessionUpdate = buildSessionUpdate;
module.exports.buildResponseCreate = buildResponseCreate;
module.exports.getSpeechInstructions = getSpeechInstructions;
module.exports.REALTIME_VOICES = REALTIME_VOICES;
module.exports.synthesizeSpeechHttp = synthesizeSpeechHttp;
module.exports.createStreamingWavHeader = createStreamingWavHeader;
module.exports.createPcm24To8StreamResampler = createPcm24To8StreamResampler;
module.exports.responseChunks = responseChunks;
module.exports.streamSpeechHttp = streamSpeechHttp;
module.exports.streamRealtimeTts = streamRealtimeTts;
module.exports.REALTIME_MODELS = REALTIME_MODELS;
