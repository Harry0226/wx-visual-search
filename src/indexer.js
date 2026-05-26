import Fuse from 'fuse.js';
import { DEFAULT_LEAVE_KEYWORDS, DEMO_CHATS, DEMO_MESSAGES } from './demo-data.js';
import { compactText, formatDate, formatDateTime, makeMessageKey, normalizeText, splitKeywords, splitQuery, uniq } from './shared.js';

const DEFAULT_SETTINGS = {
  wxCommand: 'wx',
  syncMode: 'quick',
  liveFallback: 'true',
  deepLimitPerChat: '0',
  searchResultLimit: '1000',
  leaveKeywords: DEFAULT_LEAVE_KEYWORDS.join('\n')
};

export class WxIndexService {
  constructor({ db, wxClient, onEvent }) {
    this.db = db;
    this.wxClient = wxClient;
    this.onEvent = onEvent || (() => {});
  }

  getSettings() {
    const map = this.db.getSettingsMap();
    return {
      wxCommand: map.get('wxCommand') || DEFAULT_SETTINGS.wxCommand,
      syncMode: map.get('syncMode') || DEFAULT_SETTINGS.syncMode,
      liveFallback: map.get('liveFallback') ?? DEFAULT_SETTINGS.liveFallback,
      deepLimitPerChat: map.get('deepLimitPerChat') || DEFAULT_SETTINGS.deepLimitPerChat,
      searchResultLimit: map.get('searchResultLimit') || DEFAULT_SETTINGS.searchResultLimit,
      leaveKeywords: splitKeywords(map.get('leaveKeywords') || DEFAULT_SETTINGS.leaveKeywords)
    };
  }

  saveSettings(nextSettings) {
    const entries = Object.entries(nextSettings || {});
    for (const [key, value] of entries) {
      if (Array.isArray(value)) {
        this.db.setSetting(key, value.join('\n'));
      } else {
        this.db.setSetting(key, String(value));
      }
    }
    this.db.save();
    this.db.rebuildLeaveEvents(this.getSettings().leaveKeywords);
  }

  getOverview() {
    const chats = this.db.one('SELECT COUNT(*) AS count FROM chats')?.count || 0;
    const messages = this.db.one('SELECT COUNT(*) AS count FROM messages')?.count || 0;
    const leaveHits = this.db.one('SELECT COUNT(*) AS count FROM leave_events')?.count || 0;
    const latest = this.db.one('SELECT MAX(ts) AS ts FROM messages')?.ts || 0;
    const topChats = this.db.all(
      `SELECT chat_id, chat_title, is_group, message_count, leave_hits, last_message_at, last_message_preview
       FROM chats
       ORDER BY last_message_at DESC
       LIMIT 8`
    );
    return {
      chats,
      messages,
      leaveHits,
      latest,
      topChats: topChats.map((row) => ({
        ...row,
        summary: row.last_message_preview || '',
        last_message_time: row.last_message_at ? formatDateTime(row.last_message_at) : ''
      })),
      settings: this.getSettings()
    };
  }

  async sync({ mode = 'quick' } = {}) {
    const settings = this.getSettings();
    const wx = this.wxClient;
    try {
      const sessionLimit = mode === 'deep' ? 500 : 80;
      const sessionPayload = await wx.sessions(sessionLimit);
      const sessions = normalizeSessions(sessionPayload);

      this.onEvent({ type: 'sync-start', mode, total: sessions.length });

      let syncedChats = 0;
      let syncedMessages = 0;
      let leaveEventCount = 0;

      for (let i = 0; i < sessions.length; i += 1) {
        const session = sessions[i];
        let syncResult;
        try {
          syncResult = await this.syncChat(session, {
            mode,
            current: i + 1,
            total: sessions.length,
            settings
          });
        } catch (error) {
          this.onEvent({ type: 'sync-warning', message: `跳过会话「${session.chat_title || session.chat || session.username || ''}」：${error?.message || String(error)}` });
          syncResult = { messages: 0, leaveEvents: 0 };
        }
        syncedChats += 1;
        syncedMessages += syncResult.messages;
        leaveEventCount += syncResult.leaveEvents;
      }

      if (!syncedMessages) {
        this.seedDemoData();
        syncedChats = this.db.one('SELECT COUNT(*) AS count FROM chats')?.count || 0;
        syncedMessages = this.db.one('SELECT COUNT(*) AS count FROM messages')?.count || 0;
        leaveEventCount = this.db.one('SELECT COUNT(*) AS count FROM leave_events')?.count || 0;
      }

      this.db.save();
      this.onEvent({ type: 'sync-complete', mode, chats: syncedChats, messages: syncedMessages, leaveEvents: leaveEventCount });
      return {
        chats: syncedChats,
        messages: syncedMessages,
        leaveEvents: leaveEventCount
      };
    } catch (error) {
      this.onEvent({ type: 'sync-error', message: error?.message || String(error) });
      if (!this.db.one('SELECT COUNT(*) AS count FROM messages')?.count) {
        this.seedDemoData();
        const overview = this.getOverview();
        this.onEvent({
          type: 'sync-complete',
          mode,
          chats: overview.chats,
          messages: overview.messages,
          leaveEvents: overview.leaveHits,
          demo: true
        });
        return {
          chats: overview.chats,
          messages: overview.messages,
          leaveEvents: overview.leaveHits,
          demo: true
        };
      }
      throw error;
    }
  }

  async syncChat(session, { mode, current, total, settings }) {
    const chat = normalizeChat(session);
    if (!chat.chat_id) return { messages: 0, leaveEvents: 0 };
    this.db.upsertChat(chat);

    const pageSize = mode === 'deep' ? 200 : 20;
    const deepLimit = Number(settings.deepLimitPerChat || 0);
    const syncState = this.db.getChatSyncState(chat.chat_id);
    const since = mode === 'incremental' && syncState?.last_synced_at
      ? formatDate(Number(syncState.last_synced_at) - 86400000)
      : undefined;

    let offset = 0;
    let messages = 0;
    let leaveEvents = 0;
    let latestAt = Number(syncState?.last_message_at || 0);
    let reachedDeepLimit = false;

    while (true) {
      const payload = await this.wxClient.history(chat.chat_id, {
        limit: pageSize,
        offset,
        since,
        type: 'text'
      });
      const batch = normalizeMessages(payload, chat);
      if (!batch.length) break;

      this.db.transaction(() => {
        for (const message of batch) {
          const inserted = this.db.upsertMessage(message);
          if (inserted) {
            messages += 1;
            latestAt = Math.max(latestAt, Number(message.ts || 0));
            this.db.updateChatCounters(chat.chat_id, {
              lastMessageAt: Number(message.ts || 0),
              lastPreview: message.content.slice(0, 120),
              deltaCount: 1
            });
            leaveEvents += this.indexLeaveEvent(message, settings.leaveKeywords);
          }
        }
      });

      offset += pageSize;
      this.onEvent({
        type: 'sync-progress',
        chat: chat.chat_title,
        current,
        total,
        mode,
        messages,
        leaveEvents
      });

      if (mode === 'quick') break;
      if (deepLimit > 0 && offset >= deepLimit) {
        reachedDeepLimit = true;
        break;
      }
      if (batch.length < pageSize) break;
    }

    this.db.upsertSyncState(chat.chat_id, chat.chat_title, {
      last_synced_at: Date.now(),
      last_message_at: latestAt,
      last_mode: mode,
      last_offset: offset
    });

    return {
      messages,
      leaveEvents,
      reachedDeepLimit
    };
  }

  indexLeaveEvent(message, leaveKeywords) {
    const matched = uniq((leaveKeywords || []).filter((keyword) => message.content.includes(keyword)));
    let count = 0;
    for (const keyword of matched) {
      this.db.run(
        'INSERT OR REPLACE INTO leave_events(message_key, chat_id, chat_title, sender, keyword, ts, day) VALUES(?, ?, ?, ?, ?, ?, ?)',
        [
          message.message_key,
          message.chat_id,
          message.chat_title,
          message.sender || '',
          keyword,
          Number(message.ts || 0),
          formatDate(Number(message.ts || 0))
        ]
      );
      count += 1;
    }
    return count;
  }

  seedDemoData() {
    for (const chat of DEMO_CHATS) {
      this.db.upsertChat({
        ...chat,
        alias: chat.chat_title,
        source: 'demo'
      });
    }
    for (const message of DEMO_MESSAGES) {
      const enriched = {
        ...message,
        message_key: makeMessageKey(message)
      };
      if (this.db.upsertMessage(enriched)) {
        this.db.updateChatCounters(enriched.chat_id, {
          lastMessageAt: enriched.ts,
          lastPreview: enriched.content.slice(0, 120),
          deltaCount: 1
        });
      }
    }
    this.db.rebuildLeaveEvents(this.getSettings().leaveKeywords);
    this.db.save();
  }

  search(query, options = {}) {
    const searchText = String(query || '').trim();
    const limit = Number(options.limit || this.getSettings().searchResultLimit || 1000);
    const allowLiveFallback = options.allowLiveFallback ?? true;
    const scope = options.scope || 'all';
    const where = [];
    const params = [];
    const tokens = splitQuery(searchText);
    const normalized = compactText(searchText);

    if (options.chatId) {
      where.push('m.chat_id = ?');
      params.push(options.chatId);
    }
    if (options.type) {
      if (normalizeMessageType(options.type) === 'text') {
        where.push("(m.message_type = 'text' OR m.message_type = '文本')");
      } else {
        where.push('m.message_type = ?');
        params.push(normalizeMessageType(options.type));
      }
    }
    if (scope === 'group') {
      where.push('m.is_group = 1');
    } else if (scope === 'private') {
      where.push('m.is_group = 0');
    }
    if (options.since) {
      where.push('m.ts >= ?');
      params.push(parseDateBoundary(options.since, 'start'));
    }
    if (options.until) {
      where.push('m.ts <= ?');
      params.push(parseDateBoundary(options.until, 'end'));
    }
    for (const token of tokens) {
      const t = `%${compactText(token)}%`;
      where.push('(m.content_norm LIKE ? OR m.sender_norm LIKE ? OR c.chat_title_norm LIKE ?)');
      params.push(t, t, t);
    }

    let candidates = [];
    if (searchText) {
      const sql = `
        SELECT m.*, c.is_group AS chat_is_group, c.leave_hits AS chat_leave_hits, c.last_message_at AS chat_last_message_at
        FROM messages m
        LEFT JOIN chats c ON c.chat_id = m.chat_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY m.ts DESC
        LIMIT ?
      `;
      params.push(Math.max(500, limit));
      candidates = this.db.all(sql, params);
    } else {
      candidates = this.db.all(
        `SELECT m.*, c.is_group AS chat_is_group, c.leave_hits AS chat_leave_hits, c.last_message_at AS chat_last_message_at
         FROM messages m
         LEFT JOIN chats c ON c.chat_id = m.chat_id
         ORDER BY m.ts DESC
         LIMIT ?`,
        [Math.max(500, limit)]
      );
    }

    const cleanCandidates = shouldPreferCleanText(options)
      ? candidates.filter((row) => isCleanTextMessage(row))
      : candidates;
    let results = rankSearchResults(cleanCandidates, searchText, normalized).slice(0, limit);

    const onlyDemoResults = results.length > 0 && results.every((item) => item.source === 'demo');
    if (searchText && allowLiveFallback && (results.length < limit || onlyDemoResults || options.forceLive)) {
      return this.liveFallbackSearch(searchText, options);
    }

    return {
      query: searchText,
      total: results.length,
      liveFallbackUsed: false,
      items: results
    };
  }

  async liveFallbackSearch(query, options = {}) {
    let payload;
    let fallbackError = '';
    try {
      payload = await this.wxClient.search(query, {
        limit: options.limit || 1000,
        since: options.since,
        until: options.until,
        type: options.type ? normalizeMessageType(options.type) : undefined,
        inChats: options.chatId ? [options.chatId] : []
      });
    } catch (error) {
      fallbackError = error?.message || String(error);
      if (!this.db.one('SELECT COUNT(*) AS count FROM messages')?.count) {
        this.seedDemoData();
      }
      const local = this.search(query, { ...options, allowLiveFallback: false });
      return {
        ...local,
        liveFallbackUsed: true,
        fallbackError
      };
    }
    const messages = normalizeMessages(payload, { chat_id: options.chatId || '', chat_title: options.chatTitle || query, chat_type: normalizeMessageType(options.type || 'text') })
      .filter((message) => {
        if (options.scope === 'group') return message.is_group;
        if (options.scope === 'private') return !message.is_group;
        return true;
      })
      .filter((message) => shouldPreferCleanText(options) ? isCleanTextMessage(message) : true);
    let inserted = 0;
    for (const message of messages) {
      this.db.upsertChat({
        chat_id: message.chat_id,
        chat_title: message.chat_title,
        is_group: message.is_group,
        chat_type: message.chat_type,
        alias: message.chat_title,
        source: 'wx'
      });
      if (this.db.upsertMessage(message)) {
        this.db.updateChatCounters(message.chat_id, {
          lastMessageAt: message.ts,
          lastPreview: message.content.slice(0, 120),
          deltaCount: 1
        });
        inserted += 1;
      }
    }
    if (inserted) {
      this.clearDemoData();
      this.db.rebuildLeaveEvents(this.getSettings().leaveKeywords);
      this.db.save();
    }
    const local = this.search(query, { ...options, allowLiveFallback: false });
    return {
      ...local,
      liveFallbackUsed: true
    };
  }

  async refreshLeaveIndexFromWx({ limit = 1000 } = {}) {
    const settings = this.getSettings();
    let imported = 0;
    for (const keyword of settings.leaveKeywords) {
      try {
        const payload = await this.wxClient.search(keyword, {
          limit,
          type: 'text'
        });
        const messages = normalizeMessages(payload, { chat_id: '', chat_title: keyword, chat_type: 'text' })
          .filter((message) => isCleanTextMessage(message));
        for (const message of messages) {
          this.db.upsertChat({
            chat_id: message.chat_id,
            chat_title: message.chat_title,
            is_group: message.is_group,
            chat_type: message.chat_type,
            alias: message.chat_title,
            source: 'wx'
          });
          if (this.db.upsertMessage(message)) {
            this.db.updateChatCounters(message.chat_id, {
              lastMessageAt: message.ts,
              lastPreview: message.content.slice(0, 120),
              deltaCount: 1
            });
            imported += 1;
          }
        }
      } catch (error) {
        this.onEvent({ type: 'sync-error', message: `统计关键词「${keyword}」扫描失败：${error?.message || String(error)}` });
      }
    }
    this.clearDemoData();
    this.db.rebuildLeaveEvents(settings.leaveKeywords);
    this.db.save();
    return { imported, stats: this.getStats() };
  }

  getChats() {
    return this.db.all(
      `SELECT chat_id, chat_title, is_group, chat_type, alias, source, message_count, leave_hits, last_message_at, last_message_preview
       FROM chats
       ORDER BY last_message_at DESC, message_count DESC, chat_title ASC`
    );
  }

  getChatMessages(chatId, { limit = 80 } = {}) {
    return this.db.all(
      `SELECT message_key, chat_id, chat_title, chat_type, is_group, sender, sender_username, sender_display, content, message_type, ts, time_text, source
       FROM messages
       WHERE chat_id = ?
       ORDER BY ts ASC
       LIMIT ?`,
      [chatId, Number(limit)]
    );
  }

  getMessageContext(messageKey, radius = 4) {
    const message = this.db.one('SELECT * FROM messages WHERE message_key = ?', [messageKey]);
    if (!message) return null;
    const context = this.db.all(
      `SELECT message_key, chat_id, chat_title, chat_type, is_group, sender, sender_display, content, ts, time_text, message_type
       FROM messages
       WHERE chat_id = ?
         AND ts BETWEEN ? AND ?
       ORDER BY ts ASC, message_key ASC`,
      [message.chat_id, Number(message.ts) - radius * 5 * 60 * 1000, Number(message.ts) + radius * 5 * 60 * 1000]
    );
    return { message, context };
  }

  getStats() {
    const leaveRows = this.db.all(
      `SELECT e.chat_id, e.chat_title, e.sender, e.keyword, e.ts, e.day, m.content
       FROM leave_events e
       LEFT JOIN messages m ON m.message_key = e.message_key
       ORDER BY e.ts DESC`
    );
    const byChat = new Map();
    const byDay = new Map();
    const keywordCounts = new Map();
    for (const row of leaveRows) {
      const chat = byChat.get(row.chat_id) || {
        chat_id: row.chat_id,
        chat_title: row.chat_title,
        count: 0,
        latest_ts: 0,
        latest_content: '',
        senders: new Set(),
        keywords: new Set()
      };
      chat.count += 1;
      if (Number(row.ts || 0) >= chat.latest_ts) {
        chat.latest_ts = Number(row.ts || 0);
        chat.latest_content = row.content || '';
      }
      if (row.sender) chat.senders.add(row.sender);
      if (row.keyword) chat.keywords.add(row.keyword);
      byChat.set(row.chat_id, chat);

      byDay.set(row.day, (byDay.get(row.day) || 0) + 1);
      if (row.keyword) keywordCounts.set(row.keyword, (keywordCounts.get(row.keyword) || 0) + 1);
    }

    return {
      totalLeaves: leaveRows.length,
      byChat: [...byChat.values()]
        .map((item) => ({
          chat_id: item.chat_id,
          chat_title: item.chat_title,
          count: item.count,
          sender_count: item.senders.size,
          keywords: [...item.keywords].slice(0, 6).join('、'),
          latest_time: item.latest_ts ? formatDateTime(item.latest_ts) : '',
          latest_content: item.latest_content
        }))
        .sort((a, b) => b.count - a.count),
      byDay: [...byDay.entries()]
        .map(([day, count]) => ({ day, count }))
        .sort((a, b) => a.day.localeCompare(b.day)),
      keywords: [...keywordCounts.entries()]
        .map(([keyword, count]) => ({ keyword, count }))
        .sort((a, b) => b.count - a.count)
    };
  }

  async refreshDerivedData(options = {}) {
    const settings = this.getSettings();
    if (options.scanWx) {
      return this.refreshLeaveIndexFromWx({ limit: Number(options.limit || settings.searchResultLimit || 1000) });
    }
    this.db.rebuildLeaveEvents(settings.leaveKeywords);
    this.db.save();
    return { imported: 0, stats: this.getStats() };
  }

  clearDemoData() {
    this.db.run("DELETE FROM messages WHERE source = 'demo'");
    this.db.run("DELETE FROM chats WHERE source = 'demo'");
  }
}

function normalizeSessions(payload) {
  const sessions = Array.isArray(payload?.sessions)
    ? payload.sessions
    : Array.isArray(payload?.messages)
      ? payload.messages
      : Array.isArray(payload)
        ? payload
        : [];
  return sessions.map((session) => {
    const chatId = session.username || session.chat || session.chat_id || session.id || '';
    const chatTitle = session.chat || session.display || session.username || session.sender || session.chat_id || '';
    const isGroup = inferGroupChat(session, chatId, chatTitle, session.chat_type);
    return {
    chat_id: chatId,
    chat_title: chatTitle,
    is_group: isGroup,
    chat_type: normalizeChatType(session.chat_type, isGroup),
    alias: session.display || session.chat || session.username || '',
    unread: Number(session.unread || session.unread_count || 0),
    last_message_at: Number(session.timestamp || session.last_timestamp || 0),
    last_message_preview: session.summary || session.last_msg || '',
    source: 'wx'
  };
  }).filter((session) => session.chat_id && session.chat_title && ['private', 'group'].includes(normalizeChatType(session.chat_type, session.is_group)));
}

function normalizeChat(session) {
  const chatId = session.chat_id || session.username || session.chat || session.id || '';
  const chatTitle = session.chat_title || session.chat || session.display || session.username || session.sender || session.chat_id || '';
  const isGroup = inferGroupChat(session, chatId, chatTitle, session.chat_type);
  return {
    chat_id: chatId,
    chat_title: chatTitle,
    is_group: isGroup,
    chat_type: normalizeChatType(session.chat_type, isGroup),
    alias: session.alias || session.display || session.chat || session.username || '',
    unread: Number(session.unread || session.unread_count || 0),
    last_message_at: normalizeTimestamp(session.last_message_at || session.timestamp || session.last_timestamp || 0),
    last_message_preview: cleanMessageContent(session.last_message_preview || session.summary || session.last_msg || ''),
    source: session.source || 'wx'
  };
}

function normalizeMessages(payload, chat) {
  const rows = Array.isArray(payload?.messages)
    ? payload.messages
    : Array.isArray(payload?.results)
      ? payload.results
    : Array.isArray(payload?.rows)
      ? payload.rows
      : Array.isArray(payload)
        ? payload
        : [];
  const isGroup = inferGroupChat(payload, chat.chat_id, chat.chat_title, chat.chat_type);
  const chatType = payload?.chat_type || (isGroup ? 'group' : 'private');
  return rows.map((row) => {
    const rowChatTitle = row.chat || row.chat_title || row.display || payload?.chat || chat.chat_title || chat.chat_id || '';
    const rowChatId = row.username || row.chat_id || row.chat || chat.chat_id || payload?.username || rowChatTitle;
    const rowIsGroup = inferGroupChat(row, rowChatId, rowChatTitle, row.chat_type || chatType, isGroup);
    const rowChatType = normalizeChatType(row.chat_type || chatType, rowIsGroup);
    const timestamp = Number(row.timestamp || row.ts || 0);
    const rawContent = String(row.content || '').trim();
    const messageType = normalizeMessageType(row.type || row.message_type || chat.chat_type || 'text', rawContent);
    return {
      message_key: makeMessageKey({
      chat_id: rowChatId,
      local_id: row.local_id ?? row.id ?? row.timestamp ?? row.time ?? '',
      ts: timestamp,
      sender_username: row.sender_username || row.sender || '',
      content: row.content || ''
    }),
    chat_id: rowChatId,
    chat_title: rowChatTitle,
    chat_type: rowChatType,
    is_group: rowIsGroup,
    sender: row.sender || row.sender_display || '',
    sender_username: row.sender_username || '',
    sender_display: row.sender_display || row.sender || '',
    content: cleanMessageContent(rawContent),
    message_type: messageType,
    ts: normalizeTimestamp(timestamp),
    time_text: row.time || row.time_text || '',
    local_id: String(row.local_id || row.id || ''),
    raw_json: row,
    source: 'wx'
    };
  }).filter((row) => row.content || row.sender || row.time_text);
}

function normalizeTimestamp(value) {
  const timestamp = Number(value || 0);
  return timestamp * (timestamp > 1_000_000_000_000 ? 1 : 1000);
}

function normalizeChatType(value, isGroup = false) {
  const text = String(value || '').toLowerCase();
  if (text.includes('group') || isGroup) return 'group';
  return 'private';
}

function inferGroupChat(...values) {
  const text = values
    .flatMap((value) => {
      if (!value || typeof value !== 'object') return [value];
      return [
        value.is_group,
        value.chat_type,
        value.type,
        value.chat_id,
        value.username,
        value.chat,
        value.chat_title,
        value.display
      ];
    })
    .map((value) => String(value || ''))
    .join(' ')
    .toLowerCase();
  if (/\btrue\b|@chatroom|group|chatroom/.test(text)) return true;
  return /(?:家长群|交流群|学习群|班级群|通知群|晚自习家长群|群聊|群$)/u.test(text);
}

function normalizeMessageType(value, content = '') {
  const text = String(value || '').toLowerCase();
  if (text === '文本' || text === 'text') return 'text';
  if (text.includes('link') || text.includes('file') || String(value || '').includes('链接') || String(value || '').includes('文件')) return 'link';
  if (text.includes('system') || String(value || '').includes('系统')) return 'system';
  if (/^\s*<\?xml|<appmsg|<msg\b/i.test(String(content || ''))) return 'link';
  return text || 'text';
}

function isCleanTextMessage(row) {
  return normalizeMessageType(row.message_type || row.type, row.content) === 'text'
    && !isNoisySearchRow(row)
    && !/^\s*<\?xml|<appmsg|<msg\b|Group Chat History/i.test(String(row.content || ''));
}

function shouldPreferCleanText(options = {}) {
  return Boolean(options.type) && normalizeMessageType(options.type) === 'text';
}

function isNoisySearchRow(row) {
  const chatTitle = String(row.chat_title || row.chat || '');
  const chatId = String(row.chat_id || row.username || '');
  const content = String(row.content || '');
  return ['文件传输助手', 'filehelper', 'brandsessionholder'].some((keyword) => chatTitle.includes(keyword) || chatId.includes(keyword))
    || /合并聊天记录|Group Chat History|<\?xml|<appmsg|<msg\b/i.test(content);
}

function cleanMessageContent(content) {
  const source = String(content || '').trim();
  if (!source) return '';
  if (!/^\s*<\?xml|<appmsg|<msg\b/i.test(source)) return source;
  const cdata = [...source.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((match) => match[1].trim()).filter(Boolean);
  if (cdata.length) return cdata.join(' ').replace(/\s+/g, ' ').trim();
  return source
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function parseDateBoundary(value, edge) {
  if (typeof value === 'number') return value;
  const text = String(value || '').trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text);
  const suffix = edge === 'end' ? 'T23:59:59.999' : 'T00:00:00.000';
  const ts = new Date(`${text}${suffix}`).getTime();
  return Number.isNaN(ts) ? 0 : ts;
}

function rankSearchResults(rows, query, normalizedQuery) {
  if (!rows.length) return [];
  const searchSpace = rows.map((row) => ({
    ...row,
    searchText: [
      row.chat_title || '',
      row.sender || '',
      row.sender_display || '',
      row.content || ''
    ].join(' ')
  }));

  const matched = query
    ? weakFilterSearchResults(searchSpace, query)
    : searchSpace;

  return dedupeSearchItems(matched.map((row) => toSearchItem(row)))
    .sort(compareSearchItems);
}

function weakFilterSearchResults(rows, query) {
  const fuse = new Fuse(rows, {
    keys: ['chat_title', 'sender', 'sender_display', 'content'],
    includeScore: true,
    ignoreLocation: true,
    threshold: 0.6
  });
  const ranked = fuse.search(query).slice(0, 3000).map((hit) => hit.item);
  return ranked.length ? ranked : rows;
}

function dedupeSearchItems(items) {
  const byKey = new Map();
  const result = [];
  for (const item of items) {
    const key = [
      item.chat_title || item.chat_id || '',
      item.sender_display || item.sender || item.sender_username || '',
      Math.floor(Number(item.ts || 0) / 1000),
      compactText(item.content || '')
    ].join('|');
    const existing = byKey.get(key);
    if (existing) {
      mergeDuplicateSearchItem(existing, item);
      continue;
    }
    byKey.set(key, item);
    result.push(item);
  }
  return result;
}

function mergeDuplicateSearchItem(target, source) {
  const isGroup = Boolean(target.is_group || source.is_group || inferGroupChat(target, source));
  target.is_group = isGroup;
  target.chat_type = isGroup ? 'group' : 'private';
  if (!target.sender_display && source.sender_display) target.sender_display = source.sender_display;
  if (!target.sender && source.sender) target.sender = source.sender;
  if (!target.sender_username && source.sender_username) target.sender_username = source.sender_username;
  if (!target.message_key && source.message_key) target.message_key = source.message_key;
}

function compareSearchItems(a, b) {
  const minuteA = Math.floor(Number(a.ts || 0) / 60_000);
  const minuteB = Math.floor(Number(b.ts || 0) / 60_000);
  const minuteDiff = minuteB - minuteA;
  if (minuteDiff) return minuteDiff;
  const privateDiff = Number(Boolean(a.is_group)) - Number(Boolean(b.is_group));
  if (privateDiff) return privateDiff;
  const timeDiff = Number(b.ts || 0) - Number(a.ts || 0);
  if (timeDiff) return timeDiff;
  const chatDiff = String(a.chat_title || '').localeCompare(String(b.chat_title || ''), 'zh-Hans-CN');
  if (chatDiff) return chatDiff;
  return String(a.sender_display || a.sender || '').localeCompare(String(b.sender_display || b.sender || ''), 'zh-Hans-CN');
}

function toSearchItem(row) {
  const content = String(row.content || '');
  const chatTitle = String(row.chat_title || '');
  const sender = String(row.sender || row.sender_display || '');
  const timeText = row.time_text || '';
  const isGroup = inferGroupChat(
    row,
    row.chat_is_group,
    row.is_group,
    row.chat_id,
    row.username,
    chatTitle,
    row.chat_type
  );
  return {
    message_key: row.message_key,
    chat_id: row.chat_id,
    chat_title: chatTitle,
    chat_type: isGroup ? 'group' : (row.chat_type || 'private'),
    is_group: isGroup,
    sender,
    sender_username: row.sender_username || '',
    sender_display: row.sender_display || sender,
    content,
    message_type: row.message_type || 'text',
    ts: Number(row.ts || 0),
    time_text: timeText,
    source: row.source || 'wx',
    chat_leave_hits: Number(row.chat_leave_hits || 0),
    chat_last_message_at: Number(row.chat_last_message_at || 0)
  };
}

function relevanceScore(row, normalizedQuery) {
  const text = normalizeText([row.chat_title, row.sender, row.sender_display, row.content].join(' '));
  let score = 0;
  if (normalizedQuery && text.includes(normalizedQuery)) score += 8;
  if (row.content && normalizedQuery && normalizeText(row.content).startsWith(normalizedQuery)) score += 4;
  if (row.chat_title && normalizedQuery && normalizeText(row.chat_title).includes(normalizedQuery)) score += 2;
  score += Math.min(3, Number(row.chat_leave_hits || 0));
  score += Math.min(3, Math.max(0, 1_000_000_000_000 - Number(row.ts || 0)) / 1_000_000_000_000);
  return score;
}
