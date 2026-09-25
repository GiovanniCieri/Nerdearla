import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const node = process.execPath;

test('quality evaluator reports WER, term recall, latency percentiles, and blind human score', async () => {
  const directory = await mkdtemp(join(os.tmpdir(), 'nerdearla-quality-'));
  try {
    const input = join(directory, 'references.jsonl');
    await writeFile(input, `${JSON.stringify({
      reference: 'Kubernetes schedules containers across nodes.',
      hypothesis: 'Kubernetes schedules containers across nodes.',
      terms: ['Kubernetes', 'containers'], latencyMs: 1850, humanTranslationScore: 4,
    })}\n${JSON.stringify({
      reference: 'The service scales globally.',
      hypothesis: 'The service grows globally.',
      terms: ['service'], latencyMs: 950, humanTranslationScore: 5,
    })}\n`);

    const result = spawnSync(node, ['scripts/evaluate-quality.mjs', input], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.samples, 2);
    assert.equal(report.wordErrorRate, 1 / 9);
    assert.equal(report.requiredTermRecall, 1);
    assert.deepEqual(report.latencyMs, { p50: 950, p95: 1850, measuredSamples: 2 });
    assert.equal(report.humanTranslationScore, 4.5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
