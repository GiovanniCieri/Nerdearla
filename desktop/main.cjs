const path = require('node:path');
const { spawn } = require('node:child_process');
const { existsSync, mkdirSync } = require('node:fs');
const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const { pathToFileURL } = require('node:url');
const { buildChromiumLaunch, findChromiumExecutable, normalizeLaunchConfig } = require('./chromium-launch.cjs');

const SERVER_URL = process.env.NERDEARLA_URL || 'http://localhost:3001';
const serverOrigin = new URL(SERVER_URL).origin;
const preloadPath = path.join(__dirname, 'preload.cjs');
const overlays = new Map();
const overlayControls = new Map();
const overlayClickThroughBySession = new Map();
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
let nextChromiumDebugPort = Number(process.env.NERDEARLA_CHROMIUM_DEBUG_PORT_BASE);
if (!Number.isInteger(nextChromiumDebugPort) || nextChromiumDebugPort < 1024 || nextChromiumDebugPort > 65535) nextChromiumDebugPort = 0;

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
    if (!trustedUrl(url) && url !== pathToFileURL(path.join(__dirname, 'offline.html')).href) event.preventDefault();
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
  let failed = false;
  for (const [sessionId, window] of overlays.entries()) {
    if (window.isDestroyed()) continue;
    try {
      window.setIgnoreMouseEvents(enabled, { forward: true });
      overlayClickThroughBySession.set(sessionId, enabled);
    } catch { failed = true; }
  }
  if (failed) {
    for (const [sessionId, window] of overlays.entries()) {
      if (window.isDestroyed()) continue;
      try {
        window.setIgnoreMouseEvents(false);
        overlayClickThroughBySession.set(sessionId, false);
      } catch { /* The compositor may not support mouse passthrough. */ }
    }
    if (overlayHotkeys.move) globalShortcut.unregister('CommandOrControl+Shift+M');
    overlayHotkeys.move = false;
  }
  overlayClickThrough = [...overlays.keys()].every((sessionId) => overlayClickThroughBySession.get(sessionId) !== false);
}

function setSessionOverlayClickThrough(sessionId, enabled) {
  const overlay = overlays.get(sessionId);
  if (!overlay || overlay.isDestroyed()) return { ok: false, error: 'El overlay ya no está abierto.' };
  try {
    overlay.setIgnoreMouseEvents(enabled, { forward: true });
    overlayClickThroughBySession.set(sessionId, enabled);
    overlayClickThrough = [...overlays.keys()].every((id) => overlayClickThroughBySession.get(id) !== false);
    return { ok: true, clickThrough: enabled };
  } catch (error) {
    return { ok: false, error: `No se pudo cambiar el modo del overlay: ${error.message}` };
  }
}

function positionOverlayControls(sessionId) {
  const overlay = overlays.get(sessionId);
  const controls = overlayControls.get(sessionId);
  if (!overlay || overlay.isDestroyed() || !controls || controls.isDestroyed()) return;
  const bounds = overlay.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const width = 244;
  const height = 48;
  const x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, bounds.x + bounds.width - width));
  const y = bounds.y - height >= workArea.y ? bounds.y - height : Math.min(workArea.y + workArea.height - height, bounds.y + 6);
  controls.setBounds({ x, y, width, height }, false);
}

async function createOverlayControls(sessionId, overlay) {
  const existing = overlayControls.get(sessionId);
  if (existing && !existing.isDestroyed()) {
    positionOverlayControls(sessionId);
    existing.showInactive();
    return existing;
  }
  const controls = new BrowserWindow({
    x: 0,
    y: 0,
    width: 244,
    height: 48,
    frame: false,
    transparent: false,
    backgroundColor: '#111916',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    show: false,
    webPreferences: webPreferences(),
  });
  controls.setAlwaysOnTop(true, 'screen-saver');
  overlayControls.set(sessionId, controls);
  controls.on('closed', () => {
    if (overlayControls.get(sessionId) === controls) overlayControls.delete(sessionId);
    const captionWindow = overlays.get(sessionId);
    if (captionWindow && !captionWindow.isDestroyed()) captionWindow.close();
  });
  overlay.on('move', () => positionOverlayControls(sessionId));
  overlay.on('resize', () => positionOverlayControls(sessionId));
  const controlsUrl = new URL(pathToFileURL(path.join(__dirname, 'overlay-controls.html')).href);
  controlsUrl.searchParams.set('session', sessionId);
  await controls.loadURL(controlsUrl.href);
  if (controls.isDestroyed()) return null;
  positionOverlayControls(sessionId);
  controls.showInactive();
  return controls;
}

function registerOverlayHotkeys() {
  if (!overlayHotkeys.move) {
    overlayHotkeys.move = globalShortcut.register('CommandOrControl+Shift+M', () => {
      const allClickThrough = [...overlays.keys()].every((sessionId) => overlayClickThroughBySession.get(sessionId) !== false);
      setOverlayClickThrough(!allClickThrough);
    });
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
  overlayClickThroughBySession.clear();
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
  mainWindow.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || !failedUrl.startsWith(serverOrigin)) return;
    void mainWindow.loadFile(path.join(__dirname, 'offline.html'));
  });
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
    const hotkeys = registerOverlayHotkeys();
    await createOverlayControls(sessionId, current);
    const clickThrough = overlayClickThroughBySession.get(sessionId) !== false;
    return {
      ok: true,
      existing: true,
      clickThrough,
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
  overlayClickThroughBySession.set(sessionId, true);
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
  setSessionOverlayClickThrough(sessionId, true);
  overlay.on('closed', () => {
    if (overlays.get(sessionId) === overlay) overlays.delete(sessionId);
    overlayClickThroughBySession.delete(sessionId);
    const controls = overlayControls.get(sessionId);
    if (controls && !controls.isDestroyed()) controls.close();
    overlayControls.delete(sessionId);
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
    await createOverlayControls(sessionId, overlay);
    return {
      ok: true,
      existing: false,
      clickThrough: overlayClickThroughBySession.get(sessionId) !== false,
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

ipcMain.handle('nerdearla:overlay-control', (event, payload) => {
  const sessionId = String(payload?.sessionId || '');
  const action = String(payload?.action || '');
  const controls = overlayControls.get(sessionId);
  if (!controls || controls.isDestroyed() || controls.webContents !== event.sender) {
    return { ok: false, error: 'El control de este overlay ya no está disponible.' };
  }
  if (action === 'toggle-move') {
    return setSessionOverlayClickThrough(sessionId, overlayClickThroughBySession.get(sessionId) === false);
  }
  if (action === 'close') {
    const overlay = overlays.get(sessionId);
    if (overlay && !overlay.isDestroyed()) overlay.close();
    else controls.close();
    return { ok: true, closed: true };
  }
  return { ok: false, error: 'La acción del overlay no es válida.' };
});

ipcMain.handle('nerdearla:open-chromium-session', async (event, payload) => {
  if (!trustedUrl(event.sender?.getURL?.() || '')) return { ok: false, error: 'La apertura de salas solo se permite desde el panel local de Nerdearla.' };
  let config;
  try { config = normalizeLaunchConfig(payload); }
  catch (error) { return { ok: false, error: error.message }; }

  const chromium = findChromiumExecutable();
  if (!chromium) return { ok: false, error: 'No encontramos un navegador Chromium que pueda iniciarse. Instalá una versión funcional de Chromium, Brave, Edge o Chrome.' };
  const extensionDirectory = app.isPackaged
    ? path.join(process.resourcesPath, 'extension')
    : path.resolve(__dirname, '..', 'extension');
  if (!existsSync(path.join(extensionDirectory, 'manifest.json'))) {
    return { ok: false, error: 'No encontramos la extensión de captura incluida en esta instalación.' };
  }

  const profileDirectory = path.join(app.getPath('userData'), 'chromium-sessions', config.sessionId);
  try { mkdirSync(profileDirectory, { recursive: true }); }
  catch (error) { return { ok: false, error: `No se pudo preparar el perfil aislado de Chromium: ${error.message}` }; }
  const remoteDebuggingPort = nextChromiumDebugPort || null;
  if (nextChromiumDebugPort) nextChromiumDebugPort = nextChromiumDebugPort < 65535 ? nextChromiumDebugPort + 1 : 0;
  const { args } = buildChromiumLaunch({ profileDirectory, extensionDirectory, config, remoteDebuggingPort });
  return new Promise((resolve) => {
    let browser;
    try { browser = spawn(chromium, args, { detached: true, stdio: 'ignore', windowsHide: false }); }
    catch (error) { resolve({ ok: false, error: `El navegador no pudo iniciarse: ${error.message}` }); return; }
    const timeout = setTimeout(() => resolve({ ok: true, sessionId: config.sessionId, profileDirectory }), 1200);
    browser.once('spawn', () => {
      browser.unref();
      clearTimeout(timeout);
      resolve({ ok: true, sessionId: config.sessionId, profileDirectory });
    });
    browser.once('error', (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, error: `El navegador Chromium no pudo iniciarse: ${error.message}` });
    });
  });
});

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
      const controls = overlayControls.get('native-overlay-smoke');
      if (!controls || controls.isDestroyed()) throw new Error('No se creó la barra nativa para mover y cerrar el overlay.');
      const controlsUi = await controls.webContents.executeJavaScript(`({
        moveText: document.querySelector('#moveOverlay span')?.textContent || '',
        closeText: document.querySelector('#closeOverlay span')?.textContent || '',
        background: getComputedStyle(document.body).backgroundColor,
      })`, true);
      const overlayAlwaysOnTop = window.isAlwaysOnTop();
      const overlayMovable = window.isMovable();
      await controls.webContents.executeJavaScript(`document.querySelector('#moveOverlay').click()`, true);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const moveEnabled = overlayClickThroughBySession.get('native-overlay-smoke') === false;
      await controls.webContents.executeJavaScript(`document.querySelector('#moveOverlay').click()`, true);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const moveCanBeLocked = overlayClickThroughBySession.get('native-overlay-smoke') === true;
      await controls.webContents.executeJavaScript(`document.querySelector('#closeOverlay').click()`, true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const closeWorks = window.isDestroyed() && !overlayControls.has('native-overlay-smoke');
      const report = {
        buttonInvokedIPC: opener.pressed,
        captionLaunchChoicesAvailable: opener.choices,
        buttonToast: opener.toast,
        languageSynchronized: view.languageSynchronized,
        styleSynchronized: view.styleSynchronized,
        nativeTransparencyRequested: OVERLAY_WINDOW_OPTIONS.transparent,
        alwaysOnTop: overlayAlwaysOnTop,
        movable: overlayMovable,
        clickThrough: moveCanBeLocked,
        controlsUi,
        moveButtonEnablesDragging: moveEnabled,
        moveButtonRestoresClickThrough: moveCanBeLocked,
        closeButtonClosesOverlay: closeWorks,
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
        && view.lineCount === 1 && view.caption
        && controlsUi.moveText === 'Mover' && controlsUi.closeText === 'Cerrar'
        && moveEnabled && moveCanBeLocked && closeWorks;
      if (!window.isDestroyed()) window.close();
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
