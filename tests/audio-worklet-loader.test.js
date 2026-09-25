import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAudioWorklet } from '../public/audio-worklet-loader.js';

test('loads the audio processor separately for each room AudioContext', async () => {
  const calls = [];
  const createContext = (name) => ({
    audioWorklet: {
      addModule: async (url) => {
        calls.push({ name, url });
        return name;
      },
    },
  });
  const firstRoom = createContext('Gran Sala');
  const secondRoom = createContext('Auditorio');

  const [first, duplicate, second] = await Promise.all([
    loadAudioWorklet(firstRoom, '/audio-worklet.js'),
    loadAudioWorklet(firstRoom, '/audio-worklet.js'),
    loadAudioWorklet(secondRoom, '/audio-worklet.js'),
  ]);

  assert.equal(first, 'Gran Sala');
  assert.equal(duplicate, 'Gran Sala');
  assert.equal(second, 'Auditorio');
  assert.deepEqual(calls, [
    { name: 'Gran Sala', url: '/audio-worklet.js' },
    { name: 'Auditorio', url: '/audio-worklet.js' },
  ]);
});

test('allows retrying a failed AudioWorklet load in that context', async () => {
  let attempts = 0;
  const context = {
    audioWorklet: {
      addModule: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary load failure');
      },
    },
  };

  await assert.rejects(loadAudioWorklet(context, '/audio-worklet.js'), /temporary load failure/u);
  await loadAudioWorklet(context, '/audio-worklet.js');
  assert.equal(attempts, 2);
});
