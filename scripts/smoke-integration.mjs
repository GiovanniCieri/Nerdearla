import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';

const root = process.cwd();
const tempDirectory = await mkdtemp(join(os.tmpdir(), 'nerdearla-smoke-'));
let appProcess;
let mockWss;
const childOutput = [];

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

function observe(socket) {
  const queued = [];
  const waiters = [];
  socket.on('message', (data) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else queued.push(message);
  });
  return {
    next(predicate, timeoutMs = 8000) {
      const index = queued.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const current = waiters.indexOf(waiter);
          if (current >= 0) waiters.splice(current, 1);
          reject(new Error(`Timeout esperando mensaje WebSocket (${timeoutMs} ms).`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

async function connectSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, inbox: observe(socket) };
}

function sendJson(socket, value) { socket.send(JSON.stringify(value)); }

async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, 'close').catch(() => {});
  if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'test complete');
  await closed;
}

async function request(baseUrl, path, options) {
  const response = await fetch(new URL(path, baseUrl), options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

async function waitForHealth(baseUrl) {
  const end = Date.now() + 12_000;
  let lastError = 'el servidor no respondió';
  while (Date.now() < end) {
    try {
      const { response, body } = await request(baseUrl, '/api/health');
      if (response.ok && body.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error.message; /* The child server is still starting. */ }
    await delay(100);
  }
  throw new Error(`El servidor aislado no inició (${lastError}). ${childOutput.join('').slice(-2000)}`);
}

function startApp(port, mockPort) {
  appProcess = spawn(process.execPath, ['scripts/test-server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: join(tempDirectory, 'data'),
      GEMINI_API_KEY: 'integration-test-placeholder',
      GEMINI_BILLING_TIER: 'free',
      LOCAL_ASR_WS_URL: `ws://127.0.0.1:${mockPort}/asr`,
      LOCAL_SPEAKER_DIARIZATION: 'true',
      LOCAL_ASR_INFRA_USD_PER_MINUTE: '0.02',
      MAX_ACTIVE_SESSIONS: '2',
      MAX_AUDIO_QUEUE_CHUNKS: '3',
      DAILY_BUDGET_USD: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  appProcess.stdout.on('data', (data) => childOutput.push(data.toString()));
  appProcess.stderr.on('data', (data) => childOutput.push(data.toString()));
  return `http://127.0.0.1:${port}`;
}

async function stopApp() {
  if (!appProcess || appProcess.exitCode !== null) return;
  const child = appProcess;
  const stopped = once(child, 'exit');
  child.stdin.end('shutdown\n');
  let timeoutId;
  try {
    await Promise.race([stopped, new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('El servidor de prueba no se detuvo.')), 5000);
    })]);
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
  appProcess = null;
}

function pcmPacket() {
  const packet = Buffer.alloc(8 + 3200);
  packet.writeDoubleLE(Date.now(), 0);
  return packet;
}

try {
  mockWss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/asr' });
  await once(mockWss, 'listening');
  const mockPort = mockWss.address().port;
  let mockFrameCount = 0;
  mockWss.on('connection', (socket) => {
    setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'config', sample_rate: 16000 }));
    }, 350);
    socket.on('message', (data, isBinary) => {
      if (!isBinary || !data.length || ++mockFrameCount !== 1) return;
      setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({
          lines: [
            { speaker: 1, text: 'My name is Alice Smith.', start: '0:00:00', end: '0:00:02', translation: 'Me llamo Alice Smith.' },
            { speaker: 2, text: 'My name is Bob Jones.', start: '0:00:02', end: '0:00:04', translation: 'Me llamo Bob Jones.' },
          ],
          buffer_transcription: 'Alice and Bob are testing the live captions.',
          buffer_diarization: 'Speaker 1',
          buffer_translation: 'Alice y Bob están probando los subtítulos en vivo.',
          remaining_time_transcription: 0.18,
          remaining_time_diarization: 0.11,
        }));
      }, 40);
    });
  });

  const port = await freePort();
  let baseUrl = startApp(port, mockPort);
  await waitForHealth(baseUrl);
  let { response, body } = await request(baseUrl, '/api/health');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  ({ body } = await request(baseUrl, '/api/config'));
  assert.equal(body.localProviderAvailable, true);
  assert.equal(body.speakerDiarizationAvailable, true);
  assert.equal(body.maxActiveSessions, 2);

  for (const asset of ['/', '/audience.html', '/caption-overlay.css', '/audio-worklet.js']) {
    const assetResponse = await fetch(new URL(asset, baseUrl));
    assert.equal(assetResponse.status, 200, `asset ${asset} debe servirse`);
  }

  const wsUrl = baseUrl.replace('http:', 'ws:') + '/ws';
  const localId = `smoke-local-${Date.now()}`;
  const local = await connectSocket(wsUrl);
  sendJson(local.socket, {
    type: 'start', sessionId: localId, title: 'Smoke local con diarización',
    speaker: 'Alice Smith, Bob Jones', speakerRoster: ['Alice Smith', 'Bob Jones'],
    language: 'en', translateTo: 'es', engine: 'local', glossary: ['Nerdearla'],
  });
  await local.inbox.next((event) => event.type === 'status' && event.status === 'connecting');
  sendJson(local.socket, { type: 'audio-level', rms: 0.05, capturedAt: Date.now(), dropped: 0 });
  for (let index = 0; index < 12; index += 1) local.socket.send(pcmPacket());
  await local.inbox.next((event) => event.type === 'status' && event.status === 'live');

  const localViewer = await connectSocket(wsUrl);
  sendJson(localViewer.socket, { type: 'watch', sessionId: localId });
  const localSnapshot = await localViewer.inbox.next((event) => event.type === 'snapshot');
  assert.equal(localSnapshot.session.engine, 'local');
  await localViewer.inbox.next((event) => event.type === 'final' && event.line.speakerId === 'speaker-1');
  await localViewer.inbox.next((event) => event.type === 'final' && event.line.speakerId === 'speaker-2');
  await localViewer.inbox.next((event) => event.type === 'interim' && event.speakerLabel === 'Voz 1');

  ({ response } = await request(baseUrl, `/api/sessions/${localId}`, { method: 'DELETE' }));
  assert.equal(response.status, 409, 'no se permite borrar una sala activa');
  ({ body } = await request(baseUrl, `/api/sessions/${localId}`));
  assert.equal(body.speakerSuggestions['speaker-1'].name, 'Alice Smith');
  assert.equal(body.speakerSuggestions['speaker-1'].source, 'self-introduction');
  assert.ok(Date.parse(body.speakerSuggestions['speaker-1'].detectedAt));
  assert.equal(body.speakerSuggestions['speaker-2'].name, 'Bob Jones');
  assert.equal(body.speakerSuggestions['speaker-2'].source, 'self-introduction');
  assert.equal(body.telemetry.audioChunksReceived, 12);
  assert.ok(body.telemetry.audioChunksDropped >= 5, 'la cola vieja debe descartarse ante la demora del proveedor');
  assert.ok(body.telemetry.audioChunksSent > 0);
  assert.equal(body.telemetry.inputFinalEvents, 2);
  assert.ok(body.telemetry.captureToFirstCaptionMs >= 0);

  const aliases = [['speaker-1', 'Alice Smith'], ['speaker-2', 'Bob Jones']];
  for (const [speakerId, name] of aliases) {
    const result = await request(baseUrl, `/api/sessions/${localId}/speakers/${speakerId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    });
    assert.equal(result.response.status, 200);
  }
  const invalidVoice = await request(baseUrl, `/api/sessions/${localId}/speakers/speaker-99`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Out of range' }),
  });
  assert.equal(invalidVoice.response.status, 400, 'no se deben asociar IDs de voz no admitidos');
  const mappedEvent = await localViewer.inbox.next((event) => event.type === 'speaker-map' && event.speakerAliases?.['speaker-2'] === 'Bob Jones');
  assert.equal(mappedEvent.speakerAliases['speaker-1'], 'Alice Smith');
  const localSession = await request(baseUrl, `/api/sessions/${localId}`);
  assert.equal(localSession.body.lines[0].speakerLabel, 'Voz 1');
  assert.equal(localSession.body.speakerAliases['speaker-1'], 'Alice Smith');

  const directId = `smoke-direct-${Date.now()}`;
  let direct = await connectSocket(wsUrl);
  sendJson(direct.socket, {
    type: 'start', sessionId: directId, title: 'Smoke direct bridge', speaker: 'Demo speaker',
    language: 'en', translateTo: 'es', engine: 'gemini-direct', audioSource: 'tab',
    captureDiagnostics: { displaySurface: 'browser', audioTrackCount: 1, audioTrackReadyState: 'live', audioTrackMuted: false, audioTrackEnabled: true },
  });
  await direct.inbox.next((event) => event.type === 'direct-provider-required');
  sendJson(direct.socket, { type: 'direct-provider-status', status: 'live' });
  await direct.inbox.next((event) => event.type === 'status' && event.status === 'live');
  const directViewer = await connectSocket(wsUrl);
  sendJson(directViewer.socket, { type: 'watch', sessionId: directId });
  await directViewer.inbox.next((event) => event.type === 'snapshot');
  sendJson(direct.socket, { type: 'audio-level', rms: 0.04, capturedAt: Date.now(), dropped: 0 });
  sendJson(direct.socket, { type: 'audio-usage', bytes: 32000 });
  sendJson(direct.socket, { type: 'direct-provider-message', payload: { serverContent: { interimInputTranscription: { text: 'This is a partial sentence.' } } } });
  await directViewer.inbox.next((event) => event.type === 'interim');
  sendJson(direct.socket, { type: 'direct-provider-message', payload: { serverContent: { inputTranscription: { text: 'This is a complete sentence.', languageCode: 'en-US' } } } });
  await directViewer.inbox.next((event) => event.type === 'final');
  sendJson(direct.socket, { type: 'direct-provider-message', payload: { serverContent: { outputTranscription: { text: 'Esta es una frase completa.', languageCode: 'es' } } } });
  const translated = await directViewer.inbox.next((event) => event.type === 'translation-stream');
  assert.ok(translated.delta.includes('Esta es una frase completa.'));
  sendJson(directViewer.socket, { type: 'render-ack', eventId: translated.eventId, latencyMs: 55 });
  sendJson(direct.socket, { type: 'capture-track-state', muted: true, readyState: 'live' });

  const directConfig = await request(baseUrl, `/api/sessions/${directId}`);
  assert.equal(directConfig.body.audioSource, 'tab');
  assert.equal(directConfig.body.requestedEngine, 'gemini-direct');
  assert.equal(directConfig.body.provider.capture.displaySurface, 'browser');
  assert.equal(directConfig.body.provider.capture.audioTrackMuted, true);
  const pausedDirect = directViewer.inbox.next((event) => event.type === 'status' && event.status === 'paused');
  direct.socket.close(1011, 'integration transient disconnect');
  const pausedEvent = await pausedDirect;
  assert.match(pausedEvent.reason, /WebSocket 1011: integration transient disconnect/u);
  const disconnectedDirect = await request(baseUrl, `/api/sessions/${directId}`);
  assert.equal(disconnectedDirect.body.provider.producerSocketClose.code, 1011);
  assert.equal(disconnectedDirect.body.provider.producerSocketClose.reason, 'integration transient disconnect');

  direct = await connectSocket(wsUrl);
  sendJson(direct.socket, {
    type: 'start', sessionId: directId, title: 'Smoke direct bridge', speaker: 'Demo speaker',
    language: 'en', translateTo: 'es', engine: 'gemini-direct', audioSource: 'tab',
    captureDiagnostics: { displaySurface: 'browser', audioTrackCount: 1, audioTrackReadyState: 'live', audioTrackMuted: false, audioTrackEnabled: true },
  });
  await direct.inbox.next((event) => event.type === 'direct-provider-required');
  sendJson(direct.socket, { type: 'direct-provider-status', status: 'live' });
  await direct.inbox.next((event) => event.type === 'status' && event.status === 'live');
  const resumedDirect = await request(baseUrl, `/api/sessions/${directId}`);
  assert.equal(resumedDirect.body.audioSource, 'tab');
  assert.equal(resumedDirect.body.requestedEngine, 'gemini-direct');
  assert.equal(resumedDirect.body.provider.producerSocketClose.code, 1011);

  const blocked = await connectSocket(wsUrl);
  sendJson(blocked.socket, { type: 'start', sessionId: `smoke-overflow-${Date.now()}`, engine: 'gemini-direct', title: 'Overflow' });
  const overflow = await blocked.inbox.next((event) => event.type === 'error');
  assert.match(overflow.message, /límite configurado/u);
  await closeSocket(blocked.socket);

  ({ body } = await request(baseUrl, '/api/metrics'));
  assert.equal(body.activeSessions, 2);
  assert.equal(body.viewers, 2);
  assert.ok(body.latencyMs.source.p50 >= 0);
  assert.ok(body.latencyMs.source.p99 >= body.latencyMs.source.p50);
  assert.ok(body.latencyMs.viewer.samples >= 1);
  ({ body } = await request(baseUrl, '/api/metrics/cost'));
  assert.equal(body.billingTier, 'free');
  assert.equal(body.totalBillableUsd > 0, true, 'la tarifa local configurada se contabiliza');
  assert.ok(body.paidEquivalentUsd > 0);

  sendJson(local.socket, { type: 'stop' });
  sendJson(direct.socket, { type: 'stop' });
  await local.inbox.next((event) => event.type === 'status' && event.status === 'finished');
  await direct.inbox.next((event) => event.type === 'status' && event.status === 'finished');
  await closeSocket(local.socket);
  await closeSocket(localViewer.socket);
  await closeSocket(direct.socket);
  await closeSocket(directViewer.socket);

  for (const format of ['vtt', 'srt', 'txt']) {
    const original = await fetch(new URL(`/api/sessions/${localId}/export?format=${format}`, baseUrl));
    assert.equal(original.status, 200);
    const originalText = await original.text();
    assert.match(originalText, /Alice Smith/u);
    assert.match(originalText, /Bob Jones/u);
    if (format === 'vtt') assert.match(originalText, /^WEBVTT/u);
    if (format === 'srt') assert.match(originalText, /\d{2}:\d{2}:\d{2},\d{3}/u);
    const translatedExport = await fetch(new URL(`/api/sessions/${localId}/export?format=${format}&language=translation`, baseUrl));
    assert.equal(translatedExport.status, 200);
    assert.match(await translatedExport.text(), /Me llamo/u);
  }

  ({ body } = await request(baseUrl, `/api/sessions/${directId}/export?format=txt&language=translation`));
  assert.match(body, /Esta es una frase completa/u);
  ({ response } = await request(baseUrl, `/api/sessions/${directId}/live-token`, { method: 'POST' }));
  assert.equal(response.status, 404, 'un token efímero solo existe mientras su sesión directa está activa');

  const beforeRestart = await request(baseUrl, `/api/sessions/${localId}`);
  assert.equal(beforeRestart.body.status, 'finished', `la sesión debe quedar finalizada antes de reiniciar; estado recibido: ${beforeRestart.body.status}`);
  await stopApp();
  const savedSnapshot = JSON.parse(await readFile(join(tempDirectory, 'data', 'sessions.json'), 'utf8'));
  const savedLocalSession = savedSnapshot.sessions.find((session) => session.id === localId);
  assert.equal(savedLocalSession?.status, 'finished', `el snapshot debe persistir la sesión finalizada; estado guardado: ${savedLocalSession?.status}`);
  baseUrl = startApp(port, mockPort);
  await waitForHealth(baseUrl);
  const restored = await request(baseUrl, `/api/sessions/${localId}`);
  assert.equal(restored.body.status, 'finished');
  assert.equal(restored.body.speakerAliases['speaker-2'], 'Bob Jones');
  assert.equal(restored.body.lines.length, 2);
  ({ response } = await request(baseUrl, `/api/sessions/${localId}`, { method: 'DELETE' }));
  assert.equal(response.status, 200);
  ({ response } = await request(baseUrl, `/api/sessions/${localId}`));
  assert.equal(response.status, 404);

  await stopApp();
  await new Promise((resolve) => mockWss.close(resolve));
  await rm(tempDirectory, { recursive: true, force: true });
  console.log('Integración OK: HTTP, WebSocket, PCM, cola acotada, diarización, nombres, métricas p50/p95/p99, costo, exportación, persistencia y limpieza.');
} catch (error) {
  console.error(error.stack || error);
  if (childOutput.length) console.error(childOutput.join('').slice(-5000));
  process.exitCode = 1;
} finally {
  if (appProcess && appProcess.exitCode === null) {
    appProcess.kill('SIGTERM');
    await Promise.race([once(appProcess, 'exit'), delay(5000)]).catch(() => {});
  }
  if (mockWss) await new Promise((resolve) => mockWss.close(resolve));
  await rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
}
