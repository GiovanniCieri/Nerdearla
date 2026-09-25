import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDirectory = process.env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url));
const sessionsFile = join(dataDirectory, 'sessions.json');
let saveQueue = Promise.resolve();
let saveTimer = null;

function persistedSession(session) {
  const result = {};
  for (const [key, value] of Object.entries(session)) {
    if (['clients', 'producer', 'live', 'providerSocket', 'translationQueue', 'audioQueue', 'draftTimer', 'reconnectTimer'].includes(key)) continue;
    if (typeof value !== 'function') result[key] = value;
  }
  return result;
}

export async function loadSessions() {
  try {
    const value = JSON.parse(await readFile(sessionsFile, 'utf8'));
    return Array.isArray(value.sessions) ? value.sessions : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    console.error('No se pudieron leer las sesiones persistidas:', error.message);
    return [];
  }
}

function writeSnapshot(sessions) {
  const content = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), sessions: [...sessions.values()].map(persistedSession) });
  saveQueue = saveQueue.then(async () => {
    await mkdir(dataDirectory, { recursive: true });
    const temporaryFile = `${sessionsFile}.tmp`;
    await writeFile(temporaryFile, content, { mode: 0o600 });
    await rename(temporaryFile, sessionsFile);
  }).catch((error) => console.error('No se pudieron persistir las sesiones:', error.message));
  return saveQueue;
}

export function saveSessions(sessions) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeSnapshot(sessions), 200);
  saveTimer.unref?.();
}

export async function flushSessions(sessions) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    writeSnapshot(sessions);
  }
  await saveQueue;
}
