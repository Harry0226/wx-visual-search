const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wxApp', {
  bootstrap: () => ipcRenderer.invoke('wx:get-bootstrap'),
  overview: () => ipcRenderer.invoke('wx:get-overview'),
  search: (query, options) => ipcRenderer.invoke('wx:search', query, options),
  chats: () => ipcRenderer.invoke('wx:get-chats'),
  chatMessages: (chatId, options) => ipcRenderer.invoke('wx:get-chat-messages', chatId, options),
  messageContext: (messageKey) => ipcRenderer.invoke('wx:get-message-context', messageKey),
  stats: () => ipcRenderer.invoke('wx:get-stats'),
  sync: (mode) => ipcRenderer.invoke('wx:sync', mode),
  settings: () => ipcRenderer.invoke('wx:get-settings'),
  updateSettings: (settings) => ipcRenderer.invoke('wx:update-settings', settings),
  refreshDerived: () => ipcRenderer.invoke('wx:refresh-derived'),
  openFolder: () => ipcRenderer.invoke('wx:open-folder'),
  openExternal: (url) => ipcRenderer.invoke('wx:open-external', url),
  onEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('wx:event', handler);
    return () => ipcRenderer.removeListener('wx:event', handler);
  }
});
