import test from 'node:test';
import assert from 'node:assert/strict';
import { recentTranslationLines } from '../public/caption-window.js';

test('shows at most three recent translated sentences', () => {
  assert.deepEqual(recentTranslationLines('One. Two. Three. Four.'), ['Two.', 'Three.', 'Four.']);
});

test('bounds an accumulating live translation and preserves the newest words', () => {
  const result = recentTranslationLines(`${'Earlier words '.repeat(60)}Latest phrase.`).join(' ');
  assert.ok(result.length <= 445);
  assert.match(result, /Latest phrase\.$/u);
  assert.match(result, /^…/u);
});
