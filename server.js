import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';
import { flushSessions, loadSessions, saveSessions } from './lib/storage.js';
import { cleanSpeakerAlias, normalizeSpeakerAliases, speakerIdFor, suggestSelfIntroducedSpeakerName } from './lib/speakers.js';
import { buildGeminiTranscriptionConfig } from './lib/gemini-transcription-config.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const MODEL = process.env.TRANSCRIBE_MODEL || 'gemini-3.5-transcribe-live';
const LIVE_TRANSLATION_MODEL = process.env.LIVE_TRANSLATION_MODEL || 'gemini-3.5-live-translate-preview';
const TRANSLATION_MODEL = process.env.TRANSLATION_MODEL || 'gemini-3.5-flash-lite';
const LOCAL_ASR_WS_URL = process.env.LOCAL_ASR_WS_URL || '';
const AUTO_FALLBACK_TO_LOCAL = process.env.AUTO_FALLBACK_TO_LOCAL === 'true';
const LOCAL_SPEAKER_DIARIZATION = process.env.LOCAL_SPEAKER_DIARIZATION === 'true';
const MAX_ACTIVE_SESSIONS = Math.max(1, Number(process.env.MAX_ACTIVE_SESSIONS || 30));
const MAX_AUDIO_QUEUE_CHUNKS = Math.max(1, Number(process.env.MAX_AUDIO_QUEUE_CHUNKS || 3));
const MAX_VIEWER_BUFFERED_BYTES = 256 * 1024;
const BILLING_TIER = process.env.GEMINI_BILLING_TIER === 'paid' ? 'paid' : 'free';
const DAILY_BUDGET_USD = Math.max(0, Number(process.env.DAILY_BUDGET_USD || 0));
const RATES = {
  liveTranslatePerMinute: Number(process.env.GEMINI_LIVE_TRANSLATE_USD_PER_MINUTE || 0.0368),
  transcribePerMinute: Number(process.env.GEMINI_TRANSCRIBE_LIVE_USD_PER_MINUTE || 0.009),
  flashLiteInputPerMillion: Number(process.env.FLASH_LITE_INPUT_USD_PER_MILLION || 0.30),
  flashLiteOutputPerMillion: Number(process.env.FLASH_LITE_OUTPUT_USD_PER_MILLION || 2.50),
  localPerMinute: Math.max(0, Number(process.env.LOCAL_ASR_INFRA_USD_PER_MINUTE || 0)),
};
const TARGET_LANGUAGE_CODES = { es: 'es', en: 'en', pt: 'pt-BR' };
const sessions = new Map();
const latencySamples = { source: [], translation: [], draftFirstToken: [], ingest: [], viewer: [] };
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.vtt': 'text/vtt; charset=utf-8',
};

function restoreSession(saved) {
  const session = {
    ...saved,
    status: ['live', 'connecting', 'reconnecting'].includes(saved.status) ? 'paused' : saved.status,
    error: ['live', 'connecting', 'reconnecting'].includes(saved.status) ? 'El servidor se reinició. Volvé a conectar el audio para continuar.' : saved.error,
    clients: new Set(), producer: null, live: null, audioQueue: [], audioSending: false,
    translationTasks: 0, translationPending: null, draftTimer: null, draftInFlight: false, draftAbortController: null, reconnectTimer: null,
    manualStop: false, connectionGeneration: 0, reconnectAttempts: 0,
    goAwayTimer: null,
    translationDraft: saved.translationDraft || '',
    speakerRoster: Array.isArray(saved.speakerRoster) ? saved.speakerRoster.map(cleanSpeakerAlias).filter(Boolean) : [],
    speakerAliases: normalizeSpeakerAliases(saved.speakerAliases),
    speakerSuggestions: saved.speakerSuggestions || {},
    speakers: Array.isArray(saved.speakers) ? saved.speakers : [],
    billing: saved.billing || { cloudLiveBytes: 0, cloudTranscribeBytes: 0, localBytes: 0, inputTokens: 0, outputTokens: 0 },
    telemetry: saved.telemetry || {},
  };
  delete session.viewerToken;
  sessions.set(session.id, session);
}

for (const saved of await loadSessions()) restoreSession(saved);

function securityHeaders(response) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('permissions-policy', 'microphone=(self), display-capture=(self), camera=()');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
}

function sendJson(response, status, body) {
  securityHeaders(response);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function cleanLine(text) {
  return String(text || '').trim();
}

function viewerSession(session) {
  return {
    id: session.id, title: session.title, speaker: session.speaker,
    language: session.language, translateTo: session.translateTo,
    translationMode: session.translationMode, engine: session.engine,
    model: session.model, status: session.status, createdAt: session.createdAt,
    startedAt: session.startedAt, updatedAt: session.updatedAt,
    lines: (session.lines || []).slice(-30),
    translationText: (session.translationText || '').slice(-6000),
    translationDraft: session.translationDraft || '',
    translationDraftAt: session.translationDraftAt || null,
    nativeTranslationAt: session.nativeTranslationAt || null,
    translationSegments: (session.translationSegments || []).slice(-120),
    speakerRoster: session.speakerRoster || [],
    speakerAliases: session.speakerAliases || {},
    speakerSuggestions: session.speakerSuggestions || {},
    speakers: session.speakers || [],
    telemetry: {
      inputFinalEvents: session.telemetry?.inputFinalEvents || 0,
      translationEvents: session.telemetry?.translationEvents || 0,
      captureToFirstCaptionMs: session.telemetry?.captureToFirstCaptionMs || null,
    },
  };
}

function operatorSession(session, full = false) {
  return {
    ...viewerSession(session),
    lines: full ? session.lines : (session.lines || []).slice(-100),
    requestedEngine: session.requestedEngine || session.engine,
    audioSource: session.audioSource || 'microphone',
    earlyTranslation: Boolean(session.earlyTranslation),
    glossary: session.glossary || [], error: session.error || null,
    translationLatencyMs: session.translationLatencyMs || null,
    telemetry: session.telemetry || null,
    provider: session.providerDiagnostics || null,
    billing: sessionCost(session),
  };
}

function persist() {
  saveSessions(sessions);
}

function activeSessionCount() {
  return [...sessions.values()].filter((session) => ['connecting', 'live', 'reconnecting'].includes(session.status)).length;
}

function audioMinutes(bytes) {
  return Number(bytes || 0) / 32_000 / 60;
}

function sessionCost(session) {
  const billing = session.billing || {};
  const liveMinutes = audioMinutes(billing.cloudLiveBytes);
  const transcribeMinutes = audioMinutes(billing.cloudTranscribeBytes);
  const localMinutes = audioMinutes(billing.localBytes);
  const cloudEquivalentUsd = liveMinutes * RATES.liveTranslatePerMinute
    + transcribeMinutes * RATES.transcribePerMinute
    + (Number(billing.inputTokens || 0) * RATES.flashLiteInputPerMillion
      + Number(billing.outputTokens || 0) * RATES.flashLiteOutputPerMillion) / 1_000_000;
  const localUsd = localMinutes * RATES.localPerMinute;
  const billableUsd = (BILLING_TIER === 'free' ? 0 : cloudEquivalentUsd) + localUsd;
  return {
    audioMinutes: liveMinutes + transcribeMinutes + localMinutes,
    liveTranslateMinutes: liveMinutes,
    transcribeMinutes,
    localMinutes,
    draftTranslationCalls: Number(billing.draftTranslationCalls || 0),
    cloudEquivalentUsd,
    billableUsd,
    localInfraRateConfigured: Boolean(RATES.localPerMinute),
  };
}

function costSummary() {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const active = [...sessions.values()].filter((session) =>
    ['connecting', 'live', 'reconnecting'].includes(session.status)
    || new Date(session.startedAt || session.createdAt).getTime() >= since);
  const costs = active.map((session) => ({ session, cost: sessionCost(session) }));
  const totalEquivalent = costs.reduce((sum, item) => sum + item.cost.cloudEquivalentUsd + (item.session.engine === 'local' ? item.cost.localMinutes * RATES.localPerMinute : 0), 0);
  const totalBillable = costs.reduce((sum, item) => sum + item.cost.billableUsd, 0);
  const totalMinutes = costs.reduce((sum, item) => sum + item.cost.audioMinutes, 0);
  return {
    generatedAt: new Date().toISOString(), billingTier: BILLING_TIER,
    window: '24h', totalBillableUsd: totalBillable, paidEquivalentUsd: totalEquivalent,
    totalAudioMinutes: totalMinutes, dailyBudgetUsd: DAILY_BUDGET_USD || null,
    budgetPercent: DAILY_BUDGET_USD ? Math.min(100, totalEquivalent / DAILY_BUDGET_USD * 100) : null,
    basis: 'Tarifa pública de Gemini: Live Translate usa costo combinado estimado por minuto; Transcribe Live incluye audio + texto; Flash-Lite usa tokens de entrada y salida medidos. El nivel gratuito factura US$0 mientras sus cuotas estén disponibles.',
    rates: RATES,
    sessions: costs.map(({ session, cost }) => ({ id: session.id, title: session.title, status: session.status, engine: session.engine, model: session.model, ...cost })),
  };
}

function addLatency(kind, milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 120_000) return;
  const samples = latencySamples[kind];
  samples.push(milliseconds);
  if (samples.length > 500) samples.shift();
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]);
}

function metricsSummary() {
  const active = [...sessions.values()].filter((session) => ['live', 'connecting', 'reconnecting'].includes(session.status));
  return {
    generatedAt: new Date().toISOString(), activeSessions: active.length,
    maxActiveSessions: MAX_ACTIVE_SESSIONS,
    viewers: active.reduce((sum, session) => sum + [...session.clients].filter((client) => client.role === 'viewer').length, 0),
    audioChunksDropped: active.reduce((sum, session) => sum + (session.telemetry?.audioChunksDropped || 0), 0),
    latencyMs: Object.fromEntries(Object.entries(latencySamples).map(([kind, values]) => [kind, { p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99), samples: values.length }])),
    providers: { gemini: Boolean(ai), localAsr: Boolean(LOCAL_ASR_WS_URL) },
  };
}

function formatVttTime(ms) {
  const value = Math.max(0, Math.floor(ms));
  const hours = String(Math.floor(value / 3_600_000)).padStart(2, '0');
  const minutes = String(Math.floor((value % 3_600_000) / 60_000)).padStart(2, '0');
  const seconds = String(Math.floor((value % 60_000) / 1000)).padStart(2, '0');
  const millis = String(value % 1000).padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

function exportTranscript(session, format, translated) {
  const start = new Date(session.startedAt || session.lines?.[0]?.at || Date.now()).getTime();
  if (translated && session.translationText && session.translationSegments?.length) {
    const groups = [];
    let current = null;
    for (const segment of session.translationSegments.filter((item) => item.text?.trim())) {
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
    const cues = groups.map((group, index) => {
      const cueStart = Math.max(0, group.startAt - start);
      const nextStart = groups[index + 1] ? groups[index + 1].startAt - start : group.endAt - start + 3500;
      const begin = formatVttTime(cueStart);
      const end = formatVttTime(Math.max(cueStart + 1400, nextStart - 100));
      return format === 'txt' ? group.text.trim() : format === 'srt'
        ? `${index + 1}\n${begin.replace('.', ',')} --> ${end.replace('.', ',')}\n${group.text.trim()}`
        : `${index + 1}\n${begin} --> ${end}\n${group.text.trim()}`;
    });
    const content = format === 'txt' ? session.translationText.trim() : `${format === 'vtt' ? 'WEBVTT\n\n' : ''}${cues.join('\n\n')}\n`;
    return { content, contentType: format === 'vtt' ? 'text/vtt; charset=utf-8' : format === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/plain; charset=utf-8' };
  }
  const lines = (session.lines || []).filter((line) => !translated || line.translation);
  const cues = lines.map((line, index) => {
    const cueStart = Math.max(0, new Date(line.at).getTime() - start);
    const nextStart = index + 1 < lines.length ? new Date(lines[index + 1].at).getTime() - start : cueStart + 3500;
    const sourceText = translated ? line.translation : line.original;
    const speakerLabel = line.speakerId ? (session.speakerAliases?.[line.speakerId] || line.speakerLabel) : '';
    const text = speakerLabel ? `[${speakerLabel}] ${sourceText}` : sourceText;
    const begin = formatVttTime(cueStart);
    const end = formatVttTime(Math.max(cueStart + 1400, nextStart - 100));
    return format === 'txt' ? text : format === 'srt'
      ? `${index + 1}\n${begin.replace('.', ',')} --> ${end.replace('.', ',')}\n${text}`
      : `${index + 1}\n${begin} --> ${end}\n${text}`;
  });
  const content = format === 'txt' ? cues.join('\n\n') : `${format === 'vtt' ? 'WEBVTT\n\n' : ''}${cues.join('\n\n')}\n`;
  return { content, contentType: format === 'vtt' ? 'text/vtt; charset=utf-8' : format === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/plain; charset=utf-8' };
}

function handleHttp(request, response) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const tokenRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/live-token$/);
  if (tokenRoute && request.method === 'POST') {
    const session = sessions.get(decodeURIComponent(tokenRoute[1]));
    if (!session || session.engine !== 'gemini-direct' || !['connecting', 'live', 'reconnecting'].includes(session.status)) {
      return sendJson(response, 404, { error: 'No encontramos una sesión directa activa.' });
    }
    if (!ai) return sendJson(response, 503, { error: 'Gemini no está configurado.' });
    const now = Date.now();
    const tokenConfig = {
      uses: 1,
      expireTime: new Date(now + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(now + 30 * 60_000).toISOString(),
      liveConnectConstraints: {
        model: LIVE_TRANSLATION_MODEL,
        config: {
          responseModalities: ['AUDIO'],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          translationConfig: { targetLanguageCode: TARGET_LANGUAGE_CODES[session.translateTo], echoTargetLanguage: true },
        },
      },
      lockAdditionalFields: [],
    };
    ai.authTokens.create({ config: tokenConfig }).then((token) => {
      sendJson(response, 200, { token: token.name, expiresAt: token.expireTime || tokenConfig.expireTime });
    }).catch((error) => {
      console.error('No se pudo emitir un token efímero de Live API:', safeError(error));
      sendJson(response, 502, { error: 'Gemini no pudo emitir un token efímero. Revisá el acceso del proyecto a Live API.' });
    });
    return;
  }
  if (url.pathname === '/api/config') {
    return sendJson(response, 200, {
      configured: Boolean(ai),
      model: MODEL, liveTranslationModel: LIVE_TRANSLATION_MODEL, translationModel: TRANSLATION_MODEL,
      localProviderAvailable: Boolean(LOCAL_ASR_WS_URL), autoFallbackToLocal: AUTO_FALLBACK_TO_LOCAL,
      speakerDiarizationAvailable: Boolean(LOCAL_ASR_WS_URL) && LOCAL_SPEAKER_DIARIZATION,
      maxActiveSessions: MAX_ACTIVE_SESSIONS, billingTier: BILLING_TIER,
      draftTranslationIntervalMs: DRAFT_TRANSLATION_INTERVAL_MS,
      draftTranslationsPerSecond: DRAFT_TRANSLATIONS_PER_SECOND,
      pricing: RATES,
    });
  }
  if (url.pathname === '/api/health') {
    return sendJson(response, 200, { ok: true, configured: Boolean(ai), uptimeSeconds: Math.round(process.uptime()), sessions: sessions.size, activeSessions: activeSessionCount() });
  }
  if (url.pathname === '/api/sessions' && request.method === 'GET') {
    return sendJson(response, 200, [...sessions.values()].map((session) => operatorSession(session)));
  }
  if (url.pathname === '/api/metrics/cost' && request.method === 'GET') {
    return sendJson(response, 200, costSummary());
  }
  if (url.pathname === '/api/metrics' && request.method === 'GET') {
    return sendJson(response, 200, metricsSummary());
  }
  if (url.pathname.startsWith('/api/sessions/') && request.method === 'GET') {
    const rest = url.pathname.slice('/api/sessions/'.length);
    const [encodedId, action] = rest.split('/');
    const session = sessions.get(decodeURIComponent(encodedId));
    if (!session) return sendJson(response, 404, { error: 'No encontramos esa sesión.' });
    if (action === 'export') {
      const format = ['vtt', 'srt', 'txt'].includes(url.searchParams.get('format')) ? url.searchParams.get('format') : 'vtt';
      const translated = url.searchParams.get('language') === 'translation';
      const exported = exportTranscript(session, format, translated);
      securityHeaders(response);
      response.writeHead(200, { 'content-type': exported.contentType, 'content-disposition': `attachment; filename="${encodeURIComponent(session.id)}-${translated ? session.translateTo : session.language}.${format}"` });
      return response.end(exported.content);
    }
    return sendJson(response, 200, operatorSession(session, true));
  }
  const speakerRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/speakers\/(speaker-\d{1,2})$/u);
  if (speakerRoute && request.method === 'PATCH') {
    const session = sessions.get(decodeURIComponent(speakerRoute[1]));
    if (!session) return sendJson(response, 404, { error: 'No encontramos esa sesión.' });
    let body = '';
    let tooLarge = false;
    request.on('data', (chunk) => {
      if (tooLarge) return;
      body += chunk.toString();
      if (body.length > 4096) {
        tooLarge = true;
        sendJson(response, 413, { error: 'El nombre supera el tamaño permitido.' });
      }
    });
    request.on('end', () => {
      if (tooLarge) return;
      let payload;
      try { payload = JSON.parse(body || '{}'); }
      catch { return sendJson(response, 400, { error: 'El cuerpo debe ser JSON válido.' }); }
      const speakerId = speakerRoute[2];
      if (!speakerIdFor(Number(speakerId.slice('speaker-'.length)))) {
        return sendJson(response, 400, { error: 'El identificador de voz está fuera del rango admitido.' });
      }
      const name = cleanSpeakerAlias(payload.name);
      if (!name) return sendJson(response, 400, { error: 'Ingresá el nombre confirmado para esta voz.' });
      session.speakerAliases = { ...normalizeSpeakerAliases(session.speakerAliases), [speakerId]: name };
      session.speakerSuggestions = { ...(session.speakerSuggestions || {}) };
      delete session.speakerSuggestions[speakerId];
      const speakerNumber = Number(speakerId.slice('speaker-'.length));
      const speaker = (session.speakers || []).find((item) => item.id === speakerId);
      if (speaker) Object.assign(speaker, { displayName: name, nameSource: 'confirmed' });
      else session.speakers = [...(session.speakers || []), { id: speakerId, number: speakerNumber, displayName: name, nameSource: 'confirmed' }];
      session.speakerRoster ||= [];
      if (!session.speakerRoster.includes(name)) session.speakerRoster.push(name);
      session.updatedAt = new Date().toISOString();
      broadcast(session, { type: 'speaker-map', speakerAliases: session.speakerAliases, speakers: session.speakers });
      persist();
      return sendJson(response, 200, { ok: true, speakerId, name });
    });
    return;
  }
  if (url.pathname.startsWith('/api/sessions/') && request.method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
    const session = sessions.get(id);
    if (!session) return sendJson(response, 404, { error: 'No encontramos esa sesión.' });
    if (['connecting', 'live', 'reconnecting'].includes(session.status)) {
      return sendJson(response, 409, { error: 'Primero finalizá o pausá la sesión.' });
    }
    sessions.delete(id);
    for (const client of session.clients || []) {
      send(client, { type: 'session-deleted', sessionId: id });
      client.close(1000, 'Sesión eliminada');
    }
    persist();
    return sendJson(response, 200, { ok: true, id });
  }

  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const filePath = normalize(join(PUBLIC, requested));
  const relativePath = relative(PUBLIC, filePath);
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    securityHeaders(response);
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return response.end('No encontrado');
  }
  securityHeaders(response);
  response.writeHead(200, { 'content-type': MIME_TYPES[extname(filePath)] || 'application/octet-stream' });
  createReadStream(filePath).pipe(response);
}

const server = createServer(handleHttp);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024, perMessageDeflate: false });

function send(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > MAX_VIEWER_BUFFERED_BYTES) {
    socket.close(1013, 'Reconectá para recibir el subtítulo más reciente');
    socket.session?.clients.delete(socket);
    return false;
  }
  try { socket.send(JSON.stringify(message)); return true; } catch { return false; }
}

function broadcast(session, message) {
  const event = { ...message, eventId: `${session.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, serverAt: Date.now() };
  for (const client of session.clients) send(client, event);
}

function status(session, value, reason = '') {
  session.status = value;
  session.updatedAt = new Date().toISOString();
  broadcast(session, { type: 'status', status: value, reason });
  persist();
}

function safeError(error) {
  const message = String(error?.message || error || 'Error del proveedor.');
  return message.replace(/(key=)[^&\s]+/gi, '$1[redactada]').slice(0, 400);
}

function canStartWithEngine(engine) {
  if (engine === 'local') return Boolean(LOCAL_ASR_WS_URL);
  return Boolean(ai);
}

function activeBillingBudgetExceeded() {
  return DAILY_BUDGET_USD > 0 && costSummary().paidEquivalentUsd >= DAILY_BUDGET_USD;
}

function enforceDailyBudget() {
  if (!activeBillingBudgetExceeded()) return;
  const message = `Se alcanzó el presupuesto diario equivalente de US$${DAILY_BUDGET_USD.toFixed(2)}. La sesión quedó pausada.`;
  for (const session of sessions.values()) {
    if (!['connecting', 'live', 'reconnecting'].includes(session.status)) continue;
    const producer = session.producer;
    session.error = message;
    stopSession(session, 'paused', message);
    try { if (producer?.readyState === WebSocket.OPEN) producer.close(1013, 'Presupuesto diario alcanzado'); } catch { /* The producer may already have disconnected. */ }
  }
}

function connectProducer(socket, config) {
  const requestedEngine = ['local', 'auto', 'gemini-direct'].includes(config.engine) ? config.engine : 'gemini';
  const engine = requestedEngine === 'local' || (requestedEngine === 'auto' && !ai && LOCAL_ASR_WS_URL) ? 'local' : 'gemini';
  // The low-latency draft profile needs Gemini Transcribe interims, which are
  // not emitted reliably by Live Translate. Route this profile through the
  // transcription stream and translate its partial/final text separately.
  const actualEngine = requestedEngine === 'gemini-direct'
    ? (config.earlyTranslation && config.translateTo ? 'gemini' : 'gemini-direct')
    : engine;
  if (!canStartWithEngine(actualEngine)) {
    return send(socket, { type: 'error', message: actualEngine === 'local' ? 'No hay un servicio WhisperLiveKit configurado.' : 'Falta GEMINI_API_KEY. Configurá la clave en .env para iniciar una sesión real.' });
  }
  if (actualEngine !== 'local' && !ai) return send(socket, { type: 'error', message: 'Falta GEMINI_API_KEY. Configurá la clave en .env para iniciar una sesión real.' });
  if (activeBillingBudgetExceeded()) return send(socket, { type: 'error', message: `Se alcanzó el presupuesto diario de US$${DAILY_BUDGET_USD.toFixed(2)}. No se inicia otra sesión.` });

  const id = cleanLine(config.sessionId);
  if (!id || id.length > 100) return send(socket, { type: 'error', message: 'La sesión necesita un identificador válido.' });
  const existing = sessions.get(id);
  if (['live', 'connecting', 'reconnecting'].includes(existing?.status) && existing.producer?.readyState === WebSocket.OPEN) {
    return send(socket, { type: 'error', message: 'Ya hay una fuente de audio conectada a esta sesión.' });
  }
  if (!existing && activeSessionCount() >= MAX_ACTIVE_SESSIONS) {
    return send(socket, { type: 'error', message: `Se alcanzó el límite configurado de ${MAX_ACTIVE_SESSIONS} salas activas.` });
  }

  const session = existing || {
    id, createdAt: new Date().toISOString(), lines: [], clients: new Set(),
    translationText: '', translationSegments: [],
    billing: { cloudLiveBytes: 0, cloudTranscribeBytes: 0, localBytes: 0, inputTokens: 0, outputTokens: 0 },
    telemetry: {},
    connectionGeneration: 0,
  };
  session.title = cleanLine(config.title).slice(0, 100) || 'Sesión sin título';
  session.speaker = cleanLine(config.speaker).slice(0, 100);
  const providedRoster = Array.isArray(config.speakerRoster) ? config.speakerRoster : String(config.speaker || '').split(/[,;\n]+/u);
  session.speakerRoster = [...new Set(providedRoster.map(cleanSpeakerAlias).filter(Boolean))].slice(0, 16);
  session.speakerAliases = normalizeSpeakerAliases(session.speakerAliases);
  session.speakerSuggestions = session.speakerSuggestions || {};
  session.speakers = session.speakers || [];
  if (session.speakerRoster.length === 1 && !session.speakerAliases['speaker-1']) {
    session.speakerAliases['speaker-1'] = session.speakerRoster[0];
  }
  session.earlyTranslation = Boolean(config.earlyTranslation);
  session.audioSource = config.audioSource === 'tab' ? 'tab' : 'microphone';
  const captureDiagnostics = config.captureDiagnostics && typeof config.captureDiagnostics === 'object' ? config.captureDiagnostics : {};
  session.captureDiagnostics = {
    source: session.audioSource,
    displaySurface: ['browser', 'window', 'monitor'].includes(captureDiagnostics.displaySurface) ? captureDiagnostics.displaySurface : 'unknown',
    audioTrackCount: Math.max(0, Math.min(4, Math.floor(Number(captureDiagnostics.audioTrackCount) || 0))),
    audioTrackReadyState: ['live', 'ended', 'missing'].includes(captureDiagnostics.audioTrackReadyState) ? captureDiagnostics.audioTrackReadyState : 'unknown',
    audioTrackMuted: Boolean(captureDiagnostics.audioTrackMuted),
    audioTrackEnabled: Boolean(captureDiagnostics.audioTrackEnabled),
  };
  session.requestedEngine = requestedEngine;
  session.language = ['es', 'pt', 'auto'].includes(config.language) ? config.language : 'en';
  const requestedTarget = ['es', 'en', 'pt'].includes(config.translateTo) ? config.translateTo : null;
  session.translateTo = requestedTarget && (session.language === 'auto' || requestedTarget !== session.language) ? requestedTarget : null;
  session.glossary = Array.isArray(config.glossary) ? [...new Set(config.glossary.map(cleanLine).filter(Boolean))].slice(0, 100) : [];
  session.engine = actualEngine;
  session.autoFallback = requestedEngine === 'auto' && AUTO_FALLBACK_TO_LOCAL && Boolean(LOCAL_ASR_WS_URL);
  session.fallbackFromGemini = false;
  session.translationMode = session.engine === 'local' ? 'local'
    : session.translateTo ? (session.earlyTranslation ? 'hybrid' : session.glossary.length ? 'glossary' : 'live')
      : 'none';
  session.model = session.engine === 'local' ? 'WhisperLiveKit'
    : session.engine === 'gemini-direct' || session.translationMode === 'live' ? LIVE_TRANSLATION_MODEL
      : MODEL;
  session.translationDraft = '';
  session.status = 'connecting';
  session.manualStop = false;
  clearTimeout(session.reconnectTimer);
  clearTimeout(session.goAwayTimer);
  clearTimeout(session.draftTimer);
  session.reconnectTimer = null;
  session.goAwayTimer = null;
  session.draftTimer = null;
  session.draftRevision = (session.draftRevision || 0) + 1;
  session.draftGeneration = (session.draftGeneration || 0) + 1;
  session.translationDraftRevision = 0;
  session.error = null;
  session.startedAt = new Date().toISOString();
  session.updatedAt = session.startedAt;
  const previousProducerSocketClose = session.providerDiagnostics?.producerSocketClose || null;
  session.providerDiagnostics = {
    engine: session.engine, connectedAt: null, reconnects: session.reconnectAttempts || 0,
    lastError: null, lastMessageKeys: [], producerSocketClose: previousProducerSocketClose,
    capture: session.captureDiagnostics,
  };
  session.lastInputFinalAt = null;
  session.speechStartedAt = null;
  session.lastSpeechAt = null;
  session.firstCaptionRecorded = false;
  session.audioQueue = [];
  session.audioSending = false;
  session.translationTasks = 0;
  session.translationPending = null;
  session.translationLastRequestAt = 0;
  session.lastPersistAt = Date.now();
  session.telemetry = {
    ...session.telemetry,
    audioChunksReceived: 0, audioChunksSent: 0, audioChunksDropped: 0,
    audioBytesReceived: 0, audioBytesSent: 0,
    inputInterimEvents: 0, inputFinalEvents: 0, translationEvents: 0,
    translatedCharacters: 0, audioLevelRms: null, audioLevelAt: null,
    lastAudioAt: null, lastInputAt: null, lastTranslationAt: null,
    audioIngressLagMs: null, captureToFirstCaptionMs: null, draftFirstTokenMs: null,
    translationFirstEventMs: null, viewers: 0,
  };
  session.producer = socket;
  session.connectionGeneration = Number.isFinite(session.connectionGeneration) ? session.connectionGeneration : 0;
  session.clients.add(socket);
  sessions.set(id, session);
  socket.role = 'producer';
  socket.session = session;
  broadcast(session, { type: 'status', status: 'connecting' });
  persist();
  if (session.engine === 'gemini-direct') send(socket, { type: 'direct-provider-required', sessionId: session.id });
  else connectProvider(session);
}

function connectProvider(session) {
  if (session.engine === 'local') {
    session.live = connectWhisperLiveKit(session);
  } else if (session.translationMode === 'live') {
    session.live = connectLiveTranslateSocket(session, session.resumptionHandle);
  } else {
    session.live = connectGeminiTranscription(session, session.resumptionHandle);
  }
  const generation = session.connectionGeneration;
  session.live.then((provider) => {
    if (generation !== session.connectionGeneration || session.manualStop) return;
    session.reconnectAttempts = 0;
    session.error = null;
    session.providerSocket = provider;
    session.providerDiagnostics.connectedAt = new Date().toISOString();
    status(session, 'live');
  }).catch((error) => providerFailed(session, error, generation));
}

function providerFailed(session, error, generation) {
  if (generation !== session.connectionGeneration || session.manualStop || session.status === 'finished') return;
  if (session.reconnectTimer) return;
  clearTimeout(session.goAwayTimer);
  session.goAwayTimer = null;
  const reason = safeError(error);
  try { session.providerSocket?.close?.(); } catch { /* The upstream socket may already be closed. */ }
  session.error = reason;
  session.providerDiagnostics.lastError = reason;
  session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;
  if (session.engine === 'gemini' && session.autoFallback && LOCAL_ASR_WS_URL && session.reconnectAttempts >= 2) {
    session.engine = 'local';
    session.fallbackFromGemini = true;
    session.model = 'WhisperLiveKit (respaldo local)';
    session.providerDiagnostics.engine = 'local';
    session.resumptionHandle = null;
    session.reconnectAttempts = 0;
    broadcast(session, { type: 'provider-fallback', engine: 'local', message: 'Gemini no responde; activando transcripción local.' });
    status(session, 'reconnecting');
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      connectProvider(session);
    }, 250);
    return;
  }
  if (session.reconnectAttempts > 5) {
    session.status = 'error';
    session.updatedAt = new Date().toISOString();
    broadcast(session, { type: 'error', message: 'Se interrumpió el motor de transcripción. Revisá la conexión o elegí otra fuente.' });
    broadcast(session, { type: 'status', status: 'error' });
    persist();
    return;
  }
  const delay = Math.min(8000, 500 * (2 ** (session.reconnectAttempts - 1)) + Math.random() * 350);
  session.providerDiagnostics.reconnects = (session.providerDiagnostics.reconnects || 0) + 1;
  status(session, 'reconnecting', `Reintento en ${Math.ceil(delay / 1000)} s`);
  broadcast(session, { type: 'provider-retrying', attempt: session.reconnectAttempts, delayMs: delay });
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    connectProvider(session);
  }, delay);
}

function updateResumptionHandle(session, message) {
  const update = message?.sessionResumptionUpdate;
  if (update?.resumable && update.newHandle) {
    session.resumptionHandle = update.newHandle;
    persist();
  }
  if (message?.goAway) {
    session.providerDiagnostics.goAwayAt = new Date().toISOString();
    session.providerDiagnostics.goAwayTimeLeft = message.goAway.timeLeft || null;
    if (!session.goAwayTimer && !session.manualStop) {
      const delay = timeLeftMilliseconds(message.goAway.timeLeft);
      const generation = session.connectionGeneration;
      session.goAwayTimer = setTimeout(() => {
        session.goAwayTimer = null;
        providerFailed(session, new Error('Gemini solicita rotar la conexión.'), generation);
      }, Math.max(0, delay - 300));
      session.goAwayTimer.unref?.();
    }
  }
}

function timeLeftMilliseconds(value) {
  if (Number.isFinite(Number(value))) return Math.max(0, Number(value) * 1000);
  const match = String(value || '').match(/([\d.]+)\s*(ms|s)?/i);
  if (!match) return 5000;
  return Number(match[1]) * (match[2]?.toLowerCase() === 'ms' ? 1 : 1000);
}

function connectGeminiTranscription(session, resumeHandle) {
  if (!ai) return Promise.reject(new Error('Falta GEMINI_API_KEY.'));
  const generation = ++session.connectionGeneration;
  return ai.live.connect({
    model: MODEL,
    config: buildGeminiTranscriptionConfig(session, resumeHandle),
    callbacks: {
      onmessage: (message) => {
        if (generation !== session.connectionGeneration) return;
        updateResumptionHandle(session, message);
        handleGeminiMessage(session, message);
      },
      onerror: (error) => providerFailed(session, error, generation),
      onclose: (event) => {
        if (session.status === 'live' || session.status === 'connecting' || session.status === 'reconnecting') providerFailed(session, event?.reason || 'Conexión de Gemini cerrada.', generation);
      },
    },
  });
}

function connectLiveTranslateSocket(session, resumeHandle) {
  const generation = ++session.connectionGeneration;
  return new Promise((resolve, reject) => {
    let settled = false;
    let provider;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { provider?.close(); } catch { /* The upstream socket may not be open yet. */ }
      reject(new Error('Gemini Live Translate no completó el inicio en 20 segundos.'));
    }, 20_000);
    const fail = (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      } else if (generation === session.connectionGeneration && !session.manualStop && session.status !== 'finished') {
        providerFailed(session, error, generation);
      }
    };
    const tokenConfig = {
      uses: 1,
      // A 2-minute connection-token expiry caused a forced reconnect and lost
      // audio every couple of minutes. Keep the connection credential valid
      // for the documented 30-minute window; GoAway + session resumption rotate
      // the Live API connection about every 10 minutes.
      expireTime: new Date(Date.now() + 30 * 60_000).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(),
      liveConnectConstraints: {
        model: LIVE_TRANSLATION_MODEL,
        config: {
          responseModalities: ['AUDIO'],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          translationConfig: { targetLanguageCode: TARGET_LANGUAGE_CODES[session.translateTo], echoTargetLanguage: true },
        },
      },
      lockAdditionalFields: [],
    };
    ai.authTokens.create({ config: tokenConfig }).then((token) => {
      if (generation !== session.connectionGeneration || session.manualStop) {
        clearTimeout(timer);
        settled = true;
        resolve(null);
        return;
      }
      const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token.name)}`;
      provider = new WebSocket(url, { handshakeTimeout: 15_000, maxPayload: 2 * 1024 * 1024 });
      session.providerSocket = provider;
      provider.on('open', () => {
        provider.send(JSON.stringify({ setup: {
          model: `models/${LIVE_TRANSLATION_MODEL}`,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
          generationConfig: {
            responseModalities: ['AUDIO'],
            translationConfig: { targetLanguageCode: TARGET_LANGUAGE_CODES[session.translateTo], echoTargetLanguage: true },
          },
        } }));
      });
      provider.on('message', (data) => {
        if (generation !== session.connectionGeneration) return;
        let message;
        try { message = JSON.parse(data.toString()); } catch { return; }
        session.providerDiagnostics.lastMessageKeys = Object.keys(message || {}).slice(0, 12);
        updateResumptionHandle(session, message);
        if (message.setupComplete && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            sendRealtimeInput: ({ audio }) => new Promise((sendResolve, sendReject) => {
              if (provider.readyState !== WebSocket.OPEN) return sendReject(new Error('La conexión de traducción se cerró.'));
              provider.send(JSON.stringify({ realtimeInput: { audio } }), (error) => error ? sendReject(error) : sendResolve());
            }),
            close: () => provider.close(),
          });
          return;
        }
        if (message.error) {
          fail(new Error(message.error.message || 'Gemini rechazó la conexión de traducción.'));
          provider.close();
          return;
        }
        handleGeminiMessage(session, message);
      });
      provider.on('error', (error) => fail(error));
      provider.on('close', (code, reason) => {
        clearTimeout(timer);
        if (!settled) fail(new Error(`Gemini cerró la conexión durante el inicio (${code}).`));
        else if (generation === session.connectionGeneration && !session.manualStop && session.status !== 'finished') providerFailed(session, reason?.toString() || `Gemini cerró (${code}).`, generation);
      });
    }).catch((error) => fail(error));
  });
}

function connectWhisperLiveKit(session) {
  if (!LOCAL_ASR_WS_URL) return Promise.reject(new Error('No hay un servicio WhisperLiveKit configurado.'));
  const generation = ++session.connectionGeneration;
  const url = new URL(LOCAL_ASR_WS_URL);
  if (!url.pathname || url.pathname === '/') url.pathname = '/asr';
  url.searchParams.set('language', session.language === 'auto' ? 'auto' : session.language);
  url.searchParams.set('mode', 'full');
  if (session.translateTo) url.searchParams.set('target_language', session.translateTo);
  const context = [...session.glossary, session.title, session.speaker].filter(Boolean).join(', ').slice(0, 1000);
  if (context) url.searchParams.set('context', context);
  if (process.env.LOCAL_ASR_TOKEN) url.searchParams.set('token', process.env.LOCAL_ASR_TOKEN);
  const provider = new WebSocket(url, { handshakeTimeout: 20_000, maxPayload: 2 * 1024 * 1024 });
  session.providerSocket = provider;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      provider.close();
      reject(new Error('WhisperLiveKit no respondió a tiempo.'));
    }, 30_000);
    provider.on('open', () => { session.providerDiagnostics.localSocketOpenedAt = new Date().toISOString(); });
    provider.on('message', (data) => {
      if (generation !== session.connectionGeneration) return;
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.type === 'config' && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          sendRealtimeInput: ({ audio }) => new Promise((sendResolve, sendReject) => {
            if (provider.readyState !== WebSocket.OPEN) return sendReject(new Error('WhisperLiveKit cerró la conexión.'));
            provider.send(Buffer.from(audio.data, 'base64'), { binary: true }, (error) => error ? sendReject(error) : sendResolve());
          }),
          close: () => { if (provider.readyState === WebSocket.OPEN) provider.send(Buffer.alloc(0), { binary: true }); provider.close(); },
        });
        return;
      }
      if (message.error) return providerFailed(session, message.error, generation);
      handleWhisperLiveKitMessage(session, message);
    });
    provider.on('error', (error) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
      else providerFailed(session, error, generation);
    });
    provider.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(new Error(`WhisperLiveKit cerró durante el inicio (${code}).`)); }
      else if (generation === session.connectionGeneration && !session.manualStop && session.status !== 'finished') providerFailed(session, `WhisperLiveKit cerró (${code}).`, generation);
    });
  });
}

function timestampSeconds(value) {
  if (typeof value === 'number') return value;
  const parts = String(value || '').split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function handleWhisperLiveKitMessage(session, message) {
  const lines = Array.isArray(message.lines) ? message.lines : [];
  for (let index = 0; index < lines.length; index += 1) {
    const value = lines[index];
    if (!value?.text?.trim()) continue;
    const speakerId = speakerIdFor(value.speaker);
    let speakerLabel = '';
    if (speakerId) {
      const speakerNumber = Number(speakerId.slice('speaker-'.length));
      const existingSpeaker = (session.speakers || []).find((item) => item.id === speakerId);
      speakerLabel = session.speakerAliases?.[speakerId] || `Voz ${speakerNumber}`;
      if (!existingSpeaker) session.speakers.push({ id: speakerId, number: speakerNumber, displayName: speakerLabel, nameSource: session.speakerAliases?.[speakerId] ? 'confirmed' : 'unknown' });
      else Object.assign(existingSpeaker, { displayName: speakerLabel, nameSource: session.speakerAliases?.[speakerId] ? 'confirmed' : existingSpeaker.nameSource || 'unknown' });
      const suggestion = suggestSelfIntroducedSpeakerName(value.text, session.speakerRoster || []);
      if (suggestion && suggestion !== session.speakerAliases?.[speakerId]) {
        session.speakerSuggestions[speakerId] = { name: suggestion, source: 'self-introduction', detectedAt: new Date().toISOString() };
      }
    }
    const id = `${session.id}-local-${index}`;
    const at = new Date(new Date(session.startedAt).getTime() + timestampSeconds(value.start) * 1000).toISOString();
    let line = session.lines.find((item) => item.id === id);
    if (!line) {
      line = { id, at, original: value.text.trim(), translation: value.translation || '', translated: Boolean(value.translation), engine: 'local', ...(speakerId ? { speakerId, speakerLabel } : {}) };
      session.lines.push(line);
      if (session.lines.length > 5000) session.lines.shift();
      session.telemetry.inputFinalEvents += 1;
      session.telemetry.lastInputAt = new Date().toISOString();
      if (!session.firstCaptionRecorded && session.speechStartedAt) {
        session.telemetry.captureToFirstCaptionMs = Math.max(0, Date.now() - session.speechStartedAt);
        session.firstCaptionRecorded = true;
        addLatency('source', session.telemetry.captureToFirstCaptionMs);
      }
      if (value.translation) {
        session.telemetry.translationEvents = (session.telemetry.translationEvents || 0) + 1;
        session.telemetry.lastTranslationAt = new Date().toISOString();
      }
      broadcast(session, { type: 'final', line });
    } else if (line.original !== value.text.trim() || line.translation !== (value.translation || '') || line.speakerId !== speakerId) {
      Object.assign(line, { original: value.text.trim(), translation: value.translation || '', translated: Boolean(value.translation), ...(speakerId ? { speakerId, speakerLabel } : {}) });
      broadcast(session, { type: 'caption-revision', line });
    }
  }
  const interim = cleanLine(message.buffer_transcription);
  if (interim && interim !== session.interimText) {
    session.interimText = interim;
    session.telemetry.inputInterimEvents += 1;
    const detectedInterimSpeaker = String(message.buffer_diarization || '').match(/(?:speaker\s*|speaker[_ -])([0-9]+)/iu);
    const interimSpeakerId = detectedInterimSpeaker ? speakerIdFor(detectedInterimSpeaker[1]) : '';
    const interimSpeakerNumber = interimSpeakerId ? Number(interimSpeakerId.slice('speaker-'.length)) : 0;
    broadcast(session, { type: 'interim', text: interim, revision: Date.now(), ...(interimSpeakerId ? { speakerId: interimSpeakerId, speakerLabel: session.speakerAliases?.[interimSpeakerId] || `Voz ${interimSpeakerNumber}` } : {}) });
  }
  const hasTranslationDraft = typeof message.buffer_translation === 'string';
  const translationDraft = hasTranslationDraft ? cleanLine(message.buffer_translation) : session.translationDraft;
  if (hasTranslationDraft && translationDraft !== session.translationDraft) {
    session.translationDraft = translationDraft;
    if (translationDraft) {
      session.telemetry.translationEvents += 1;
      session.telemetry.lastTranslationAt = new Date().toISOString();
    }
    broadcast(session, { type: 'translation-draft', text: translationDraft, revision: Date.now(), final: !translationDraft });
  }
  if (message.translation_error) session.providerDiagnostics.translationError = String(message.translation_error).slice(0, 300);
  session.telemetry.processingLagSeconds = Number(message.remaining_time_transcription || 0);
  session.telemetry.diarizationLagSeconds = Number(message.remaining_time_diarization || 0);
  session.updatedAt = new Date().toISOString();
  persist();
}

function recordCaptionLatency(session, type) {
  if (!session.speechStartedAt) return;
  const latency = Math.max(0, Date.now() - session.speechStartedAt);
  if (type === 'source' && !session.firstCaptionRecorded) {
    session.telemetry.captureToFirstCaptionMs = latency;
    session.firstCaptionRecorded = true;
    addLatency(type, latency);
  }
  if (type === 'translation' && !session.telemetry.translationFirstEventMs) {
    session.telemetry.translationFirstEventMs = latency;
    addLatency(type, latency);
  }
}

function handleGeminiMessage(session, message) {
  const content = message?.serverContent;
  if (!content) return;
  if (content.interimInputTranscription?.text) {
    const text = cleanLine(content.interimInputTranscription.text);
    session.telemetry.inputInterimEvents += 1;
    session.telemetry.lastInputAt = new Date().toISOString();
    session.interimText = text;
    recordCaptionLatency(session, 'source');
    broadcast(session, { type: 'interim', text, revision: Date.now() });
    if (session.translateTo && ['glossary', 'hybrid'].includes(session.translationMode)) scheduleDraftTranslation(session, text);
  }
  if (content.inputTranscription?.text) {
    const text = cleanLine(content.inputTranscription.text);
    if (text) {
      session.telemetry.inputFinalEvents += 1;
      session.telemetry.lastInputAt = new Date().toISOString();
      if (content.inputTranscription.languageCode) session.telemetry.inputLanguageCode = content.inputTranscription.languageCode;
      session.lastInputFinalAt = Date.now();
      recordCaptionLatency(session, 'source');
      const line = addFinalLine(session, text);
      if (session.translateTo && ['glossary', 'hybrid'].includes(session.translationMode)) {
        session.translationPending = null;
        session.draftAbortController?.abort();
        session.draftRevision = (session.draftRevision || 0) + 1;
        session.draftGeneration = (session.draftGeneration || 0) + 1;
        clearTimeout(session.draftTimer);
        session.translationDraft = '';
        broadcast(session, { type: 'translation-draft', text: '', revision: session.draftRevision, final: true });
        queueTranslation(() => translateLine(session, line)).catch((error) => {
          line.translationError = safeError(error);
          broadcast(session, { type: 'translation-error', id: line.id, message: 'No se pudo traducir este fragmento.' });
        });
      }
    }
  }
  if (content.outputTranscription?.text && ['live', 'hybrid'].includes(session.translationMode)) {
    const text = cleanLine(content.outputTranscription.text);
    if (text) {
      const update = appendStreamingText(session.translationText || '', text);
      session.translationText = update.text.slice(-16_000);
      session.translationDraft = trailingDraft(session.translationText);
      session.nativeTranslationAt = Date.now();
      session.telemetry.translationEvents += 1;
      session.telemetry.translatedCharacters = session.translationText.length;
      session.telemetry.lastTranslationAt = new Date().toISOString();
      if (content.outputTranscription.languageCode) session.telemetry.outputLanguageCode = content.outputTranscription.languageCode;
      recordCaptionLatency(session, 'translation');
      if (session.lastInputFinalAt) {
        session.translationLatencyMs = Math.max(0, Date.now() - session.lastInputFinalAt);
        addLatency('translation', session.translationLatencyMs);
        session.lastInputFinalAt = null;
      }
      if (update.delta) {
        session.translationSegments.push({ at: Date.now(), text: update.delta });
        if (session.translationSegments.length > 5000) session.translationSegments.shift();
      }
      session.updatedAt = new Date().toISOString();
      broadcast(session, {
        type: 'translation-stream', draft: session.translationDraft,
        nativeTranslationAt: session.nativeTranslationAt,
        delta: update.delta, translationLatencyMs: session.translationLatencyMs || null,
        telemetry: session.telemetry,
      });
      persistPeriodically(session);
    }
  }
}

function trailingDraft(text) {
  const boundary = Math.max(text.lastIndexOf('.'), text.lastIndexOf('!'), text.lastIndexOf('?'), text.lastIndexOf('。'), text.lastIndexOf('！'), text.lastIndexOf('？'));
  return text.slice(boundary + 1).trim().slice(-300);
}

function appendStreamingText(previous, incoming) {
  const next = cleanLine(incoming);
  if (!next) return { text: previous, delta: '' };
  if (!previous) return { text: next, delta: next };
  if (next === previous) return { text: previous, delta: '' };
  if (previous.endsWith(next) && (next.length >= 3 || /^[,.;:!?]$/u.test(next))) {
    const previousStart = previous.length - next.length - 1;
    if (previousStart < 0 || /[\s,.;:!?()[\]{}]/u.test(previous[previousStart])) return { text: previous, delta: '' };
  }
  if (next.startsWith(previous)) return { text: next, delta: next.slice(previous.length).trimStart() };
  const maxOverlap = Math.min(previous.length, next.length, 120);
  let overlap = 0;
  for (let length = maxOverlap; length >= 3; length -= 1) {
    const previousStart = previous.length - length;
    const previousBoundary = previousStart === 0 || /[\s,.;:!?()[\]{}]/u.test(previous[previousStart - 1]);
    const nextBoundary = length === next.length || /[\s,.;:!?()[\]{}]/u.test(next[length]);
    if (previousBoundary && nextBoundary && previous.slice(-length).toLocaleLowerCase() === next.slice(0, length).toLocaleLowerCase()) { overlap = length; break; }
  }
  const delta = next.slice(overlap);
  const needsSpace = previous && delta && !/\s$/.test(previous) && !/^[\s,.;:!?)}\]]/.test(delta);
  return { text: `${previous}${needsSpace ? ' ' : ''}${delta}`, delta: `${needsSpace ? ' ' : ''}${delta}` };
}

function addFinalLine(session, text) {
  const line = {
    id: `${Date.now()}-${randomBytes(4).toString('hex')}`,
    at: new Date().toISOString(), original: text, translation: '',
    translated: !session.translateTo, revision: 0,
  };
  session.lines.push(line);
  if (session.lines.length > 5000) session.lines.shift();
  session.interimText = '';
  session.updatedAt = line.at;
  broadcast(session, { type: 'final', line });
  persist();
  return line;
}

let translationActive = 0;
const translationWaiters = [];
const MAX_TRANSLATION_CALLS = Math.max(1, Number(process.env.MAX_TRANSLATION_REQUESTS || 8));
const DRAFT_TRANSLATION_INTERVAL_MS = Math.max(750, Number(process.env.DRAFT_TRANSLATION_INTERVAL_MS || 1200));
const DRAFT_TRANSLATIONS_PER_SECOND = Math.max(0.2, Number(process.env.DRAFT_TRANSLATIONS_PER_SECOND || 4));
let lastDraftTranslationAt = 0;
let draftFailureStreak = 0;
let draftCooldownUntil = 0;
async function queueTranslation(task) {
  if (translationActive >= MAX_TRANSLATION_CALLS) await new Promise((resolve) => translationWaiters.push(resolve));
  else translationActive += 1;
  try { return await task(); }
  finally {
    const next = translationWaiters.shift();
    if (next) next();
    else translationActive -= 1;
  }
}

function scheduleDraftTranslation(session, text) {
  if (text.length < 10 || !ai || !['gemini', 'gemini-direct'].includes(session.engine)) return;
  const revision = (session.draftRevision || 0) + 1;
  session.draftRevision = revision;
  session.translationPending = {
    text, revision, generation: session.draftGeneration || 0, scheduledAt: Date.now(),
  };
  if (session.draftTimer) return;
  runDraftTranslation(session);
}

function runDraftTranslation(session, retryDelay = 0) {
  if (session.draftTimer || !session.translationPending) return;
  const perSessionWait = DRAFT_TRANSLATION_INTERVAL_MS - (Date.now() - (session.translationLastRequestAt || 0));
  const globalWait = (1000 / DRAFT_TRANSLATIONS_PER_SECOND) - (Date.now() - lastDraftTranslationAt);
  const providerWait = draftCooldownUntil - Date.now();
  const wait = Math.max(retryDelay, perSessionWait, globalWait, providerWait, 0);
  session.draftTimer = setTimeout(async () => {
    session.draftTimer = null;
    const pending = session.translationPending;
    if (!pending || ['finished', 'paused', 'error'].includes(session.status)) return;
    const nextGlobalWait = (1000 / DRAFT_TRANSLATIONS_PER_SECOND) - (Date.now() - lastDraftTranslationAt);
    if (session.draftInFlight || translationActive >= MAX_TRANSLATION_CALLS || nextGlobalWait > 0) {
      runDraftTranslation(session, Math.max(500, nextGlobalWait));
      return;
    }
    session.translationPending = null;
    session.translationLastRequestAt = Date.now();
    lastDraftTranslationAt = session.translationLastRequestAt;
    session.draftInFlight = true;
    const controller = new AbortController();
    session.draftAbortController = controller;
    let firstVisibleTokenAt = 0;
    try {
      // Drafts are intentionally not queued behind other rooms: stale previews
      // are less useful than a fresh one, so every room keeps only its newest text.
      const draftInput = pending.text.length > 600 ? `… ${pending.text.slice(-600)}` : pending.text;
      const result = await queueTranslation(() => translateText(session, draftInput, true, (text) => {
        if (session.draftGeneration !== pending.generation || ['finished', 'paused', 'error'].includes(session.status)) return;
        if (!firstVisibleTokenAt) {
          firstVisibleTokenAt = Date.now();
          const latency = firstVisibleTokenAt - Number(pending.scheduledAt || firstVisibleTokenAt);
          session.telemetry.draftFirstTokenMs = latency;
          addLatency('draftFirstToken', latency);
        }
        session.translationDraft = text;
        session.translationDraftAt = Date.now();
        broadcast(session, { type: 'translation-draft', text, revision: pending.revision, final: false, provisional: session.translationMode === 'hybrid', translationDraftAt: session.translationDraftAt });
      }, controller.signal));
      if (session.draftGeneration !== pending.generation || pending.revision < (session.translationDraftRevision || 0) || ['finished', 'paused', 'error'].includes(session.status)) return;
      session.translationDraftRevision = pending.revision;
      session.translationDraft = result.text;
      session.translationDraftAt = Date.now();
      session.telemetry.translationEvents += 1;
      session.telemetry.lastTranslationAt = new Date().toISOString();
      session.translationLatencyMs = result.latencyMs;
      addLatency('translation', result.latencyMs);
      recordCaptionLatency(session, 'translation');
      if (Date.now() >= draftCooldownUntil) {
        draftFailureStreak = 0;
        draftCooldownUntil = 0;
      }
      broadcast(session, { type: 'translation-draft', text: result.text, revision: pending.revision, final: false, provisional: session.translationMode === 'hybrid', translationDraftAt: session.translationDraftAt, translationLatencyMs: result.latencyMs });
    } catch (error) {
      if (controller.signal.aborted || session.draftGeneration !== pending.generation) return;
      const statusCode = Number(error?.status || error?.code);
      const providerBusy = [429, 500, 502, 503, 504].includes(statusCode)
        || /RESOURCE_EXHAUSTED|rate.?limit|quota.{0,30}(exhausted|exceeded)/i.test(String(error?.message || ''));
      if (providerBusy) {
        draftFailureStreak = Math.min(6, draftFailureStreak + 1);
        const cooldownMs = Math.min(30_000, 1000 * (2 ** (draftFailureStreak - 1)));
        draftCooldownUntil = Math.max(draftCooldownUntil, Date.now() + cooldownMs);
      }
      session.providerDiagnostics.translationError = safeError(error);
      broadcast(session, { type: 'translation-error', message: 'La traducción parcial no está disponible; se conserva la transcripción original.' });
    } finally {
      session.draftInFlight = false;
      if (session.draftAbortController === controller) session.draftAbortController = null;
      if (session.translationPending) runDraftTranslation(session);
    }
  }, wait);
  session.draftTimer.unref?.();
}

async function translateText(session, text, draft = false, onDraftText = null, abortSignal = null) {
  const languageNames = { es: 'español', en: 'inglés', pt: 'portugués brasileño' };
  const source = languageNames[session.language] || 'el idioma original';
  const target = languageNames[session.translateTo] || 'español';
  const glossaryTerms = draft ? session.glossary.slice(0, 30) : session.glossary;
  const glossary = glossaryTerms.length ? `Usá este glosario cuando corresponda y respetá comandos e identificadores: ${glossaryTerms.join(', ')}.\n` : '';
  const draftGuidance = draft ? 'El texto está incompleto: traducí solo lo recibido, sin inventar cómo continúa la idea.\n' : '';
  const prompt = `Traducí ${draft ? 'el borrador parcial de' : ''} esta charla técnica del ${source} al ${target}. Conservá el sentido, los nombres propios, comandos y código. Entregá solo el texto traducido.\n${draftGuidance}${glossary}Texto:\n${text}`;
  const started = Date.now();
  let response;
  if (draft) {
    session.billing.draftTranslationCalls = (session.billing.draftTranslationCalls || 0) + 1;
    let textOutput = '';
    let usageMetadata = {};
    let lastEmittedText = '';
    let lastEmittedAt = 0;
    const stream = await ai.models.generateContentStream({
      model: TRANSLATION_MODEL,
      contents: prompt,
      config: abortSignal ? { abortSignal } : {},
    });
    for await (const chunk of stream) {
      if (chunk.text) textOutput += chunk.text;
      if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
      const now = Date.now();
      if (textOutput && now - lastEmittedAt >= 120) {
        lastEmittedAt = now;
        lastEmittedText = textOutput;
        onDraftText?.(textOutput);
      }
    }
    if (textOutput && textOutput !== lastEmittedText) onDraftText?.(textOutput);
    response = { text: textOutput, usageMetadata };
  } else {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { response = await ai.models.generateContent({ model: TRANSLATION_MODEL, contents: prompt }); break; }
      catch (error) {
        const retryable = [429, 500, 502, 503, 504].includes(Number(error?.status || error?.code));
        if (!retryable || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 350 * (2 ** attempt) + Math.random() * 200));
      }
    }
  }
  const usage = response?.usageMetadata || {};
  session.billing.inputTokens = (session.billing.inputTokens || 0) + Number(usage.promptTokenCount || 0);
  session.billing.outputTokens = (session.billing.outputTokens || 0) + Number(usage.candidatesTokenCount || 0);
  return { text: cleanLine(response?.text), latencyMs: Date.now() - started };
}

async function translateLine(session, line) {
  const result = await translateText(session, line.original);
  line.translation = result.text;
  line.translated = Boolean(line.translation);
  line.translationLatencyMs = Date.now() - new Date(line.at).getTime();
  line.revision = (line.revision || 0) + 1;
  session.translationLatencyMs = line.translationLatencyMs;
  session.telemetry.translationEvents += 1;
  session.telemetry.lastTranslationAt = new Date().toISOString();
  session.updatedAt = new Date().toISOString();
  addLatency('translation', line.translationLatencyMs);
  broadcast(session, { type: 'translation', id: line.id, translation: line.translation, translated: line.translated, translationLatencyMs: line.translationLatencyMs, revision: line.revision });
  persist();
}

function persistPeriodically(session) {
  if (Date.now() - session.lastPersistAt < 5000) return;
  session.lastPersistAt = Date.now();
  persist();
}

function updateAudioLevel(session, rms) {
  const now = Date.now();
  session.telemetry.audioLevelRms = Math.max(0, Math.min(1, rms));
  session.telemetry.audioLevelAt = new Date(now).toISOString();
  if (rms >= 0.003) {
    if (!session.speechStartedAt) {
      session.speechStartedAt = now;
      session.firstCaptionRecorded = false;
      session.telemetry.translationFirstEventMs = null;
      session.telemetry.captureToFirstCaptionMs = null;
    }
    session.lastSpeechAt = now;
  } else if (session.speechStartedAt && now - (session.lastSpeechAt || now) > 1800) {
    session.speechStartedAt = null;
  }
}

function scheduleAudio(session, packet) {
  let capturedAt = Date.now();
  let pcm = packet;
  if (packet.length > 8) {
    const timestamp = packet.readDoubleLE(0);
    if (Number.isFinite(timestamp) && timestamp > 1_000_000_000_000) capturedAt = timestamp;
    pcm = packet.subarray(8);
  }
  if (!pcm.length || pcm.length > 64 * 1024 || pcm.length % 2) {
    session.telemetry.audioChunksDropped += 1;
    return;
  }
  session.telemetry.audioChunksReceived += 1;
  session.telemetry.audioBytesReceived += pcm.length;
  session.telemetry.lastAudioAt = new Date().toISOString();
  session.telemetry.audioIngressLagMs = Math.max(0, Date.now() - capturedAt);
  addLatency('ingest', session.telemetry.audioIngressLagMs);
  session.lastAudioCaptureAt = capturedAt;
  if (session.audioQueue.length >= MAX_AUDIO_QUEUE_CHUNKS) {
    session.audioQueue.shift();
    session.telemetry.audioChunksDropped += 1;
  }
  session.audioQueue.push({ pcm: Buffer.from(pcm), capturedAt });
  pumpAudio(session);
}

function pumpAudio(session) {
  if (session.audioSending || !session.audioQueue?.length || !session.producer) return;
  const frame = session.audioQueue.shift();
  if (Date.now() - frame.capturedAt > 900) {
    session.telemetry.audioChunksDropped += 1;
    return pumpAudio(session);
  }
  session.audioSending = true;
  const live = session.live;
  Promise.resolve(live)
    .then((provider) => provider.sendRealtimeInput({ audio: { data: frame.pcm.toString('base64'), mimeType: 'audio/pcm;rate=16000' } }))
    .then(() => {
      session.telemetry.audioChunksSent += 1;
      session.telemetry.audioBytesSent += frame.pcm.length;
      if (session.engine === 'local') session.billing.localBytes = (session.billing.localBytes || 0) + frame.pcm.length;
      else if (session.translationMode === 'live') session.billing.cloudLiveBytes = (session.billing.cloudLiveBytes || 0) + frame.pcm.length;
      else session.billing.cloudTranscribeBytes = (session.billing.cloudTranscribeBytes || 0) + frame.pcm.length;
      enforceDailyBudget();
      persistPeriodically(session);
    })
    .catch((error) => {
      session.telemetry.audioChunksDropped += 1;
      session.providerDiagnostics.lastSendError = safeError(error);
    })
    .finally(() => {
      session.audioSending = false;
      pumpAudio(session);
    });
}

function stopSession(session, finalStatus = 'finished', reason = '') {
  session.manualStop = true;
  clearTimeout(session.reconnectTimer);
  clearTimeout(session.goAwayTimer);
  clearTimeout(session.draftTimer);
  session.reconnectTimer = null;
  session.goAwayTimer = null;
  session.draftTimer = null;
  session.audioQueue = [];
  if (session.live && typeof session.live.then === 'function') session.live.then((live) => live.close?.()).catch(() => {});
  else { try { session.providerSocket?.close?.(); } catch { /* Already disconnected. */ } }
  session.producer = null;
  status(session, finalStatus, reason);
}

function handleSocketMessage(socket, data, isBinary) {
  if (isBinary) {
    if (socket.role !== 'producer' || !socket.session?.live) return;
    scheduleAudio(socket.session, Buffer.from(data));
    return;
  }
  let message;
  try { message = JSON.parse(data.toString()); } catch { return send(socket, { type: 'error', message: 'Mensaje inválido.' }); }
  if (message.type === 'start') return connectProducer(socket, message);
  if (message.type === 'capture-ended' && socket.role === 'producer' && socket.session) {
    const session = socket.session;
    const reason = cleanLine(message.reason).slice(0, 240) || 'La fuente compartida terminó.';
    session.error = reason;
    stopSession(session, 'paused', reason);
    return;
  }
  if (message.type === 'capture-track-state' && socket.role === 'producer' && socket.session) {
    const capture = socket.session.providerDiagnostics?.capture;
    if (capture) {
      if (typeof message.muted === 'boolean') capture.audioTrackMuted = message.muted;
      if (['live', 'ended', 'missing'].includes(message.readyState)) capture.audioTrackReadyState = message.readyState;
    }
    return;
  }
  if (message.type === 'audio-level' && socket.role === 'producer' && socket.session?.telemetry) {
    const rms = Number(message.rms);
    if (Number.isFinite(rms)) updateAudioLevel(socket.session, rms);
    socket.session.telemetry.audioChunksDropped = Math.max(socket.session.telemetry.audioChunksDropped || 0, Number(message.dropped) || 0);
    const capturedAt = Number(message.capturedAt);
    if (socket.session.engine === 'gemini-direct' && Number.isFinite(capturedAt) && capturedAt > 1_000_000_000_000) {
      socket.session.telemetry.audioIngressLagMs = Math.max(0, Date.now() - capturedAt);
    }
    return;
  }
  if (message.type === 'audio-usage' && socket.role === 'producer' && socket.session?.engine === 'gemini-direct') {
    const bytes = Math.max(0, Math.min(2_000_000, Math.floor(Number(message.bytes) || 0)));
    socket.session.billing.cloudLiveBytes = (socket.session.billing.cloudLiveBytes || 0) + bytes;
    socket.session.telemetry.audioBytesSent = (socket.session.telemetry.audioBytesSent || 0) + bytes;
    socket.session.telemetry.audioChunksSent = (socket.session.telemetry.audioChunksSent || 0) + Math.floor(bytes / 3200);
    enforceDailyBudget();
    persistPeriodically(socket.session);
    return;
  }
  if (message.type === 'direct-provider-message' && socket.role === 'producer' && socket.session?.engine === 'gemini-direct') {
    if (message.payload?.serverContent && typeof message.payload.serverContent === 'object') {
      updateResumptionHandle(socket.session, message.payload);
      handleGeminiMessage(socket.session, message.payload);
    }
    return;
  }
  if (message.type === 'direct-provider-fallback' && socket.role === 'producer' && socket.session?.engine === 'gemini-direct') {
    const session = socket.session;
    session.engine = 'gemini';
    session.translationMode = session.translateTo ? (session.earlyTranslation ? 'hybrid' : session.glossary.length ? 'glossary' : 'live') : 'none';
    session.model = session.translationMode === 'live' ? LIVE_TRANSLATION_MODEL : MODEL;
    session.providerDiagnostics.engine = 'gemini';
    session.providerDiagnostics.directFallbackAt = new Date().toISOString();
    const connectionFailed = message.reason === 'connection' || message.reason === 'timeout';
    session.providerDiagnostics.directFallbackReason = connectionFailed ? message.reason : 'token';
    session.error = null;
    send(socket, { type: 'direct-provider-fallback', message: connectionFailed
      ? 'El enlace directo no respondió; la sesión seguirá por el servidor.'
      : 'No se pudo emitir el token efímero; la sesión seguirá por el servidor.' });
    status(session, 'connecting');
    connectProvider(session);
    persist();
    return;
  }
  if (message.type === 'direct-provider-status' && socket.role === 'producer' && socket.session?.engine === 'gemini-direct') {
    const session = socket.session;
    if (message.status === 'live') {
      session.error = null;
      session.providerDiagnostics.connectedAt = new Date().toISOString();
      status(session, 'live');
    } else if (message.status === 'reconnecting') {
      session.providerDiagnostics.reconnects = (session.providerDiagnostics.reconnects || 0) + 1;
      status(session, 'reconnecting', 'Reconectando el enlace directo con Gemini.');
    } else if (message.status === 'error') {
      session.error = safeError(message.message || 'No se pudo conectar con Gemini Live.');
      session.providerDiagnostics.lastError = session.error;
      status(session, 'error', session.error);
      send(socket, { type: 'error', message: 'No se pudo conectar con Gemini Live. Revisá la red y los permisos de Live API.' });
    }
    return;
  }
  if (message.type === 'watch') {
    const session = sessions.get(cleanLine(message.sessionId));
    if (!session) return send(socket, { type: 'error', message: 'No encontramos esa sesión.' });
    socket.role = 'viewer';
    socket.session = session;
    session.clients.add(socket);
    send(socket, { type: 'snapshot', session: viewerSession(session) });
    return;
  }
  if (message.type === 'stop' && socket.role === 'producer' && socket.session) {
    const session = socket.session;
    stopSession(session);
    return;
  }
  if (message.type === 'ping') return send(socket, { type: 'pong', clientNow: message.clientNow, serverNow: Date.now() });
  if (message.type === 'render-ack' && socket.role === 'viewer' && socket.session) {
    const latency = Number(message.latencyMs);
    if (Number.isFinite(latency) && latency >= 0 && latency < 30_000 && Date.now() - (socket.lastRenderAckAt || 0) >= 250) {
      socket.lastRenderAckAt = Date.now();
      addLatency('viewer', latency);
      socket.session.telemetry.viewerRenderLatencyMs = latency;
    }
    return;
  }
}

wss.on('connection', (socket, request) => {
  socket.role = 'unknown';
  socket.on('message', (data, isBinary) => handleSocketMessage(socket, data, isBinary));
  socket.on('close', (code, reasonBuffer) => {
    const session = socket.session;
    if (!session) return;
    session.clients.delete(socket);
    if (socket.role === 'producer' && session.producer === socket && ['live', 'connecting', 'reconnecting'].includes(session.status)) {
      const reason = Buffer.from(reasonBuffer || '').toString('utf8').trim().slice(0, 160);
      const detail = `La conexión de audio se cerró (WebSocket ${code}${reason ? `: ${reason}` : ''}).`;
      session.providerDiagnostics = session.providerDiagnostics || {};
      session.providerDiagnostics.producerSocketClose = { code, reason, at: new Date().toISOString() };
      if (!session.error || session.error === 'La fuente de audio se desconectó.') session.error = detail;
      console.warn(`[producer-ws-close] session=${session.id} code=${code} reason=${JSON.stringify(reason)}`);
      stopSession(session, 'paused', session.error);
    }
  });
  socket.on('error', (error) => {
    const session = socket.session;
    if (!session || socket.role !== 'producer') return;
    session.providerDiagnostics = session.providerDiagnostics || {};
    session.providerDiagnostics.producerSocketError = safeError(error);
    console.warn(`[producer-ws-error] session=${session.id} error=${JSON.stringify(safeError(error))}`);
  });
  if (process.env.NODE_ENV === 'production' && request.headers.origin) {
    try {
      if (new URL(request.headers.origin).host !== request.headers.host) socket.close(1008, 'Origin no permitido');
    } catch { socket.close(1008, 'Origin inválido'); }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Nerdearla Live listo en http://localhost:${PORT}`);
  console.log(`Almacenamiento durable: ${DATA_DIR}`);
  console.log(`Proveedores: Gemini ${ai ? 'disponible' : 'sin clave'}, WhisperLiveKit ${LOCAL_ASR_WS_URL ? 'configurado' : 'no configurado'}`);
  if (!ai && !LOCAL_ASR_WS_URL) console.log('Modo demo: definí GEMINI_API_KEY o LOCAL_ASR_WS_URL para iniciar audio real.');
});

async function shutdown() {
  for (const session of sessions.values()) {
    session.manualStop = true;
    clearTimeout(session.reconnectTimer);
    clearTimeout(session.goAwayTimer);
    for (const client of session.clients) client.close(1001, 'Servidor en mantenimiento');
    try { session.providerSocket?.close?.(); } catch { /* Already disconnected. */ }
  }
  wss.close();
  server.close();
  await flushSessions(sessions);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
