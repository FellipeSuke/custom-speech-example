const path = require('node:path');
const express = require('express');
const WebSocket = require('ws');
const {resamplePcm16Mono} = require('../audio/pcm');
const {synthesizeText} = require('../tts/openai');
const {buildSessionUpdate} = require('../stt/openai');
const {clearSessionCookie, createSession, getSessionSecret, requireAdmin, setSessionCookie} = require('./auth');
const {verifyPassword} = require('./store');

const TTS_OPTIONS = [
  {model: 'gpt-realtime-2.1', transport: 'realtime'},
  {model: 'gpt-realtime-2.1-mini', transport: 'realtime'},
  {model: 'gpt-4o-mini-tts', transport: 'audio_speech'}
];
const STT_MODELS = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe'];
const TTS_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const SAFE_TEST_TEXT_LIMIT = 500;

const findTtsOption = (model, transport) => TTS_OPTIONS.find((option) => option.model === model && option.transport === transport);
const getStore = (req) => req.app.locals.adminStore;
const requireStore = (req, res, next) => getStore(req) ? next() : res.status(503).json({error: 'Admin storage is not configured'});

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
    ttsOptions: TTS_OPTIONS,
    sttModels: STT_MODELS,
    voices: VOICES,
    streaming: process.env.TTS_STREAMING_ENABLED === 'true'
  });
});

router.put('/api/config', (req, res) => {
  const body = req.body || {};
  const current = getStore(req).getSettings();
  const next = {
    tts_model: body.tts_model === undefined ? current.tts_model : String(body.tts_model),
    tts_transport: body.tts_transport === undefined ? current.tts_transport : String(body.tts_transport),
    tts_reasoning_effort: body.tts_reasoning_effort === undefined ? current.tts_reasoning_effort : String(body.tts_reasoning_effort),
    tts_voice: body.tts_voice === undefined ? current.tts_voice : String(body.tts_voice),
    stt_model: body.stt_model === undefined ? current.stt_model : String(body.stt_model)
  };
  if (!findTtsOption(next.tts_model, next.tts_transport) || !TTS_REASONING_EFFORTS.includes(next.tts_reasoning_effort) || !VOICES.includes(next.tts_voice) || !STT_MODELS.includes(next.stt_model)) {
    return res.status(400).json({error: 'Unsupported speech configuration'});
  }
  const settings = getStore(req).updateSettings(next);
  getStore(req).addAuditEvent('speech_config_updated', req.adminSession.username);
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
  const settings = getStore(req).getSettings();
  const startedAt = process.hrtime.bigint();
  let firstAudioMs;
  try {
    const result = await synthesizeText({
      text,
      model: settings.tts_model,
      transport: settings.tts_transport,
      voice: settings.tts_voice,
      reasoningEffort: settings.tts_reasoning_effort,
      onFirstAudio: (value) => { firstAudioMs = value; }
    });
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    getStore(req).addAuditEvent('tts_test_completed', req.adminSession.username);
    return res.json({ok: true, model: settings.tts_model, transport: settings.tts_transport, firstAudioMs: Math.round(firstAudioMs || result.firstAudioMs || 0), durationMs: Math.round(durationMs), bytes: result.pcm.length});
  } catch (error) {
    getStore(req).addAuditEvent('tts_test_failed', req.adminSession.username);
    return res.status(502).json({ok: false, error: 'TTS test failed'});
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
      reasoningEffort: settings.tts_reasoning_effort
    });
    const result = await runSyntheticSttTest({apiKey: process.env.OPENAI_API_KEY, model: settings.stt_model, pcm: tts.pcm, sampleRate: tts.sampleRate || 24000});
    getStore(req).addAuditEvent('stt_test_completed', req.adminSession.username);
    return res.json({ok: true, model: settings.stt_model, ttsModel: settings.tts_model, providerReadyMs: result.providerReadyMs, completedMs: result.completedMs, transcriptReceived: result.transcriptLength > 0, transcriptLength: result.transcriptLength});
  } catch {
    getStore(req).addAuditEvent('stt_test_failed', req.adminSession.username);
    return res.status(502).json({ok: false, error: 'STT test failed'});
  }
});

module.exports = router;
module.exports.runSyntheticSttTest = runSyntheticSttTest;
