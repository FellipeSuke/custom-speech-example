const path = require('node:path');
const express = require('express');
const WebSocket = require('ws');
const {resamplePcm16Mono, createWavPcm16Mono} = require('../audio/pcm');
const {synthesizeText, prewarmLiveTtsConnection, closeWarmLiveTtsConnection} = require('../tts/openai');
const {buildSessionUpdate} = require('../stt/openai');
const {clearSessionCookie, createSession, getSessionSecret, requireAdmin, setSessionCookie} = require('./auth');
const {verifyPassword} = require('./store');
const {getOpenAiApiKeyStatus, readOpenAiApiKey, writeOpenAiApiKey} = require('../openai-config');

const TTS_OPTIONS = [
  {model: 'gpt-realtime-2.1', transport: 'realtime'},
  {model: 'gpt-realtime-2.1-mini', transport: 'realtime'},
  {model: 'gpt-live-1', transport: 'gpt_live'},
  {model: 'gpt-4o-mini-tts', transport: 'audio_speech'}
];
const STT_MODELS = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe'];
const TTS_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar', 'bossa', 'tempo'];
const SAFE_TEST_TEXT_LIMIT = 500;
const SAFE_LIVE_INSTRUCTIONS_LIMIT = 8000;
const SAFE_TTS_INSTRUCTIONS_LIMIT = 4000;
const LIVE_TEST_VOICES = ['bossa', 'tempo'];

const getPublicBaseUrl = (req) => {
  const configured = process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, '');
  if (configured) return configured;
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProto || (req.secure ? 'https' : 'http');
  return `${protocol}://${req.get('host')}`;
};

const getEndpointCatalog = (req) => {
  const adapterBase = getPublicBaseUrl(req);
  const adapterWsBase = adapterBase.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  const openaiBase = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const openaiRealtime = process.env.OPENAI_REALTIME_URL || 'wss://api.openai.com/v1/realtime';
  return [
    {name: 'TTS Cognigy (HTTP)', method: 'POST', url: `${adapterBase}/synthesize/openai`, authentication: 'Bearer Cognigy'},
    {name: 'STT Cognigy (WebSocket)', method: 'WebSocket', url: `${adapterWsBase}/transcribe/openai`, authentication: 'Bearer Cognigy'},
    {name: 'Health check', method: 'GET', url: `${adapterBase}/healthz`, authentication: 'none'},
    {name: 'Portal administrativo', method: 'GET', url: `${adapterBase}/admin`, authentication: 'admin session'},
    {name: 'OpenAI Responses (server-side)', method: 'POST', url: `${openaiBase}/responses`, authentication: 'server-side OpenAI key'},
    {name: 'OpenAI STT (server-side)', method: 'POST', url: `${openaiBase}/audio/transcriptions`, authentication: 'server-side OpenAI key'},
    {name: 'OpenAI TTS (server-side)', method: 'POST', url: `${openaiBase}/audio/speech`, authentication: 'server-side OpenAI key'},
    {name: 'OpenAI Realtime (server-side)', method: 'WebSocket', url: openaiRealtime, authentication: 'server-side OpenAI key'},
    {name: 'OpenAI GPT-Live (server-side)', method: 'WebSocket', url: 'wss://api.openai.com/v1/live/sessions', authentication: 'server-side OpenAI key'}
  ];
};

const findTtsOption = (model, transport) => TTS_OPTIONS.find((option) => option.model === model && option.transport === transport);
const getStore = (req) => req.app.locals.adminStore;
const requireStore = (req, res, next) => getStore(req) ? next() : res.status(503).json({error: 'Admin storage is not configured'});

const GPT_LIVE_GREETING = 'Cumprimente a pessoa agora em português brasileiro, diga brevemente que esta é uma chamada direta de teste do GPT-Live e pergunte como pode ajudar. Depois, pare de falar e escute.';

const createGptLiveSession = async ({apiKey, sdp, instructions, voice, speakFirst = false, fetchImpl = fetch, timeoutMs = 30000}) => {
  if (!apiKey) throw new Error('OpenAI is not configured');
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/live/sessions`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        session: {
          model: 'gpt-live-1', instructions, audio: {output: {voice}}, store: false,
          ...(speakFirst ? {input: [{type: 'message', role: 'developer', content: [{type: 'input_text', text: GPT_LIVE_GREETING}]}]} : {})
        },
        transport: {type: 'webrtc', sdp}
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error('GPT-Live session creation failed');
    const result = await response.json();
    const answerSdp = result?.transport?.sdp;
    if (typeof answerSdp !== 'string' || !answerSdp.trim()) throw new Error('GPT-Live response was invalid');
    return {sdp: answerSdp};
  } finally {
    clearTimeout(timeout);
  }
};

const runSyntheticSttTest = ({apiKey, model, pcm, sampleRate, language = 'pt-BR', timeoutMs = 15000, WebSocketImpl = WebSocket}) => new Promise((resolve, reject) => {
  if (!apiKey) return reject(new Error('OpenAI is not configured'));
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/^http/i, 'ws').replace(/\/$/, '');
  const startedAt = process.hrtime.bigint();
  const audio = resamplePcm16Mono(pcm, sampleRate, 24000);
  let settled = false;
  let providerReadyMs;
  let transcriptLength = 0;
  let ws;
  const timer = setTimeout(() => finish(new Error('STT test timed out')), timeoutMs);
  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    ws?.removeAllListeners();
    if (ws && (ws.readyState === WebSocketImpl.OPEN || ws.readyState === WebSocketImpl.CONNECTING)) ws.close();
    if (error) return reject(error);
    resolve(result);
  };
  try {
    ws = new WebSocketImpl(`${base}/realtime?intent=transcription`, {headers: {Authorization: `Bearer ${apiKey}`}, handshakeTimeout: timeoutMs, maxPayload: 1024 * 1024});
  } catch {
    return finish(new Error('STT connection failed'));
  }
  ws.on('open', () => ws.send(JSON.stringify(buildSessionUpdate({model, language}))));
  ws.on('message', (raw) => {
    let event;
    try { event = JSON.parse(raw.toString()); } catch { return finish(new Error('STT provider protocol failed')); }
    if (event.type === 'error') return finish(new Error('STT provider request failed'));
    if (event.type === 'session.updated') {
      providerReadyMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
      ws.send(JSON.stringify({type: 'input_audio_buffer.append', audio: audio.toString('base64')}));
      ws.send(JSON.stringify({type: 'input_audio_buffer.commit'}));
    }
    if (event.type === 'conversation.item.input_audio_transcription.delta') transcriptLength += String(event.delta || '').length;
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = String(event.transcript || '');
      transcriptLength = Math.max(transcriptLength, transcript.length);
      finish(null, {providerReadyMs, completedMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6), transcriptLength});
    }
  });
  ws.on('error', () => finish(new Error('STT connection failed')));
  ws.on('close', () => { if (!settled) finish(new Error('STT connection closed before completion')); });
});

const router = express.Router();

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  return next();
});

router.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

router.post('/api/login', (req, res) => {
  const secret = getSessionSecret();
  if (!getStore(req)) return res.status(503).json({error: 'Admin storage is not configured'});
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = secret ? getStore(req).getAdminUser(username) : null;
  if (!secret || !user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({error: 'Invalid credentials'});
  }
  getStore(req).addAuditEvent('admin_login', username);
  setSessionCookie(res, createSession(username, secret));
  return res.json({ok: true});
});

router.use('/api', requireStore, requireAdmin);

router.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  getStore(req).addAuditEvent('admin_logout', req.adminSession.username);
  res.json({ok: true});
});

router.get('/api/config', (req, res) => {
  const settings = getStore(req).getSettings();
  res.json({
    settings,
    openai: getOpenAiApiKeyStatus(),
    endpoints: getEndpointCatalog(req),
    ttsOptions: TTS_OPTIONS,
    sttModels: STT_MODELS,
    voices: VOICES,
    streaming: process.env.TTS_STREAMING_ENABLED === 'true'
  });
});

router.post('/api/openai-key', (req, res) => {
  try {
    writeOpenAiApiKey(req.body?.apiKey);
    getStore(req).addAuditEvent('openai_key_updated', req.adminSession.username);
    if (process.env.TTS_STREAMING_ENABLED === 'true' && getStore(req).getSettings().tts_transport === 'gpt_live') prewarmLiveTtsConnection().catch(() => {});
    else closeWarmLiveTtsConnection();
    return res.json({ok: true, openai: getOpenAiApiKeyStatus()});
  } catch {
    return res.status(400).json({error: 'Invalid OpenAI API key'});
  }
});

router.put('/api/config', (req, res) => {
  const body = req.body || {};
  const current = getStore(req).getSettings();
  const next = {
    tts_model: body.tts_model === undefined ? current.tts_model : String(body.tts_model),
    tts_transport: body.tts_transport === undefined ? current.tts_transport : String(body.tts_transport),
    tts_reasoning_effort: body.tts_reasoning_effort === undefined ? current.tts_reasoning_effort : String(body.tts_reasoning_effort),
    tts_voice: body.tts_voice === undefined ? current.tts_voice : String(body.tts_voice),
    stt_model: body.stt_model === undefined ? current.stt_model : String(body.stt_model),
    tts_reading_instructions: body.tts_reading_instructions === undefined ? current.tts_reading_instructions : String(body.tts_reading_instructions).trim()
  };
  const liveVoice = ['bossa', 'tempo'].includes(next.tts_voice);
  if (!findTtsOption(next.tts_model, next.tts_transport) || !TTS_REASONING_EFFORTS.includes(next.tts_reasoning_effort) || !VOICES.includes(next.tts_voice) || (next.tts_transport === 'gpt_live') !== liveVoice || !STT_MODELS.includes(next.stt_model)) {
    return res.status(400).json({error: 'Unsupported speech configuration'});
  }
  if (!next.tts_reading_instructions || next.tts_reading_instructions.length > SAFE_TTS_INSTRUCTIONS_LIMIT) return res.status(400).json({error: 'TTS instructions must contain 1 to 4000 characters'});
  const settings = getStore(req).updateSettings(next);
  getStore(req).addAuditEvent('speech_config_updated', req.adminSession.username);
  if (process.env.TTS_STREAMING_ENABLED === 'true' && settings.tts_transport === 'gpt_live') prewarmLiveTtsConnection().catch(() => {});
  else closeWarmLiveTtsConnection();
  return res.json({settings});
});

router.get('/api/tokens', (req, res) => res.json({tokens: getStore(req).listSpeechTokens()}));

router.post('/api/tokens', (req, res) => {
  const label = typeof req.body?.label === 'string' && req.body.label.trim() ? req.body.label.trim() : 'Cognigy';
  const created = getStore(req).createSpeechToken(label);
  getStore(req).addAuditEvent('speech_token_created', req.adminSession.username);
  return res.status(201).json(created);
});

router.post('/api/tokens/:id/revoke', (req, res) => {
  const revoked = getStore(req).revokeSpeechToken(req.params.id);
  if (!revoked) return res.status(404).json({error: 'Token not found'});
  getStore(req).addAuditEvent('speech_token_revoked', req.adminSession.username);
  return res.json({ok: true});
});

router.post('/api/tests/tts', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text || text.length > SAFE_TEST_TEXT_LIMIT) return res.status(400).json({error: 'Test text must contain 1 to 500 characters'});
  const savedSettings = getStore(req).getSettings();
  const settings = {
    tts_model: req.body?.tts_model === undefined ? savedSettings.tts_model : String(req.body.tts_model),
    tts_transport: req.body?.tts_transport === undefined ? savedSettings.tts_transport : String(req.body.tts_transport),
    tts_voice: req.body?.tts_voice === undefined ? savedSettings.tts_voice : String(req.body.tts_voice),
    tts_reasoning_effort: req.body?.tts_reasoning_effort === undefined ? savedSettings.tts_reasoning_effort : String(req.body.tts_reasoning_effort)
  };
  const testVoiceIsLive = ['bossa', 'tempo'].includes(settings.tts_voice);
  if (!findTtsOption(settings.tts_model, settings.tts_transport) || !VOICES.includes(settings.tts_voice) || (settings.tts_transport === 'gpt_live') !== testVoiceIsLive || !TTS_REASONING_EFFORTS.includes(settings.tts_reasoning_effort)) {
    return res.status(400).json({error: 'Unsupported speech configuration'});
  }
  const startedAt = process.hrtime.bigint();
  let firstAudioMs;
  try {
    const result = await synthesizeText({
      text,
      model: settings.tts_model,
      transport: settings.tts_transport,
      voice: settings.tts_voice,
      reasoningEffort: settings.tts_reasoning_effort,
      readingInstructions: savedSettings.tts_reading_instructions,
      language: 'pt-BR',
      onFirstAudio: (value) => { firstAudioMs = value; }
    });
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    getStore(req).addAuditEvent('tts_test_completed', req.adminSession.username);
    const previewPcm = resamplePcm16Mono(result.pcm, result.sampleRate || 24000, 8000);
    const previewWav = createWavPcm16Mono(previewPcm, 8000);
    return res.json({ok: true, model: settings.tts_model, transport: settings.tts_transport, firstAudioMs: Math.round(firstAudioMs || result.firstAudioMs || 0), durationMs: Math.round(durationMs), bytes: result.pcm.length, previewAudio: previewWav.toString('base64')});
  } catch (error) {
    getStore(req).addAuditEvent('tts_test_failed', req.adminSession.username);
    return res.status(502).json({ok: false, error: 'TTS test failed'});
  }
});

router.post('/api/tests/gpt-live/session', async (req, res) => {
  const sdp = typeof req.body?.sdp === 'string' ? req.body.sdp : '';
  const instructions = typeof req.body?.instructions === 'string' ? req.body.instructions.trim() : '';
  const voice = typeof req.body?.voice === 'string' ? req.body.voice : '';
  const speakFirst = req.body?.speakFirst === true;
  if (!sdp.trim() || sdp.length > 100000 || !instructions || instructions.length > SAFE_LIVE_INSTRUCTIONS_LIMIT || !LIVE_TEST_VOICES.includes(voice) || (req.body?.speakFirst !== undefined && typeof req.body.speakFirst !== 'boolean')) {
    return res.status(400).json({error: 'Invalid GPT-Live test configuration'});
  }
  try {
    const result = await createGptLiveSession({apiKey: readOpenAiApiKey(), sdp, instructions, voice, speakFirst});
    getStore(req).addAuditEvent('gpt_live_direct_test_started', req.adminSession.username);
    return res.status(201).json(result);
  } catch {
    getStore(req).addAuditEvent('gpt_live_direct_test_failed', req.adminSession.username);
    return res.status(502).json({error: 'GPT-Live test could not be started'});
  }
});

router.post('/api/tests/stt', async (req, res) => {
  const settings = getStore(req).getSettings();
  const syntheticText = 'Este é um teste sintético do reconhecimento de fala.';
  try {
    const tts = await synthesizeText({
      text: syntheticText,
      model: settings.tts_model,
      transport: settings.tts_transport,
      voice: settings.tts_voice,
      reasoningEffort: settings.tts_reasoning_effort,
      readingInstructions: settings.tts_reading_instructions,
      language: 'pt-BR'
    });
    const result = await runSyntheticSttTest({apiKey: readOpenAiApiKey(), model: settings.stt_model, pcm: tts.pcm, sampleRate: tts.sampleRate || 24000});
    getStore(req).addAuditEvent('stt_test_completed', req.adminSession.username);
    return res.json({ok: true, model: settings.stt_model, ttsModel: settings.tts_model, providerReadyMs: result.providerReadyMs, completedMs: result.completedMs, transcriptReceived: result.transcriptLength > 0, transcriptLength: result.transcriptLength});
  } catch {
    getStore(req).addAuditEvent('stt_test_failed', req.adminSession.username);
    return res.status(502).json({ok: false, error: 'STT test failed'});
  }
});

module.exports = router;
module.exports.runSyntheticSttTest = runSyntheticSttTest;
module.exports.createGptLiveSession = createGptLiveSession;
module.exports.GPT_LIVE_GREETING = GPT_LIVE_GREETING;
