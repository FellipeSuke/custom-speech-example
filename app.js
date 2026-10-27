const express = require('express');
const crypto = require('node:crypto');
const dns = require('node:dns');
const Websocket = require('ws');
const adminRoutes = require('./lib/admin/routes');
const {readOpenAiApiKey} = require('./lib/openai-config');
const {prewarmLiveTtsConnection, closeWarmLiveTtsConnection} = require('./lib/tts/openai');
dns.setDefaultResultOrder('ipv4first');
const opts = Object.assign({level: process.env.LOGLEVEL || 'info'});
const logger = require('pino')(opts);
const routes = require('./lib/tts');
const MAX_COGNIGY_WS_MESSAGE_BYTES = 256 * 1024;

const getExpectedApiKey = () => process.env.COGNIGY_SPEECH_TOKEN || process.env.API_KEY;

const getBearerValue = (hdr) => {
  if (typeof hdr !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(hdr.trim());
  return match?.[1]?.trim() || null;
};

const isValidApiKey = (hdr, apiKey = getExpectedApiKey()) => {
  if (typeof apiKey !== 'string' || !apiKey) return false;
  const value = getBearerValue(hdr);
  if (!value) return false;
  const actual = Buffer.from(value);
  const expected = Buffer.from(apiKey);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

const isValidSpeechAuth = (hdr, store) => isValidApiKey(hdr) || Boolean(store?.validateSpeechToken(getBearerValue(hdr)));

const verifyApiKey = (req, res, next) => {
  if (!isValidSpeechAuth(req.headers.authorization, req.app.locals.adminStore)) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
};

const createApp = ({adminStore = process.env.ADMIN_DB_PATH ? new (require('./lib/admin/store').AdminStore)() : null} = {}) => {
  const app = express();
  app.disable('x-powered-by');
  app.locals = {...app.locals, logger, adminStore, getRuntimeConfig: () => adminStore?.getSettings() || {}};

  app.get('/healthz', (req, res) => res.json({
    status: 'ok',
    openaiConfigured: Boolean(readOpenAiApiKey()),
    openaiConnectivity: 'not_checked'
  }));

  app.use(express.urlencoded({ extended: true, limit: process.env.HTTP_BODY_LIMIT || '128kb' }));
  app.use(express.json({ limit: process.env.HTTP_BODY_LIMIT || '128kb' }));
  app.use('/admin', adminRoutes);
  app.use('/synthesize', verifyApiKey, routes);
  app.use((err, req, res, next) => {
    logger.error({err: err.message}, 'request failed');
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({message: 'Internal server error'});
  });
  return app;
};

const createServer = ({app = createApp(), port = process.env.HTTP_PORT || 3000} = {}) => {
  const transcribe = require('./lib/stt/');
  const transcribeWsServer = new Websocket.Server({ noServer: true, maxPayload: MAX_COGNIGY_WS_MESSAGE_BYTES });
  transcribeWsServer.setMaxListeners(0);
  transcribeWsServer.on('connection', transcribe.bind(null, logger));

  const server = app.listen(port, () => {
    logger.info('Example Cognigy Voice Gateway speech server listening');
  });

  server.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n', () => socket.destroy());
      return;
    }

    if (!pathname.startsWith('/transcribe/')) {
      return socket.write('HTTP/1.1 404 Not Found\r\n\r\n', () => socket.destroy());
    }

    if (!isValidSpeechAuth(request.headers.authorization, app.locals.adminStore)) {
      return socket.write('HTTP/1.1 403 Forbidden\r\n\r\n', () => socket.destroy());
    }

    transcribeWsServer.handleUpgrade(request, socket, head, (ws) => {
      transcribeWsServer.emit('connection', ws, request.url, app.locals.getRuntimeConfig());
    });
  });

  server.closeSpeechSockets = () => {
    for (const socket of transcribeWsServer.clients) socket.close(1012, 'Service restart');
    const forceCloseTimer = setTimeout(() => {
      for (const socket of transcribeWsServer.clients) socket.terminate();
    }, 15000);
    forceCloseTimer.unref();
  };

  return server;
};

if (require.main === module) {
  const app = createApp();
  const server = createServer({app});
  const settings = app.locals.getRuntimeConfig();
  if (process.env.TTS_STREAMING_ENABLED === 'true' && settings.tts_transport === 'gpt_live' && settings.tts_model === 'gpt-live-1') prewarmLiveTtsConnection().catch(() => {});
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({signal}, 'Speech adapter shutting down');
    closeWarmLiveTtsConnection();
    server.closeSpeechSockets();
    server.close((error) => {
      if (error) {
        logger.error({error: error.message}, 'Speech adapter shutdown failed');
        process.exitCode = 1;
      }
    });
    setTimeout(() => server.closeAllConnections?.(), 25000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {createApp, createServer, isValidApiKey};
