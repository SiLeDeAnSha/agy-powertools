import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveCapturePlan,
  formatScreenshotFilename,
  readPngDimensions,
  createScreenshotController
} from '../lib/screenshot.mjs';

test('resolveCapturePlan selects foreground window in auto mode and builds fullscreen fallback', () => {
  const plan = resolveCapturePlan(
    {
      mode: 'window',
      windowId: 4242,
      appName: 'Google Chrome',
      displayRect: { x: -1920, y: 0, w: 1920, h: 1080 }
    },
    { mode: 'auto', noShadow: true, outPath: '/tmp/shot.png' }
  );
  assert.equal(plan.captureMode, 'window');
  assert.deepEqual(plan.args, ['-x', '-o', '-l', '4242', '/tmp/shot.png']);
  assert.deepEqual(plan.fallbackArgs, ['-x', '-R-1920,0,1920,1080', '/tmp/shot.png']);
  assert.equal(plan.labelZh, '窗口：Google Chrome');
  assert.equal(plan.labelEn, 'Window: Google Chrome');
});

test('resolveCapturePlan respects noShadow=false and falls back to fullscreen when target is fullscreen or Antigravity', () => {
  const withShadow = resolveCapturePlan(
    { mode: 'window', windowId: 99, appName: 'Terminal' },
    { mode: 'auto', noShadow: false, outPath: '/tmp/a.png' }
  );
  assert.deepEqual(withShadow.args, ['-x', '-l', '99', '/tmp/a.png']);

  const agyFront = resolveCapturePlan(
    { mode: 'fullscreen', reason: 'antigravity-frontmost', isAntigravity: true, displayRect: { x: 0, y: 0, w: 1512, h: 982 } },
    { mode: 'auto', noShadow: true, outPath: '/tmp/b.png' }
  );
  assert.equal(agyFront.captureMode, 'fullscreen');
  assert.deepEqual(agyFront.args, ['-x', '-R0,0,1512,982', '/tmp/b.png']);
  assert.equal(agyFront.fallbackArgs, null);

  const interactive = resolveCapturePlan(
    { mode: 'window', windowId: 99 },
    { mode: 'interactive', outPath: '/tmp/c.png' }
  );
  assert.equal(interactive.captureMode, 'interactive');
  assert.deepEqual(interactive.args, ['-i', '-x', '/tmp/c.png']);
});

test('formatScreenshotFilename produces sortable PNG name and readPngDimensions parses IHDR', () => {
  assert.equal(formatScreenshotFilename(new Date(2026, 10, 25, 9, 5, 3)), 'screenshot-20261125-090503.png');
  assert.equal(formatScreenshotFilename(new Date(2026, 10, 25, 9, 5, 3), 'ab12'), 'screenshot-20261125-090503-ab12.png');
  const pngHeader = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngHeader, 0);
  pngHeader.writeUInt32BE(2560, 16);
  pngHeader.writeUInt32BE(1440, 20);
  assert.deepEqual(readPngDimensions(pngHeader), { width: 2560, height: 1440 });
  assert.equal(readPngDimensions(Buffer.from('not-a-png')), null);
});

test('createScreenshotController captures window, pushes image to active CDP client, activates app, and falls back to clipboard on missing composer', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'agy-shot-test-'));
  try {
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const evalCalls = [];
    const scArgs = [];
    let activated = 0;
    let clipboardCalls = 0;
    let attachResult = { attached: true };

    const mockClient = {
      async send(method, params) {
        evalCalls.push({ method, params });
        return { result: { value: attachResult } };
      }
    };

    const spawnImpl = (cmd, args) => {
      const proc = new EventEmitter();
      proc.stderr = new EventEmitter();
      if (cmd === '/usr/sbin/screencapture') {
        scArgs.push(args);
        const outPath = args[args.length - 1];
        queueMicrotask(() => {
          writeFileSync(outPath, fakePng);
          proc.emit('close', 0);
        });
      }
      return proc;
    };

    const spawnSyncImpl = (cmd) => {
      if (cmd === '/usr/bin/osascript') clipboardCalls++;
      return { status: 0, stdout: '', stderr: '' };
    };

    const controller = createScreenshotController({
      dataDir: workDir,
      platform: 'darwin',
      getSettings: () => ({
        enabled: true,
        quickScreenshot: true,
        quickScreenshotMode: 'auto',
        quickScreenshotAutoFocus: true,
        quickScreenshotNoShadow: true
      }),
      pickTargetClient: () => mockClient,
      spawnImpl,
      spawnSyncImpl,
      tmpdirImpl: () => workDir,
      activateAppImpl: () => { activated++; }
    });

    const ok = await controller.performCapture({
      mode: 'window',
      windowId: 777,
      appName: 'Safari',
      displayRect: { x: 0, y: 0, w: 1440, h: 900 }
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.attached, true);
    assert.equal(ok.captureMode, 'window');
    assert.equal(activated, 1);
    assert.equal(clipboardCalls, 0);
    assert.deepEqual(scArgs[0].slice(0, 4), ['-x', '-o', '-l', '777']);
    assert.equal(evalCalls.length, 1);
    assert.match(evalCalls[0].params.expression, /receiveScreenshot/);
    assert.match(evalCalls[0].params.expression, /Safari/);

    // When no composer is mounted, controller copies to clipboard and notifies renderer
    attachResult = { attached: false, reason: 'no-composer' };
    const fallback = await controller.performCapture({
      mode: 'fullscreen',
      displayRect: { x: 0, y: 0, w: 1440, h: 900 }
    });
    assert.equal(fallback.ok, false);
    assert.equal(fallback.copiedToClipboard, true);
    assert.equal(clipboardCalls, 1);
    assert.equal(activated, 1);
    controller.stop();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
