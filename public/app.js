import { loadAudioWorklet } from './audio-worklet-loader.js';

const $ = (selector) => document.querySelector(selector);
const sessionDialog = $('#sessionDialog');
const sessionForm = $('#sessionForm');
const sessionGrid = $('#sessionGrid');
const demoSessions = new Map();
const producers = new Map();
const directProviders = new Map();
const MAX_QUEUED_AUDIO_BYTES = 12 * 1024; // Keep at most ~300 ms of 16 kHz mono PCM in the browser socket.
const MAX_PRODUCER_RECONNECTS = 5;
const AUDIO_PACKET_HEADER_BYTES = 8;
const DIRECT_PROVIDER_SETUP_TIMEOUT_MS = 3000;
let serverSessions = [];
let apiConfig = { configured: false, localProviderAvailable: false, model: 'gemini-3.5-transcribe-live' };
let reuseSessionId = null;
let demoTimers = [];
let searchText = '';
let currentCosts = null;

const roomStyles = ['purple-room', 'orange-room', 'blue-room', 'green-room', 'coral-room', 'gold-room'];
const roomIcons = ['⌘', '◈', '⌁', '✳', '◉', '◇'];
const enLines = [
  ['The best infrastructure is the one that lets your team focus on the product.', 'La mejor infraestructura es la que permite que tu equipo se enfoque en el producto.'],
  ['We moved our event pipeline to Kubernetes, and the deployment time went from hours to minutes.', 'Migramos nuestro pipeline de eventos a Kubernetes y el tiempo de despliegue pasó de horas a minutos.'],
  ['Open source works because people can build on each other’s ideas.', 'El código abierto funciona porque las personas pueden construir a partir de las ideas de otras.'],
  ['Let’s look at how observability changes the way we debug production issues.', 'Veamos cómo la observabilidad cambia nuestra forma de resolver problemas en producción.'],
  ['The goal is not to add more tools. It is to make the tools we have work together.', 'El objetivo no es sumar más herramientas. Es hacer que las que ya tenemos funcionen juntas.'],
];
const esLines = [
  ['Hoy vamos a recorrer tres decisiones que hicieron nuestro sistema mucho más simple.', 'Today we’ll walk through three decisions that made our system much simpler.'],
  ['La comunidad encontró una forma de compartir conocimiento sin barreras.', 'The community found a way to share knowledge without barriers.'],
  ['Con Kubernetes podemos escalar cada servicio según la demanda real.', 'With Kubernetes, we can scale each service based on actual demand.'],
];

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function showToast(message, tone = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${tone}`;
  toast.textContent = message;
  $('#toastRegion').append(toast);
  setTimeout(() => toast.remove(), 4400);
}

function langLabel(language) {
  return language === 'es' ? 'Español' : language === 'pt' ? 'Português' : language === 'auto' ? 'Auto' : 'English';
}

function statusLabel(status) {
  return ({ live: 'EN VIVO', connecting: 'CONECTANDO', reconnecting: 'RECONECTANDO', paused: 'PAUSADA', error: 'ERROR', finished: 'FINALIZADA', ready: 'LISTA' })[status] || 'EN ESPERA';
}

function mergedSessions() {
  const demos = [...demoSessions.values()].map((session) => ({ ...session, demo: true }));
  const actual = serverSessions.map((session) => ({ ...session, demo: false }));
  return [...actual, ...demos].filter((session) => {
    if (!searchText) return true;
    return `${session.title} ${session.speaker || ''}`.toLowerCase().includes(searchText);
  });
}

function renderSession(session, index) {
  const live = session.status === 'live';
  const style = roomStyles[index % roomStyles.length];
  const icon = roomIcons[index % roomIcons.length];
  const originalLabel = langLabel(session.language);
  const targetLabel = session.translateTo ? langLabel(session.translateTo) : null;
  const lastLine = session.lines?.at(-1);
  const preview = session.error || lastLine?.original || (live ? 'Esperando el próximo fragmento de voz…' : 'Los subtítulos aparecerán al conectar el audio.');
  const statusClass = live ? 'state-live' : ['connecting', 'reconnecting'].includes(session.status) ? 'state-connecting' : session.status === 'error' ? 'state-error' : 'state-finished';
  const primaryAction = live
    ? `<button class="card-action primary-card-action" data-action="audience" data-id="${escapeHtml(session.id)}" ${session.demo ? 'data-demo="1"' : ''}>↗ <span>Vista audiencia</span></button>`
    : ['connecting', 'reconnecting'].includes(session.status)
      ? `<button class="card-action" disabled>◌ <span>${session.status === 'reconnecting' ? 'Recuperando…' : 'Conectando…'}</span></button>`
    : `<button class="card-action primary-card-action" data-action="reconnect" data-id="${escapeHtml(session.id)}">↻ <span>${session.status === 'finished' ? 'Nueva transmisión' : 'Conectar audio'}</span></button>`;
  const stopAction = live && !session.demo ? `<button class="card-action danger-card-action" data-action="stop" data-id="${escapeHtml(session.id)}">■ <span>Finalizar</span></button>` : '';
  const deleteAction = !session.demo && ['finished', 'paused', 'error'].includes(session.status) ? `<button class="card-action danger-card-action" data-action="delete-session" data-id="${escapeHtml(session.id)}">× <span>Borrar</span></button>` : '';
  const overlayAction = live && !session.demo ? `<button class="card-action" data-action="overlay" data-id="${escapeHtml(session.id)}" title="Copiar URL de overlay OBS">▱ OBS</button>` : '';
  const chromiumAction = window.nerdearlaDesktop?.openChromiumSession && session.sourceUrl && !active && !session.demo
    ? `<button class="card-action" data-action="open-chromium" data-id="${escapeHtml(session.id)}" title="Reabrir esta sala en su Chromium aislado">↗ Chromium</button>`
    : '';
  const speakerHints = Object.entries(session.speakerSuggestions || {}).map(([speakerId, suggestion]) => {
    const speakerNumber = Number(speakerId.slice('speaker-'.length));
    const label = session.speakers?.find((speaker) => speaker.id === speakerId)?.displayName || `Voz ${speakerNumber}`;
    return `<div class="speaker-hint"><span>${escapeHtml(label)} podría ser <b>${escapeHtml(suggestion.name)}</b></span><button class="card-action" data-action="confirm-speaker" data-id="${escapeHtml(session.id)}" data-speaker-id="${escapeHtml(speakerId)}" data-name="${escapeHtml(suggestion.name)}">Confirmar</button></div>`;
  }).join('');
  const speakerMappings = (session.speakers || []).slice(0, 12).map((speaker) => {
    const speakerNumber = Number(speaker.number) || Number(String(speaker.id).match(/speaker-(\d+)/u)?.[1]) || 0;
    const name = session.speakerAliases?.[speaker.id] || '';
    return `<div class="speaker-map-row"><label><span>Voz ${speakerNumber}</span><input class="speaker-name-input" type="text" maxlength="80" value="${escapeHtml(name)}" placeholder="Nombre confirmado" aria-label="Nombre de Voz ${speakerNumber}"></label><button class="card-action" data-action="save-speaker-map" data-id="${escapeHtml(session.id)}" data-speaker-id="${escapeHtml(speaker.id)}">Guardar</button></div>`;
  }).join('');
  const metrics = session.telemetry;
  const audioThreshold = session.audioSource === 'tab' ? 0.00001 : 0.003;
  const audioLevelKnown = Number.isFinite(metrics?.audioLevelRms);
  const audioSignalDetected = audioLevelKnown && metrics.audioLevelRms > audioThreshold;
  const requestedSourceLanguageCode = session.language === 'pt' ? 'pt' : session.language;
  const inputLanguageMismatch = metrics?.inputLanguageCode && session.language !== 'auto'
    && !metrics.inputLanguageCode.toLowerCase().startsWith(requestedSourceLanguageCode.toLowerCase());
  const requestedLanguageCode = session.translateTo === 'pt' ? 'pt' : session.translateTo;
  const outputLanguageMismatch = metrics?.outputLanguageCode && requestedLanguageCode && !metrics.outputLanguageCode.toLowerCase().startsWith(requestedLanguageCode.toLowerCase());
  const diagnostic = !metrics
    ? 'Conectando al servidor'
    : session.provider?.capture?.audioTrackMuted
      ? 'El navegador silenció la pista de captura; revisá el audio de la pestaña'
      : !metrics.audioChunksSent && audioSignalDetected
        ? 'La pestaña entrega audio; esperando que Gemini termine de conectar'
      : !metrics.audioChunksSent && audioLevelKnown
        ? 'La pestaña está compartida, pero el nivel de audio sigue en silencio'
      : !metrics.audioChunksSent
        ? 'Midiendo la pista de audio de la pestaña'
      : audioLevelKnown && metrics.audioLevelRms < audioThreshold
        ? 'El nivel de audio es muy bajo; revisá la fuente compartida'
        : !metrics.inputFinalEvents
          ? 'Llega audio pero aún no hay transcripción original'
          : inputLanguageMismatch
            ? `Se detecta ${metrics.inputLanguageCode}, pero se configuró ${requestedSourceLanguageCode}; revisá la pista de audio`
          : outputLanguageMismatch
            ? `Gemini emite ${metrics.outputLanguageCode}; se pidió ${requestedLanguageCode}`
          : session.translateTo && !metrics.translationEvents
            ? 'Hay transcripción original pero Gemini aún no envía traducción'
            : metrics.audioChunksDropped
              ? `Se descartaron ${metrics.audioChunksDropped} bloques para evitar acumular demora`
              : 'Flujo de audio y transcripción activos';
  const active = ['live', 'connecting', 'reconnecting'].includes(session.status);
  const sourceLabel = session.audioSource === 'tab'
    ? session.provider?.capture?.displaySurface === 'browser' ? 'PESTAÑA' : 'CAPTURA DE PESTAÑA'
    : 'MICRÓFONO';
  const connectionLabel = live ? 'EN VIVO' : session.status === 'reconnecting' ? 'RECUPERANDO' : 'CONECTANDO';
  const signalLabel = !audioLevelKnown ? 'audio midiéndose' : audioSignalDetected ? 'señal presente' : 'sin señal de audio';
  const liveDetails = active
    ? `<span class="card-live-meta" title="${escapeHtml(diagnostic)} · ${sourceLabel}; ${signalLabel}. A = bloques enviados, O = textos reconocidos, T = traducciones. Audio→primer subtítulo aproximado: ${metrics?.captureToFirstCaptionMs ? formatLatency(metrics.captureToFirstCaptionMs) : 'midiendo'}. Entrada a servidor: ${metrics?.audioIngressLagMs ? formatLatency(metrics.audioIngressLagMs) : '—'}. RMS ${metrics?.audioLevelRms?.toFixed?.(6) ?? '—'}">${session.demo ? 'DEMO' : metrics ? `${sourceLabel} · ${connectionLabel} · ${signalLabel} · A ${metrics.audioChunksSent} · O ${metrics.inputFinalEvents} · T ${metrics.translationEvents}${metrics.captureToFirstCaptionMs ? ` · ${formatLatency(metrics.captureToFirstCaptionMs)} audio→texto` : ''}${session.billing ? ` · ${formatMoney(session.billing.billableUsd)}` : ''}${inputLanguageMismatch ? ` · ⚠ entrada ${escapeHtml(metrics.inputLanguageCode)}` : outputLanguageMismatch ? ` · ⚠ salida ${escapeHtml(metrics.outputLanguageCode)}` : ''}` : 'CONECTANDO'}</span>`
    : `<span class="card-live-meta">${session.lines?.length || 0} frag.</span>`;
  return `<article class="session-card" data-session="${escapeHtml(session.id)}">
    <div class="session-card-top"><span class="room-icon ${style}">${icon}</span><div class="session-title-block"><h3 title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</h3><p>${escapeHtml(session.speaker || 'Sala de conferencia')} · ${originalLabel}</p></div><button class="card-menu" title="Exportar subtítulos" data-action="export-menu" data-id="${escapeHtml(session.id)}">···</button></div>
    <div class="session-state"><span class="state-pill ${statusClass}"><i></i>${statusLabel(session.status)}</span><span class="language-pair">${originalLabel}${targetLabel ? `<span>↔</span>${targetLabel}` : ''}</span>${session.demo ? '<span class="demo-tag">DEMO</span>' : ''}</div>
    <div class="session-caption-preview"><div class="preview-label">ÚLTIMO SUBTÍTULO</div><div class="preview-text">${escapeHtml(preview)}${!lastLine ? '<em> — por acá vas a verlo</em>' : ''}</div></div>
    ${speakerHints || speakerMappings ? `<div class="speaker-hints">${speakerMappings}${speakerHints}</div>` : ''}
    <div class="session-card-footer">${primaryAction}${stopAction}${overlayAction}${chromiumAction}${deleteAction}<button class="card-action" title="Descargar subtítulos VTT" data-action="export-vtt" data-id="${escapeHtml(session.id)}">↓ VTT</button>${liveDetails}</div>
  </article>`;
}

function formatClock(value) {
  try { return new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
  catch { return '—'; }
}

function formatLatency(milliseconds) {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

function render() {
  const sessions = mergedSessions();
  const live = sessions.filter((session) => session.status === 'live');
  const lineCount = sessions.reduce((total, session) => total + (session.lines?.length || 0), 0);
  const languagePairs = new Set(sessions.filter((session) => session.translateTo).map((session) => `${session.language}:${session.translateTo}`));
  $('#activeCount').textContent = String(live.length);
  $('#totalCount').textContent = String(sessions.length);
  $('#navLiveCount').textContent = String(live.length);
  $('#languageCount').textContent = String(languagePairs.size || (sessions.length ? 1 : 0));
  $('#captionCount').textContent = lineCount.toLocaleString('es-AR');
  const latest = sessions.map((session) => session.updatedAt).filter(Boolean).sort().at(-1);
  $('#lastActivity').textContent = latest ? formatClock(latest) : '—';
  $('#sessionTotal').textContent = String(sessions.length);
  sessionGrid.innerHTML = sessions.map(renderSession).join('');
  const noSessions = sessions.length === 0;
  $('#emptyState').hidden = !noSessions;
  $('#templateGrid').hidden = !noSessions;
}

async function refreshSessions() {
  try {
    const response = await fetch('/api/sessions', { cache: 'no-store' });
    if (response.ok) {
      serverSessions = await response.json();
      render();
    }
  } catch { /* The server may still be starting. */ }
}

async function loadSystemStatus() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    apiConfig = await response.json();
    $('#engineInput').querySelector('[value="gemini-direct"]').disabled = !apiConfig.configured;
    $('#engineInput').querySelector('[value="gemini"]').disabled = !apiConfig.configured;
    $('#engineInput').querySelector('[value="local"]').disabled = !apiConfig.localProviderAvailable;
    $('#engineInput').querySelector('[value="auto"]').disabled = !apiConfig.localProviderAvailable || !apiConfig.autoFallbackToLocal;
    if (apiConfig.configured) {
      $('#systemBanner').classList.remove('warning');
      $('#systemTitle').textContent = 'Gemini Live está listo';
      $('#systemDescription').textContent = `Live Translate · ${apiConfig.liveTranslationModel}`;
      $('#systemAction').textContent = 'Ver estado ↗';
      $('#connectionNote').innerHTML = `<span>✓</span><span>Gemini listo · ${apiConfig.billingTier === 'free' ? 'nivel gratuito: cuota limitada y uso de contenido según las condiciones de Google' : 'nivel pago'} · ${apiConfig.localProviderAvailable ? 'hay motor local para respaldo' : 'sin motor local configurado'}.</span>`;
      $('#geminiStatus').textContent = '✓';
      $('#geminiStatus').classList.add('ready-check');
      $('#modelLabel').textContent = apiConfig.liveTranslationModel;
    } else {
      $('#systemBanner').classList.add('warning');
      $('#systemTitle').textContent = 'Modo de exploración';
      $('#systemDescription').textContent = 'La demo funciona sin clave. Agregá Gemini para conectar audio real.';
      $('#systemAction').textContent = 'Cómo configurar ↗';
      $('#geminiStatus').textContent = '·';
      $('#connectionNote').innerHTML = `<span>ⓘ</span><span>${apiConfig.localProviderAvailable ? 'WhisperLiveKit está disponible para procesar audio localmente.' : 'Para transmitir en vivo, cargá una <code>GEMINI_API_KEY</code> o configurá WhisperLiveKit. Mientras tanto podés explorar la demo.'}</span>`;
    }
  } catch {
    $('#systemBanner').classList.add('warning');
    $('#systemTitle').textContent = 'No encontramos el servidor';
    $('#systemDescription').textContent = 'Iniciá el servidor con npm start para conectar las salas.';
  }
}

function formatMoney(value) {
  return `US$${Number(value || 0).toFixed(4)}`;
}

async function refreshCosts() {
  try {
    const [costResponse, metricsResponse] = await Promise.all([
      fetch('/api/metrics/cost', { cache: 'no-store' }),
      fetch('/api/metrics', { cache: 'no-store' }),
    ]);
    if (costResponse.ok) {
      currentCosts = await costResponse.json();
      const billable = $('#costBillable');
      if (billable) {
        billable.textContent = formatMoney(currentCosts.totalBillableUsd);
        $('#costTierLabel').textContent = currentCosts.billingTier === 'free' ? 'Estimación · nivel gratuito (si hay cuota)' : 'Estimación a tarifa paga';
        $('#costEquivalent').textContent = `${formatMoney(currentCosts.paidEquivalentUsd)} equivalente a tarifa paga`;
        const hasUnpricedLocal = currentCosts.sessions.some((item) => item.localMinutes > 0) && !currentCosts.rates.localPerMinute;
        $('#costUsage').textContent = `${currentCosts.totalAudioMinutes.toFixed(1)} minutos de audio procesados en las últimas 24 h${hasUnpricedLocal ? ' · falta ingresar el costo de GPU/CPU local' : ''}`;
        $('#costBasis').textContent = currentCosts.basis;
        const budget = $('#costBudget');
        budget.style.width = `${Math.min(100, currentCosts.budgetPercent || 0)}%`;
        $('#costBudgetLabel').textContent = currentCosts.dailyBudgetUsd
          ? currentCosts.budgetPercent >= 100
            ? `${formatMoney(currentCosts.paidEquivalentUsd)} / ${formatMoney(currentCosts.dailyBudgetUsd)} · presupuesto alcanzado; sesiones pausadas`
            : `${formatMoney(currentCosts.paidEquivalentUsd)} / ${formatMoney(currentCosts.dailyBudgetUsd)} de presupuesto equivalente`
          : 'Presupuesto diario sin límite configurado';
        const rows = currentCosts.sessions.filter((item) => item.audioMinutes > 0).slice(0, 8);
        $('#costSessionRows').innerHTML = rows.length ? rows.map((item) => {
          const estimated = currentCosts.billingTier === 'free' ? item.cloudEquivalentUsd : item.billableUsd;
          const draftUsage = item.draftTranslationCalls ? ` · ${item.draftTranslationCalls} borradores` : '';
          return `<div class="cost-session-row"><span>${escapeHtml(item.title)}</span><small>${item.audioMinutes.toFixed(1)} min · ${escapeHtml(item.engine)}${draftUsage}</small><b>${formatMoney(estimated)}</b></div>`;
        }).join('') : '<p class="cost-empty">El costo por sala aparecerá cuando fluya audio.</p>';
      }
    }
    if (metricsResponse.ok) {
      const metrics = await metricsResponse.json();
      $('#monitorStatus').textContent = `${metrics.activeSessions}/${metrics.maxActiveSessions} salas · ${metrics.viewers} espectadores · ${metrics.audioChunksDropped} bloques de audio descartados`;
      $('#monitorLatency').textContent = metrics.latencyMs.source.p50 === null
        ? 'Midiendo latencia con el próximo fragmento de voz…'
        : `Audio→primer texto p50 ${formatLatency(metrics.latencyMs.source.p50)} · p95 ${formatLatency(metrics.latencyMs.source.p95)} · p99 ${formatLatency(metrics.latencyMs.source.p99 ?? metrics.latencyMs.source.p95)} · borrador traducido p95 ${metrics.latencyMs.draftFirstToken.p95 === null ? '—' : formatLatency(metrics.latencyMs.draftFirstToken.p95)} · entrega a audiencia p95 ${metrics.latencyMs.viewer.p95 === null ? '—' : formatLatency(metrics.latencyMs.viewer.p95)} · texto final→traducción p95 ${metrics.latencyMs.translation.p95 === null ? '—' : formatLatency(metrics.latencyMs.translation.p95)}`;
    }
  } catch { /* Cost and monitoring update again on the next tick. */ }
}

function openDialog(values = {}) {
  reuseSessionId = values.id || null;
  sessionForm.reset();
  $('#titleInput').value = values.title || '';
  $('#speakerInput').value = values.speaker || '';
  $('#languageInput').value = values.language || 'en';
  $('#engineInput').value = values.status === 'live'
    ? (values.requestedEngine || values.engine || 'gemini')
    : 'gemini';
  const defaultTarget = values.language === 'es' ? 'en' : 'es';
  $('#translateInput').value = values.translateTo === null && values.id ? 'none' : values.translateTo || defaultTarget;
  $('#audioSourceInput').value = values.audioSource || (window.nerdearlaDesktop?.openChromiumSession ? 'tab' : 'microphone');
  $('#sourceUrlInput').value = values.sourceUrl || '';
  updateAudioNotice();
  $('#glossaryInput').value = (values.glossary || []).join(', ');
  $('#earlyTranslationInput').checked = Boolean(values.earlyTranslation || values.translationMode === 'hybrid');
  updateEarlyTranslationNotice();
  sessionDialog.showModal();
  setTimeout(() => $('#titleInput').focus(), 40);
}

if (window.nerdearlaDesktop?.openChromiumSession) {
  $('#nativeChromiumField').hidden = false;
  $('#audioSourceInput').value = 'tab';
}

function updateAudioNotice() {
  const useTabAudio = $('#audioSourceInput').value === 'tab';
  const nativeSourceUrl = window.nerdearlaDesktop?.openChromiumSession && $('#sourceUrlInput').value.trim();
  const submitButton = sessionForm.querySelector('[type="submit"]');
  submitButton.innerHTML = nativeSourceUrl ? 'Abrir sala en Chromium <span>→</span>' : 'Conectar audio <span>→</span>';
  if (nativeSourceUrl) {
    $('#audioNotice').innerHTML = '<span>♩</span><span>Se abrirá una ventana Chromium independiente y cargará el link que pegaste. Repetí con el link de cada sala; cada transmisión conserva su propia captura y subtítulos. Después conectá <b>Nerdearla Captura</b> en esa ventana.</span>';
    return;
  }
  if (window.nerdearlaDesktop?.openChromiumSession) {
    $('#audioNotice').innerHTML = '<span>↗</span><span>Para abrir una sala en Chromium, pegá su URL en <b>Link de la transmisión o sala</b>. Si preferís compartir audio desde una pestaña ya abierta, dejá el campo vacío y elegí la pestaña en el selector.</span>';
    return;
  }
  const title = $('#titleInput').value.trim();
  const selectedTab = title ? `la pestaña correspondiente a <b>${escapeHtml(title)}</b>` : 'la pestaña de esta sesión';
  $('#audioNotice').innerHTML = useTabAudio
    ? `<span>♩</span><span>Esta sesión captura solo ${selectedTab}. En el selector activá <b>Compartir audio de la pestaña</b>. Para otra sala, volvé a <b>Agregar</b> y abrí un selector nuevo. El botón del navegador <b>“Compartir esta pestaña” reemplaza esta fuente</b> y corta el audio de la sala anterior.</span>`
    : '<span>♩</span><span>Al continuar, el navegador te va a pedir acceso a un micrófono o a la entrada de audio de la sala. El audio se enviará a Google Gemini.</span>';
}

function updateEarlyTranslationNotice() {
  const enabled = $('#earlyTranslationInput').checked;
  $('#earlyTranslationHelp').textContent = enabled
    ? 'Usa Gemini Transcribe para recibir texto parcial y Flash-Lite para traducirlo antes del cierre de frase. El borrador es provisional; cada frase final se traduce otra vez. Consume cuota y texto adicionales.'
    : 'La traducción nativa suele ser más consistente. Activá borradores anticipados si preferís ver una versión provisional antes.';
}

$('#earlyTranslationInput').addEventListener('change', updateEarlyTranslationNotice);

async function requestDirectLiveToken(sessionId) {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/live-token`, {
    method: 'POST', cache: 'no-store',
  });
  const value = await response.json();
  if (!response.ok || !value.token) throw new Error(value.error || 'No se pudo preparar el enlace directo con Gemini.');
  return value.token;
}

function forwardDirectTranscript(state, providerMessage) {
  const source = providerMessage?.serverContent;
  if (!source || state.appSocket.readyState !== WebSocket.OPEN) return;
  const serverContent = {};
  for (const field of ['interimInputTranscription', 'inputTranscription', 'outputTranscription']) {
    const item = source[field];
    if (item && typeof item.text === 'string') serverContent[field] = { text: item.text, ...(item.languageCode ? { languageCode: item.languageCode } : {}) };
  }
  if (Object.keys(serverContent).length) {
    state.appSocket.send(JSON.stringify({ type: 'direct-provider-message', payload: { serverContent } }));
  }
}

function directStatus(state, status, message = '') {
  if (state.appSocket.readyState === WebSocket.OPEN) {
    state.appSocket.send(JSON.stringify({ type: 'direct-provider-status', status, message }));
  }
}

function fallbackDirectProvider(state, reason = 'connection') {
  if (state.stopped) return;
  const appSocket = state.appSocket;
  closeDirectProvider(state.sessionId);
  if (appSocket.readyState === WebSocket.OPEN) {
    appSocket.send(JSON.stringify({ type: 'direct-provider-fallback', reason }));
  }
}

function scheduleDirectReconnect(state, delay = null, message = '') {
  if (state.stopped || state.reconnectTimer) return;
  const rejectedToken = /token.{0,80}(used too many times|expired|invalid)|(?:used too many times|expired|invalid).{0,80}token/i.test(message);
  const rejectedHandle = /(?:session\s*resumption|resumption|resume(?:\s*handle)?|handle).{0,100}(invalid|expired|not found|not valid|rejected)|(?:invalid|expired|not found|not valid|rejected).{0,100}(?:session\s*resumption|resumption|resume(?:\s*handle)?|handle)/i.test(message);
  if (rejectedToken || rejectedHandle) {
    state.resumeHandle = '';
    state.token = '';
  }
  state.ready = false;
  state.reconnectAttempts += 1;
  if (state.reconnectAttempts >= 2) {
    fallbackDirectProvider(state, 'connection');
    return;
  }
  const wait = delay ?? Math.min(8000, 500 * (2 ** (state.reconnectAttempts - 1)) + Math.random() * 350);
  directStatus(state, 'reconnecting', message);
  try { state.socket?.close(); } catch { /* The provider socket may already be closed. */ }
  state.reconnectTimer = setTimeout(async () => {
    try {
      // Ephemeral tokens are one-use credentials. Every new WebSocket, including
      // a resumable one, must get a fresh token before it connects.
      await renewDirectToken(state);
      if (state.stopped) return;
      state.reconnectTimer = null;
      openDirectProvider(state);
    } catch {
      state.reconnectTimer = null;
      scheduleDirectReconnect(state, null, 'No se pudo renovar el token de Gemini; reintentando.');
    }
  }, wait);
}

function openDirectProvider(state) {
  if (state.stopped || !state.token) return;
  if (!/^[A-Za-z0-9/_-]+$/.test(state.token)) {
    directStatus(state, 'error', 'Gemini devolvió un token efímero con formato inesperado.');
    closeDirectProvider(state.sessionId);
    return;
  }
  const endpoint = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${state.token}`;
  const provider = new WebSocket(endpoint);
  state.socket = provider;
  const setupTimeout = setTimeout(() => {
    if (!state.ready && !state.stopped && provider === state.socket) {
      fallbackDirectProvider(state, 'timeout');
    }
  }, DIRECT_PROVIDER_SETUP_TIMEOUT_MS);
  provider.addEventListener('open', () => {
    provider.send(JSON.stringify({ setup: {
      model: `models/${apiConfig.liveTranslationModel}`,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: state.resumeHandle ? { handle: state.resumeHandle } : {},
      generationConfig: {
        responseModalities: ['AUDIO'],
        translationConfig: {
          targetLanguageCode: ({ es: 'es', en: 'en', pt: 'pt-BR' })[state.config.translateTo],
          echoTargetLanguage: true,
        },
      },
    } }));
  });
  provider.addEventListener('message', (event) => {
    if (provider !== state.socket) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      state.resumeHandle = message.sessionResumptionUpdate.newHandle;
    }
    if (message.setupComplete) {
      clearTimeout(setupTimeout);
      state.ready = true;
      state.reconnectAttempts = 0;
      directStatus(state, 'live');
    }
    if (message.error) {
      const reason = String(message.error.message || 'Gemini rechazó la conexión directa.').slice(0, 250);
      scheduleDirectReconnect(state, null, reason);
      return;
    }
    forwardDirectTranscript(state, message);
    if (message.goAway && !state.goAwayTimer) {
      const match = String(message.goAway.timeLeft || '').match(/([\d.]+)\s*(ms|s)?/i);
      const remaining = match ? Number(match[1]) * (match[2]?.toLowerCase() === 'ms' ? 1 : 1000) : 4000;
      state.goAwayTimer = setTimeout(() => {
        state.goAwayTimer = null;
        scheduleDirectReconnect(state, 0, 'Rotando la conexión larga de Gemini.');
      }, Math.max(0, remaining - 350));
    }
  });
  provider.addEventListener('close', (event) => {
    clearTimeout(setupTimeout);
    if (provider !== state.socket) return;
    if (state.stopped || state.reconnectTimer) return;
    scheduleDirectReconnect(state, null, event.reason || 'Se cerró la conexión directa con Gemini.');
  });
  provider.addEventListener('error', () => {
    if (provider !== state.socket) return;
    if (!state.stopped) scheduleDirectReconnect(state, null, 'Error de red en la conexión directa con Gemini.');
  });
}

async function renewDirectToken(state) {
  if (state.stopped) throw new Error('La sesión directa está finalizada.');
  if (state.tokenPromise) return state.tokenPromise;
  const pending = requestDirectLiveToken(state.sessionId).then((token) => {
    if (!state.stopped) state.token = token;
    return token;
  }).finally(() => {
    if (state.tokenPromise === pending) state.tokenPromise = null;
  });
  state.tokenPromise = pending;
  return pending;
}

function startDirectProvider(sessionId, token, config, appSocket) {
  closeDirectProvider(sessionId);
  const state = {
    sessionId, token, config, appSocket, socket: null, ready: false, stopped: false,
    resumeHandle: '', reconnectAttempts: 0, reconnectTimer: null, goAwayTimer: null,
    tokenPromise: null,
  };
  directProviders.set(sessionId, state);
  openDirectProvider(state);
}

function closeDirectProvider(sessionId) {
  const state = directProviders.get(sessionId);
  if (!state) return;
  state.stopped = true;
  clearTimeout(state.reconnectTimer);
  clearTimeout(state.goAwayTimer);
  try { state.socket?.close(); } catch { /* Already closed. */ }
  directProviders.delete(sessionId);
}

function encodeBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x800) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x800));
  }
  return btoa(binary);
}

function createAudioProcessor(stream, socket, sessionId) {
  const producer = producers.get(sessionId);
  if (!producer) throw new Error('La captura de audio ya no está disponible.');
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  let audioContext;
  try {
    audioContext = new AudioContextClass({ sampleRate: 16000, latencyHint: 'interactive' });
  } catch {
    audioContext = new AudioContextClass({ latencyHint: 'interactive' });
  }
  const source = audioContext.createMediaStreamSource(stream);
  let processor;
  let muted = null;
  let lastMeterAt = 0;
  let droppedChunks = 0;
  let providerAudioBytes = 0;
  let pendingSamples = new Int16Array(0);
  let lastRms = 0;
  let signalDetected = false;
  const sendPacket = (pcmBuffer, rms) => {
    const activeSocket = producer.socket;
    lastRms = rms;
    const now = performance.now();
    if (now - lastMeterAt >= 1000) {
      if (activeSocket?.readyState === WebSocket.OPEN) {
        try { activeSocket.send(JSON.stringify({ type: 'audio-level', rms: lastRms, dropped: droppedChunks, capturedAt: performance.timeOrigin + now, bufferedBytes: activeSocket.bufferedAmount })); } catch { /* The next worklet packet reports a fresh level. */ }
      }
      if (producer.config.audioSource === 'tab' && lastRms > 0.00001) {
        signalDetected = true;
        clearTimeout(producer.silentAudioTimer);
        producer.silentAudioTimer = null;
      }
      lastMeterAt = now;
    }
    if (!producer.transportReady || activeSocket?.readyState !== WebSocket.OPEN) return;
    const activeDirectState = directProviders.get(sessionId) || null;
    if (activeDirectState) {
      const provider = activeDirectState.socket;
      if (!activeDirectState.ready || provider?.readyState !== WebSocket.OPEN || provider.bufferedAmount > 48 * 1024) {
        droppedChunks += 1;
      } else {
        try { provider.send(JSON.stringify({ realtimeInput: { audio: { data: encodeBase64(pcmBuffer), mimeType: 'audio/pcm;rate=16000' } } })); }
        catch { droppedChunks += 1; }
        providerAudioBytes += pcmBuffer.byteLength;
      }
    } else {
      if (activeSocket.bufferedAmount > MAX_QUEUED_AUDIO_BYTES) {
        droppedChunks += 1;
      } else {
        const timestamped = new ArrayBuffer(AUDIO_PACKET_HEADER_BYTES + pcmBuffer.byteLength);
        const view = new DataView(timestamped);
        view.setFloat64(0, performance.timeOrigin + performance.now(), true);
        new Uint8Array(timestamped, AUDIO_PACKET_HEADER_BYTES).set(new Uint8Array(pcmBuffer));
        try { activeSocket.send(timestamped); } catch { droppedChunks += 1; }
      }
    }
    if (activeDirectState && providerAudioBytes && now - (producer.lastUsageAt || 0) >= 1000) {
      try { activeSocket.send(JSON.stringify({ type: 'audio-usage', bytes: providerAudioBytes })); } catch { /* Usage is best effort during a network interruption. */ }
      providerAudioBytes = 0;
      producer.lastUsageAt = now;
    }
  };
  const processLegacyAudio = (event) => {
    const input = event.inputBuffer;
    const mono = input.numberOfChannels === 1 ? input.getChannelData(0) : mixToMono(input);
    const converted = floatToPcm16k(mono, audioContext.sampleRate);
    const combined = new Int16Array(pendingSamples.length + converted.samples.length);
    combined.set(pendingSamples);
    combined.set(converted.samples, pendingSamples.length);
    let offset = 0;
    while (combined.length - offset >= 1600) {
      sendPacket(combined.slice(offset, offset + 1600).buffer, converted.rms);
      offset += 1600;
    }
    pendingSamples = combined.slice(offset);
  };

  const attachProcessor = async () => {
    if (audioContext.audioWorklet && window.AudioWorkletNode) {
      await loadAudioWorklet(audioContext, '/audio-worklet.js');
      processor = new AudioWorkletNode(audioContext, 'nerdearla-pcm-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1,
      });
      processor.port.onmessage = (event) => {
        if (event.data?.type === 'pcm') sendPacket(event.data.buffer, event.data.rms);
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
    } else {
      processor = audioContext.createScriptProcessor(2048, 1, 1);
      muted = audioContext.createGain();
      muted.gain.value = 0;
      processor.onaudioprocess = processLegacyAudio;
      source.connect(processor);
      processor.connect(muted);
      muted.connect(audioContext.destination);
      showToast('Este navegador usa captura de audio compatible; AudioWorklet no está disponible.', 'error');
    }
    await audioContext.resume();
  };
  Object.assign(producer, { socket, stream, audioContext, processor: null, source, muted: null });
  return attachProcessor().then(() => {
    Object.assign(producer, { processor, source, muted });
    if (producer.config.audioSource === 'tab' && !signalDetected) {
      producer.silentAudioTimer = setTimeout(() => {
        if (!producer.terminal && !signalDetected && producers.get(sessionId) === producer) {
          showToast('La pestaña está compartida, pero todavía no llega sonido. Verificá que la charla esté reproduciéndose y que activaste “Compartir audio de la pestaña”.', 'error');
        }
      }, 8000);
    }
  }).catch((error) => {
    releaseProducer(sessionId, { stopTracks: false, remove: false });
    throw error;
  });
}

function mixToMono(audioBuffer) {
  const output = new Float32Array(audioBuffer.length);
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const samples = audioBuffer.getChannelData(channel);
    for (let index = 0; index < output.length; index += 1) output[index] += samples[index] / audioBuffer.numberOfChannels;
  }
  return output;
}

function floatToPcm16k(input, sampleRate) {
  const ratio = sampleRate / 16000;
  const outputLength = Math.floor(input.length / ratio);
  const samples = new Int16Array(outputLength);
  let sumSquares = 0;
  for (let i = 0; i < outputLength; i += 1) {
    const start = i * ratio;
    const end = (i + 1) * ratio;
    let weighted = 0;
    for (let sourceIndex = Math.floor(start); sourceIndex < Math.ceil(end); sourceIndex += 1) {
      const weight = Math.min(end, sourceIndex + 1) - Math.max(start, sourceIndex);
      if (weight > 0 && sourceIndex < input.length) weighted += input[sourceIndex] * weight;
    }
    const sample = Math.max(-1, Math.min(1, weighted / ratio));
    sumSquares += sample * sample;
    samples[i] = sample < 0 ? sample * 32768 : sample * 32767;
  }
  return { samples, rms: outputLength ? Math.sqrt(sumSquares / outputLength) : 0 };
}

function releaseProducer(sessionId, { stopTracks = true, remove = true } = {}) {
  const producer = producers.get(sessionId);
  if (!producer) return;
  if (remove) producers.delete(sessionId);
  clearTimeout(producer.silentAudioTimer);
  if (producer.processor) {
    producer.processor.onaudioprocess = null;
    if (producer.processor.port) producer.processor.port.onmessage = null;
  }
  try { producer.source?.disconnect(); } catch { /* Audio nodes can already be disconnected. */ }
  try { producer.processor?.disconnect(); } catch { /* Audio nodes can already be disconnected. */ }
  try { producer.muted?.disconnect(); } catch { /* AudioWorklet does not create a muted gain node. */ }
  if (stopTracks) {
    try { producer.stream?.getTracks().forEach((track) => track.stop()); } catch { /* The browser may have ended capture already. */ }
  }
  try {
    if (producer.audioContext && producer.audioContext.state !== 'closed') {
      Promise.resolve(producer.audioContext.close()).catch(() => {});
    }
  } catch { /* The browser may have closed the context already. */ }
  Object.assign(producer, { audioContext: null, processor: null, source: null, muted: null });
}

async function startSession(config, sessionId = null) {
  if (config.engine === 'gemini-direct' && config.glossary?.length) {
    config.engine = 'gemini';
    showToast('El glosario requiere la traducción contextual; esta sesión usará Gemini por servidor.', 'success');
  }
  if (config.engine === 'gemini-direct' && config.translateTo === 'none') config.engine = 'gemini';
  if (config.engine !== 'local' && !apiConfig.configured) {
    showToast('Para iniciar una sala real, agregá GEMINI_API_KEY a .env y reiniciá el servidor.', 'error');
    return;
  }
  if (config.engine === 'local' && !apiConfig.localProviderAvailable) {
    showToast('No hay un servicio WhisperLiveKit configurado.', 'error');
    return;
  }
  if (config.audioSource === 'tab' && !navigator.mediaDevices?.getDisplayMedia) {
    showToast('Este navegador no permite compartir el audio de una pestaña. Abrí Nerdearla en Chrome o Brave actualizado.', 'error');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast('El navegador no puede acceder al micrófono. Abrí la app en localhost o con HTTPS.', 'error');
    return;
  }
  let stream;
  try {
    stream = config.audioSource === 'tab'
      ? await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser', frameRate: { ideal: 1, max: 2 } },
        audio: true,
        preferCurrentTab: false,
        selfBrowserSurface: 'exclude',
        // Prevent Chromium's browser-level "Share this tab instead" button
        // from silently switching this session to another room's audio.
        surfaceSwitching: 'exclude',
        systemAudio: 'exclude',
        windowAudio: 'exclude',
      })
      : await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    if (config.audioSource === 'tab') {
      if (!stream.getAudioTracks().length) throw new Error('El navegador compartió la imagen sin audio. En “Pestaña de Chrome”, elegí la sala y activá “Compartir audio de la pestaña”.');
    }
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    const denied = error?.name === 'NotAllowedError';
    showToast(error?.message && !denied ? error.message : denied ? 'No se concedió el permiso para compartir audio.' : 'No pudimos abrir la entrada de audio.', 'error');
    return;
  }
  const id = sessionId || `s-${crypto.randomUUID()}`;
  const stored = { ...config, sessionId: id };
  const videoTrack = stream.getVideoTracks()[0];
  let displaySurface = '';
  try { displaySurface = videoTrack?.getSettings?.().displaySurface || ''; } catch { /* Some browsers do not expose the selected surface type. */ }
  const audioTrack = stream.getAudioTracks()[0];
  const captureDiagnostics = {
    source: config.audioSource === 'tab' ? 'tab' : 'microphone',
    displaySurface: ['browser', 'window', 'monitor'].includes(displaySurface) ? displaySurface : 'unknown',
    audioTrackCount: stream.getAudioTracks().length,
    audioTrackReadyState: audioTrack?.readyState || 'missing',
    audioTrackMuted: Boolean(audioTrack?.muted),
    audioTrackEnabled: Boolean(audioTrack?.enabled),
  };
  const controller = {
    id, config: stored, stream, captureDiagnostics, socket: null, transportReady: false,
    reconnectAttempt: 0, reconnectTimer: null, openTimer: null, stableTimer: null,
    terminal: false, intentionalStop: false, everLive: false,
  };
  producers.set(id, controller);
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('mute', () => {
      controller.captureDiagnostics.audioTrackMuted = true;
      if (controller.socket?.readyState === WebSocket.OPEN) controller.socket.send(JSON.stringify({ type: 'capture-track-state', muted: true, readyState: track.readyState }));
      if (!controller.terminal) showToast('El navegador dejó la pista de audio en silencio. Revisá el sonido de la pestaña compartida.');
    });
    track.addEventListener('unmute', () => {
      controller.captureDiagnostics.audioTrackMuted = false;
      if (controller.socket?.readyState === WebSocket.OPEN) controller.socket.send(JSON.stringify({ type: 'capture-track-state', muted: false, readyState: track.readyState }));
    });
    track.addEventListener('ended', () => {
      if (controller.terminal) return;
      controller.terminal = true;
      controller.transportReady = false;
      clearTimeout(controller.reconnectTimer);
      clearTimeout(controller.stableTimer);
      const reason = 'La captura terminó: el navegador dejó de compartir el audio.';
      if (controller.socket?.readyState === WebSocket.OPEN) {
        controller.socket.send(JSON.stringify({ type: 'capture-ended', reason }));
        controller.socket.close(1000, 'La captura de audio terminó');
      }
      closeDirectProvider(id);
      releaseProducer(id);
      showToast(reason, 'error');
      refreshSessions();
    }, { once: true });
  }
  connectProducerSocket(controller);
}

function finishProducer(controller, message = '', tone = '') {
  if (!controller || controller.terminal) return;
  controller.terminal = true;
  controller.transportReady = false;
  clearTimeout(controller.reconnectTimer);
  clearTimeout(controller.openTimer);
  clearTimeout(controller.stableTimer);
  closeDirectProvider(controller.id);
  releaseProducer(controller.id);
  if (message) showToast(message, tone);
  refreshSessions();
}

function scheduleProducerReconnect(controller, closeEvent = null) {
  if (controller.terminal || controller.intentionalStop) {
    releaseProducer(controller.id);
    return;
  }
  const liveTracks = controller.stream.getAudioTracks().some((track) => track.readyState === 'live');
  if (!liveTracks) {
    finishProducer(controller, 'El navegador terminó la captura de audio. Volvé a compartir la fuente para continuar.', 'error');
    return;
  }
  if (controller.reconnectAttempt >= MAX_PRODUCER_RECONNECTS) {
    finishProducer(controller, `No se pudo recuperar la conexión de audio después de ${MAX_PRODUCER_RECONNECTS} intentos. Revisá la red y volvé a conectar la fuente.`, 'error');
    return;
  }
  controller.reconnectAttempt += 1;
  const delay = Math.min(8000, 500 * (2 ** (controller.reconnectAttempt - 1)));
  const code = closeEvent?.code;
  const reason = String(closeEvent?.reason || '').trim();
  const closeDetail = reason ? `: ${reason.slice(0, 100)}` : '';
  showToast(`Se interrumpió el enlace de subtítulos${code ? ` (código ${code}${closeDetail})` : ''}; recuperando el audio en ${Math.ceil(delay / 1000)} s…`);
  controller.reconnectTimer = setTimeout(() => {
    controller.reconnectTimer = null;
    if (!controller.terminal) connectProducerSocket(controller);
  }, delay);
  refreshSessions();
}

function connectProducerSocket(controller) {
  if (controller.terminal) return;
  let socket;
  try {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  } catch {
    scheduleProducerReconnect(controller);
    return;
  }
  controller.socket = socket;
  controller.transportReady = false;
  socket.binaryType = 'arraybuffer';
  controller.openTimer = setTimeout(() => {
    if (controller.socket === socket && socket.readyState === WebSocket.CONNECTING) socket.close();
  }, 8000);
  socket.addEventListener('open', () => {
    clearTimeout(controller.openTimer);
    if (controller.socket !== socket || controller.terminal) return;
    const audioProducer = producers.get(controller.id);
    if (audioProducer) audioProducer.socket = socket;
    socket.send(JSON.stringify({ type: 'start', ...controller.config, captureDiagnostics: controller.captureDiagnostics }));
    if (!controller.audioContext) {
      createAudioProcessor(controller.stream, socket, controller.id).then(() => {
        if (controller.socket === socket && !controller.terminal && !controller.transportReady) {
          showToast(controller.config.audioSource === 'tab' ? 'Pista de audio de la pestaña lista; conectando Gemini…' : 'Entrada de audio lista; conectando Gemini…', 'success');
        }
      }).catch((error) => {
        if (controller.socket !== socket || controller.terminal) return;
        const detail = error?.name ? ` (${error.name})` : '';
        finishProducer(controller, `No pudimos iniciar el procesamiento del audio${detail}.`, 'error');
        socket.close();
      });
    }
  });
  socket.addEventListener('message', async (event) => {
    if (controller.socket !== socket || controller.terminal) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'status' && message.status === 'live') {
      controller.transportReady = true;
      clearTimeout(controller.stableTimer);
      controller.stableTimer = setTimeout(() => { controller.reconnectAttempt = 0; }, 15000);
      try {
        if (!controller.audioContext) await createAudioProcessor(controller.stream, socket, controller.id);
        if (controller.socket !== socket || controller.terminal) return;
        $('#micStatus').textContent = '✓';
        $('#micStatus').classList.add('ready-check');
        showToast(controller.everLive ? `Audio recuperado · ${controller.config.title}` : `Audio conectado · ${controller.config.title}`, 'success');
        controller.everLive = true;
      } catch (error) {
        const detail = error?.name ? ` (${error.name})` : '';
        finishProducer(controller, `No pudimos iniciar el procesamiento del audio en este navegador${detail}.`, 'error');
        socket.close();
      }
      refreshSessions();
    }
    if (message.type === 'direct-provider-required') {
      try {
        const token = await requestDirectLiveToken(controller.id);
        if (controller.socket === socket && !controller.terminal) startDirectProvider(controller.id, token, controller.config, socket);
      } catch {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'direct-provider-fallback' }));
      }
    }
    if (message.type === 'direct-provider-fallback') showToast(message.message, 'success');
    if (message.type === 'provider-fallback') showToast(message.message, 'success');
    if (message.type === 'provider-retrying') showToast(`Reintentando conexión (${message.attempt}/5)…`);
    if (message.type === 'error') {
      finishProducer(controller, message.message, 'error');
      socket.close();
    }
    if (message.type === 'status' || message.type === 'final' || message.type === 'translation') refreshSessions();
    if (message.type === 'status' && ['finished', 'paused', 'error'].includes(message.status)) {
      finishProducer(controller, message.reason || '', message.status === 'error' ? 'error' : '');
      socket.close();
    }
  });
  socket.addEventListener('close', (event) => {
    if (controller.socket !== socket) return;
    clearTimeout(controller.openTimer);
    clearTimeout(controller.stableTimer);
    controller.socket = null;
    controller.transportReady = false;
    closeDirectProvider(controller.id);
    refreshSessions();
    scheduleProducerReconnect(controller, event);
  });
  socket.addEventListener('error', () => {
    if (controller.socket === socket && !controller.terminal) socket.close();
  });
}

function stopSession(sessionId) {
  const producer = producers.get(sessionId);
  if (producer) {
    producer.intentionalStop = true;
    producer.terminal = true;
    producer.transportReady = false;
    clearTimeout(producer.reconnectTimer);
    clearTimeout(producer.openTimer);
    clearTimeout(producer.stableTimer);
  }
  const socket = producer?.socket;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'stop' }));
    setTimeout(() => socket.close(), 150);
  } else if (socket) {
    socket.close();
  }
  closeDirectProvider(sessionId);
  releaseProducer(sessionId);
  setTimeout(refreshSessions, 250);
}

function runDemo() {
  if (demoSessions.size) {
    demoTimers.forEach(clearInterval);
    demoTimers = [];
    demoSessions.clear();
    render();
    $('#demoButton').innerHTML = '<span class="play-icon">▶</span> Ver demo';
    showToast('La demo terminó. Las salas de ejemplo siguen disponibles para explorar.');
    return;
  }
  const rooms = [
    { id: 'demo-principal', title: 'Auditorio principal', speaker: 'Alex Rivera', language: 'en', translateTo: 'es' },
    { id: 'demo-open-source', title: 'Track Open Source', speaker: 'Lucía Fernández', language: 'es', translateTo: 'en' },
    { id: 'demo-cloud', title: 'Track Cloud & DevOps', speaker: 'Sam Wilson', language: 'en', translateTo: 'es' },
  ];
  rooms.forEach((room, roomIndex) => {
    demoSessions.set(room.id, { ...room, status: 'live', lines: [], updatedAt: new Date().toISOString(), startedAt: new Date().toISOString(), index: roomIndex });
    let lineIndex = roomIndex % 2;
    const addLine = () => {
      const demo = demoSessions.get(room.id);
      if (!demo) return;
      const sample = (room.language === 'es' ? esLines : enLines)[lineIndex % (room.language === 'es' ? esLines : enLines).length];
      demo.lines.push({ id: `${room.id}-${lineIndex}-${Date.now()}`, at: new Date().toISOString(), original: sample[0], translation: sample[1], translated: true });
      demo.updatedAt = new Date().toISOString();
      lineIndex += 1;
      render();
    };
    setTimeout(addLine, 750 + roomIndex * 480);
    demoTimers.push(setInterval(addLine, 5700 + roomIndex * 700));
  });
  $('#demoButton').innerHTML = '<span class="play-icon">■</span> Detener demo';
  render();
  showToast('Demo en vivo: tres salas, subtítulos y traducción de ejemplo.', 'success');
}

function toVttTime(milliseconds) {
  const value = Math.max(0, Math.floor(milliseconds));
  const hours = Math.floor(value / 3_600_000).toString().padStart(2, '0');
  const minutes = Math.floor((value % 3_600_000) / 60_000).toString().padStart(2, '0');
  const seconds = Math.floor((value % 60_000) / 1000).toString().padStart(2, '0');
  const millis = (value % 1000).toString().padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

function liveTranslationCues(session) {
  const segments = (session.translationSegments || []).filter((segment) => segment.text?.trim());
  if (!segments.length) return [];
  const start = new Date(session.startedAt || segments[0].at).getTime();
  const groups = [];
  let current = null;
  for (const segment of segments) {
    const at = typeof segment.at === 'number' ? segment.at : new Date(segment.at).getTime();
    if (!current) current = { startAt: at, endAt: at, text: '' };
    current.endAt = at;
    current.text += segment.text;
    if (/[.!?。！？]["')\]]?\s*$/u.test(current.text) || current.text.length >= 100 || at - current.startAt >= 3000) {
      groups.push(current);
      current = null;
    }
  }
  if (current) groups.push(current);
  return groups.map((group, index) => {
    const cueStart = Math.max(0, group.startAt - start);
    const nextStart = groups[index + 1] ? groups[index + 1].startAt - start : group.endAt - start + 3500;
    return {
      start: cueStart,
      end: Math.max(cueStart + 1400, nextStart - 100),
      text: group.text.trim(),
    };
  });
}

function exportVtt(session, translated = false) {
  const lines = session.lines || [];
  if (!lines.length) return showToast('Todavía no hay subtítulos para exportar.');
  if (translated && session.translationText && session.translationSegments?.length) {
    const cues = liveTranslationCues(session).map((cue, index) => `${index + 1}\n${toVttTime(cue.start)} --> ${toVttTime(cue.end)}\n${cue.text}\n`);
    return downloadFile(`${safeFileName(session.title)}-${session.translateTo}.vtt`, `WEBVTT\n\n${cues.join('\n')}`, 'text/vtt;charset=utf-8');
  }
  const start = new Date(session.startedAt || lines[0].at).getTime();
  const cues = lines.map((line, index) => {
    const cueStart = Math.max(0, new Date(line.at).getTime() - start);
    const nextStart = index + 1 < lines.length ? new Date(lines[index + 1].at).getTime() - start : cueStart + 3500;
    const content = translated && line.translation ? line.translation : line.original;
    return `${index + 1}\n${toVttTime(cueStart)} --> ${toVttTime(Math.max(cueStart + 1400, nextStart - 150))}\n${content}\n`;
  });
  downloadFile(`${session.title.replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/g, '') || 'nerdearla'}-${translated ? session.translateTo : session.language || 'original'}.vtt`, `WEBVTT\n\n${cues.join('\n')}`, 'text/vtt;charset=utf-8');
}

function exportSrt(session, translated = false) {
  const lines = session.lines || [];
  if (!lines.length) return showToast('Todavía no hay subtítulos para exportar.');
  if (translated && session.translationText && session.translationSegments?.length) {
    const cues = liveTranslationCues(session).map((cue, index) => `${index + 1}\n${toVttTime(cue.start).replace('.', ',')} --> ${toVttTime(cue.end).replace('.', ',')}\n${cue.text}\n`);
    return downloadFile(`${safeFileName(session.title)}-${session.translateTo}.srt`, cues.join('\n'), 'application/x-subrip;charset=utf-8');
  }
  const start = new Date(session.startedAt || lines[0].at).getTime();
  const cues = lines.map((line, index) => {
    const cueStart = Math.max(0, new Date(line.at).getTime() - start);
    const nextStart = index + 1 < lines.length ? new Date(lines[index + 1].at).getTime() - start : cueStart + 3500;
    const content = translated && line.translation ? line.translation : line.original;
    return `${index + 1}\n${toVttTime(cueStart).replace('.', ',')} --> ${toVttTime(Math.max(cueStart + 1400, nextStart - 150)).replace('.', ',')}\n${content}\n`;
  });
  const suffix = translated ? session.translateTo : session.language || 'original';
  downloadFile(`${safeFileName(session.title)}-${suffix}.srt`, cues.join('\n'), 'application/x-subrip;charset=utf-8');
}

function exportText(session, translated = false) {
  const lines = session.lines || [];
  if (!lines.length) return showToast('Todavía no hay subtítulos para exportar.');
  const content = translated && session.translationText
    ? session.translationText
    : lines.map((line) => translated && line.translation ? line.translation : line.original).join('\n\n');
  const suffix = translated ? session.translateTo : session.language || 'original';
  downloadFile(`${safeFileName(session.title)}-${suffix}.txt`, content, 'text/plain;charset=utf-8');
}

function safeFileName(value) {
  return String(value || 'nerdearla').replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/g, '') || 'nerdearla';
}

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
}

async function exportFromServer(session, format, translated = false) {
  if (session.demo) {
    if (format === 'vtt') return exportVtt(session, translated);
    if (format === 'srt') return exportSrt(session, translated);
    return exportText(session, translated);
  }
  const language = translated ? 'translation' : 'original';
  const path = `/api/sessions/${encodeURIComponent(session.id)}/export?format=${format}&language=${language}`;
  try {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error('No se pudo preparar la exportación de subtítulos.');
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${safeFileName(session.title)}-${translated ? session.translateTo : session.language}.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) { showToast(error.message, 'error'); }
}

function getSession(id) {
  return serverSessions.find((session) => session.id === id) || demoSessions.get(id);
}

$('#newSessionButton').addEventListener('click', () => openDialog());
$('#addSessionSmall').addEventListener('click', () => openDialog());
$('#emptyAddButton').addEventListener('click', () => openDialog());
$('#closeDialog').addEventListener('click', () => sessionDialog.close());
$('#cancelDialog').addEventListener('click', () => sessionDialog.close());
$('#demoButton').addEventListener('click', runDemo);
$('#prepareKeynote').addEventListener('click', () => openDialog({
  title: 'Monty Widenius opening keynote',
  speaker: 'Monty Widenius',
  language: 'en',
  translateTo: 'es',
  audioSource: 'tab',
}));
$('#sessionSearch').addEventListener('input', (event) => { searchText = event.target.value.trim().toLowerCase(); render(); });
$('#filterButton').addEventListener('click', () => showToast('Mostrando todas las salas. Los filtros avanzados estarán disponibles próximamente.'));
$('#audioSourceInput').addEventListener('change', updateAudioNotice);
$('#titleInput').addEventListener('input', updateAudioNotice);
$('#sourceUrlInput').addEventListener('input', updateAudioNotice);
$('#languageInput').addEventListener('change', (event) => {
  const language = event.target.value;
  $('#translateInput').value = language === 'es' ? 'en' : 'es';
});

document.querySelectorAll('[data-template]').forEach((button) => button.addEventListener('click', () => {
  const name = button.dataset.template;
  const language = name === 'Open Source' ? 'es' : 'en';
  openDialog({ title: name === 'Principal' ? 'Auditorio principal' : `Track ${name}`, language, translateTo: language === 'es' ? 'en' : 'es' });
}));

sessionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(sessionForm);
  const language = String(form.get('language'));
  const translateTo = String(form.get('translateTo'));
  const config = {
    title: String(form.get('title')).trim(),
    speaker: String(form.get('speaker')).trim(),
    speakerRoster: String(form.get('speaker')).split(/[\n,;]+/u).map((name) => name.trim()).filter(Boolean),
    language,
    translate: translateTo !== 'none',
    translateTo: translateTo === 'none' ? null : translateTo,
    audioSource: String(form.get('audioSource')),
    engine: String(form.get('engine') || 'gemini'),
    glossary: String(form.get('glossary')).split(/[\n,;]/).map((term) => term.trim()).filter(Boolean),
    earlyTranslation: $('#earlyTranslationInput').checked,
  };
  const sourceUrl = String(form.get('sourceUrl') || '').trim();
  sessionDialog.close();
  if (sourceUrl && window.nerdearlaDesktop?.openChromiumSession) {
    const result = await window.nerdearlaDesktop.openChromiumSession({
      ...config,
      sessionId: reuseSessionId || `s-${crypto.randomUUID()}`,
      sourceUrl,
    });
    if (!result?.ok) showToast(result?.error || 'No se pudo abrir Chromium para esta sesión.', 'error');
    else showToast(`Chromium independiente abierto para «${config.title}». Usá la extensión en esa ventana para conectar el audio.`, 'success');
  } else {
    await startSession(config, reuseSessionId);
  }
  reuseSessionId = null;
});

sessionGrid.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const session = getSession(button.dataset.id);
  if (!session) return;
  if (button.dataset.action === 'audience') {
    const url = session.demo ? `/audience.html?demo=1&session=${encodeURIComponent(session.id)}` : `/audience.html?session=${encodeURIComponent(session.id)}`;
    window.open(url, '_blank', 'noopener');
  }
  if (button.dataset.action === 'stop') {
    stopSession(session.id);
    showToast(`Finalizando ${session.title}…`);
  }
  if (button.dataset.action === 'delete-session') {
    if (!window.confirm(`Borrar “${session.title}” y su transcripción guardada? Esta acción no se puede deshacer.`)) return;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE', cache: 'no-store' });
      if (!response.ok) throw new Error((await response.json()).error || 'No se pudo borrar la sesión.');
      serverSessions = serverSessions.filter((item) => item.id !== session.id);
      render();
      showToast('Sesión y transcripción eliminadas.', 'success');
    } catch (error) { showToast(error.message, 'error'); }
  }
  if (button.dataset.action === 'confirm-speaker') {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/speakers/${encodeURIComponent(button.dataset.speakerId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: button.dataset.name }), cache: 'no-store',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'No se pudo guardar el nombre de la voz.');
      await refreshSessions();
      showToast(`${result.name} quedó asociado a esa voz.`, 'success');
    } catch (error) { showToast(error.message, 'error'); }
  }
  if (button.dataset.action === 'save-speaker-map') {
    const name = button.closest('.speaker-map-row')?.querySelector('.speaker-name-input')?.value.trim();
    if (!name) return showToast('Escribí el nombre que corresponde a esta voz.', 'error');
    button.disabled = true;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/speakers/${encodeURIComponent(button.dataset.speakerId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }), cache: 'no-store',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'No se pudo guardar el nombre de la voz.');
      await refreshSessions();
      showToast(`${result.name} quedó asociado a esa voz.`, 'success');
    } catch (error) {
      button.disabled = false;
      showToast(error.message, 'error');
    }
  }
  if (button.dataset.action === 'reconnect') {
    openDialog({ ...session, translateTo: session.translateTo });
  }
  if (button.dataset.action === 'open-chromium' && window.nerdearlaDesktop?.openChromiumSession) {
    const result = await window.nerdearlaDesktop.openChromiumSession({
      sessionId: session.id,
      title: session.title,
      speaker: session.speaker,
      language: session.language,
      translateTo: session.translateTo,
      engine: session.requestedEngine || session.engine,
      glossary: session.glossary,
      earlyTranslation: session.earlyTranslation,
      sourceUrl: session.sourceUrl,
    });
    if (!result?.ok) showToast(result?.error || 'No se pudo reabrir Chromium.', 'error');
    else showToast(`Se abrió Chromium aislado para «${session.title}».`, 'success');
  }
  if (button.dataset.action === 'export-vtt') exportFromServer(session, 'vtt');
  if (button.dataset.action === 'export-menu') {
    if (!session.lines?.length) return showToast('Todavía no hay subtítulos para exportar.');
    const choice = session.translateTo && (session.translationText || session.lines.some((line) => line.translation))
      ? window.confirm('Aceptar: exportar traducción. Cancelar: exportar idioma original.')
      : false;
    const format = String(window.prompt('Formato de descarga: VTT, SRT o TXT', 'VTT') || '').trim().toLowerCase();
    if (format === 'vtt') exportFromServer(session, 'vtt', choice);
    else if (format === 'srt') exportFromServer(session, 'srt', choice);
    else if (format === 'txt') exportFromServer(session, 'txt', choice);
    else if (format) showToast('Elegí VTT, SRT o TXT para exportar.');
  }
  if (button.dataset.action === 'overlay') {
    const overlayUrl = new URL('/audience.html', location.origin);
    overlayUrl.searchParams.set('session', session.id);
    overlayUrl.searchParams.set('lang', session.translateTo ? 'translation' : 'original');
    overlayUrl.searchParams.set('overlay', '1');
    try {
      await navigator.clipboard.writeText(overlayUrl.toString());
      showToast('URL del overlay OBS copiada. Pegala como Browser Source.', 'success');
    } catch {
      window.prompt('Copiá la URL del overlay para OBS:', overlayUrl.toString());
    }
  }
});

loadSystemStatus();
refreshSessions();
refreshCosts();
render();
setInterval(refreshSessions, 3000);
setInterval(refreshCosts, 2000);
