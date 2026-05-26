import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { compactText, normalizeText, splitKeywords } from './shared.js';

const require = createRequire(import.meta.url);

export async function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({
    locateFile: () => wasmPath
  });
  const exists = fs.existsSync(dbPath);
  const db = exists ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
  return new SqlStore(db, dbPath);
}

class SqlStore {
  constructor(db, filePath) {
    this.db = db;
    this.filePath = filePath;
    this.dirty = false;
    this.ensureSchema();
  }

  ensureSchema() {
    this.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY,
        chat_title TEXT NOT NULL,
        chat_title_norm TEXT NOT NULL,
        is_group INTEGER NOT NULL DEFAULT 0,
        chat_type TEXT NOT NULL DEFAULT 'private',
        alias TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'wx',
        message_count INTEGER NOT NULL DEFAULT 0,
        leave_hits INTEGER NOT NULL DEFAULT 0,
        last_message_at INTEGER NOT NULL DEFAULT 0,
        last_message_preview TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS messages (
        message_key TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        chat_title TEXT NOT NULL,
        chat_title_norm TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        is_group INTEGER NOT NULL DEFAULT 0,
        sender TEXT NOT NULL DEFAULT '',
        sender_username TEXT NOT NULL DEFAULT '',
        sender_display TEXT NOT NULL DEFAULT '',
        sender_norm TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        content_norm TEXT NOT NULL,
        message_type TEXT NOT NULL DEFAULT 'text',
        ts INTEGER NOT NULL,
        time_text TEXT NOT NULL,
        local_id TEXT NOT NULL DEFAULT '',
        raw_json TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'wx'
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_norm);
      CREATE INDEX IF NOT EXISTS idx_messages_title ON messages(chat_title_norm);

      CREATE TABLE IF NOT EXISTS sync_state (
        chat_id TEXT PRIMARY KEY,
        chat_title TEXT NOT NULL,
        last_synced_at INTEGER NOT NULL DEFAULT 0,
        last_message_at INTEGER NOT NULL DEFAULT 0,
        last_mode TEXT NOT NULL DEFAULT 'quick',
        last_offset INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS leave_events (
        message_key TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        chat_title TEXT NOT NULL,
        sender TEXT NOT NULL DEFAULT '',
        keyword TEXT NOT NULL,
        ts INTEGER NOT NULL,
        day TEXT NOT NULL
      );
    `);
  }

  exec(sql) {
    this.db.exec(sql);
    this.dirty = true;
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  one(sql, params = []) {
    return this.all(sql, params)[0] || null;
  }

  run(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.run(params);
    stmt.free();
    this.dirty = true;
  }

  transaction(fn) {
    this.exec('BEGIN');
    try {
      const result = fn();
      this.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.exec('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw error;
    }
  }

  save() {
    if (!this.dirty) return;
    const data = this.db.export();
    fs.writeFileSync(this.filePath, Buffer.from(data));
    this.dirty = false;
  }

  close() {
    this.save();
    this.db.close();
  }

  getSettingsMap() {
    const rows = this.all('SELECT key, value FROM settings');
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  setSetting(key, value) {
    this.run(
      'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, String(value)]
    );
  }

  getSetting(key, fallback = null) {
    const row = this.one('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? row.value : fallback;
  }

  upsertChat(chat) {
    this.run(
      `INSERT INTO chats(
        chat_id, chat_title, chat_title_norm, is_group, chat_type, alias, source,
        message_count, leave_hits, last_message_at, last_message_preview, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        chat_title = excluded.chat_title,
        chat_title_norm = excluded.chat_title_norm,
        is_group = excluded.is_group,
        chat_type = excluded.chat_type,
        alias = excluded.alias,
        source = excluded.source,
        updated_at = excluded.updated_at
      `,
      [
        chat.chat_id,
        chat.chat_title,
        normalizeText(chat.chat_title),
        chat.is_group ? 1 : 0,
        chat.chat_type || (chat.is_group ? 'group' : 'private'),
        chat.alias || '',
        chat.source || 'wx',
        chat.message_count ?? 0,
        chat.leave_hits ?? 0,
        chat.last_message_at ?? 0,
        chat.last_message_preview || '',
        Date.now()
      ]
    );
  }

  upsertMessage(message) {
    const params = [
      message.message_key,
      message.chat_id,
      message.chat_title,
      normalizeText(message.chat_title),
      message.chat_type || (message.is_group ? 'group' : 'private'),
      message.is_group ? 1 : 0,
      message.sender || '',
      message.sender_username || '',
      message.sender_display || message.sender || '',
      compactText(message.sender_display || message.sender || ''),
      message.content || '',
      compactText(message.content || ''),
      message.message_type || 'text',
      Number(message.ts || 0),
      message.time_text || '',
      String(message.local_id || ''),
      JSON.stringify(message.raw_json || {}),
      message.source || 'wx'
    ];

    const existing = this.one('SELECT message_key FROM messages WHERE message_key = ?', [message.message_key]);
    if (existing) {
      this.run(
        `UPDATE messages SET
          chat_id = ?, chat_title = ?, chat_title_norm = ?, chat_type = ?, is_group = ?,
          sender = ?, sender_username = ?, sender_display = ?, sender_norm = ?,
          content = ?, content_norm = ?, message_type = ?, ts = ?, time_text = ?,
          local_id = ?, raw_json = ?, source = ?
         WHERE message_key = ?`,
        [...params.slice(1), params[0]]
      );
      return false;
    }
    this.run(
      `INSERT INTO messages(
        message_key, chat_id, chat_title, chat_title_norm, chat_type, is_group,
        sender, sender_username, sender_display, sender_norm,
        content, content_norm, message_type, ts, time_text, local_id, raw_json, source
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params
    );
    return true;
  }

  updateChatCounters(chatId, { lastMessageAt, lastPreview, deltaCount = 1 }) {
    this.run(
      `UPDATE chats
       SET message_count = message_count + ?,
           last_message_at = MAX(last_message_at, ?),
           last_message_preview = ?,
           updated_at = ?
       WHERE chat_id = ?`,
      [deltaCount, Number(lastMessageAt || 0), lastPreview || '', Date.now(), chatId]
    );
  }

  upsertSyncState(chatId, chatTitle, state) {
    this.run(
      `INSERT INTO sync_state(chat_id, chat_title, last_synced_at, last_message_at, last_mode, last_offset, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         chat_title = excluded.chat_title,
         last_synced_at = excluded.last_synced_at,
         last_message_at = excluded.last_message_at,
         last_mode = excluded.last_mode,
         last_offset = excluded.last_offset,
         updated_at = excluded.updated_at`,
      [
        chatId,
        chatTitle,
        Number(state.last_synced_at || 0),
        Number(state.last_message_at || 0),
        state.last_mode || 'quick',
        Number(state.last_offset || 0),
        Date.now()
      ]
    );
  }

  getChatSyncState(chatId) {
    return this.one('SELECT * FROM sync_state WHERE chat_id = ?', [chatId]);
  }

  rebuildLeaveEvents(keywords) {
    this.run('DELETE FROM leave_events');
    const active = splitKeywords(keywords);
    if (!active.length) return 0;
    const messages = this.all("SELECT message_key, chat_id, chat_title, sender, content, ts FROM messages WHERE message_type = 'text' OR message_type = '文本' ORDER BY ts ASC");
    let count = 0;
    for (const message of messages) {
      const hits = active.filter((keyword) => String(message.content || '').includes(keyword));
      for (const keyword of hits) {
        this.run(
          'INSERT OR REPLACE INTO leave_events(message_key, chat_id, chat_title, sender, keyword, ts, day) VALUES(?, ?, ?, ?, ?, ?, ?)',
          [message.message_key, message.chat_id, message.chat_title, message.sender || '', keyword, Number(message.ts || 0), new Date(Number(message.ts || 0)).toISOString().slice(0, 10)]
        );
        count += 1;
      }
    }
    this.run(
      `UPDATE chats SET leave_hits = (
         SELECT COUNT(*) FROM leave_events e WHERE e.chat_id = chats.chat_id
       )`
    );
    return count;
  }
}
