const OFFSCREEN_PATH = 'offscreen.html';
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_PATH);
let creatingOffscreen;

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_URL],
  });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA'],
      justification: 'Capturar y convertir en tiempo real el audio de varias pestañas elegidas por producción.',
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

function validateServerUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Usá una dirección HTTP o HTTPS del servidor, sin usuario, contraseña ni parámetros.');
  }
  return url.toString().replace(/\/+$/u, '');
}

async function startTabCapture(message) {
  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('No encontramos la pestaña activa.');
  // Invoke tabCapture while the popup's explicit user gesture is still current.
  const streamIdPromise = chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const [streamId, tab] = await Promise.all([streamIdPromise, chrome.tabs.get(tabId)]);
  if (!tab.active) throw new Error('Volvé a la pestaña de la charla y abrí la extensión desde allí.');
  if (!tab.url || /^(chrome|chrome-extension|devtools|about):/u.test(tab.url)) {
    throw new Error('Chromium no permite capturar esta página. Abrí una pestaña web con la transmisión.');
  }
  const serverUrl = validateServerUrl(message.serverUrl);
  const config = message.config || {};
  const sessionId = String(config.sessionId || '');
  if (!sessionId || sessionId.length > 100) throw new Error('Elegí o creá una sesión válida.');

  // The popup prepares the offscreen consumer before the operator clicks Start.
  // If it was closed meanwhile, reopen it and consume the short-lived ID promptly.
  await ensureOffscreenDocument();
  const result = await chrome.runtime.sendMessage({
    type: 'offscreen-start-capture', tabId, streamId, serverUrl, config,
    tabTitle: tab.title || 'Pestaña Chromium',
  });
  if (!result?.ok) throw new Error(result?.error || 'No se pudo iniciar la captura de esta pestaña.');
  await chrome.storage.session.set({ [`capture:${tabId}`]: {
    tabId, sessionId, title: String(config.title || tab.title || 'Sala'), status: 'capturing', startedAt: Date.now(),
  } });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#14845c' });
  await chrome.action.setBadgeText({ tabId, text: 'CAP' });
  return { ok: true, sessionId, title: String(config.title || tab.title || 'Sala') };
}

async function sendOffscreen(message) {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [OFFSCREEN_URL] });
  if (!contexts.length) return { ok: true };
  return chrome.runtime.sendMessage(message);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'prepare-tab-capture') {
    ensureOffscreenDocument().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error?.message || 'No se pudo preparar la captura.' }));
    return true;
  }
  if (message?.type === 'start-tab-capture') {
    startTabCapture(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || 'Error al iniciar la captura.' }));
    return true;
  }
  if (message?.type === 'stop-tab-capture') {
    sendOffscreen({ type: 'offscreen-stop-capture', tabId: Number(message.tabId) })
      .then(async (result) => {
        await chrome.storage.session.remove(`capture:${Number(message.tabId)}`);
        await chrome.action.setBadgeText({ tabId: Number(message.tabId), text: '' });
        sendResponse(result || { ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error?.message || 'No se pudo detener la captura.' }));
    return true;
  }
  if (message?.type === 'capture-state') {
    (async () => {
      const { tabId, sessionId, title, status, reason } = message;
      if (!Number.isInteger(Number(tabId))) return;
      const key = `capture:${Number(tabId)}`;
      if (['stopped', 'disconnected', 'error'].includes(status)) {
        await chrome.storage.session.remove(key);
        await chrome.action.setBadgeText({ tabId: Number(tabId), text: status === 'error' ? 'ERR' : '' });
        if (status === 'error') await chrome.action.setBadgeBackgroundColor({ tabId: Number(tabId), color: '#bd493e' });
      } else {
        await chrome.storage.session.set({ [key]: { tabId: Number(tabId), sessionId, title, status, reason, updatedAt: Date.now() } });
        await chrome.action.setBadgeBackgroundColor({ tabId: Number(tabId), color: '#14845c' });
        await chrome.action.setBadgeText({ tabId: Number(tabId), text: status === 'live' ? 'LIVE' : 'CAP' });
      }
    })().catch(() => {});
    return false;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sendOffscreen({ type: 'offscreen-stop-capture', tabId }).catch(() => {});
  chrome.storage.session.remove(`capture:${tabId}`).catch(() => {});
});

chrome.tabCapture.onStatusChanged.addListener((info) => {
  if (info.status === 'stopped' || info.status === 'error') {
    chrome.action.setBadgeText({ tabId: info.tabId, text: '' }).catch(() => {});
  }
});
