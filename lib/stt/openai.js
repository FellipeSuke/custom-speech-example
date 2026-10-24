const WebSocket = require('ws');
const {resamplePcm16Mono} = require('../audio/pcm');

const OPENAI_INPUT_RATE = 24000;
const DEFAULT_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_SILENCE_MS = 700;
const DEFAULT_MIN_SPEECH_MS = 100;
const DEFAULT_VAD_RMS = 400;
const MAX_AUDIO_CHUNK_BYTES = 256 * 1024;
const MAX_PENDING_AUDIO_BYTES = 4 * 1024 * 1024;
const MAX_PROVIDER_EVENT_BYTES = 1024 * 1024;
const SUPPORTED_SAMPLE_RATES = [8000, 16000, 24000];

const getModel = () => process.env.OPENAI_STT_MODEL || DEFAULT_MODEL;
const getSilenceMs = () => Number(process.env.OPENAI_STT_SILENCE_MS) || DEFAULT_SILENCE_MS;
const getMinSpeechMs = () => Number(process.env.OPENAI_STT_MIN_SPEECH_MS) || DEFAULT_MIN_SPEECH_MS;
const getVadRms = () => Number(process.env.OPENAI_STT_VAD_RMS) || DEFAULT_VAD_RMS;

const getRealtimeUrl = () => {
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1')
    .replace(/^http/i, 'ws')
    .replace(/\/$/, '');
  return `${base}/realtime?intent=transcription`;
};

const normalizeLanguage = (language) => {
  if (typeof language !== 'string' || !language.trim()) return undefined;
  return language.trim().split(/[-_]/)[0].toLowerCase();
};

const normalizeSampleRate = (sampleRate) => {
  const value = Number(sampleRate) || 8000;
  if (!SUPPORTED_SAMPLE_RATES.includes(value)) throw new Error('unsupported sample rate');
  return value;
};

const buildSessionUpdate = ({language, model = getModel()}) => {
  const languages = normalizeLanguage(language);
  const transcription = {model};
  if (model === 'gpt-live-transcribe' || model === 'gpt-transcribe') {
    if (languages) transcription.languages = [languages];
    transcription.delay = process.env.OPENAI_STT_DELAY || 'low';
  } else if (languages) transcription.language = languages;
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: {type: 'audio/pcm', rate: OPENAI_INPUT_RATE},
          transcription,
          turn_detection: null
        }
      }
    }
  };
};

const createCognigyTranscription = ({transcript, isFinal, language}) => ({
  type: 'transcription',
  is_final: isFinal,
  alternatives: [{confidence: 0, transcript}],
  channel: 1,
  language
});

const getPcmStats = (pcm) => {
  let sumSquares = 0;
  let peak = 0;
  const sampleCount = pcm.length / 2;
  for (let index = 0; index < sampleCount; index++) {
    const sample = pcm.readInt16LE(index * 2);
    const absolute = Math.abs(sample);
    peak = Math.max(peak, absolute);
    sumSquares += sample * sample;
  }
  return {
    rms: sampleCount ? Math.sqrt(sumSquares / sampleCount) : 0,
    sampleCount,
    peak
  };
};

const transcribeOpenAI = async (logger, socket, {WebSocketImpl = WebSocket} = {}) => {
  const state = {
    provider: null,
    providerReady: false,
    closed: false,
    language: undefined,
    sampleRateHz: 8000,
    interimResults: true,
    pendingAudio: [],
    pendingBytes: 0,
    audioSinceCommit: 0,
    speechSeen: false,
    speechMs: 0,
    silenceMs: 0,
    currentTranscript: '',
    pendingCommitTranscripts: []
  };

  const sendToCognigy = (payload) => {
    if (socket.readyState === WebSocketImpl.OPEN) socket.send(JSON.stringify(payload));
  };

  const closeProvider = () => {
    if (!state.provider) return;
    state.provider.removeAllListeners();
    if (state.provider.readyState === WebSocketImpl.OPEN || state.provider.readyState === WebSocketImpl.CONNECTING) state.provider.close();
    state.provider = null;
    state.providerReady = false;
  };

  const closeSession = () => {
    if (state.closed) return;
    state.closed = true;
    closeProvider();
    if (socket.readyState === WebSocketImpl.OPEN || socket.readyState === WebSocketImpl.CONNECTING) socket.close();
  };

  const flushAudio = () => {
    if (!state.providerReady || !state.provider || state.provider.readyState !== WebSocketImpl.OPEN) return;
    for (const audio of state.pendingAudio) {
      state.provider.send(JSON.stringify({type: 'input_audio_buffer.append', audio: audio.toString('base64')}));
    }
    state.pendingAudio = [];
    state.pendingBytes = 0;
  };

  const commitTurn = () => {
    if (!state.providerReady || !state.provider || state.audioSinceCommit === 0 || !state.speechSeen) return;
    state.provider.send(JSON.stringify({type: 'input_audio_buffer.commit'}));
    state.pendingCommitTranscripts.push(state.currentTranscript);
    state.currentTranscript = '';
    state.audioSinceCommit = 0;
    state.speechSeen = false;
    state.speechMs = 0;
    state.silenceMs = 0;
  };

  const handleProviderMessage = (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch (error) {
      logger.error({error: error.message}, 'OpenAI STT returned invalid JSON');
      return;
    }
    if (event.type === 'session.updated') {
      state.providerReady = true;
      flushAudio();
      if (state.speechSeen && state.speechMs >= getMinSpeechMs() && state.silenceMs >= getSilenceMs()) commitTurn();
      logger.info({model: getModel(), operation: 'stt'}, 'OpenAI STT session ready');
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      state.currentTranscript += event.delta || '';
      if (state.interimResults && state.currentTranscript) sendToCognigy(createCognigyTranscription({transcript: state.currentTranscript, isFinal: false, language: state.language}));
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = event.transcript || state.currentTranscript || state.pendingCommitTranscripts.shift() || '';
      if (transcript) sendToCognigy(createCognigyTranscription({transcript, isFinal: true, language: state.language}));
      state.currentTranscript = '';
      logger.info({operation: 'stt', model: getModel(), language: state.language, transcriptLength: transcript.length}, 'OpenAI STT transcription completed');
      return;
    }
    if (event.type === 'error') logger.error({operation: 'stt', errorCode: event.error?.code || 'provider_error', errorType: event.error?.type || 'unknown'}, 'OpenAI STT provider error');
  };

  const openProvider = () => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.error({operation: 'stt', errorCode: 'not_configured'}, 'OpenAI STT is not configured');
      return closeSession();
    }
    const provider = new WebSocketImpl(getRealtimeUrl(), {
      headers: {Authorization: `Bearer ${apiKey}`},
      handshakeTimeout: Number(process.env.OPENAI_STT_TIMEOUT_MS) || 10000,
      maxPayload: MAX_PROVIDER_EVENT_BYTES
    });
    state.provider = provider;
    provider.on('open', () => provider.send(JSON.stringify(buildSessionUpdate({language: state.language, model: getModel()}))));
    provider.on('message', handleProviderMessage);
    provider.on('error', (error) => logger.error({operation: 'stt', errorCode: 'provider_connection', error: error.message}, 'OpenAI STT connection failed'));
    provider.on('close', () => {
      state.provider = null;
      state.providerReady = false;
      if (!state.closed) closeSession();
    });
  };

  const handleAudio = (data) => {
    if (data.length === 0 || data.length % 2 !== 0) return;
    if (data.length > MAX_AUDIO_CHUNK_BYTES) {
      logger.error({operation: 'stt', errorCode: 'audio_chunk_limit'}, 'OpenAI STT audio chunk limit exceeded');
      return closeSession();
    }
    const input = Buffer.from(data);
    const stats = getPcmStats(input);
    const durationMs = (stats.sampleCount / state.sampleRateHz) * 1000;
    const voiced = stats.rms >= getVadRms() || stats.peak >= getVadRms() * 3;
    if (voiced) {
      state.speechSeen = true;
      state.speechMs += durationMs;
      state.silenceMs = 0;
    } else if (state.speechSeen) state.silenceMs += durationMs;

    const audio = state.sampleRateHz === OPENAI_INPUT_RATE ? input : resamplePcm16Mono(input, state.sampleRateHz, OPENAI_INPUT_RATE);
    state.audioSinceCommit += audio.length;
    if (state.providerReady && state.provider && state.provider.readyState === WebSocketImpl.OPEN) {
      state.provider.send(JSON.stringify({type: 'input_audio_buffer.append', audio: audio.toString('base64')}));
    } else {
      state.pendingAudio.push(audio);
      state.pendingBytes += audio.length;
      if (state.pendingBytes > MAX_PENDING_AUDIO_BYTES) {
        logger.error({operation: 'stt', errorCode: 'audio_buffer_limit'}, 'OpenAI STT audio buffer limit exceeded');
        return closeSession();
      }
    }
    if (state.speechSeen && state.speechMs >= getMinSpeechMs() && state.silenceMs >= getSilenceMs()) commitTurn();
  };

  socket.on('message', (data, isBinary) => {
    try {
      if (!isBinary) {
        const message = JSON.parse(data.toString());
        if (message.type === 'start') {
          if (state.provider) throw new Error('STT start received more than once');
          state.language = normalizeLanguage(message.language);
          state.sampleRateHz = normalizeSampleRate(message.sampleRateHz);
          state.interimResults = message.interimResults !== false;
          logger.info({operation: 'stt', model: getModel(), language: state.language, sampleRateHz: state.sampleRateHz}, 'OpenAI STT starting');
          openProvider();
        } else if (message.type === 'stop') closeSession();
      } else if (state.provider) handleAudio(data);
    } catch (error) {
      logger.error({operation: 'stt', errorCode: 'invalid_request', error: error.message}, 'OpenAI STT request failed');
      closeSession();
    }
  });
  socket.on('error', (error) => logger.error({operation: 'stt', error: error.message}, 'Cognigy STT socket failed'));
  socket.on('close', closeSession);
  socket.on('end', closeSession);
};

module.exports = transcribeOpenAI;
module.exports.transcribeOpenAI = transcribeOpenAI;
module.exports.buildSessionUpdate = buildSessionUpdate;
module.exports.createCognigyTranscription = createCognigyTranscription;
module.exports.getPcmStats = getPcmStats;
