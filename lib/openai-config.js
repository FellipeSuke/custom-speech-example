const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_KEY_FILE = path.join(process.cwd(), 'data', 'openai-api-key');
const MAX_KEY_LENGTH = 512;

const getOpenAiApiKeyFile = () => process.env.OPENAI_API_KEY_FILE
  || (process.env.ADMIN_DB_PATH ? path.join(path.dirname(process.env.ADMIN_DB_PATH), 'openai-api-key') : DEFAULT_KEY_FILE);

const readManagedKey = () => {
  try {
    const value = fs.readFileSync(getOpenAiApiKeyFile(), 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
};

const readOpenAiApiKey = () => readManagedKey() || process.env.OPENAI_API_KEY || null;

const validateOpenAiApiKey = (value) => {
  if (typeof value !== 'string') return false;
  const key = value.trim();
  return key.startsWith('sk-') && key.length <= MAX_KEY_LENGTH && !/\s/.test(key);
};

const writeOpenAiApiKey = (value) => {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!validateOpenAiApiKey(key)) throw new Error('Invalid OpenAI API key');
  const filePath = getOpenAiApiKeyFile();
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const temporaryPath = `${filePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${key}\n`, {encoding: 'utf8', mode: 0o600});
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
};

const getOpenAiApiKeyStatus = () => ({
  configured: Boolean(readOpenAiApiKey()),
  source: readManagedKey() ? 'managed_file' : process.env.OPENAI_API_KEY ? 'environment' : 'not_configured',
  storage: 'server_side'
});

module.exports = {getOpenAiApiKeyFile, getOpenAiApiKeyStatus, readOpenAiApiKey, validateOpenAiApiKey, writeOpenAiApiKey};
