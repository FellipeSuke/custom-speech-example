const express = require('express');
const crypto = require('node:crypto');
const dns = require('node:dns');
const Websocket = require('ws');
dns.setDefaultResultOrder('ipv4first');
const opts = Object.assign({level: process.env.LOGLEVEL || 'info'});
const logger = require('pino')(opts);
const routes = require('./lib/tts');
const MAX_COGNIGY_WS_MESSAGE_BYTES = 256 * 1024;

const getExpectedApiKey = () => process.env.COGNIGY_SPEECH_TOKEN || process.env.API_KEY;

const isValidApiKey = (hdr, apiKey = getExpectedApiKey()) => {
  if (typeof hdr !== 'string' || typeof apiKey !== 'string' || !apiKey) return false;
  const match = /^Bearer\s+(.+)$/i.exec(hdr.trim());
  if (!match || !match[1].trim()) return false;
  const actual = Buffer.from(match[1].trim());
  const expected = Buffer.from(apiKey);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
};

const verifyApiKey = (req, res, next) => {
  if (!isValidApiKey(req.headers.authorization)) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
};

const createApp = () => {
  const app = express();
  app.disable('x-powered-by');
  app.locals = {...app.locals, logger};

  app.get('/healthz', (req, res) => res.json({
    status: 'ok',
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    openaiConnectivity: 'not_checked'
  }));

  app.use(express.urlencoded({ extended: true, limit: process.env.HTTP_BODY_LIMIT || '128kb' }));
  app.use(express.json({ limit: process.env.HTTP_BODY_LIMIT || '128kb' }));
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

    if (!isValidApiKey(request.headers.authorization)) {
      return socket.write('HTTP/1.1 403 Forbidden\r\n\r\n', () => socket.destroy());
    }

    transcribeWsServer.handleUpgrade(request, socket, head, (ws) => {
      transcribeWsServer.emit('connection', ws, request.url);
    });
  });

  return server;
};

if (require.main === module) createServer();

module.exports = {createApp, createServer, isValidApiKey};
