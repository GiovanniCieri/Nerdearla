const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nerdearlaDesktop', Object.freeze({
  openCaptionOverlay: (options) => ipcRenderer.invoke('nerdearla:open-caption-overlay', {
    sessionId: String(options?.sessionId || ''),
    lang: options?.lang === 'translation' ? 'translation' : 'original',
    demo: options?.demo === true,
  }),
  openChromiumSession: (options) => ipcRenderer.invoke('nerdearla:open-chromium-session', {
    sessionId: String(options?.sessionId || ''),
    title: String(options?.title || ''),
    speaker: String(options?.speaker || ''),
    language: String(options?.language || 'en'),
    translateTo: options?.translateTo ? String(options.translateTo) : null,
    engine: String(options?.engine || 'gemini'),
    glossary: Array.isArray(options?.glossary) ? options.glossary.map(String) : [],
    earlyTranslation: options?.earlyTranslation === true,
    sourceUrl: String(options?.sourceUrl || ''),
  }),
  controlCaptionOverlay: (sessionId, action) => ipcRenderer.invoke('nerdearla:overlay-control', {
    sessionId: String(sessionId || ''),
    action: String(action || ''),
  }),
  onCaptionOverlayClosed: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, sessionId) => callback(sessionId);
    ipcRenderer.on('nerdearla:caption-overlay-closed', listener);
    return () => ipcRenderer.removeListener('nerdearla:caption-overlay-closed', listener);
  },
}));
