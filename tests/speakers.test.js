import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSpeakerAlias, normalizeSpeakerAliases, speakerIdFor, suggestSelfIntroducedSpeakerName } from '../lib/speakers.js';

test('normalizes diarization speaker ids and rejects silence/invalid ids', () => {
  assert.equal(speakerIdFor(1), 'speaker-1');
  assert.equal(speakerIdFor('4'), 'speaker-4');
  assert.equal(speakerIdFor(-2), '');
  assert.equal(speakerIdFor(33), '');
  assert.equal(suggestSelfIntroducedSpeakerName("I'm Alex.", []), 'Alex');
});

test('only suggests names from an explicit self-introduction', () => {
  assert.equal(suggestSelfIntroducedSpeakerName('My name is Alice Smith, and today we discuss audio.', ['Alice Smith', 'Bob Jones']), 'Alice Smith');
  assert.equal(suggestSelfIntroducedSpeakerName('Hola, me llamo Lucía Fernández.', ['Lucía Fernández']), 'Lucía Fernández');
  assert.equal(suggestSelfIntroducedSpeakerName('We asked Alice Smith to explain it.', ['Alice Smith']), '');
  assert.equal(suggestSelfIntroducedSpeakerName('I think Kubernetes is useful.'), '');
});

test('cleans aliases and keeps only supported speaker keys', () => {
  assert.equal(cleanSpeakerAlias('  Alice\n Smith  '), 'Alice Smith');
  assert.deepEqual(normalizeSpeakerAliases({ 'speaker-1': ' Alice Smith ', 'speaker-0': 'Wrong', 'speaker-33': 'Wrong', 'speaker-2': '' }), { 'speaker-1': 'Alice Smith' });
});
