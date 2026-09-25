import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';

const baseUrl = (process.env.CAPTIONS_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/u, '');
const sessionId = `smoke-gemini-${randomUUID()}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let exitCode = 0;

function requestJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(url), { method }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode || 0, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function removeSmokeSession() {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'stop' }));
    await delay(250);
  }
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const response = await requestJson(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, 'DELETE');
      if (response.status >= 200 && response.status < 300 || response.status === 404) return;
      if (response.status !== 409) throw new Error(`No se pudo borrar la sesión temporal (HTTP ${response.status}).`);
    } catch (error) {
      if (attempt === 11) throw error;
    }
    await delay(250);
  }
  throw new Error('La sesión temporal quedó activa y no se pudo borrar.');
}

try {
  const healthResponse = await requestJson(`${baseUrl}/api/config`);
  const health = JSON.parse(healthResponse.body);
  if (healthResponse.status < 200 || healthResponse.status >= 300 || !health.configured) throw new Error('El servidor no está saludable o Gemini no está configurado.');

  const outcome = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(reject, new Error('Gemini no confirmó la conexión en 20 segundos.')), 20_000);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    socket = new WebSocket(`${baseUrl.replace(/^http/u, 'ws')}/ws`);
    socket.on('open', () => socket.send(JSON.stringify({
      type: 'start', sessionId, title: 'Prueba temporal de configuración Gemini', language: 'es', engine: 'gemini',
    })));
    socket.on('message', (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.type === 'status' && message.status === 'live') finish(resolve, message);
      else if (message.type === 'error' || message.type === 'status' && message.status === 'error') {
        finish(reject, new Error(message.message || 'Gemini rechazó el inicio de Live Transcribe.'));
      }
    });
    socket.on('error', (error) => finish(reject, error));
    socket.on('close', (code, reason) => finish(reject, new Error(`WebSocket cerrado durante el inicio (${code}): ${reason.toString()}`)));
  });

  console.log(JSON.stringify({
    ok: true,
    model: health.model,
    status: outcome.status,
    languageDetection: 'automatic',
    audioFramesSent: 0,
    sessionCleanedUp: true,
  }));
} catch (error) {
  exitCode = 1;
  console.error(`Falló la prueba de inicio de Gemini: ${error.message}`);
} finally {
  try { await removeSmokeSession(); }
  catch (error) {
    exitCode = 1;
    console.error(error.message);
  }
}

process.exitCode = exitCode;
