import { recentTranslationLines } from './caption-window.js';

const $ = (selector) => document.querySelector(selector);
const query = new URLSearchParams(location.search);
const sessionId = query.get('session');
const captionLanguageKey = sessionId ? `nerdearla.caption-language.${sessionId}` : null;
const isDemo = query.get('demo') === '1';
const captionLines = $('#captionLines');
let session = null;
let interimText = '';
let interimSpeakerLabel = '';
let reconnectTimer = null;
let reconnectDelay = 1000;
let audienceSocket = null;
let clockOffsetMs = 0;
let clockSyncTimer = null;
let lastRenderAckAt = 0;
let sessionRemoved = false;

function showToast(message, tone = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${tone}`;
  toast.textContent = message;
  $('#toastRegion').append(toast);
  setTimeout(() => toast.remove(), 5000);
}

function setSession(value) {
  session = value;
  $('#audienceTitle').textContent = value.title || 'Subtítulos en vivo';
  $('#audienceSpeaker').textContent = value.speaker || 'NERDEARLA · charla en vivo';
  $('#audienceStatus').textContent = value.status === 'live' ? 'EN VIVO' : value.status === 'finished' ? 'SESIÓN FINALIZADA' : value.status === 'error' ? 'CONEXIÓN INTERRUMPIDA' : value.status === 'paused' ? 'ESPERANDO AUDIO' : 'CONECTANDO';
  $('#audienceRoom').textContent = `NERDEARLA · ${value.title || 'SALA'}`.toLocaleUpperCase('es-AR');
  const select = $('#audienceLanguage');
  if (value.translateTo) {
    const target = value.translateTo === 'es' ? 'Español' : value.translateTo === 'pt' ? 'Português' : 'English';
    select.options[1].textContent = target;
    select.options[1].disabled = false;
  } else {
    select.options[1].textContent = 'Traducción no disponible';
    select.options[1].disabled = true;
  }
  let savedLanguage = null;
  try { savedLanguage = captionLanguageKey ? localStorage.getItem(captionLanguageKey) : null; } catch { /* Storage can be disabled by browser policy. */ }
  const preferredLanguage = query.has('lang') ? query.get('lang') : savedLanguage;
  select.value = preferredLanguage === 'translation' && value.translateTo ? 'translation' : 'original';
  renderCaptions();
}

function renderCaptions() {
  if (!session) return;
  const translatedView = $('#audienceLanguage').value === 'translation' && Boolean(session.translateTo);
  $('#captionLangLabel').textContent = translatedView ? ({ es: 'ESPAÑOL', pt: 'PORTUGUÊS', en: 'ENGLISH' }[session.translateTo] || 'TRADUCCIÓN') : ({ es: 'ESPAÑOL', pt: 'PORTUGUÊS', auto: 'ORIGINAL', en: 'ENGLISH' }[session.language] || 'ORIGINAL');
  const overlayMode = document.body.classList.contains('overlay-page');
  const lines = (session.lines || []).slice(overlayMode ? -1 : -3);
  const translationDraft = session.translationDraft || '';
  const completedTranslations = lines.map((line) => line.translation).filter(Boolean).join(' ');
  // Live translationText already includes its draft. Only combine a separate
  // draft when there is no cumulative live stream (for example glossary mode).
  const earlyDraftIsNewer = session.translationMode === 'hybrid' && translationDraft
    && Date.now() - Number(session.nativeTranslationAt || 0) > 1400
    && Date.now() - Number(session.translationDraftAt || 0) < 8000;
  const translationText = earlyDraftIsNewer
    ? [session.translationText, translationDraft].filter(Boolean).join(' ')
    : session.translationText || [completedTranslations, translationDraft].filter(Boolean).join(' ');
  const translatedLines = recentTranslationLines(translationText).slice(overlayMode ? -1 : -3);
  const translatedRows = !session.translationText ? lines.filter((line) => line.translation).slice(-3) : [];
  const captionNode = (text, label, className, previous = false) => {
    const wrapper = document.createElement('div');
    wrapper.className = `${className}${previous ? ' previous' : ''}`;
    if (label) {
      const speaker = document.createElement('span');
      speaker.className = 'caption-speaker';
      speaker.textContent = label;
      wrapper.append(speaker);
    }
    const content = document.createElement('span');
    content.textContent = text;
    wrapper.append(content);
    return wrapper;
  };
  const speakerLabelFor = (line) => line.speakerId && session.speakerAliases?.[line.speakerId]
    ? session.speakerAliases[line.speakerId]
    : line.speakerLabel || '';
  if (translatedView && !translatedLines.length && !translatedRows.length && !lines.length) {
    captionLines.innerHTML = '<div class="caption-placeholder"><span>CC</span><p>Los subtítulos van a aparecer acá cuando empiece la charla.</p></div>';
  } else if (translatedView) {
    if (translatedRows.length) {
      captionLines.replaceChildren(...translatedRows.map((line, index) => captionNode(line.translation, speakerLabelFor(line), 'caption-line caption-translation', index < translatedRows.length - 1)));
    } else if (translatedLines.length) {
      captionLines.replaceChildren(...translatedLines.map((text, index) => {
        return captionNode(text, '', 'caption-line caption-translation', index < translatedLines.length - 1);
      }));
    } else {
      const waiting = document.createElement('div');
      waiting.className = 'caption-placeholder';
      waiting.textContent = session.telemetry?.inputFinalEvents
        ? 'Audio recibido · esperando texto traducido del proveedor…'
        : 'Los subtítulos traducidos van a aparecer cuando el modelo reciba voz.';
      captionLines.replaceChildren(waiting);
    }
  } else if (!lines.length) {
    captionLines.innerHTML = '<div class="caption-placeholder"><span>CC</span><p>Los subtítulos van a aparecer acá cuando empiece la charla.</p></div>';
  } else {
    captionLines.replaceChildren(...lines.map((line, index) => captionNode(line.original || '', speakerLabelFor(line), 'caption-line', index < lines.length - 1)));
  }
  const interim = $('#interimCaption');
  if (translatedView) interim.textContent = '';
  else {
    interim.replaceChildren();
    if (interimSpeakerLabel) {
      const speaker = document.createElement('span');
      speaker.className = 'caption-speaker';
      speaker.textContent = interimSpeakerLabel;
      interim.append(speaker);
    }
    interim.append(document.createTextNode(interimText));
  }
}

function mergeSession(incoming) {
  if (!session) return setSession(incoming);
  session = { ...session, ...incoming };
  renderCaptions();
}

function updateLine(id, update) {
  if (!session) return;
  const line = session.lines.find((item) => item.id === id);
  if (line) Object.assign(line, update);
  renderCaptions();
}

function syncClock(socket) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'ping', clientNow: performance.timeOrigin + performance.now() }));
}

function acknowledgeRenderedCaption(message) {
  if (!message.eventId || !Number.isFinite(Number(message.serverAt)) || !audienceSocket || audienceSocket.readyState !== WebSocket.OPEN) return;
  requestAnimationFrame(() => {
    const now = performance.timeOrigin + performance.now() + clockOffsetMs;
    const latencyMs = now - Number(message.serverAt);
    if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 30_000 || now - lastRenderAckAt < 1000) return;
    lastRenderAckAt = now;
    audienceSocket.send(JSON.stringify({ type: 'render-ack', eventId: message.eventId, latencyMs }));
  });
}

function connectAudience() {
  if (!sessionId) {
    $('#audienceStatus').textContent = 'SESIÓN NO ENCONTRADA';
    showToast('Falta el identificador de la sesión en el enlace.', 'error');
    return;
  }
  clearTimeout(reconnectTimer);
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  audienceSocket = socket;
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'watch', sessionId }));
    syncClock(socket);
    clearInterval(clockSyncTimer);
    clockSyncTimer = setInterval(() => syncClock(socket), 15_000);
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'pong') {
      const clientReceived = performance.timeOrigin + performance.now();
      clockOffsetMs = Number(message.serverNow) - ((Number(message.clientNow) + clientReceived) / 2);
      return;
    }
    if (message.type === 'snapshot') {
      reconnectDelay = 1000;
      setSession(message.session);
    }
    if (message.type === 'session-deleted') {
      sessionRemoved = true;
      $('#audienceStatus').textContent = 'SESIÓN ELIMINADA';
      $('#audienceLive').innerHTML = '<i style="background:#b49561;box-shadow:none"></i> SESIÓN CERRADA';
      socket.close();
      return;
    }
    if (message.type === 'status') {
      if (session) session.status = message.status;
      $('#audienceStatus').textContent = message.status === 'live' ? 'EN VIVO' : message.status === 'finished' ? 'SESIÓN FINALIZADA' : message.status === 'error' ? 'CONEXIÓN INTERRUMPIDA' : 'ESPERANDO AUDIO';
      $('#audienceLive').innerHTML = message.status === 'live' ? '<i></i> EN VIVO' : '<i style="background:#b49561;box-shadow:none"></i> EN ESPERA';
    }
    if (message.type === 'interim') {
      interimText = message.text || '';
      interimSpeakerLabel = message.speakerLabel || '';
      renderCaptions();
    }
    if (message.type === 'final' && session) {
      session.lines.push(message.line);
      interimText = '';
      interimSpeakerLabel = '';
      renderCaptions();
    }
    if (message.type === 'caption-revision' && session) {
      const line = session.lines.find((item) => item.id === message.line.id);
      if (line) Object.assign(line, message.line);
      else session.lines.push(message.line);
      renderCaptions();
    }
    if (message.type === 'translation-stream' && session) {
      session.translationText = `${session.translationText || ''}${message.delta || ''}`.slice(-6000);
      session.translationDraft = message.draft || '';
      session.nativeTranslationAt = message.nativeTranslationAt || message.serverAt || Date.now();
      session.telemetry = message.telemetry || session.telemetry;
      renderCaptions();
    }
    if (message.type === 'translation-draft' && session) {
      session.translationDraft = message.text || '';
      session.translationDraftAt = message.translationDraftAt || message.serverAt || Date.now();
      renderCaptions();
    }
    if (message.type === 'speaker-map' && session) {
      session.speakerAliases = message.speakerAliases || {};
      session.speakers = message.speakers || [];
      renderCaptions();
    }
    if (message.type === 'translation') updateLine(message.id, { translation: message.translation, translated: message.translated });
    if (message.type === 'error') {
      $('#audienceStatus').textContent = 'REINTENTANDO CONEXIÓN';
      socket.close();
    }
    if (['interim', 'final', 'caption-revision', 'translation-stream', 'translation-draft'].includes(message.type)) acknowledgeRenderedCaption(message);
  });
  socket.addEventListener('close', () => {
    clearInterval(clockSyncTimer);
    if (audienceSocket === socket) audienceSocket = null;
    if (sessionRemoved) return;
    if (sessionId && !document.hidden) {
      $('#audienceStatus').textContent = 'REINTENTANDO CONEXIÓN';
      reconnectTimer = setTimeout(connectAudience, reconnectDelay);
      reconnectDelay = Math.min(5000, reconnectDelay * 1.5);
    }
  });
  socket.addEventListener('error', () => socket.close());
}

const demoLines = {
  'demo-principal': { title: 'Auditorio principal', speaker: 'Alex Rivera · Platform Engineer', language: 'en', translateTo: 'es', lines: [
    { original: 'The best infrastructure is the one that lets your team focus on the product.', translation: 'La mejor infraestructura es la que permite que tu equipo se enfoque en el producto.' },
    { original: 'We moved our event pipeline to Kubernetes, and the deployment time went from hours to minutes.', translation: 'Migramos nuestro pipeline de eventos a Kubernetes y el tiempo de despliegue pasó de horas a minutos.' },
    { original: 'Open source works because people can build on each other’s ideas.', translation: 'El código abierto funciona porque las personas pueden construir a partir de las ideas de otras.' },
  ] },
  'demo-open-source': { title: 'Track Open Source', speaker: 'Lucía Fernández · Maintainer', language: 'es', translateTo: 'en', lines: [
    { original: 'Hoy vamos a recorrer tres decisiones que hicieron nuestro sistema mucho más simple.', translation: 'Today we’ll walk through three decisions that made our system much simpler.' },
    { original: 'La comunidad encontró una forma de compartir conocimiento sin barreras.', translation: 'The community found a way to share knowledge without barriers.' },
    { original: 'Con Kubernetes podemos escalar cada servicio según la demanda real.', translation: 'With Kubernetes, we can scale each service based on actual demand.' },
  ] },
  'demo-cloud': { title: 'Track Cloud & DevOps', speaker: 'Sam Wilson · SRE', language: 'en', translateTo: 'es', lines: [
    { original: 'Let’s look at how observability changes the way we debug production issues.', translation: 'Veamos cómo la observabilidad cambia nuestra forma de resolver problemas en producción.' },
    { original: 'The goal is not to add more tools. It is to make the tools we have work together.', translation: 'El objetivo es sumar valor haciendo que las herramientas funcionen juntas.' },
    { original: 'A good deployment pipeline gives people confidence to ship small changes every day.', translation: 'Un buen pipeline de despliegue permite publicar cambios pequeños todos los días con confianza.' },
  ] },
};

function playDemo() {
  const room = demoLines[sessionId] || demoLines['demo-principal'];
  const initial = { ...room, id: sessionId, status: 'live', lines: [], startedAt: new Date().toISOString() };
  setSession(initial);
  let index = 0;
  const append = () => {
    const sample = room.lines[index % room.lines.length];
    session.lines.push({ ...sample, id: `${sessionId}-${index}`, at: new Date().toISOString(), translated: true });
    index += 1;
    renderCaptions();
  };
  append();
  setInterval(append, 5000);
}

const CAPTION_STYLE_KEY = 'nerdearla.caption-style.v1';
const CAPTION_STYLE_DEFAULTS = {
  fontFamily: 'system', fontWeight: '500', fontSize: 36, width: 82,
  textColor: '#ffffff', panelColor: '#101713', opacity: 60,
  glow: 8, depth: 18, outline: 1, align: 'center', lineHeight: 1.3,
};
const CAPTION_FONTS = {
  system: "'DM Sans', Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'DM Mono', 'SFMono-Regular', Consolas, monospace",
  display: "'Manrope', 'DM Sans', Inter, sans-serif",
};
let captionStyle = { ...CAPTION_STYLE_DEFAULTS };

function readLocalJson(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? { ...fallback, ...JSON.parse(value) } : { ...fallback };
  } catch { return { ...fallback }; }
}

function saveLocalJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage can be disabled by browser policy. */ }
}

function applyCaptionStyle() {
  const style = document.body.style;
  const rgb = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(captionStyle.panelColor || '');
  const panel = rgb
    ? `rgba(${parseInt(rgb[1], 16)}, ${parseInt(rgb[2], 16)}, ${parseInt(rgb[3], 16)}, ${Math.max(0, Math.min(95, Number(captionStyle.opacity) || 0)) / 100})`
    : 'rgba(16, 23, 19, .6)';
  const depth = Math.max(0, Math.min(48, Number(captionStyle.depth) || 0));
  const glow = Math.max(0, Math.min(32, Number(captionStyle.glow) || 0));
  const textShadows = [`0 2px ${Math.max(2, Math.round(depth / 3))}px rgba(0, 0, 0, .94)`];
  if (glow > 0) textShadows.push(`0 0 ${glow}px ${captionStyle.textColor || '#fff'}`);
  style.setProperty('--caption-font-family', CAPTION_FONTS[captionStyle.fontFamily] || CAPTION_FONTS.system);
  style.setProperty('--caption-font-weight', String(captionStyle.fontWeight || '500'));
  style.setProperty('--caption-font-size', `${Math.max(20, Math.min(80, Number(captionStyle.fontSize) || 36))}px`);
  style.setProperty('--caption-width', `${Math.max(40, Math.min(98, Number(captionStyle.width) || 82))}vw`);
  style.setProperty('--caption-text-color', captionStyle.textColor || '#fff');
  style.setProperty('--caption-panel-background', panel);
  style.setProperty('--caption-text-shadow', textShadows.join(', '));
  style.setProperty('--caption-panel-shadow', `0 ${Math.round(depth * .45)}px ${depth * 1.8}px rgba(0, 0, 0, .48)`);
  style.setProperty('--caption-outline', `${Math.max(0, Math.min(4, Number(captionStyle.outline) || 0))}px`);
  style.setProperty('--caption-align', ['left', 'center', 'right'].includes(captionStyle.align) ? captionStyle.align : 'center');
  style.setProperty('--caption-line-height', `${Math.max(1.05, Math.min(1.8, Number(captionStyle.lineHeight) || 1.3))}`);
}

function makeCaptionPageUrl() {
  const url = new URL('/audience.html', location.origin);
  url.searchParams.set('session', sessionId);
  url.searchParams.set('lang', $('#audienceLanguage').value);
  url.searchParams.set('overlay', '1');
  if (isDemo) url.searchParams.set('demo', '1');
  return url;
}

function openCaptionPage() {
  if (!sessionId) return showToast('No encontramos el identificador de esta sesión.', 'error');
  const url = makeCaptionPageUrl();
  const popup = window.open(url.href, `nerdearla-captions-${sessionId}`, 'popup,width=1080,height=300,resizable=yes');
  $('#captionLaunchDialog')?.close();
  if (!popup) {
    showToast('El navegador bloqueó la ventana. Permití ventanas emergentes para abrir los subtítulos aparte.', 'error');
    return;
  }
  showToast('Subtítulos abiertos en una ventana aparte. Podés moverla desde la barra superior.');
}

async function openFloatingCaptions() {
  $('#captionLaunchDialog')?.showModal();
}

async function openNativeCaptionOverlay(desktop = window.nerdearlaDesktop) {
  if (!desktop?.openCaptionOverlay) {
    showToast('La app Nerdearla Desktop no está disponible. Abrí los subtítulos en una ventana aparte o instalá la app de escritorio.', 'error');
    return;
  }
  try {
    const result = await desktop.openCaptionOverlay({ sessionId, lang: $('#audienceLanguage').value, demo: isDemo });
    if (!result?.ok) throw new Error(result?.error || 'No se pudo abrir el overlay nativo.');
    $('#openCaptionOverlay')?.setAttribute('aria-pressed', 'true');
    const moveHint = result.moveShortcutAvailable
      ? `Usá la barra flotante Mover/Fijar o ${result.moveShortcut} para cambiar el modo de arrastre.`
      : 'Usá la barra flotante Mover/Fijar para arrastrar y fijar la posición.';
    const closeHint = result.closeShortcutAvailable
      ? `La barra flotante tiene Cerrar; ${result.closeShortcut} también cierra el overlay.`
      : 'La barra flotante tiene un botón Cerrar.';
    $('#captionLaunchDialog')?.close();
    showToast(`Overlay transparente activo. ${moveHint} ${closeHint}`);
  } catch (error) {
    showToast(error.message || 'No se pudo abrir el overlay transparente.', 'error');
  }
}

function requestDesktopApp() {
  if (!sessionId) return showToast('No encontramos el identificador de esta sesión.', 'error');
  if (window.nerdearlaDesktop?.openCaptionOverlay) return openNativeCaptionOverlay();
  const deepLink = new URL('nerdearla://overlay');
  deepLink.searchParams.set('session', sessionId);
  deepLink.searchParams.set('lang', $('#audienceLanguage').value);
  if (isDemo) deepLink.searchParams.set('demo', '1');
  const launch = document.createElement('a');
  launch.href = deepLink.href;
  launch.target = '_blank';
  launch.rel = 'noopener';
  launch.hidden = true;
  document.body.append(launch);
  launch.click();
  launch.remove();
  $('#captionLaunchDialog')?.close();
  showToast('Solicité abrir Nerdearla Desktop. Si no está instalada, usá la página aparte o iniciá la app de escritorio una vez.');
}

function updateCaptionControlOutputs() {
  document.querySelectorAll('[data-caption-output]').forEach((output) => {
    const key = output.dataset.captionOutput;
    const value = captionStyle[key];
    const suffix = key === 'fontSize' || key === 'outline' ? ' px'
      : key === 'width' || key === 'opacity' ? ' %' : '';
    output.textContent = `${value}${suffix}`;
  });
}

function syncCaptionControls() {
  document.querySelectorAll('[data-caption-setting]').forEach((control) => {
    if (Object.hasOwn(captionStyle, control.dataset.captionSetting)) {
      control.value = captionStyle[control.dataset.captionSetting];
    }
  });
  updateCaptionControlOutputs();
}

function initializeCaptionControls() {
  captionStyle = readLocalJson(CAPTION_STYLE_KEY, CAPTION_STYLE_DEFAULTS);
  syncCaptionControls();
  applyCaptionStyle();
  const overlayButton = $('#openCaptionOverlay');
  if (overlayButton && !window.nerdearlaDesktop) {
    overlayButton.textContent = '▱ Subtítulos flotantes';
    overlayButton.title = 'Elegí una ventana aparte o abrí el modo escritorio transparente.';
  }

  document.querySelectorAll('[data-caption-setting]').forEach((control) => {
    control.addEventListener('input', () => {
      const key = control.dataset.captionSetting;
      captionStyle[key] = control.type === 'range' ? Number(control.value) : control.value;
      applyCaptionStyle();
      updateCaptionControlOutputs();
      saveLocalJson(CAPTION_STYLE_KEY, captionStyle);
    });
  });

  $('#resetCaptionStyle')?.addEventListener('click', () => {
    captionStyle = { ...CAPTION_STYLE_DEFAULTS };
    syncCaptionControls();
    applyCaptionStyle();
    saveLocalJson(CAPTION_STYLE_KEY, captionStyle);
  });

  $('#openCaptionOverlay')?.addEventListener('click', openFloatingCaptions);
  $('#openCaptionPage')?.addEventListener('click', openCaptionPage);
  $('#openCaptionDesktop')?.addEventListener('click', requestDesktopApp);
  $('#closeCaptionLaunch')?.addEventListener('click', () => $('#captionLaunchDialog')?.close());
  window.nerdearlaDesktop?.onCaptionOverlayClosed?.((closedSessionId) => {
    if (closedSessionId === sessionId) $('#openCaptionOverlay')?.setAttribute('aria-pressed', 'false');
  });

}

window.addEventListener('storage', (event) => {
  if (event.key === CAPTION_STYLE_KEY) {
    captionStyle = readLocalJson(CAPTION_STYLE_KEY, CAPTION_STYLE_DEFAULTS);
    syncCaptionControls();
    applyCaptionStyle();
  }
  if (event.key === captionLanguageKey && ['original', 'translation'].includes(event.newValue)) {
    const select = $('#audienceLanguage');
    if (select && !select.options[1].disabled) {
      select.value = event.newValue;
      renderCaptions();
    }
  }
});

$('#audienceLanguage').addEventListener('change', () => {
  if (captionLanguageKey) {
    try { localStorage.setItem(captionLanguageKey, $('#audienceLanguage').value); } catch { /* Storage can be disabled by browser policy. */ }
  }
  renderCaptions();
});
if (query.get('overlay') === '1') {
  document.body.classList.add('overlay-page');
  document.body.classList.add(`overlay-size-${query.get('size') || 'medium'}`);
}
initializeCaptionControls();
if (isDemo) playDemo();
else {
  connectAudience();
}
