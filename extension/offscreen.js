const captures = new Map();
const MAX_SOCKET_BUFFERED_BYTES = 48 * 1024;

function emitState(capture, status, reason = '') {
  chrome.runtime.sendMessage({
    type: 'capture-state', tabId: capture.tabId, sessionId: capture.config.sessionId,
    title: capture.config.title || capture.tabTitle, status, reason,
  }).catch(() => {});
}

function captureConstraints(streamId) {
  return {
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  };
}

function openWebSocket(url) {
  const endpoint = new URL('/ws', url);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(endpoint);
  socket.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('El WebSocket del servidor no respondió en 8 segundos.'));
    }, 8000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(socket); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('No pudimos conectar con el WebSocket del servidor.')); }, { once: true });
  });
}

async function startCapture(message) {
  const { tabId, streamId, serverUrl, config, tabTitle } = message;
  if (captures.has(tabId)) return { ok: false, error: 'Esta pestaña ya tiene una captura activa. Detenela antes de volver a conectar.' };
  let stream;
  let socket;
  let audioContext;
  let source;
  let processor;
  let silentGain;
  let passthroughGain;
  const capture = { tabId, config, tabTitle, stream: null, socket: null, audioContext: null, source: null, processor: null, silentGain: null, passthroughGain: null, terminal: false, transportReady: false, droppedChunks: 0, lastMeterAt: 0, lastRms: 0 };
  captures.set(tabId, capture);
  try {
    stream = await navigator.mediaDevices.getUserMedia(captureConstraints(streamId));
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) throw new Error('Chromium no entregó la pista de audio de la pestaña.');
    capture.stream = stream;
    audioContext = new AudioContext({ latencyHint: 'interactive' });
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet.js'));
    source = audioContext.createMediaStreamSource(stream);
    processor = new AudioWorkletNode(audioContext, 'nerdearla-pcm-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1,
    });
    // Tab capture mutes the tab's normal local playback. Route the original audio back
    // to the output while sending a separate, silent worklet branch to transcription.
    passthroughGain = audioContext.createGain();
    passthroughGain.gain.value = 1;
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(passthroughGain).connect(audioContext.destination);
    source.connect(processor).connect(silentGain).connect(audioContext.destination);
    await audioContext.resume();
    socket = await openWebSocket(serverUrl);
    capture.socket = socket;
    capture.audioContext = audioContext;
    capture.source = source;
    capture.processor = processor;
    capture.silentGain = silentGain;
    capture.passthroughGain = passthroughGain;
    const audioDiagnostics = {
      source: 'tab', displaySurface: 'browser', audioTrackCount: stream.getAudioTracks().length,
      audioTrackReadyState: audioTrack.readyState, audioTrackMuted: audioTrack.muted,
      audioTrackEnabled: audioTrack.enabled,
    };
    socket.send(JSON.stringify({ type: 'start', ...config, audioSource: 'tab', captureDiagnostics: audioDiagnostics }));
    processor.port.onmessage = (event) => handlePcm(capture, event.data);
    processor.port.start();
    audioTrack.addEventListener('mute', () => {
      if (capture.socket?.readyState === WebSocket.OPEN) capture.socket.send(JSON.stringify({ type: 'capture-track-state', muted: true, readyState: audioTrack.readyState }));
    });
    audioTrack.addEventListener('unmute', () => {
      if (capture.socket?.readyState === WebSocket.OPEN) capture.socket.send(JSON.stringify({ type: 'capture-track-state', muted: false, readyState: audioTrack.readyState }));
    });
    audioTrack.addEventListener('ended', () => stopCapture(tabId, 'La pestaña o su audio dejaron de compartir.', true), { once: true });
    socket.addEventListener('message', (event) => handleServerMessage(capture, event));
    socket.addEventListener('close', (event) => {
      if (!capture.terminal) stopCapture(tabId, `WebSocket ${event.code || 1006}: la conexión de audio se cerró.`, false, 'disconnected');
    });
    socket.addEventListener('error', () => {
      if (!capture.terminal) stopCapture(tabId, 'Error en el WebSocket de esta sala.', false, 'error');
    });
    emitState(capture, 'capturing');
    return { ok: true };
  } catch (error) {
    capture.terminal = true;
    captures.delete(tabId);
    try { socket?.close(); } catch { /* The socket may not have opened. */ }
    try { stream?.getTracks().forEach((track) => track.stop()); } catch { /* Capture may already be closed. */ }
    try { source?.disconnect(); } catch { /* Audio graph may be incomplete. */ }
    try { processor?.disconnect(); } catch { /* Audio graph may be incomplete. */ }
    try { silentGain?.disconnect(); } catch { /* Audio graph may be incomplete. */ }
    try { passthroughGain?.disconnect(); } catch { /* Audio graph may be incomplete. */ }
    try { await audioContext?.close(); } catch { /* Context may not have been created. */ }
    throw error;
  }
}

function handlePcm(capture, data) {
  if (capture.terminal || data?.type !== 'pcm' || !(data.buffer instanceof ArrayBuffer)) return;
  const now = performance.now();
  capture.lastRms = Number(data.rms) || 0;
  if (now - capture.lastMeterAt >= 1000) {
    if (capture.socket?.readyState === WebSocket.OPEN) {
      capture.socket.send(JSON.stringify({
        type: 'audio-level', rms: capture.lastRms, dropped: capture.droppedChunks,
        capturedAt: performance.timeOrigin + now, bufferedBytes: capture.socket.bufferedAmount,
      }));
    }
    capture.lastMeterAt = now;
  }
  const socket = capture.socket;
  if (!capture.transportReady || socket?.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
    capture.droppedChunks += 1;
    return;
  }
  const packet = new ArrayBuffer(8 + data.buffer.byteLength);
  new DataView(packet).setFloat64(0, performance.timeOrigin + now, true);
  new Uint8Array(packet, 8).set(new Uint8Array(data.buffer));
  try { socket.send(packet); } catch { capture.droppedChunks += 1; }
}

function handleServerMessage(capture, event) {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.type === 'status') {
    if (message.status === 'live') {
      capture.transportReady = true;
      emitState(capture, 'live');
    } else if (message.status === 'connecting' || message.status === 'reconnecting') {
      capture.transportReady = false;
      emitState(capture, 'connecting', message.reason || 'Conectando el motor de transcripción.');
    } else if (['paused', 'finished', 'error'].includes(message.status)) {
      capture.transportReady = false;
      const state = message.status === 'error' ? 'error' : 'disconnected';
      stopCapture(capture.tabId, message.reason || 'La sesión se detuvo en el servidor.', false, state);
    }
  }
  if (message.type === 'error') stopCapture(capture.tabId, message.message || 'El servidor rechazó la sesión.', false, 'error');
}

async function stopCapture(tabId, reason = 'Captura detenida desde la extensión.', tellServer = true, finalState = 'stopped') {
  const capture = captures.get(Number(tabId));
  if (!capture || capture.terminal) return { ok: true };
  capture.terminal = true;
  capture.transportReady = false;
  captures.delete(Number(tabId));
  if (tellServer && capture.socket?.readyState === WebSocket.OPEN) {
    try { capture.socket.send(JSON.stringify({ type: 'capture-ended', reason })); } catch { /* The close event will pause the session. */ }
  }
  try { capture.socket?.close(1000, 'Captura finalizada'); } catch { /* Already closed. */ }
  try { capture.processor?.port.close(); } catch { /* Processor may have ended. */ }
  try { capture.source?.disconnect(); } catch { /* Graph may already be disconnected. */ }
  try { capture.processor?.disconnect(); } catch { /* Graph may already be disconnected. */ }
  try { capture.silentGain?.disconnect(); } catch { /* Graph may already be disconnected. */ }
  try { capture.passthroughGain?.disconnect(); } catch { /* Graph may already be disconnected. */ }
  try { capture.stream?.getTracks().forEach((track) => track.stop()); } catch { /* Stream may already be closed. */ }
  try { await capture.audioContext?.close(); } catch { /* Context may already be closed. */ }
  emitState(capture, finalState, reason);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'offscreen-start-capture') {
    startCapture(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || 'No se pudo capturar el audio.' }));
    return true;
  }
  if (message?.type === 'offscreen-stop-capture') {
    stopCapture(Number(message.tabId)).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || 'No se pudo detener la captura.' }));
    return true;
  }
  return false;
});
