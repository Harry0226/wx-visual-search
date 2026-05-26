import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.js';
import { WxIndexService } from '../src/indexer.js';

async function createService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-search-test-'));
  const db = await openDatabase(path.join(dir, 'test.sqlite'));
  const wxClient = {
    sessions: async () => ({ sessions: [] }),
    history: async () => ({ messages: [] }),
    search: async () => ({ results: [] })
  };
  return { db, service: new WxIndexService({ db, wxClient }) };
}

function addChat(db, chat) {
  db.upsertChat({
    chat_id: chat.chat_id,
    chat_title: chat.chat_title,
    is_group: chat.is_group,
    chat_type: chat.is_group ? 'group' : 'private',
    alias: chat.chat_title,
    source: 'wx'
  });
}

function addMessage(db, message) {
  addChat(db, {
    chat_id: message.chat_id,
    chat_title: message.chat_title,
    is_group: message.is_group
  });
  db.upsertMessage({
    message_key: message.message_key,
    chat_id: message.chat_id,
    chat_title: message.chat_title,
    chat_type: message.is_group ? 'group' : 'private',
    is_group: message.is_group,
    sender: message.sender || '家长',
    sender_display: message.sender || '家长',
    sender_username: message.sender_username || '',
    content: message.content,
    message_type: 'text',
    ts: message.ts,
    time_text: '',
    local_id: message.local_id || '',
    raw_json: {},
    source: 'wx'
  });
}

async function testTimeFirstPrivateBeforeGroup() {
  const { db, service } = await createService();
  addMessage(db, {
    message_key: 'old-group',
    chat_id: 'group-1',
    chat_title: '初三家长群',
    is_group: true,
    content: '请假，今天家里有事',
    ts: 1700000000000
  });
  addMessage(db, {
    message_key: 'new-private',
    chat_id: 'parent-1',
    chat_title: '张同学妈妈',
    is_group: false,
    content: '老师您好，孩子今天想请假',
    ts: 1800000000000
  });
  addMessage(db, {
    message_key: 'same-time-group',
    chat_id: 'group-2',
    chat_title: '晚自习家长群',
    is_group: true,
    content: '老师请假',
    ts: 1800000000000
  });

  const result = await service.search('请假', { allowLiveFallback: false, type: 'text', limit: 10 });

  assert.deepEqual(result.items.map((item) => item.message_key), [
    'new-private',
    'same-time-group',
    'old-group'
  ]);
}

async function testDefaultHidesNoisyChats() {
  const { db, service } = await createService();
  addMessage(db, {
    message_key: 'noise',
    chat_id: 'filehelper',
    chat_title: '文件传输助手',
    is_group: false,
    content: '林忆雅2.23请假',
    ts: 1800000000000
  });
  addMessage(db, {
    message_key: 'real-parent',
    chat_id: 'parent-2',
    chat_title: '李同学妈妈',
    is_group: false,
    content: '老师，孩子今天请假',
    ts: 1700000000000
  });

  const result = await service.search('请假', { allowLiveFallback: false, type: 'text', limit: 10 });

  assert.deepEqual(result.items.map((item) => item.message_key), ['real-parent']);
}

async function testPrivateComesBeforeGroupWithinSameMinute() {
  const { db, service } = await createService();
  addMessage(db, {
    message_key: 'group-later-second',
    chat_id: 'group-4',
    chat_title: '请假统计群',
    is_group: true,
    content: '老师我请假',
    ts: 1800000059000
  });
  addMessage(db, {
    message_key: 'private-earlier-second',
    chat_id: 'parent-4',
    chat_title: '刘同学妈妈',
    is_group: false,
    content: '孩子请假',
    ts: 1800000001000
  });

  const result = await service.search('请假', { allowLiveFallback: false, type: 'text', limit: 10 });

  assert.deepEqual(result.items.map((item) => item.message_key), [
    'private-earlier-second',
    'group-later-second'
  ]);
}

async function testInfersGroupFromChatTitle() {
  const { db, service } = await createService();
  addMessage(db, {
    message_key: 'title-group',
    chat_id: 'title-group',
    chat_title: '\u5f20\u68d2\u68d2\u5bb6\u957f\u7fa4',
    is_group: false,
    content: '\u8001\u5e08\u8bf7\u5047',
    ts: 1800000059000
  });
  addMessage(db, {
    message_key: 'title-private',
    chat_id: 'title-private',
    chat_title: '\u5f20\u68d2\u68d2\u5988\u5988',
    is_group: false,
    content: '\u8001\u5e08\u8bf7\u5047',
    ts: 1800000001000
  });

  const result = await service.search('\u8bf7\u5047', { allowLiveFallback: false, type: 'text', limit: 10 });

  assert.deepEqual(result.items.map((item) => item.message_key), [
    'title-private',
    'title-group'
  ]);
  assert.equal(result.items[1].chat_type, 'group');
}

async function testDeduplicatesSameMessage() {
  const { db, service } = await createService();
  for (const key of ['dup-a', 'dup-b']) {
    addMessage(db, {
      message_key: key,
      chat_id: 'parent-3',
      chat_title: '王同学妈妈',
      is_group: false,
      sender: '王同学妈妈',
      content: '今天发烧请假一天',
      ts: 1800000000000
    });
  }

  const result = await service.search('请假', { allowLiveFallback: false, type: 'text', limit: 10 });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].message_key, 'dup-a');
}

await testTimeFirstPrivateBeforeGroup();
await testDefaultHidesNoisyChats();
await testPrivateComesBeforeGroupWithinSameMinute();
await testInfersGroupFromChatTitle();
await testDeduplicatesSameMessage();

console.log('search behavior tests passed');
