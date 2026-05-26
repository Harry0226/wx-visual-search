import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 8_000;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const needsShell = /\.(cmd|bat)$/i.test(command);
    execFile(command, args, {
      shell: needsShell,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      timeout: DEFAULT_TIMEOUT_MS,
      ...options
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        if (error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT') {
          error.message = `wx-cli command timed out: ${command} ${args.join(' ')}`;
        }
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseMaybeJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export class WxClient {
  constructor(command = 'wx') {
    const runtime = getWxRuntime(command || 'wx');
    this.command = runtime.command;
    this.baseArgs = runtime.baseArgs;
  }

  args(items) {
    return [...this.baseArgs, ...items];
  }

  async sessions(limit = 500) {
    const { stdout } = await run(this.command, this.args(['sessions', '--json', '-n', String(limit)]), { timeout: 10_000 });
    return parseMaybeJson(stdout);
  }

  async history(chat, options = {}) {
    const args = ['history', chat, '--json', '-n', String(options.limit ?? 200)];
    if (options.offset) args.push('--offset', String(options.offset));
    if (options.since) args.push('--since', options.since);
    if (options.until) args.push('--until', options.until);
    if (options.type) args.push('--type', options.type);
    const { stdout } = await run(this.command, this.args(args), { timeout: 10_000 });
    return parseMaybeJson(stdout);
  }

  async search(keyword, options = {}) {
    const args = ['search', keyword, '--json', '-n', String(options.limit ?? 50)];
    if (options.inChats?.length) {
      for (const chat of options.inChats) args.push('--in', chat);
    }
    if (options.since) args.push('--since', options.since);
    if (options.until) args.push('--until', options.until);
    if (options.type) args.push('--type', options.type);
    const { stdout } = await run(this.command, this.args(args), { timeout: 8_000 });
    return parseMaybeJson(stdout);
  }

  async export(chat, options = {}) {
    const args = ['export', chat, '-f', options.format || 'json', '-n', String(options.limit ?? 500)];
    if (options.output) args.push('-o', options.output);
    if (options.since) args.push('--since', options.since);
    if (options.until) args.push('--until', options.until);
    const { stdout } = await run(this.command, this.args(args), { timeout: 12_000 });
    return parseMaybeJson(stdout) || stdout;
  }
}

export async function detectWxCommand(preferred = 'wx') {
  const npmBin = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '';
  const preferredLooksExplicit = /[\\/]/.test(preferred) || /\.(cmd|exe|js)$/i.test(preferred);
  const candidates = [
    preferredLooksExplicit ? preferred : '',
    npmBin ? path.join(npmBin, 'wx.cmd') : '',
    npmBin ? path.join(npmBin, 'wx.exe') : '',
    preferredLooksExplicit ? '' : preferred,
    'wx.cmd',
    'wx.exe',
    'wx'
  ].filter(Boolean);
  for (const command of candidates) {
    try {
      const runtime = getWxRuntime(command);
      const { stdout } = await run(runtime.command, [...runtime.baseArgs, '--version'], { timeout: 2_500 });
      if (String(stdout || '').trim()) return command;
    } catch {
      continue;
    }
  }
  return preferred;
}

function getWxRuntime(command) {
  const normalized = command || 'wx';
  if (/\.cmd$/i.test(normalized)) {
    const scriptPath = path.join(path.dirname(normalized), 'node_modules', '@jackwener', 'wx-cli', 'bin', 'wx.js');
    if (fs.existsSync(scriptPath)) {
      return {
        command: 'node',
        baseArgs: [scriptPath]
      };
    }
  }
  return {
    command: normalized,
    baseArgs: []
  };
}
