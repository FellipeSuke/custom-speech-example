const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  Database = null;
}

const DEFAULT_SETTINGS = {
  tts_model: process.env.OPENAI_TTS_MODEL || 'gpt-realtime-2.1',
  tts_transport: process.env.OPENAI_TTS_TRANSPORT || 'realtime',
  tts_reasoning_effort: process.env.OPENAI_TTS_REASONING_EFFORT || 'minimal',
  tts_voice: process.env.OPENAI_TTS_VOICE || 'marin',
  stt_model: process.env.OPENAI_STT_MODEL || 'gpt-4o-mini-transcribe'
};

const hashToken = (token) => crypto.createHash('sha256').update(token).digest();

const hashPassword = (password) => {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64, {N: 16384, r: 8, p: 1});
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
};

const verifyPassword = (password, encoded) => {
  try {
    if (typeof password !== 'string' || typeof encoded !== 'string') return false;
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltText, digestText] = parts;
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(digestText, 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length, {N: Number(n), r: Number(r), p: Number(p)});
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
};

class AdminStore {
  constructor(dbPath = process.env.ADMIN_DB_PATH || path.join(process.cwd(), 'data', 'speech-adapter.sqlite')) {
    if (!Database) throw new Error('SQLite driver is unavailable');
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), {recursive: true, mode: 0o700});
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initialize();
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS speech_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash BLOB NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    const insertSetting = this.db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
    const now = new Date().toISOString();
    const seedSettings = this.db.transaction(() => {
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(key, String(value), now);
    });
    seedSettings();

    const username = process.env.ADMIN_USERNAME || 'admin';
    const passwordHash = process.env.ADMIN_PASSWORD_HASH;
    if (passwordHash && !this.db.prepare('SELECT 1 FROM admin_users LIMIT 1').get()) {
      this.db.prepare('INSERT INTO admin_users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(username, passwordHash, now, now);
    }
  }

  getSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    return rows.reduce((settings, row) => ({...settings, [row.key]: row.value}), {...DEFAULT_SETTINGS});
  }

  updateSettings(values) {
    const now = new Date().toISOString();
    const update = this.db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
    const save = this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) update.run(key, String(value), now);
    });
    save();
    return this.getSettings();
  }

  getAdminUser(username) {
    return this.db.prepare('SELECT username, password_hash FROM admin_users WHERE username = ?').get(username);
  }

  setAdminPassword(username, password) {
    if (typeof username !== 'string' || !username.trim()) throw new Error('Admin username is required');
    if (typeof password !== 'string' || password.length < 12) throw new Error('Admin password must be at least 12 characters');
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO admin_users (username, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at
    `).run(username.trim(), hashPassword(password), now, now);
  }

  createSpeechToken(label = 'Cognigy') {
    const token = `cgv_${crypto.randomBytes(32).toString('base64url')}`;
    const now = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO speech_tokens (token_hash, token_prefix, label, created_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), token.slice(0, 12), String(label).slice(0, 80) || 'Cognigy', now);
    return {id: Number(result.lastInsertRowid), token, prefix: token.slice(0, 12), createdAt: now};
  }

  listSpeechTokens() {
    return this.db.prepare('SELECT id, token_prefix AS prefix, label, created_at AS createdAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt FROM speech_tokens ORDER BY id DESC').all();
  }

  revokeSpeechToken(id) {
    const result = this.db.prepare('UPDATE speech_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(new Date().toISOString(), Number(id));
    return result.changes === 1;
  }

  validateSpeechToken(token) {
    if (typeof token !== 'string' || !token) return false;
    const actual = hashToken(token);
    const rows = this.db.prepare('SELECT id, token_hash FROM speech_tokens WHERE revoked_at IS NULL').all();
    for (const row of rows) {
      const expected = Buffer.from(row.token_hash);
      if (actual.length === expected.length && crypto.timingSafeEqual(actual, expected)) {
        this.db.prepare('UPDATE speech_tokens SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
        return true;
      }
    }
    return false;
  }

  addAuditEvent(event, actor = 'system') {
    this.db.prepare('INSERT INTO audit_events (event, actor, created_at) VALUES (?, ?, ?)')
      .run(String(event).slice(0, 100), String(actor).slice(0, 100), new Date().toISOString());
  }

  close() {
    this.db.close();
  }
}

module.exports = {AdminStore, hashPassword, verifyPassword};
