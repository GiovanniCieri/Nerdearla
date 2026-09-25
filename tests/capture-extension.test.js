import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isCaptureExtensionOrigin, isSameHostOrigin } from '../lib/capture-extension-origin.js';

const expectedExtensionId = 'hihbplbemkhehapigojnjdhcilndcjeg';

test('bundled Chromium extension has a stable id matching the server allowlist', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  const extensionId = hash.replace(/[0-9a-f]/gu, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
  assert.equal(extensionId, expectedExtensionId);
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.equal(manifest.permissions.includes('tabCapture'), true);
  assert.equal(manifest.permissions.includes('offscreen'), true);
});

test('backend accepts only the configured capture extension origin', () => {
  const origin = `chrome-extension://${expectedExtensionId}`;
  assert.equal(isCaptureExtensionOrigin(origin, expectedExtensionId), true);
  assert.equal(isCaptureExtensionOrigin('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', expectedExtensionId), false);
  assert.equal(isCaptureExtensionOrigin(origin, ''), false);
});

test('websocket origin comparison accepts same-host app tabs independent of scheme', () => {
  assert.equal(isSameHostOrigin('http://localhost:3001', 'localhost:3001'), true);
  assert.equal(isSameHostOrigin('https://localhost:3001', 'localhost:3001'), true);
  assert.equal(isSameHostOrigin('https://evil.example', 'localhost:3001'), false);
});

test('extension uses the same low-latency PCM processor as the audience panel', async () => {
  const [panelWorklet, extensionWorklet] = await Promise.all([
    readFile(new URL('../public/audio-worklet.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/audio-worklet.js', import.meta.url), 'utf8'),
  ]);
  assert.equal(extensionWorklet, panelWorklet);
});
