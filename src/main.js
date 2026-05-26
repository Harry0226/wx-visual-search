import { app, BrowserWindow, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { WxClient, detectWxCommand } from './wx-client.js';
import { WxIndexService } from './indexer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let store;
let service;

async function bootstrap() {
  const dataDir = app.getPath('userData');
  const dbPath = path.join(dataDir, 'wx-visual-search.sqlite');
  const settingsPath = path.join(dataDir, 'wx-visual-search-settings.json');
  const savedSettings = readJson(settingsPath);
  const db = await openDatabase(dbPath);
  const wxCommand = savedSettings?.wxCommand || db.getSetting('wxCommand', 'wx');
  const resolvedWxCommand = await detectWxCommand(wxCommand);
  db.setSetting('wxCommand', resolvedWxCommand);
  db.setSetting('syncMode', savedSettings?.syncMode || db.getSetting('syncMode', 'quick'));
  db.setSetting('liveFallback', savedSettings?.liveFallback ?? db.getSetting('liveFallback', 'true'));
  db.setSetting('deepLimitPerChat', savedSettings?.deepLimitPerChat || db.getSetting('deepLimitPerChat', '0'));
  const storedSearchLimit = savedSettings?.searchResultLimit || db.getSetting('searchResultLimit', '1000');
  const normalizedSearchLimit = ['120', '500'].includes(String(storedSearchLimit)) ? '1000' : String(storedSearchLimit || '1000');
  db.setSetting('searchResultLimit', normalizedSearchLimit);
  db.setSetting('leaveKeywords', savedSettings?.leaveKeywords || db.getSetting('leaveKeywords', '请假\n病假\n事假'));
  db.save();

  const wxClient = new WxClient(resolvedWxCommand);
  service = new WxIndexService({
    db,
    wxClient,
    onEvent: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('wx:event', event);
      }
    }
  });
  store = { db, dbPath, settingsPath };

  createWindow();
  mainWindow.webContents.on('did-finish-load', async () => {
    mainWindow.webContents.send('wx:bootstrap', await getBootstrapPayload());
    mainWindow.webContents.send('wx:state', service.getOverview());
  });

  registerIpc();

  if (!savedSettings?.hasSeenWelcome) {
    db.setSetting('hasSeenWelcome', 'true');
    db.save();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1220,
    minHeight: 760,
    backgroundColor: '#050505',
    title: 'WX 透视工具',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
  mainWindow.webContents.on('did-finish-load', async () => {
    try {
      const bridgeReady = await mainWindow.webContents.executeJavaScript('Boolean(window.wxApp && window.wxApp.search)');
      console.log(`[wx-visual-search] preload bridge ready: ${bridgeReady}`);
    } catch (error) {
      console.error('[wx-visual-search] preload bridge check failed:', error);
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle('wx:get-bootstrap', async () => getBootstrapPayload());
  ipcMain.handle('wx:get-overview', async () => service.getOverview());
  ipcMain.handle('wx:search', async (_event, query, options) => service.search(query, options));
  ipcMain.handle('wx:get-chats', async () => service.getChats());
  ipcMain.handle('wx:get-chat-messages', async (_event, chatId, options) => service.getChatMessages(chatId, options));
  ipcMain.handle('wx:get-message-context', async (_event, messageKey) => service.getMessageContext(messageKey));
  ipcMain.handle('wx:get-stats', async () => service.getStats());
  ipcMain.handle('wx:sync', async (_event, mode) => service.sync({ mode }));
  ipcMain.handle('wx:get-settings', async () => service.getSettings());
  ipcMain.handle('wx:update-settings', async (_event, settings) => {
    service.saveSettings(settings);
    persistSettings(settings);
    return service.getSettings();
  });
  ipcMain.handle('wx:refresh-derived', async (_event, options) => {
    const result = await service.refreshDerivedData(options || {});
    return result.stats || service.getStats();
  });
  ipcMain.handle('wx:open-folder', async () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('wx:open-external', async (_event, url) => shell.openExternal(url));
}

async function getBootstrapPayload() {
  const overview = service.getOverview();
  const settings = service.getSettings();
  return {
    appName: 'WX 透视工具',
    version: app.getVersion(),
    wxCommand: settings.wxCommand,
    dataPath: store.dbPath,
    overview,
    settings
  };
}

function persistSettings(settings) {
  const payload = {
    wxCommand: settings.wxCommand,
    syncMode: settings.syncMode,
    liveFallback: settings.liveFallback,
    deepLimitPerChat: settings.deepLimitPerChat,
    searchResultLimit: settings.searchResultLimit,
    leaveKeywords: settings.leaveKeywords,
    hasSeenWelcome: true
  };
  fs.mkdirSync(path.dirname(store.settingsPath), { recursive: true });
  fs.writeFileSync(store.settingsPath, JSON.stringify(payload, null, 2), 'utf-8');
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

app.whenReady().then(async () => {
  await bootstrap();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try {
    store?.db?.save();
    store?.db?.close?.();
  } catch {
    // ignore shutdown persistence errors
  }
});
