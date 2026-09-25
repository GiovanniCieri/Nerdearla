const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXTENSION_ID = 'hihbplbemkhehapigojnjdhcilndcjeg';

function normalizeLaunchConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('La configuración de la sesión no es válida.');
  const sessionId = String(value.sessionId || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(sessionId)) throw new Error('El identificador de sesión no es válido.');

  let source;
  try { source = new URL(String(value.sourceUrl || '')); }
  catch { throw new Error('Ingresá la URL de la transmisión.'); }
  if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password) {
    throw new Error('La fuente debe usar HTTP o HTTPS y no incluir credenciales.');
  }

  const language = ['en', 'es', 'pt', 'auto'].includes(value.language) ? value.language : 'en';
  const requestedTarget = ['en', 'es', 'pt'].includes(value.translateTo) ? value.translateTo : null;
  const translateTo = requestedTarget && (language === 'auto' || requestedTarget !== language) ? requestedTarget : null;
  return {
    sessionId,
    title: String(value.title || 'Sesión Nerdearla').trim().slice(0, 100),
    speaker: String(value.speaker || '').trim().slice(0, 100),
    language,
    translateTo,
    engine: ['gemini', 'local', 'auto'].includes(value.engine) ? value.engine : 'gemini',
    glossary: Array.isArray(value.glossary)
      ? [...new Set(value.glossary.map((term) => String(term).trim().slice(0, 120)).filter(Boolean))].slice(0, 100)
      : [],
    earlyTranslation: Boolean(value.earlyTranslation),
    sourceUrl: source.href,
  };
}

function chromiumCandidates(env = process.env, platform = process.platform) {
  if (env.NERDEARLA_CHROMIUM_EXECUTABLE) return [env.NERDEARLA_CHROMIUM_EXECUTABLE];
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = env.LOCALAPPDATA || '';
    return [
      path.join(localAppData, 'Nerdearla', 'Chromium', 'chrome.exe'),
      path.join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
      path.join(programFiles, 'Chromium', 'chrome.exe'),
      path.join(programFilesX86, 'Chromium', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Chromium', 'chrome.exe'),
      path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(programFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  }
  if (platform === 'darwin') return [
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/brave-browser', '/usr/bin/microsoft-edge', '/usr/bin/google-chrome'];
}

function findChromiumExecutable({ env = process.env, platform = process.platform, exists = require('node:fs').existsSync, probe } = {}) {
  const canStart = probe || ((candidate) => {
    const result = spawnSync(candidate, ['--version'], { windowsHide: true, timeout: 4000, stdio: 'ignore' });
    return !result.error && result.status === 0;
  });
  return chromiumCandidates(env, platform).find((candidate) => candidate && exists(candidate) && canStart(candidate)) || null;
}

function buildChromiumLaunch({ profileDirectory, extensionDirectory, config, remoteDebuggingPort = null }) {
  const normalizedConfig = normalizeLaunchConfig(config);
  const encodedConfig = Buffer.from(JSON.stringify(normalizedConfig), 'utf8').toString('base64url');
  const launcherUrl = `chrome-extension://${EXTENSION_ID}/launcher.html?config=${encodedConfig}`;
  const args = [
    `--user-data-dir=${profileDirectory}`,
    `--disable-extensions-except=${extensionDirectory}`,
    `--load-extension=${extensionDirectory}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
  ];
  if (Number.isInteger(remoteDebuggingPort) && remoteDebuggingPort >= 1024 && remoteDebuggingPort <= 65535) {
    args.push(`--remote-debugging-port=${remoteDebuggingPort}`, '--remote-debugging-address=127.0.0.1');
  }
  args.push(launcherUrl);
  return { args, launcherUrl, config: normalizedConfig };
}

module.exports = { EXTENSION_ID, buildChromiumLaunch, chromiumCandidates, findChromiumExecutable, normalizeLaunchConfig };
