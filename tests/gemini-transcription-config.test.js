import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGeminiTranscriptionConfig } from '../lib/gemini-transcription-config.js';

test('Gemini Live transcription uses automatic language detection without languageCodes', () => {
  for (const language of ['es', 'en', 'pt']) {
    const config = buildGeminiTranscriptionConfig({ language, glossary: [] }, 'resume-handle');
    assert.deepEqual(config.inputAudioTranscription, {});
    assert.equal('languageCodes' in config.inputAudioTranscription, false);
    assert.deepEqual(config.sessionResumption, { handle: 'resume-handle' });
  }
});

test('Gemini Live transcription retains glossary biasing when language auto-detection is used', () => {
  const config = buildGeminiTranscriptionConfig({ language: 'en', glossary: ['Nerdearla', 'Kubernetes'] });
  assert.deepEqual(config.inputAudioTranscription, { customVocabulary: ['Nerdearla', 'Kubernetes'] });
  assert.deepEqual(config.sessionResumption, {});
});
