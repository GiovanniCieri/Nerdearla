const path = require('node:path');
const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');

const SERVER_URL = process.env.NERDEARLA_URL || 'http://localhost:3001';
const serverOrigin = new URL(SERVER_URL).origin;
const preloadPath = path.join(__dirname, 'preload.cjs');
const overlays = new Map();
const overlayHotkeys = { move: false, close: false };
const DESKTOP_PROTOCOL = 'nerdearla';
let mainWindow = null;
let overlayClickThrough = false;
let pendingDeepLink = '';
const OVERLAY_WINDOW_OPTIONS = Object.freeze({
  width: 960,
  height: 220,
  minWidth: 420,
  minHeight: 100,
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  skipTaskbar: true,
  hasShadow: false,
  resizable: false,
  movable: true,
  show: false,
});

function trustedUrl(value) {
  try { return new URL(value).origin === serverOrigin; }
  catch { return false; }
}

function webPreferences() {
  return { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true };
}

function captionUrl({ sessionId, lang = 'original', demo = false }) {
  const url = new URL('/audience.html', SERVER_URL);
  url.searchParams.set('session', sessionId);
  url.searchParams.set('lang', lang === 'translation' ? 'translation' : 'original');
  url.searchParams.set('overlay', '1');
  if (demo) url.searchParams.set('demo', '1');
  return url.href;
}

function restrictNavigation(window) {
  window.webContents.on('will-navigate', (event, url) => {
    if (!trustedUrl(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!trustedUrl(url)) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1240,
        height: 820,
        minWidth: 900,
        minHeight: 620,
        backgroundColor: '#111916',
        webPreferences: webPreferences(),
      },
    };
  });
}

function parseCaptionDeepLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== `${DESKTOP_PROTOCOL}:` || url.hostname !== 'overlay') return null;
    const sessionId = url.searchParams.get('session') || '';
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) return null;
    return {
      sessionId,
      lang: url.searchParams.get('lang') === 'translation' ? 'translation' : 'original',
      demo: url.searchParams.get('demo') === '1',
    };
  } catch {
    return null;
  }
}

async function openCaptionDeepLink(value) {
  const payload = parseCaptionDeepLink(value);
  if (!payload) return false;
  if (!mainWindow || mainWindow.isDestroyed()) {
    const url = new URL('/audience.html', SERVER_URL);
    url.searchParams.set('session', payload.sessionId);
    url.searchParams.set('lang', payload.lang);
    if (payload.demo) url.searchParams.set('demo', '1');
    await createMainWindow(url.href, false);
  }
  const result = await createCaptionOverlay(payload, mainWindow.webContents);
  if (!result.ok) {
    if (!mainWindow.isDestroyed()) mainWindow.show();
    return false;
  }
  return true;
}

if (process.defaultApp && process.argv[1]) {
  app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL);
}

const hasDesktopLock = app.requestSingleInstanceLock();
if (!hasDesktopLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const deepLink = commandLine.find((argument) => argument.startsWith(`${DESKTOP_PROTOCOL}://`));
    if (deepLink) {
      void openCaptionDeepLink(deepLink);
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on('open-url', (event, value) => {
    event.preventDefault();
    if (app.isReady()) void openCaptionDeepLink(value);
    else pendingDeepLink = value;
  });
}

function setOverlayClickThrough(enabled) {
  overlayClickThrough = enabled;
  let failed = false;
  for (const window of overlays.values()) {
    if (window.isDestroyed()) continue;
    try { window.setIgnoreMouseEvents(overlayClickThrough, { forward: true }); }
    catch { failed = true; }
  }
  if (failed) {
    overlayClickThrough = false;
    for (const window of overlays.values()) {
      if (window.isDestroyed()) continue;
      try { window.setIgnoreMouseEvents(false); } catch { /* The compositor may not support mouse passthrough. */ }
    }
    if (overlayHotkeys.move) globalShortcut.unregister('CommandOrControl+Shift+M');
    overlayHotkeys.move = false;
  }
}

function registerOverlayHotkeys() {
  if (!overlayHotkeys.move) {
    overlayHotkeys.move = globalShortcut.register('CommandOrControl+Shift+M', () => {
      setOverlayClickThrough(!overlayClickThrough);
    });
    if (overlayHotkeys.move && overlays.size === 0) overlayClickThrough = true;
  }
  if (!overlayHotkeys.close) {
    overlayHotkeys.close = globalShortcut.register('CommandOrControl+Shift+X', () => {
      for (const window of overlays.values()) if (!window.isDestroyed()) window.close();
    });
  }
  return { move: overlayHotkeys.move, close: overlayHotkeys.close };
}

function releaseOverlayHotkeysWhenIdle() {
  if (overlays.size) return;
  if (overlayHotkeys.move) globalShortcut.unregister('CommandOrControl+Shift+M');
  if (overlayHotkeys.close) globalShortcut.unregister('CommandOrControl+Shift+X');
  overlayHotkeys.move = false;
  overlayHotkeys.close = false;
  overlayClickThrough = false;
}

function createMainWindow(startPath = '/', show = true) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 1000,
    minHeight: 680,
    show,
    backgroundColor: '#111916',
    webPreferences: webPreferences(),
  });
  restrictNavigation(mainWindow);
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow.loadURL(new URL(startPath, SERVER_URL).href);
}

async function createCaptionOverlay(payload, sender) {
  const sessionId = String(payload?.sessionId || '');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) {
    return { ok: false, error: 'El identificador de sesión no es válido.' };
  }
  const senderUrl = sender?.getURL?.() || '';
  if (!trustedUrl(senderUrl)) return { ok: false, error: 'El overlay solo se puede abrir desde Nerdearla Live.' };

  const current = overlays.get(sessionId);
  if (current && !current.isDestroyed()) {
    current.show();
    current.focus();
    const hotkeys = registerOverlayHotkeys();
    return {
      ok: true,
      existing: true,
      clickThrough: overlayClickThrough,
      moveShortcutAvailable: hotkeys.move,
      closeShortcutAvailable: hotkeys.close,
      moveShortcut: process.platform === 'darwin' ? '⌘⇧M' : 'Ctrl+Shift+M',
      closeShortcut: process.platform === 'darwin' ? '⌘⇧X' : 'Ctrl+Shift+X',
    };
  }

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  const overlay = new BrowserWindow({
    x: x + Math.max(0, Math.round((width - 960) / 2)),
    y: y + Math.max(0, Math.min(height - OVERLAY_WINDOW_OPTIONS.height, Math.round(height * 0.70))),
    ...OVERLAY_WINDOW_OPTIONS,
    webPreferences: webPreferences(),
  });
  overlay.setAlwaysOnTop(true);
  restrictNavigation(overlay);
  const hotkeys = registerOverlayHotkeys();
  overlay.webContents.on('before-input-event', (event, input) => {
    const closeShortcut = input.key === 'Escape'
      || (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'q')
      || (input.type === 'keyDown' && input.meta && input.shift && input.key.toLowerCase() === 'q');
    if (closeShortcut) {
      event.preventDefault();
      overlay.close();
    }
  });
  overlays.set(sessionId, overlay);
  if (hotkeys.move) setOverlayClickThrough(overlayClickThrough);
  overlay.on('closed', () => {
    if (overlays.get(sessionId) === overlay) overlays.delete(sessionId);
    releaseOverlayHotkeysWhenIdle();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('nerdearla:caption-overlay-closed', sessionId);
    }
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  try {
    await overlay.loadURL(captionUrl({ sessionId, lang: payload?.lang, demo: payload?.demo === true }));
    if (!overlay.isDestroyed()) overlay.show();
    return {
      ok: true,
      existing: false,
      clickThrough: overlayClickThrough,
      moveShortcutAvailable: hotkeys.move,
      closeShortcutAvailable: hotkeys.close,
      moveShortcut: process.platform === 'darwin' ? '⌘⇧M' : 'Ctrl+Shift+M',
      closeShortcut: process.platform === 'darwin' ? '⌘⇧X' : 'Ctrl+Shift+X',
    };
  } catch (error) {
    if (!overlay.isDestroyed()) overlay.close();
    return { ok: false, error: `No se pudo cargar la sala ${sessionId}: ${error.message}` };
  }
}

ipcMain.handle('nerdearla:open-caption-overlay', (event, payload) => createCaptionOverlay(payload, event.sender));

if (hasDesktopLock) app.whenReady().then(async () => {
  if (process.argv.includes('--smoke-test')) {
    try {
      await createMainWindow('/audience.html?session=native-overlay-smoke&demo=1', false);
    } catch (error) {
      console.error(`OVERLAY_SMOKE_FAILED opener page: ${error.message}`);
      app.exit(1);
      return;
    }
    const opener = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
      const button = document.querySelector('#openCaptionOverlay');
      if (!button) return resolve({ pressed: false, error: 'overlay button missing' });
      const pageOption = document.querySelector('#openCaptionPage');
      const desktopOption = document.querySelector('#openCaptionDesktop');
      if (!pageOption || !desktopOption) return resolve({ pressed: false, error: 'caption launch choices missing' });
      const deadline = Date.now() + 5000;
      const timer = setInterval(() => {
        if (button.getAttribute('aria-pressed') === 'true') {
          clearInterval(timer);
          resolve({ pressed: true, choices: true, toast: document.querySelector('.toast')?.innerText || '' });
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          resolve({ pressed: false, toast: document.querySelector('.toast')?.innerText || '' });
        }
      }, 50);
      button.click();
      desktopOption.click();
    })`, true);
    const result = { ok: opener.pressed, error: opener.error };
    const window = overlays.get('native-overlay-smoke');
    if (!result.ok || !window) {
      console.error(`OVERLAY_SMOKE_FAILED ${result.error || 'window was not created'}`);
      app.exit(1);
      return;
    }
    try {
      await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const read = () => {
          const stage = document.querySelector('#captionStage');
          const lines = Array.from(document.querySelectorAll('#captionLines .caption-line'));
          if (lines.length || Date.now() > deadline) return resolve(true);
          setTimeout(read, 50);
        };
        const deadline = Date.now() + 3000;
        read();
      })`, true);
      await mainWindow.webContents.executeJavaScript(`(() => {
        const styleKey = 'nerdearla.caption-style.v1';
        const langKey = 'nerdearla.caption-language.native-overlay-smoke';
        window.__nerdearlaSmokeBackup = {
          style: localStorage.getItem(styleKey),
          language: localStorage.getItem(langKey),
        };
        const fontSize = document.querySelector('[data-caption-setting="fontSize"]');
        const language = document.querySelector('#audienceLanguage');
        fontSize.value = '52';
        fontSize.dispatchEvent(new Event('input', { bubbles: true }));
        language.value = 'translation';
        language.dispatchEvent(new Event('change', { bubbles: true }));
      })()`, true);
      const view = await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const read = () => {
          const stage = document.querySelector('#captionStage');
          const lines = Array.from(document.querySelectorAll('#captionLines .caption-line'));
          const line = lines.at(-1);
          const synced = document.querySelector('#audienceLanguage')?.value === 'translation'
            && line?.classList.contains('caption-translation')
            && getComputedStyle(line).fontSize === '52px';
          if (synced || Date.now() > deadline) {
            resolve({
              bodyBackground: getComputedStyle(document.body).backgroundColor,
              stageBackground: getComputedStyle(stage).backgroundColor,
              dragRegion: getComputedStyle(stage).webkitAppRegion,
              toolbarDisplay: getComputedStyle(document.querySelector('#captionToolbar')).display,
              labelsDisplay: getComputedStyle(document.querySelector('.caption-label')).display,
              lineCount: lines.length,
              caption: line?.innerText || '',
              language: document.querySelector('#audienceLanguage')?.value || '',
              fontSize: line ? getComputedStyle(line).fontSize : '',
              languageSynchronized: synced,
              styleSynchronized: synced,
            });
            return;
          }
          setTimeout(read, 50);
        };
        const deadline = Date.now() + 3000;
        read();
      })`, true);
      await mainWindow.webContents.executeJavaScript(`(() => {
        const backup = window.__nerdearlaSmokeBackup;
        const restore = (key, value) => value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value);
        restore('nerdearla.caption-style.v1', backup.style);
        restore('nerdearla.caption-language.native-overlay-smoke', backup.language);
        delete window.__nerdearlaSmokeBackup;
      })()`, true);
      const report = {
        buttonInvokedIPC: opener.pressed,
        captionLaunchChoicesAvailable: opener.choices,
        buttonToast: opener.toast,
        languageSynchronized: view.languageSynchronized,
        styleSynchronized: view.styleSynchronized,
        nativeTransparencyRequested: OVERLAY_WINDOW_OPTIONS.transparent,
        alwaysOnTop: window.isAlwaysOnTop(),
        movable: window.isMovable(),
        clickThrough: overlayClickThrough,
        renderer: view,
      };
      console.log(`OVERLAY_SMOKE_RESULT ${JSON.stringify(report)}`);
      const passed = report.nativeTransparencyRequested && report.alwaysOnTop && report.movable
        && report.buttonInvokedIPC && report.captionLaunchChoicesAvailable && /Overlay transparente activo/.test(report.buttonToast)
        && report.languageSynchronized && report.styleSynchronized
        && /rgba\(0, 0, 0, 0\)/i.test(view.bodyBackground)
        && /rgba\(0, 0, 0, 0\)/i.test(view.stageBackground)
        && view.dragRegion === 'drag'
        && view.toolbarDisplay === 'none' && view.labelsDisplay === 'none'
        && view.lineCount === 1 && view.caption;
      window.close();
      app.exit(passed ? 0 : 1);
    } catch (error) {
      console.error(`OVERLAY_SMOKE_FAILED ${error.stack || error}`);
      if (!window.isDestroyed()) window.close();
      app.exit(1);
    }
    return;
  }
  const deepLink = process.argv.find((argument) => argument.startsWith(`${DESKTOP_PROTOCOL}://`)) || pendingDeepLink;
  if (deepLink && parseCaptionDeepLink(deepLink)) {
    openCaptionDeepLink(deepLink).then((opened) => {
      if (!opened && !mainWindow) createMainWindow();
    }).catch((error) => {
      console.error(`No se pudo abrir el overlay solicitado: ${error.message}`);
      if (!mainWindow) createMainWindow();
    });
  } else {
    createMainWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
