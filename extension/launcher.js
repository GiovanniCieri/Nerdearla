function decodePayload(encoded) {
  const base64 = encoded.replace(/-/gu, '+').replace(/_/gu, '/');
  const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (value) => value.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function cleanPayload(value) {
  if (!value || typeof value !== 'object') throw new Error('No encontramos la configuración de la sala.');
  const source = new URL(String(value.sourceUrl || ''));
  if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password) {
    throw new Error('La fuente debe ser una URL HTTP o HTTPS válida.');
  }
  const sessionId = String(value.sessionId || '');
  if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(sessionId)) throw new Error('El identificador de sala no es válido.');
  const encodedConfig = {
    sessionId,
    title: String(value.title || 'Sesión Nerdearla').trim().slice(0, 100),
    speaker: String(value.speaker || '').trim().slice(0, 100),
    language: ['en', 'es', 'pt', 'auto'].includes(value.language) ? value.language : 'en',
    translateTo: ['en', 'es', 'pt'].includes(value.translateTo) ? value.translateTo : 'es',
    engine: ['gemini', 'local', 'auto'].includes(value.engine) ? value.engine : 'gemini',
    glossary: Array.isArray(value.glossary) ? value.glossary.map((term) => String(term).trim()).filter(Boolean).slice(0, 100) : [],
    earlyTranslation: Boolean(value.earlyTranslation),
    sourceUrl: source.href,
  };
  if (encodedConfig.language !== 'auto' && encodedConfig.language === encodedConfig.translateTo) encodedConfig.translateTo = null;
  return { config: encodedConfig, sourceUrl: source.href };
}

async function launch() {
  const message = document.querySelector('#message');
  try {
    const payload = cleanPayload(decodePayload(new URL(location.href).searchParams.get('config') || ''));
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No encontramos la pestaña de Chromium para esta sala.');
    await chrome.storage.session.set({ [`launch:${tab.id}`]: payload.config });
    await chrome.tabs.update(tab.id, { url: payload.sourceUrl });
  } catch (error) {
    message.textContent = error?.message || 'No se pudo abrir la fuente de audio.';
  }
}

launch();
