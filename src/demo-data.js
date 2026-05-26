export const DEMO_CHATS = [
  {
    chat_id: 'demo-parent-1',
    chat_title: '三年级家长群',
    is_group: 1,
    chat_type: 'group'
  },
  {
    chat_id: 'demo-parent-2',
    chat_title: '李老师',
    is_group: 0,
    chat_type: 'private'
  },
  {
    chat_id: 'demo-parent-3',
    chat_title: '六2班家长群',
    is_group: 1,
    chat_type: 'group'
  }
];

export const DEMO_MESSAGES = [
  {
    chat_id: 'demo-parent-1',
    chat_title: '三年级家长群',
    chat_type: 'group',
    sender: '张同学妈妈',
    sender_username: 'wxid_demo_01',
    sender_display: '张同学妈妈',
    content: '老师您好，孩子今天发烧，请假一天。',
    message_type: 'text',
    ts: Date.now() - 86400000 * 2,
    time_text: '昨天 08:12',
    source: 'demo'
  },
  {
    chat_id: 'demo-parent-1',
    chat_title: '三年级家长群',
    chat_type: 'group',
    sender: '班主任',
    sender_username: 'wxid_demo_02',
    sender_display: '班主任',
    content: '收到，注意休息，课后我会补发作业。',
    message_type: 'text',
    ts: Date.now() - 86400000 * 2 + 240000,
    time_text: '昨天 08:16',
    source: 'demo'
  },
  {
    chat_id: 'demo-parent-2',
    chat_title: '李老师',
    chat_type: 'private',
    sender: '家长',
    sender_username: 'wxid_demo_03',
    sender_display: '家长',
    content: '老师，孩子今天晚到，可能要 9 点半左右到校。',
    message_type: 'text',
    ts: Date.now() - 86400000,
    time_text: '今天 07:40',
    source: 'demo'
  },
  {
    chat_id: 'demo-parent-3',
    chat_title: '六2班家长群',
    chat_type: 'group',
    sender: '王同学爸爸',
    sender_username: 'wxid_demo_04',
    sender_display: '王同学爸爸',
    content: '家里有事，请假半天，下午的活动可能参加不了。',
    message_type: 'text',
    ts: Date.now() - 86400000 * 3,
    time_text: '前天 15:20',
    source: 'demo'
  },
  {
    chat_id: 'demo-parent-3',
    chat_title: '六2班家长群',
    chat_type: 'group',
    sender: '班主任',
    sender_username: 'wxid_demo_02',
    sender_display: '班主任',
    content: '好的，收到。稍后把资料发到群里。',
    message_type: 'text',
    ts: Date.now() - 86400000 * 3 + 600000,
    time_text: '前天 15:30',
    source: 'demo'
  }
];

export const DEFAULT_LEAVE_KEYWORDS = [
  '请假',
  '病假',
  '事假',
  '晚到',
  '晚来',
  '发烧',
  '感冒',
  '肚子疼',
  '拉肚子',
  '去医院',
  '看病',
  '家里有事',
  '临时有事',
  '休息',
  '半天假',
  '一天假',
  '早退'
];
