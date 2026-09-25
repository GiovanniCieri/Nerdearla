const $ = (selector) => document.querySelector(selector);
let activeTab;
let sessions = [];
let currentCapture = null;
let apiConfig = null;
let connectedServerUrl = null;
let launchConfig = null;

function showMessage(text, tone = '') {
  $('#statusMessage').textContent = text;
  $('#statusMessage').className = tone;
}

function updateEarlyTranslationNotice() {
  $('#earlyTranslationHelp').textContent = $('#earlyTranslationInput').checked
    ? 'Muestra texto provisional antes de la versión final y consume cuota adicional.'
    : 'Los borradores pueden aparecer antes, con mayor consumo de cuota.';
}

async function findSourceTab() {
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused?.id && /^https?:/u.test(focused.url || '')) return focused;
  const tabs = await chrome.tabs.query({});
  const webTabs = tabs.filter((tab) => tab.id && /^https?:/u.test(tab.url || ''));
  if (!webTabs.length) return null;
  const launches = await chrome.storage.session.get(webTabs.map((tab) => `launch:${tab.id}`));
  return webTabs.find((tab) => launches[`launch:${tab.id}`]) || null;
}

function normalizeServerUrl() {
  const url = new URL($('#serverUrl').value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Ingresá la dirección HTTP o HTTPS del servidor, sin ruta ni parámetros.');
  }
  return url.toString().replace(/\/+$/u, '');
}

async function loadServer(requestPermission = false) {
  const selectedSessionId = launchConfig?.sessionId || $('#sessionSelect').value || 'new';
  let serverUrl;
  try { serverUrl = normalizeServerUrl(); }
  catch (error) { $('#serverStatus').className = 'server-status offline'; showMessage(error.message, 'error'); return; }
  await chrome.storage.local.set({ serverUrl });
  const url = new URL(serverUrl);
  const originPattern = `${url.origin}/*`;
  if (!await chrome.permissions.contains({ origins: [originPattern] })) {
    if (!requestPermission || !await chrome.permissions.request({ origins: [originPattern] })) {
      $('#serverStatus').className = 'server-status offline';
      $('#serverHint').textContent = 'Guardá la dirección para conceder acceso al host de tu servidor.';
      $('#captureButton').disabled = !activeTab;
      showMessage('La extensión necesita permiso del navegador para consultar este servidor.');
      return false;
    }
  }
  try {
    const [healthResponse, sessionsResponse, configResponse] = await Promise.all([
      fetch(`${serverUrl}/api/health`, { cache: 'no-store' }),
      fetch(`${serverUrl}/api/sessions`, { cache: 'no-store' }),
      fetch(`${serverUrl}/api/config`, { cache: 'no-store' }),
    ]);
    if (!healthResponse.ok) throw new Error(`Servidor respondió HTTP ${healthResponse.status}.`);
    const health = await healthResponse.json();
    if (!sessionsResponse.ok) throw new Error(`No se pudieron cargar las sesiones (HTTP ${sessionsResponse.status}).`);
    sessions = await sessionsResponse.json();
    apiConfig = configResponse.ok ? await configResponse.json() : null;
    connectedServerUrl = serverUrl;
    $('#serverStatus').className = 'server-status online';
    const localAvailable = Boolean(apiConfig?.localProviderAvailable);
    $('#engineInput').querySelector('[value="gemini"]').disabled = !health.configured;
    $('#engineInput').querySelector('[value="local"]').disabled = !localAvailable;
    $('#engineInput').querySelector('[value="auto"]').disabled = !health.configured || !localAvailable || !apiConfig?.autoFallbackToLocal;
    if ($('#engineInput').selectedOptions[0]?.disabled) $('#engineInput').value = localAvailable ? 'local' : 'gemini';
    $('#serverHint').textContent = health.configured ? 'Servidor conectado · Gemini configurado' : localAvailable ? 'Servidor conectado · WhisperLiveKit local disponible' : 'Servidor conectado · falta configurar un motor de audio';
    populateSessions(selectedSessionId);
    $('#captureButton').disabled = !activeTab || (!currentCapture && !health.configured && !localAvailable);
    if (currentCapture) showMessage(`${currentCapture.title} · ${currentCapture.status === 'live' ? 'transcripción activa' : 'captura conectada'}`);
    return true;
  } catch (error) {
    $('#serverStatus').className = 'server-status offline';
    showMessage(`${error.message} Si aparece un error de origen, verificá CAPTURE_EXTENSION_ID y reiniciá Docker.`, 'error');
    return false;
  }
}

function populateSessions(selectedId = 'new') {
  const select = $('#sessionSelect');
  select.replaceChildren(new Option('＋ Crear una sesión', 'new'));
  for (const session of sessions) {
    const active = ['live', 'connecting', 'reconnecting'].includes(session.status);
    const option = new Option(`${session.title} · ${active ? 'en vivo' : session.status}`, session.id);
    option.disabled = active;
    select.add(option);
  }
  select.value = selectedId;
  updateSessionFields();
}

function updateSessionFields() {
  const selected = sessions.find((session) => session.id === $('#sessionSelect').value);
  $('#newSessionFields').hidden = Boolean(selected);
  if (!selected) {
    $('#engineInput').value = apiConfig?.configured ? 'gemini' : apiConfig?.localProviderAvailable ? 'local' : 'gemini';
    return;
  }
  $('#titleInput').value = selected.title || '';
  $('#speakerInput').value = selected.speaker || '';
  $('#languageInput').value = ['en', 'es', 'pt', 'auto'].includes(selected.language) ? selected.language : 'en';
  $('#translateInput').value = selected.translateTo || 'none';
  const savedEngine = selected.requestedEngine || selected.engine;
  $('#engineInput').value = ['local', 'auto'].includes(savedEngine) ? savedEngine : 'gemini';
}

function audienceHref(sessionId) {
  const base = normalizeServerUrl();
  return `${base}/audience.html?session=${encodeURIComponent(sessionId)}&lang=translation`;
}

async function askServerPermission(serverUrl) {
  const origin = new URL(serverUrl).origin;
  const pattern = `${origin}/*`;
  if (await chrome.permissions.contains({ origins: [pattern] })) return true;
  return chrome.permissions.request({ origins: [pattern] });
}

async function connectCurrentTab() {
  if (!activeTab?.id) throw new Error('No encontramos la pestaña activa.');
  if (!activeTab.url || /^(chrome|chrome-extension|devtools|about):/u.test(activeTab.url)) throw new Error('Abrí la pestaña web de la charla antes de conectar el audio.');
  const serverUrl = normalizeServerUrl();
  if (serverUrl !== connectedServerUrl || !apiConfig) throw new Error('Guardá la dirección del servidor y esperá a que aparezca como conectado antes de iniciar audio.');
  const selected = sessions.find((session) => session.id === $('#sessionSelect').value);
  const title = selected?.title || launchConfig?.title || $('#titleInput').value.trim();
  if (!title) throw new Error('Escribí el nombre de la sala o charla.');
  const language = selected?.language || $('#languageInput').value;
  const translateTo = selected ? selected.translateTo : $('#translateInput').value;
  const config = {
    sessionId: selected?.id || launchConfig?.sessionId || `s-${crypto.randomUUID()}`,
    title,
    speaker: selected?.speaker || launchConfig?.speaker || $('#speakerInput').value.trim(),
    speakerRoster: selected?.speakerRoster || ((launchConfig?.speaker || $('#speakerInput').value.trim()) ? [launchConfig?.speaker || $('#speakerInput').value.trim()] : []),
    language: selected?.language || launchConfig?.language || language,
    translate: Boolean(translateTo && translateTo !== 'none'),
    translateTo: selected ? (translateTo && translateTo !== 'none' ? translateTo : null)
      : launchConfig?.translateTo || (translateTo && translateTo !== 'none' ? translateTo : null),
    audioSource: 'tab',
    engine: selected && ['local', 'auto'].includes(selected.requestedEngine || selected.engine)
      ? selected.requestedEngine || selected.engine
      : launchConfig?.engine || $('#engineInput').value,
    glossary: selected?.glossary || launchConfig?.glossary || $('#glossaryInput').value.split(/[\n,;]+/u).map((term) => term.trim()).filter(Boolean).slice(0, 100),
    earlyTranslation: Boolean(selected?.earlyTranslation || launchConfig?.earlyTranslation || $('#earlyTranslationInput').checked),
    sourceUrl: activeTab.url,
  };
  $('#captureButton').disabled = true;
  showMessage('Abriendo captura independiente de esta pestaña…');
  const result = await chrome.runtime.sendMessage({ type: 'start-tab-capture', tabId: activeTab.id, serverUrl, config });
  if (!result?.ok) throw new Error(result?.error || 'No se pudo iniciar la captura.');
  currentCapture = { tabId: activeTab.id, sessionId: result.sessionId, title: result.title, status: 'capturing' };
  $('#captureButton').textContent = 'Detener audio de esta pestaña';
  $('#captureButton').classList.add('stop');
  $('#audienceLink').href = audienceHref(result.sessionId);
  $('#audienceLink').hidden = false;
  showMessage(`Audio conectado a «${result.title}». Abrí otra pestaña y repetí para cada sala.`);
}

async function stopCurrentTab() {
  $('#captureButton').disabled = true;
  showMessage('Deteniendo solo esta pestaña…');
  const result = await chrome.runtime.sendMessage({ type: 'stop-tab-capture', tabId: activeTab.id });
  if (!result?.ok) throw new Error(result?.error || 'No se pudo detener la captura.');
  currentCapture = null;
  $('#captureButton').textContent = 'Conectar esta pestaña';
  $('#captureButton').classList.remove('stop');
  $('#sessionSelect').disabled = false;
  $('#audienceLink').hidden = true;
  $('#captureButton').disabled = false;
  await loadServer();
  showMessage('Captura detenida. La sesión queda pausada para reanudarla.');
}

async function initialize() {
  const stored = await chrome.storage.local.get({ serverUrl: 'http://localhost:3001' });
  $('#serverUrl').value = stored.serverUrl;
  activeTab = await findSourceTab();
  if (activeTab) {
    $('#activeTabTitle').textContent = activeTab.title || 'Pestaña activa';
    $('#activeTabUrl').textContent = activeTab.url || '';
    const captureState = await chrome.storage.session.get(`capture:${activeTab.id}`);
    currentCapture = captureState[`capture:${activeTab.id}`] || null;
    const launchState = await chrome.storage.session.get(`launch:${activeTab.id}`);
    launchConfig = launchState[`launch:${activeTab.id}`] || null;
    if (!currentCapture) {
      const browserCaptures = await chrome.tabCapture.getCapturedTabs();
      if (browserCaptures.some((capture) => capture.tabId === activeTab.id && capture.status !== 'stopped')) {
        currentCapture = { tabId: activeTab.id, status: 'capturing', title: activeTab.title, sessionId: '' };
      }
    }
  }
  const prepared = await chrome.runtime.sendMessage({ type: 'prepare-tab-capture' });
  if (!prepared?.ok) showMessage(prepared?.error || 'El capturador de pestañas no pudo prepararse.', 'error');
  if (currentCapture) {
    $('#sessionSelect').disabled = true;
    $('#newSessionFields').hidden = true;
    $('#captureButton').textContent = 'Detener audio de esta pestaña';
    $('#captureButton').classList.add('stop');
    $('#audienceLink').hidden = !currentCapture.sessionId;
    if (currentCapture.sessionId) $('#audienceLink').href = audienceHref(currentCapture.sessionId);
  }
  await loadServer();
  if (launchConfig && !sessions.some((session) => session.id === $('#sessionSelect').value)) {
    $('#sessionSelect').value = 'new';
    $('#newSessionFields').hidden = false;
    $('#titleInput').value = launchConfig.title || '';
    $('#speakerInput').value = launchConfig.speaker || '';
    $('#languageInput').value = launchConfig.language || 'en';
    $('#translateInput').value = launchConfig.translateTo || 'es';
    $('#glossaryInput').value = (launchConfig.glossary || []).join(', ');
    $('#earlyTranslationInput').checked = Boolean(launchConfig.earlyTranslation);
    updateEarlyTranslationNotice();
    if ($('#engineInput').querySelector(`[value="${CSS.escape(launchConfig.engine || 'gemini')}"]`)) {
      $('#engineInput').value = launchConfig.engine || 'gemini';
    }
    $('#notice').textContent = `Chromium independiente · sesión «${launchConfig.title}». Conectá esta pestaña para iniciar los subtítulos.`;
  }
}

$('#sessionSelect').addEventListener('change', updateSessionFields);
$('#engineInput').addEventListener('change', () => {
  if ($('#sessionSelect').value !== 'new') $('#sessionSelect').value = 'new';
  updateSessionFields();
});
$('#languageInput').addEventListener('change', () => {
  $('#translateInput').value = $('#languageInput').value === 'es' ? 'en' : 'es';
});
$('#earlyTranslationInput').addEventListener('change', updateEarlyTranslationNotice);
$('#saveServer').addEventListener('click', async () => {
  try {
    const serverUrl = normalizeServerUrl();
    if (!await askServerPermission(serverUrl)) throw new Error('No se concedió acceso al servidor configurado.');
    await loadServer();
  } catch (error) { showMessage(error.message, 'error'); }
});
$('#captureButton').addEventListener('click', async () => {
  try {
    if (currentCapture) await stopCurrentTab();
    else await connectCurrentTab();
  } catch (error) {
    showMessage(error.message, 'error');
    $('#captureButton').disabled = false;
  }
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'capture-state' && Number(message.tabId) === activeTab?.id) {
    if (message.status === 'live') showMessage(`En vivo · ${message.title}`);
    if (message.status === 'error') showMessage(message.reason || 'La sesión encontró un error.', 'error');
    if (['stopped', 'disconnected', 'error'].includes(message.status)) {
      currentCapture = null;
      $('#captureButton').textContent = 'Conectar esta pestaña';
      $('#captureButton').classList.remove('stop');
      $('#sessionSelect').disabled = false;
      $('#captureButton').disabled = false;
    }
  }
});

initialize().catch((error) => showMessage(error.message || 'No se pudo iniciar la extensión.', 'error'));
