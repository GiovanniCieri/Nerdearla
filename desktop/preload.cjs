const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nerdearlaDesktop', Object.freeze({
  openCaptionOverlay: (options) => ipcRenderer.invoke('nerdearla:open-caption-overlay', {
    sessionId: String(options?.sessionId || ''),
    lang: options?.lang === 'translation' ? 'translation' : 'original',
    demo: options?.demo === true,
  }),
  onCaptionOverlayClosed: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, sessionId) => callback(sessionId);
    ipcRenderer.on('nerdearla:caption-overlay-closed', listener);
    return () => ipcRenderer.removeListener('nerdearla:caption-overlay-closed', listener);
  },
}));
