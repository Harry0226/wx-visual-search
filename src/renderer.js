const state = {
  page: 'search',
  bootstrap: null,
  overview: null,
  settings: null,
  chats: [],
  searchResults: [],
  rawSearchItems: [],
  currentSearch: { query: '', limit: 1000 },
  searchChatFilter: '',
  selectedMessageKey: '',
  selectedChatId: '',
  context: null,
  stats: null,
  sync: null,
  eventUnsub: null,
  searchTimer: null
};

const els = {
  subtitle: document.querySelector('#subtitle'),
  metricChats: document.querySelector('#metricChats'),
  metricMessages: document.querySelector('#metricMessages'),
  metricLeaves: document.querySelector('#metricLeaves'),
  wxCommandLabel: document.querySelector('#wxCommandLabel'),
  dbPathLabel: document.querySelector('#dbPathLabel'),
  noticeText: document.querySelector('#noticeText'),
  searchInput: document.querySelector('#searchInput'),
  searchBtn: document.querySelector('#searchBtn'),
  sinceInput: document.querySelector('#sinceInput'),
  untilInput: document.querySelector('#untilInput'),
  typeFilter: document.querySelector('#typeFilter'),
  scopeFilter: document.querySelector('#scopeFilter'),
  liveFallbackToggle: document.querySelector('#liveFallbackToggle'),
  searchSummary: document.querySelector('#searchSummary'),
  searchPills: document.querySelector('#searchPills'),
  resultsList: document.querySelector('#resultsList'),
  loadMoreBtn: document.querySelector('#loadMoreBtn'),
  previewMeta: document.querySelector('#previewMeta'),
  previewBody: document.querySelector('#previewBody'),
  copyContextBtn: document.querySelector('#copyContextBtn'),
  quickSyncBtn: document.querySelector('#quickSyncBtn'),
  deepSyncBtn: document.querySelector('#deepSyncBtn'),
  openSettingsBtn: document.querySelector('#openSettingsBtn'),
  refreshStatsBtn: document.querySelector('#refreshStatsBtn'),
  reloadChatsBtn: document.querySelector('#reloadChatsBtn'),
  reloadSettingsBtn: document.querySelector('#reloadSettingsBtn'),
  saveSettingsBtn: document.querySelector('#saveSettingsBtn'),
  rebuildDerivedBtn: document.querySelector('#rebuildDerivedBtn'),
  openDataFolderBtn: document.querySelector('#openDataFolderBtn'),
  syncBar: document.querySelector('#syncBar'),
  syncTitle: document.querySelector('#syncTitle'),
  syncDetail: document.querySelector('#syncDetail'),
  syncFill: document.querySelector('#syncFill'),
  chatList: document.querySelector('#chatList'),
  leaveByChat: document.querySelector('#leaveByChat'),
  leaveByDay: document.querySelector('#leaveByDay'),
  leaveKeywords: document.querySelector('#leaveKeywords'),
  statsTotalLeaves: document.querySelector('#statsTotalLeaves'),
  statsContacts: document.querySelector('#statsContacts'),
  statsDays: document.querySelector('#statsDays'),
  statsKeywords: document.querySelector('#statsKeywords'),
  wxCommandInput: document.querySelector('#wxCommandInput'),
  searchLimitInput: document.querySelector('#searchLimitInput'),
  deepLimitInput: document.querySelector('#deepLimitInput'),
  liveFallbackSetting: document.querySelector('#liveFallbackSetting'),
  syncModeSelect: document.querySelector('#syncModeSelect'),
  leaveKeywordsInput: document.querySelector('#leaveKeywordsInput')
};

async function init() {
  bindNav();
  bindActions();
  try {
    state.bootstrap = await window.wxApp.bootstrap();
    state.overview = state.bootstrap.overview;
    state.settings = state.bootstrap.settings;
    renderBootstrap();
    renderOverview();
    await loadChats();
    await loadStats();
    renderSettings();
    state.eventUnsub = window.wxApp.onEvent(handleEvent);
    showPage('search');

    if (!state.overview.messages) {
      startSync('quick', true);
    }
  } catch (error) {
    showFatalError(error);
  }
}

function bindNav() {
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => showPage(button.dataset.page));
  });
}

function bindActions() {
  els.searchBtn.addEventListener('click', () => runSearch());
  els.searchInput.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(runSearch, 180);
  });
  els.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runSearch();
    }
  });
  [els.sinceInput, els.untilInput, els.typeFilter, els.scopeFilter, els.liveFallbackToggle].forEach((el) => {
    el.addEventListener('change', runSearch);
  });
  els.loadMoreBtn.addEventListener('click', () => runSearch({ append: true }));
  els.quickSyncBtn.addEventListener('click', () => startSync('quick'));
  els.deepSyncBtn.addEventListener('click', () => startSync('deep'));
  els.openSettingsBtn.addEventListener('click', () => showPage('settings'));
  els.refreshStatsBtn.addEventListener('click', () => loadStats(true));
  els.reloadChatsBtn.addEventListener('click', loadChats);
  els.reloadSettingsBtn.addEventListener('click', renderSettings);
  els.saveSettingsBtn.addEventListener('click', saveSettings);
  els.rebuildDerivedBtn.addEventListener('click', async () => {
    await window.wxApp.refreshDerived({ scanWx: true });
    await loadStats();
    await loadChats();
    await refreshOverview();
  });
  els.openDataFolderBtn.addEventListener('click', () => window.wxApp.openFolder());
  els.copyContextBtn.addEventListener('click', copyCurrentContext);
}

function showPage(page) {
  state.page = page;
  document.querySelectorAll('.page').forEach((section) => {
    section.classList.toggle('active', section.id === `page-${page}`);
  });
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === page);
  });
  if (page === 'search' && !state.searchResults.length) runSearch();
  if (page === 'stats') loadStats(!state.stats || !(state.stats.totalLeaves > 0));
  if (page === 'chats') loadChats();
  if (page === 'settings') renderSettings();
}

function renderBootstrap() {
  els.subtitle.textContent = '本地微信聊天检索与请假统计';
  els.wxCommandLabel.textContent = state.bootstrap.wxCommand || 'wx';
  els.dbPathLabel.textContent = state.bootstrap.dataPath || '-';
}

function renderOverview() {
  const overview = state.overview || {};
  els.metricChats.textContent = overview.chats || 0;
  els.metricMessages.textContent = overview.messages || 0;
  els.metricLeaves.textContent = overview.leaveHits || 0;
  els.noticeText.textContent = overview.messages
    ? '搜索会先走本地索引，命中少时会实时回查 wx-cli 并缓存结果。'
    : '当前还没有索引数据，点击快速同步或深度同步开始导入。';
  els.searchPills.innerHTML = [
    pill(`会话 ${overview.chats || 0}`),
    pill(`消息 ${overview.messages || 0}`),
    pill(`请假 ${overview.leaveHits || 0}`)
  ].join('');
}

async function refreshOverview() {
  state.overview = await window.wxApp.overview();
  renderOverview();
}

async function loadChats() {
  state.chats = await window.wxApp.chats();
  renderChatList();
}

function renderChatList() {
  if (!state.chats.length) {
    els.chatList.classList.add('empty-state');
    els.chatList.textContent = '暂时没有会话数据。';
    return;
  }
  els.chatList.classList.remove('empty-state');
  els.chatList.innerHTML = state.chats.map((chat) => `
    <article class="chat-card ${state.selectedChatId === chat.chat_id ? 'active' : ''}" data-chat-id="${escapeAttr(chat.chat_id)}">
      <div class="chat-top">
        <div>
          <div class="chat-title">${escapeHtml(chat.chat_title)}</div>
          <div class="chat-meta">${chat.chat_type === 'group' ? '群聊' : '私聊'} · ${chat.message_count || 0} 条消息</div>
        </div>
        <span class="tag">${chat.leave_hits || 0} 请假</span>
      </div>
      <div class="result-snippet">${escapeHtml(chat.last_message_preview || '暂无摘要')}</div>
      <div class="chat-meta">${formatDateTimeText(chat.last_message_at)}</div>
    </article>
  `).join('');
  els.chatList.querySelectorAll('.chat-card').forEach((card) => {
    card.addEventListener('click', async () => {
      const chatId = card.dataset.chatId;
      state.selectedChatId = chatId;
      await showChat(chatId);
      renderChatList();
    });
  });
}

async function showChat(chatId) {
  const rows = await window.wxApp.chatMessages(chatId, { limit: 120 });
  els.previewMeta.textContent = `${rows.length} 条会话消息`;
  renderFocusedContext(rows.map(normalizeMessageForView), { title: state.chats.find((chat) => chat.chat_id === chatId)?.chat_title || chatId });
  state.context = { context: rows };
}

async function runSearch({ append = false } = {}) {
  const query = els.searchInput.value.trim();
  state.selectedMessageKey = '';
  if (!append) state.searchChatFilter = '';
  const baseLimit = Number(state.settings?.searchResultLimit || 1000);
  const nextLimit = append ? Number(state.currentSearch.limit || baseLimit) + 500 : baseLimit;
  state.currentSearch = { query, limit: Math.min(nextLimit, 3000) };
  const options = {
    limit: state.currentSearch.limit,
    since: els.sinceInput.value || undefined,
    until: els.untilInput.value || undefined,
    type: els.typeFilter.value || undefined,
    scope: els.scopeFilter.value || 'all',
    allowLiveFallback: els.liveFallbackToggle.checked
  };
  if (!query) {
    state.searchResults = [];
    state.rawSearchItems = [];
    els.loadMoreBtn.hidden = true;
    els.searchSummary.textContent = '输入关键词开始查找';
    els.resultsList.classList.add('empty-state');
    els.resultsList.textContent = '请输入关键词。';
    return;
  }
  els.searchSummary.textContent = `正在搜索 “${query}”`;
  els.resultsList.classList.add('empty-state');
  els.resultsList.textContent = '正在搜索...';
  try {
    const result = await window.wxApp.search(query, options);
    state.rawSearchItems = result.items || [];
    state.searchResults = getFilteredSearchItems();
    renderSearchResults(result);
  } catch (error) {
    state.searchResults = [];
    state.rawSearchItems = [];
    els.loadMoreBtn.hidden = true;
    els.searchSummary.textContent = '搜索失败';
    els.resultsList.classList.add('empty-state');
    els.resultsList.textContent = error?.message || '搜索失败，请检查 wx-cli 是否已初始化。';
  }
}

function renderSearchResults(result) {
  const query = result.query || '';
  const items = getFilteredSearchItems();
  state.searchResults = items;
  renderConversationPills();
  els.loadMoreBtn.hidden = !query || state.rawSearchItems.length < Number(state.currentSearch.limit || 1000);
  els.searchSummary.textContent = `${result.total || items.length} 条结果${result.liveFallbackUsed ? ' · 已实时回查 wx-cli' : ''}`;
  if (result.fallbackError) {
    els.searchSummary.textContent += ' · wx-cli 回查超时，已显示本地/示例结果';
  }
  if (!items.length) {
    els.resultsList.classList.add('empty-state');
    els.resultsList.textContent = '没有命中，换个关键词试试。';
    renderPreviewEmpty();
    return;
  }
  els.resultsList.classList.remove('empty-state');
  els.resultsList.innerHTML = items.map((item) => {
    const snippet = highlightText(truncateText(cleanTextForView(item.content), 150), query);
    return `
      <article class="result-card ${state.selectedMessageKey === item.message_key ? 'active' : ''}" data-message-key="${escapeAttr(item.message_key)}">
        <div class="result-top">
          <div>
            <div class="result-title">${escapeHtml(item.chat_title)}</div>
            <div class="result-meta">${escapeHtml(item.sender_display || item.sender || '未知')}${item.chat_type === 'group' ? ' · 群聊' : ' · 私聊'}</div>
          </div>
          <div class="tag">${formatDateTimeText(item.ts)}</div>
        </div>
        <div class="result-snippet">${snippet}</div>
      </article>
    `;
  }).join('');
  els.resultsList.querySelectorAll('.result-card').forEach((card) => {
    card.addEventListener('click', async () => {
      const messageKey = card.dataset.messageKey;
      state.selectedMessageKey = messageKey;
      await loadContext(messageKey);
      renderSearchResults(result);
    });
  });
  if (!items.some((item) => item.message_key === state.selectedMessageKey) && items[0]) {
    state.selectedMessageKey = items[0].message_key;
    loadContext(items[0].message_key);
  }
}

function getFilteredSearchItems() {
  if (!state.searchChatFilter) return state.rawSearchItems || [];
  return (state.rawSearchItems || []).filter((item) => item.chat_id === state.searchChatFilter);
}

function renderConversationPills() {
  const counts = new Map();
  for (const item of state.rawSearchItems || []) {
    const current = counts.get(item.chat_id) || {
      chat_id: item.chat_id,
      chat_title: item.chat_title,
      count: 0,
      latest_ts: 0,
      is_group: Boolean(item.is_group)
    };
    current.count += 1;
    current.latest_ts = Math.max(current.latest_ts, Number(item.ts || 0));
    current.is_group = current.is_group || Boolean(item.is_group);
    counts.set(item.chat_id, current);
  }
  const chats = [...counts.values()]
    .sort((a, b) => Number(a.is_group) - Number(b.is_group) || b.latest_ts - a.latest_ts)
    .slice(0, 12);
  const scope = els.scopeFilter.value || 'all';
  els.searchPills.innerHTML = [
    `<button class="pill ${scope === 'all' && !state.searchChatFilter ? 'active' : ''}" data-scope="all">全部 ${state.rawSearchItems.length}</button>`,
    `<button class="pill ${scope === 'private' && !state.searchChatFilter ? 'active' : ''}" data-scope="private">只看私聊</button>`,
    `<button class="pill ${scope === 'group' && !state.searchChatFilter ? 'active' : ''}" data-scope="group">只看群聊</button>`,
    ...chats.map((chat) => `<button class="pill ${state.searchChatFilter === chat.chat_id ? 'active' : ''}" data-chat-id="${escapeAttr(chat.chat_id)}">${escapeHtml(chat.chat_title)} ${formatTimeShort(chat.latest_ts)} · ${chat.count}</button>`)
  ].join('');
  els.searchPills.querySelectorAll('button[data-scope]').forEach((button) => {
    button.addEventListener('click', () => {
      els.scopeFilter.value = button.dataset.scope || 'all';
      state.searchChatFilter = '';
      runSearch();
    });
  });
  els.searchPills.querySelectorAll('button[data-chat-id]').forEach((button) => {
    button.addEventListener('click', () => {
      state.searchChatFilter = button.dataset.chatId || '';
      renderSearchResults({ query: state.currentSearch.query || els.searchInput.value.trim(), items: state.rawSearchItems });
    });
  });
}

async function loadContext(messageKey) {
  const payload = await window.wxApp.messageContext(messageKey);
  state.context = payload;
  const contextRows = (payload?.context || []).map(normalizeMessageForView);
  renderFocusedContext(contextRows, { title: payload?.message?.chat_title || '上下文' });
}

function renderContext(messages, meta = {}) {
  const activeKey = state.selectedMessageKey;
  if (!messages.length) {
    renderPreviewEmpty();
    return;
  }
  const body = messages.map((message) => `
    <article class="context-message ${message.message_key === activeKey ? 'active' : ''}">
      <div class="time">${escapeHtml(message.time_text || formatTimeShort(message.ts))}</div>
      <div class="sender">${escapeHtml(message.sender_display || message.sender || '未知')}</div>
      <div class="content-text">${highlightText(message.content, els.searchInput.value.trim())}</div>
    </article>
  `).join('');
  els.previewMeta.textContent = `${meta.title || '上下文'} · ${messages.length} 条`;
  els.previewBody.classList.remove('empty-state');
  els.previewBody.innerHTML = `<div class="context-list">${body}</div>`;
}

function renderFocusedContext(messages, meta = {}) {
  const activeKey = state.selectedMessageKey;
  if (!messages.length) {
    renderPreviewEmpty();
    return;
  }
  const focused = focusContextMessages(messages, activeKey);
  const body = focused.map((message) => `
    <article class="context-message ${message.message_key === activeKey ? 'active' : ''}">
      <div class="time">${escapeHtml(message.time_text || formatDateTimeText(message.ts))}</div>
      <div class="sender">${escapeHtml(message.sender_display || message.sender || '未知')}</div>
      <div class="content-text">${highlightText(cleanTextForView(message.content), els.searchInput.value.trim())}</div>
    </article>
  `).join('');
  els.previewMeta.textContent = `${meta.title || '上下文'} · ${focused.length} 条`;
  els.previewBody.classList.remove('empty-state');
  els.previewBody.innerHTML = `<div class="context-list">${body}</div>`;
}

function focusContextMessages(messages, activeKey) {
  if (!activeKey) return messages.slice(0, 7);
  const index = messages.findIndex((message) => message.message_key === activeKey);
  if (index < 0) return messages.slice(0, 7);
  return messages.slice(Math.max(0, index - 3), Math.min(messages.length, index + 4));
}

function renderPreviewEmpty() {
  els.previewMeta.textContent = '选择一条结果查看前后文';
  els.previewBody.classList.add('empty-state');
  els.previewBody.textContent = '这里会显示前后消息。';
}

function showFatalError(error) {
  const message = error?.message || String(error || '未知错误');
  els.searchSummary.textContent = '程序初始化失败';
  els.resultsList.classList.add('empty-state');
  els.resultsList.textContent = `初始化失败：${message}`;
  els.previewMeta.textContent = '无法读取本地索引';
  els.previewBody.classList.add('empty-state');
  els.previewBody.textContent = '请重新打开程序，或检查 wx-cli 是否可以正常运行。';
  els.syncBar.hidden = true;
}

async function loadStats(scanWx = false) {
  if (scanWx) {
    state.stats = await window.wxApp.refreshDerived({ scanWx: true, limit: Number(state.settings?.searchResultLimit || 1000) });
    await refreshOverview();
  } else {
    state.stats = await window.wxApp.stats();
  }
  renderStats();
}

function renderStats() {
  const stats = state.stats || { totalLeaves: 0, byChat: [], byDay: [], keywords: [] };
  els.statsTotalLeaves.textContent = stats.totalLeaves || 0;
  els.statsContacts.textContent = stats.byChat?.length || 0;
  els.statsDays.textContent = stats.byDay?.length || 0;
  els.statsKeywords.textContent = stats.keywords?.length || 0;

  els.leaveByChat.innerHTML = stats.byChat?.length
    ? stats.byChat.map((item) => `
        <div class="table-row">
          <div class="row-top">
            <div>
              <strong>${escapeHtml(item.chat_title)}</strong>
              <div class="row-meta">${item.count} 次 · 最近 ${escapeHtml(item.latest_time || '-')}</div>
            </div>
            <span class="tag">${item.sender_count || 0} 人</span>
          </div>
          <div class="row-meta">${escapeHtml(item.keywords || '')}</div>
          <div class="row-meta">${escapeHtml(cleanTextForView(item.latest_content || ''))}</div>
        </div>
      `).join('')
    : '<div class="empty-state">还没有请假数据。</div>';

  els.leaveByDay.innerHTML = stats.byDay?.length
    ? stats.byDay.map((item) => `
        <div class="chip">
          <strong>${escapeHtml(item.day)}</strong>
          <span>${item.count} 次</span>
        </div>
      `).join('')
    : '<div class="empty-state">暂无日期统计。</div>';

  els.leaveKeywords.innerHTML = stats.keywords?.length
    ? stats.keywords.map((item) => `
        <div class="chip">
          <strong>${escapeHtml(item.keyword)}</strong>
          <span>${item.count} 次</span>
        </div>
      `).join('')
    : '<div class="empty-state">暂无关键词统计。</div>';
}

function renderSettings() {
  const settings = state.settings || {};
  els.wxCommandInput.value = settings.wxCommand || 'wx';
  els.searchLimitInput.value = settings.searchResultLimit || 1000;
  els.deepLimitInput.value = settings.deepLimitPerChat || 0;
  els.liveFallbackSetting.checked = String(settings.liveFallback ?? 'true') === 'true';
  els.syncModeSelect.value = settings.syncMode || 'quick';
  els.leaveKeywordsInput.value = (settings.leaveKeywords || []).join('\n');
}

async function saveSettings() {
  const nextSettings = {
    wxCommand: els.wxCommandInput.value.trim() || 'wx',
    searchResultLimit: els.searchLimitInput.value || '1000',
    deepLimitPerChat: els.deepLimitInput.value || '0',
    liveFallback: els.liveFallbackSetting.checked ? 'true' : 'false',
    syncMode: els.syncModeSelect.value,
    leaveKeywords: splitLines(els.leaveKeywordsInput.value)
  };
  state.settings = await window.wxApp.updateSettings(nextSettings);
  await loadStats();
  await loadChats();
  await refreshOverview();
}

async function startSync(mode, quiet = false) {
  els.syncBar.hidden = false;
  els.syncTitle.textContent = mode === 'deep' ? '深度同步' : '快速同步';
  els.syncDetail.textContent = quiet ? '后台同步中…' : '正在连接 wx-cli…';
  els.syncFill.style.width = '5%';
  try {
    await window.wxApp.sync(mode);
    await refreshOverview();
    await loadChats();
    await loadStats();
    els.syncDetail.textContent = '同步完成';
    els.syncFill.style.width = '100%';
    setTimeout(() => {
      els.syncBar.hidden = true;
    }, 1500);
  } catch (error) {
    els.syncDetail.textContent = error?.message || '同步失败';
    els.syncFill.style.width = '100%';
  }
}

function handleEvent(event) {
  if (!event) return;
  if (event.type === 'sync-start') {
    els.syncBar.hidden = false;
    els.syncTitle.textContent = event.mode === 'deep' ? '深度同步' : '快速同步';
    els.syncDetail.textContent = `共 ${event.total || 0} 个会话`;
    els.syncFill.style.width = '8%';
    return;
  }
  if (event.type === 'sync-progress') {
    const progress = event.total ? Math.min(98, Math.round((event.current / event.total) * 100)) : 35;
    els.syncBar.hidden = false;
    els.syncTitle.textContent = `同步 ${event.chat || ''}`;
    els.syncDetail.textContent = `会话 ${event.current}/${event.total} · 累计 ${event.messages || 0} 条消息`;
    els.syncFill.style.width = `${progress}%`;
    return;
  }
  if (event.type === 'sync-complete') {
    els.syncTitle.textContent = '同步完成';
    els.syncDetail.textContent = `导入 ${event.messages || 0} 条消息，命中 ${event.leaveEvents || 0} 条请假记录`;
    els.syncFill.style.width = '100%';
    return;
  }
  if (event.type === 'sync-error') {
    els.syncTitle.textContent = '同步失败';
    els.syncDetail.textContent = event.message || 'wx-cli 连接失败';
    els.syncFill.style.width = '100%';
  }
}

async function copyCurrentContext() {
  if (!state.context?.context?.length) return;
  const text = state.context.context.map((item) => `${item.time_text || formatTimeShort(item.ts)} ${item.sender || item.sender_display || ''}: ${item.content}`).join('\n');
  await navigator.clipboard.writeText(text);
  els.copyContextBtn.textContent = '已复制';
  setTimeout(() => { els.copyContextBtn.textContent = '复制上下文'; }, 1200);
}

function normalizeMessageForView(message) {
  return {
    ...message,
    sender_display: message.sender_display || message.sender,
    time_text: message.time_text || formatTimeShort(message.ts)
  };
}

function pill(text) {
  return `<span class="pill">${escapeHtml(text)}</span>`;
}

function splitLines(value) {
  return String(value || '')
    .split(/[\r\n,，、;；/\\|]+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function cleanTextForView(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(value, maxLength) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trim()}...`;
}

function highlightText(text, query) {
  const source = escapeHtml(String(text || ''));
  const tokens = splitQueryTokens(query);
  if (!tokens.length) return source;
  let output = source;
  for (const token of tokens) {
    const safe = escapeRegex(token);
    if (!safe) continue;
    output = output.replace(new RegExp(safe, 'ig'), (match) => `<mark>${match}</mark>`);
  }
  return output;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitQueryTokens(value) {
  const parts = String(value || '')
    .split(/[\s,，、;；/\\|]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return parts.length ? parts : (String(value || '').trim() ? [String(value || '').trim()] : []);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function formatTimeShort(value) {
  if (!value) return '';
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateTimeText(value) {
  if (!value) return '';
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

init();
