const test = require('node:test');
const assert = require('node:assert/strict');
const { EXTENSION_ID, buildChromiumLaunch, chromiumCandidates, findChromiumExecutable, normalizeLaunchConfig } = require('../desktop/chromium-launch.cjs');

const source = {
  sessionId: 's-gran-sala',
  title: 'Gran Sala',
  speaker: 'Monty Widenius',
  language: 'en',
  translateTo: 'es',
  sourceUrl: 'https://app.swapcard.com/event/nerdearla-2026/plannings/RXZlbnRWaWV3XzEyNDc0MTY=',
};

test('launch config accepts an HTTPS source and keeps a distinct session id', () => {
  const config = normalizeLaunchConfig(source);
  assert.equal(config.sessionId, 's-gran-sala');
  assert.equal(config.sourceUrl, source.sourceUrl);
  assert.equal(config.translateTo, 'es');
});

test('launch config rejects non-web and credential-bearing source URLs', () => {
  assert.throws(() => normalizeLaunchConfig({ ...source, sourceUrl: 'file:///secret' }), /HTTP o HTTPS/u);
  assert.throws(() => normalizeLaunchConfig({ ...source, sourceUrl: 'https://user:pass@example.com/live' }), /credenciales/u);
  assert.throws(() => normalizeLaunchConfig({ ...source, sessionId: '../bad' }), /identificador/u);
});

test('one Chromium profile is isolated from other session profiles and loads the extension launcher', () => {
  const launch = buildChromiumLaunch({ profileDirectory: 'C:\\profiles\\s-gran-sala', extensionDirectory: 'C:\\repo\\extension', config: source });
  assert.ok(launch.args.includes('--user-data-dir=C:\\profiles\\s-gran-sala'));
  assert.ok(launch.args.includes('--load-extension=C:\\repo\\extension'));
  assert.ok(launch.launcherUrl.startsWith(`chrome-extension://${EXTENSION_ID}/launcher.html?config=`));
  assert.equal(Buffer.from(new URL(launch.launcherUrl).searchParams.get('config'), 'base64url').toString(), JSON.stringify(normalizeLaunchConfig(source)));
});

test('remote DevTools stays disabled by default and is loopback-only when explicitly enabled', () => {
  const normal = buildChromiumLaunch({ profileDirectory: 'C:\\profiles\\s-gran-sala', extensionDirectory: 'C:\\repo\\extension', config: source });
  assert.equal(normal.args.some((argument) => argument.startsWith('--remote-debugging-port=')), false);
  const debug = buildChromiumLaunch({ profileDirectory: 'C:\\profiles\\s-gran-sala', extensionDirectory: 'C:\\repo\\extension', config: source, remoteDebuggingPort: 9512 });
  assert.ok(debug.args.includes('--remote-debugging-port=9512'));
  assert.ok(debug.args.includes('--remote-debugging-address=127.0.0.1'));
});

test('browser lookup prefers Chromium and Chromium-based browsers before Google Chrome', () => {
  const candidates = chromiumCandidates({
    ProgramFiles: 'C:\\PF',
    'ProgramFiles(x86)': 'C:\\PF86',
    LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
  }, 'win32');
  assert.equal(candidates[0], 'C:\\Users\\test\\AppData\\Local\\Nerdearla\\Chromium\\chrome.exe');
  assert.ok(candidates.indexOf('C:\\PF\\Chromium\\Application\\chrome.exe') < candidates.indexOf('C:\\PF\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(candidates.indexOf('C:\\PF\\BraveSoftware\\Brave-Browser\\Application\\brave.exe') < candidates.indexOf('C:\\PF\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(candidates.indexOf('C:\\PF86\\Microsoft\\Edge\\Application\\msedge.exe') < candidates.indexOf('C:\\PF\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(candidates.includes('C:\\Users\\test\\AppData\\Local\\Chromium\\chrome.exe'));
});

test('browser lookup skips a browser that exists but cannot start', () => {
  const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\Local' };
  const failing = 'C:\\Local\\Nerdearla\\Chromium\\chrome.exe';
  const working = 'C:\\PF\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
  const result = findChromiumExecutable({
    env, platform: 'win32',
    exists: (candidate) => [failing, working].includes(candidate),
    probe: (candidate) => candidate === working,
  });
  assert.equal(result, working);
});
