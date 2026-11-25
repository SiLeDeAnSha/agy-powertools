import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SCREENSHOT_MODES = Object.freeze(['auto', 'window', 'fullscreen', 'interactive']);
const DEFAULT_SOURCE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'mac-hotkey-helper.swift');
const HELPER_PREFIX = 'agy-hotkey-helper-';

export function formatScreenshotFilename(date = new Date(), suffix = '') {
  const pad = n => String(n).padStart(2, '0');
  const tail = suffix ? `-${suffix}` : '';
  return `screenshot-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${tail}.png`;
}

export function readPngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (
    buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47 ||
    buffer[4] !== 0x0d || buffer[5] !== 0x0a || buffer[6] !== 0x1a || buffer[7] !== 0x0a
  ) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

function validRect(rect) {
  return Boolean(
    rect &&
    typeof rect === 'object' &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.w) &&
    Number.isFinite(rect.h) &&
    rect.w > 0 &&
    rect.h > 0
  );
}

function fullscreenArgs(displayRect, outPath) {
  if (validRect(displayRect)) {
    const x = Math.round(displayRect.x);
    const y = Math.round(displayRect.y);
    const w = Math.max(1, Math.round(displayRect.w));
    const h = Math.max(1, Math.round(displayRect.h));
    // Attach coordinates directly to -R so negative display coordinates are not parsed as flags.
    return ['-x', `-R${x},${y},${w},${h}`, outPath];
  }
  return ['-x', outPath];
}

export function resolveCapturePlan(target = {}, { mode = 'auto', noShadow = true, outPath = '' } = {}) {
  const normalizedMode = SCREENSHOT_MODES.includes(mode) ? mode : 'auto';
  const appName = typeof target?.appName === 'string' ? target.appName.trim() : '';
  const windowId = Number.isInteger(target?.windowId) && target.windowId > 0 ? target.windowId : 0;
  const fullArgs = fullscreenArgs(target?.displayRect, outPath);

  if (normalizedMode === 'interactive') {
    return {
      captureMode: 'interactive',
      args: ['-i', '-x', outPath],
      fallbackArgs: null,
      appName,
      labelZh: '区域截图',
      labelEn: 'Selection'
    };
  }

  const wantsWindow =
    (normalizedMode === 'window' && windowId > 0) ||
    (normalizedMode === 'auto' && target?.mode === 'window' && windowId > 0);

  if (wantsWindow) {
    const winArgs = ['-x'];
    if (noShadow !== false) winArgs.push('-o');
    winArgs.push('-l', String(windowId), outPath);
    return {
      captureMode: 'window',
      args: winArgs,
      fallbackArgs: fullArgs,
      appName,
      labelZh: appName ? `窗口：${appName}` : '前台窗口',
      labelEn: appName ? `Window: ${appName}` : 'Foreground window'
    };
  }

  return {
    captureMode: 'fullscreen',
    args: fullArgs,
    fallbackArgs: null,
    appName,
    labelZh: '全屏',
    labelEn: 'Fullscreen'
  };
}

export function resolveMacAntigravityApp({ home = homedir(), existsImpl = existsSync } = {}) {
  for (const candidate of ['/Applications/Antigravity.app', join(home, 'Applications', 'Antigravity.app')]) {
    if (existsImpl(candidate)) return candidate;
  }
  return 'Antigravity';
}

export function ensureHotkeyHelper({
  sourcePath = DEFAULT_SOURCE_PATH,
  dataDir,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  existsImpl = existsSync,
  readFileImpl = readFileSync
} = {}) {
  if (platform !== 'darwin') return { supported: false, path: '', error: '仅支持 macOS' };
  if (!existsImpl(sourcePath)) return { supported: false, path: '', error: '缺少热键辅助源码' };
  const source = readFileImpl(sourcePath);
  const hash = createHash('sha256').update(source).digest('hex');
  const binDir = join(dataDir || join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-powertools'), 'bin');
  // Keep a stable binary path so macOS TCC permissions persist across plugin updates.
  const binPath = join(binDir, 'agy-hotkey-helper');
  const hashPath = `${binPath}.sha256`;
  if (existsImpl(binPath) && existsImpl(hashPath)) {
    try {
      if (readFileImpl(hashPath, 'utf8').trim() === hash) {
        return { supported: true, path: binPath, error: '' };
      }
    } catch {}
  }

  mkdirSync(binDir, { recursive: true });
  const tempPath = `${binPath}.${process.pid}.tmp`;
  const result = spawnSyncImpl('/usr/bin/swiftc', [
    '-O',
    sourcePath,
    '-o', tempPath,
    '-framework', 'Cocoa',
    '-framework', 'CoreGraphics',
    '-framework', 'ApplicationServices'
  ], {
    encoding: 'utf8',
    timeout: 60000
  });
  if (result.error || result.status !== 0 || !existsImpl(tempPath)) {
    try { if (existsImpl(tempPath)) unlinkSync(tempPath); } catch {}
    const detail = (result.stderr || result.error?.message || `exit ${result.status}`).trim().slice(0, 240);
    return { supported: false, path: '', error: `编译热键助手失败：${detail}` };
  }
  try {
    const rename = spawnSyncImpl('/bin/mv', ['-f', tempPath, binPath], { timeout: 5000 });
    if (rename.error || rename.status !== 0) {
      throw new Error(rename.error?.message || '移动编译产物失败');
    }
    try {
      spawnSyncImpl('/usr/bin/codesign', ['-f', '-s', '-', '--identifier', 'com.whitebr1ck.agy-powertools.hotkey-helper', binPath], { timeout: 5000 });
    } catch {}
    writeFileSync(hashPath, `${hash}\n`, 'utf8');
    for (const entry of readdirSync(binDir)) {
      if (entry.startsWith(HELPER_PREFIX)) {
        try { unlinkSync(join(binDir, entry)); } catch {}
      }
    }
  } catch (error) {
    return { supported: false, path: '', error: error.message };
  }
  return { supported: true, path: binPath, error: '' };
}

export function copyPngToClipboard(pngPath, { platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
  if (platform !== 'darwin' || !pngPath) return false;
  const res = spawnSyncImpl('/usr/bin/osascript', [
    '-e', 'on run argv',
    '-e', 'set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)',
    '-e', 'end run',
    pngPath
  ], {
    encoding: 'utf8',
    timeout: 5000
  });
  return !res.error && res.status === 0;
}

export function openMacPrivacyPane(kind = 'inputMonitoring', { platform = process.platform, spawnImpl = spawn } = {}) {
  if (platform !== 'darwin') return { ok: false, error: '仅支持 macOS' };
  const map = {
    inputMonitoring: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
    accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
  };
  const url = map[kind] || map.inputMonitoring;
  try {
    const child = spawnImpl('/usr/bin/open', [url], { detached: true, stdio: 'ignore' });
    child.unref?.();
    return { ok: true, kind, url };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function createScreenshotController({
  dataDir = join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'agy-powertools'),
  sourcePath = DEFAULT_SOURCE_PATH,
  platform = process.platform,
  getSettings = () => ({ enabled: true, quickScreenshot: true, quickScreenshotMode: 'auto', quickScreenshotAutoFocus: true, quickScreenshotNoShadow: true }),
  pickTargetClient = () => null,
  onStatus = () => {},
  ensureHelperImpl = ensureHotkeyHelper,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  readFileImpl = readFileSync,
  statImpl = statSync,
  unlinkImpl = unlinkSync,
  tmpdirImpl = tmpdir,
  activateAppImpl
} = {}) {
  let helperPath = '';
  let helperError = '';
  let child = null;
  let stopped = false;
  let capturing = false;
  let restartTimer = null;
  let restartDelayMs = 1500;
  let lastPermissions = {
    supported: platform === 'darwin',
    listening: false,
    accessibility: false,
    listenEvent: false,
    inputMonitoring: false,
    screenRecording: false
  };

  const activateApp = activateAppImpl || (() => {
    if (platform !== 'darwin') return;
    try {
      const app = resolveMacAntigravityApp();
      const proc = spawnImpl('/usr/bin/open', ['-a', app], { detached: true, stdio: 'ignore' });
      proc.unref?.();
    } catch {}
  });

  const ensureCompiled = () => {
    if (platform !== 'darwin') {
      helperError = '仅支持 macOS';
      return '';
    }
    if (helperPath && existsSync(helperPath)) return helperPath;
    const res = ensureHelperImpl({ sourcePath, dataDir, platform, spawnSyncImpl });
    if (res.supported && res.path) {
      helperPath = res.path;
      helperError = '';
      return helperPath;
    }
    helperError = res.error || '无法启动热键助手';
    return '';
  };

  const runScreencapture = args => new Promise(resolve => {
    try {
      const proc = spawnImpl('/usr/sbin/screencapture', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr?.on('data', chunk => { stderr += String(chunk); });
      proc.on('error', error => resolve({ ok: false, error: error.message }));
      proc.on('close', code => resolve({ ok: code === 0, code, error: stderr.trim() }));
    } catch (error) {
      resolve({ ok: false, error: error.message });
    }
  });

  const fileHasBytes = path => {
    try { return statImpl(path).size > 0; } catch { return false; }
  };

  const performCapture = async (target = {}, overrideMode = '') => {
    if (platform !== 'darwin') return { ok: false, error: '仅支持 macOS' };
    if (capturing) return { ok: false, busy: true };
    const settings = getSettings() || {};
    if (settings.enabled === false) return { ok: false, disabled: true };

    capturing = true;
    const outPath = join(tmpdirImpl(), `agy-shot-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
    try {
      const mode = overrideMode || settings.quickScreenshotMode || 'auto';
      const noShadow = settings.quickScreenshotNoShadow !== false;
      const plan = resolveCapturePlan(target, { mode, noShadow, outPath });

      let capRes = await runScreencapture(plan.args);
      let actualMode = plan.captureMode;
      let labelZh = plan.labelZh;
      let labelEn = plan.labelEn;

      if ((!capRes.ok || !fileHasBytes(outPath)) && plan.fallbackArgs) {
        try { unlinkImpl(outPath); } catch {}
        capRes = await runScreencapture(plan.fallbackArgs);
        actualMode = 'fullscreen';
        labelZh = '全屏';
        labelEn = 'Fullscreen';
      }

      if (!capRes.ok || !fileHasBytes(outPath)) {
        if (plan.captureMode === 'interactive') {
          return { ok: false, cancelled: true };
        }
        return { ok: false, error: capRes.error || '截屏失败，请检查屏幕录制权限' };
      }

      const bytes = readFileImpl(outPath);
      const dims = readPngDimensions(bytes);
      const base64 = bytes.toString('base64');
      const name = formatScreenshotFilename(new Date(), randomUUID().slice(0, 4));
      const client = pickTargetClient();

      if (!client) {
        const copied = copyPngToClipboard(outPath, { platform, spawnSyncImpl });
        return { ok: false, copiedToClipboard: copied, error: copied ? '未找到活动窗口，截图已复制到剪贴板' : '未找到活动的 Antigravity 窗口' };
      }

      const windowTitle = typeof target?.windowTitle === 'string' ? target.windowTitle.trim() : '';
      const appIcon = typeof target?.appIcon === 'string' ? target.appIcon : '';
      const bundleId = typeof target?.bundleId === 'string' ? target.bundleId : '';
      const reason = typeof target?.reason === 'string' ? target.reason : '';
      const payload = {
        base64,
        name,
        mimeType: 'image/png',
        captureMode: actualMode,
        appName: plan.appName || '',
        windowTitle,
        appIcon,
        bundleId,
        reason,
        width: dims?.width || 0,
        height: dims?.height || 0,
        labelZh,
        labelEn
      };
      const evalRes = await client.send('Runtime.evaluate', {
        expression: `(async()=>{if(typeof globalThis.__agyPowertools?.receiveScreenshot==='function')return await globalThis.__agyPowertools.receiveScreenshot(${JSON.stringify(payload)});if(typeof globalThis.__agyNativeAdapter?.attachFileToComposer==='function'){await globalThis.__agyNativeAdapter.attachFileToComposer({mode:'media',base64:${JSON.stringify(base64)},name:${JSON.stringify(name)},mimeType:'image/png'});return{attached:true};}return{attached:false,reason:'missing-adapter'};})()`,
        awaitPromise: true,
        returnByValue: true
      });
      const resultValue = evalRes?.result?.value;
      if (evalRes?.exceptionDetails || !resultValue?.attached) {
        const copied = copyPngToClipboard(outPath, { platform, spawnSyncImpl });
        if (copied) {
          await client.send('Runtime.evaluate', {
            expression: `globalThis.__agyPowertools?.notifyScreenshotFallback?.(${JSON.stringify({ labelZh, labelEn, copied: true })})`
          }).catch(() => {});
        }
        return { ok: false, attached: false, copiedToClipboard: copied, reason: resultValue?.reason || evalRes?.exceptionDetails?.text || 'attach-failed' };
      }

      if (settings.quickScreenshotAutoFocus !== false) {
        activateApp();
      }
      return { ok: true, attached: true, captureMode: actualMode, name, labelZh, labelEn };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      capturing = false;
      try { unlinkImpl(outPath); } catch {}
    }
  };

  const stopHelper = () => {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (child) {
      const proc = child;
      child = null;
      try { proc.kill('SIGTERM'); } catch {}
    }
    lastPermissions = { ...lastPermissions, listening: false };
  };

  const startHelper = () => {
    if (stopped || platform !== 'darwin' || child) return;
    const bin = ensureCompiled();
    if (!bin) {
      onStatus(helperError);
      return;
    }
    try {
      const proc = spawnImpl(bin, ['--hold-ms', '150'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      child = proc;
      let stdoutBuf = '';
      proc.stdout?.on('data', chunk => {
        stdoutBuf += String(chunk);
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() || '';
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.event === 'ready') {
            restartDelayMs = 1500;
            lastPermissions = {
              supported: true,
              listening: Boolean(msg.listening),
              accessibility: Boolean(msg.accessibility),
              listenEvent: Boolean(msg.listenEvent),
              inputMonitoring: Boolean(msg.inputMonitoring),
              screenRecording: Boolean(msg.screenRecording)
            };
          } else if (msg.event === 'capture') {
            const current = getSettings() || {};
            if (current.enabled !== false && current.quickScreenshot !== false) {
              void performCapture(msg);
            }
          }
        }
      });
      proc.on('close', () => {
        if (child === proc) {
          child = null;
          lastPermissions = { ...lastPermissions, listening: false };
          const current = getSettings() || {};
          if (!stopped && current.enabled !== false && current.quickScreenshot !== false) {
            restartTimer = setTimeout(() => {
              restartTimer = null;
              startHelper();
            }, restartDelayMs);
            restartDelayMs = Math.min(15000, restartDelayMs * 2);
          }
        }
      });
      proc.on('error', error => {
        helperError = error.message;
        if (child === proc) child = null;
      });
    } catch (error) {
      helperError = error.message;
    }
  };

  const syncSettings = (settings = getSettings()) => {
    if (stopped || platform !== 'darwin') return;
    if (settings && settings.enabled !== false && settings.quickScreenshot !== false) {
      startHelper();
    } else {
      stopHelper();
    }
  };

  const checkStatus = () => {
    if (platform !== 'darwin') {
      return { supported: false, listening: false, inputMonitoring: false, accessibility: false, screenRecording: false, error: '' };
    }
    const bin = ensureCompiled();
    if (!bin) {
      return { supported: true, listening: false, inputMonitoring: false, accessibility: false, screenRecording: false, error: helperError };
    }
    const res = spawnSyncImpl(bin, ['--check'], { encoding: 'utf8', timeout: 4000 });
    if (!res.error && res.status === 0) {
      try {
        const parsed = JSON.parse((res.stdout || '').trim());
        const hadListening = lastPermissions.listening;
        lastPermissions = {
          supported: true,
          listening: hadListening,
          accessibility: Boolean(parsed.accessibility),
          listenEvent: Boolean(parsed.listenEvent),
          inputMonitoring: Boolean(parsed.inputMonitoring),
          screenRecording: Boolean(parsed.screenRecording)
        };
        // macOS TCC can cache a denied state in the already-running watcher process;
        // respawn once a fresh --check probe observes granted permissions.
        const current = getSettings() || {};
        if (lastPermissions.inputMonitoring && !hadListening && current.enabled !== false && current.quickScreenshot !== false) {
          stopHelper();
          startHelper();
        }
      } catch {}
    }
    return { ...lastPermissions, running: Boolean(child), error: helperError };
  };

  const requestPermissions = () => {
    if (platform !== 'darwin') return checkStatus();
    const bin = ensureCompiled();
    if (!bin) return checkStatus();
    spawnSyncImpl(bin, ['--request-permissions'], { encoding: 'utf8', timeout: 5000 });
    return checkStatus();
  };

  const captureNow = async ({ mode } = {}) => {
    if (platform !== 'darwin') return { ok: false, error: '仅支持 macOS' };
    const bin = ensureCompiled();
    let target = {};
    if (bin) {
      const probed = spawnSyncImpl(bin, ['--probe'], { encoding: 'utf8', timeout: 4000 });
      if (!probed.error && probed.status === 0) {
        try { target = JSON.parse((probed.stdout || '').trim()); } catch {}
      }
    }
    return await performCapture(target, mode);
  };

  const stop = () => {
    stopped = true;
    stopHelper();
  };

  return {
    syncSettings,
    status: checkStatus,
    requestPermissions,
    openPermissionSettings: kind => openMacPrivacyPane(kind, { platform, spawnImpl }),
    captureNow,
    performCapture,
    stop
  };
}
