import { createReadStream } from 'node:fs';
import readline from 'node:readline';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Uso: node scripts/evaluate-quality.mjs benchmarks/references.jsonl');
  process.exitCode = 2;
} else {
  const rows = [];
  const reader = readline.createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
  for await (const raw of reader) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try { rows.push(JSON.parse(line)); }
    catch { console.error(`JSON inválido en línea ${rows.length + 1}.`); process.exitCode = 2; break; }
  }
  if (!process.exitCode) {
    const words = (value) => String(value || '').normalize('NFKC').toLocaleLowerCase('und')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/u).filter(Boolean);
    const distance = (left, right) => {
      let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
      for (let i = 1; i <= left.length; i += 1) {
        const current = [i];
        for (let j = 1; j <= right.length; j += 1) {
          current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
        }
        previous = current;
      }
      return previous[right.length];
    };
    const percentiles = (values, p) => {
      if (!values.length) return null;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
    };
    const refs = rows.reduce((sum, row) => sum + words(row.reference).length, 0);
    const errors = rows.reduce((sum, row) => sum + distance(words(row.reference), words(row.hypothesis)), 0);
    const terms = rows.flatMap((row) => (row.terms || []).map((term) => ({ term, hypothesis: String(row.hypothesis || '').toLocaleLowerCase('und') })));
    const termHits = terms.filter(({ term, hypothesis }) => hypothesis.includes(String(term).toLocaleLowerCase('und'))).length;
    const latencies = rows.map((row) => Number(row.latencyMs)).filter((value) => Number.isFinite(value) && value >= 0);
    const scoreRows = rows.filter((row) => Number.isFinite(Number(row.humanTranslationScore)));
    const report = {
      samples: rows.length,
      wordErrorRate: refs ? errors / refs : null,
      wordErrors: errors,
      referenceWords: refs,
      requiredTermRecall: terms.length ? termHits / terms.length : null,
      requiredTermsCorrect: termHits,
      requiredTermsTotal: terms.length,
      latencyMs: { p50: percentiles(latencies, 0.5), p95: percentiles(latencies, 0.95), measuredSamples: latencies.length },
      humanTranslationScore: scoreRows.length ? scoreRows.reduce((sum, row) => sum + Number(row.humanTranslationScore), 0) / scoreRows.length : null,
      humanScoredSamples: scoreRows.length,
      note: 'WER y recall de términos no evalúan por sí solos la calidad semántica de la traducción. Añadí humanTranslationScore tras una revisión humana ciega para comparar motores.',
    };
    console.log(JSON.stringify(report, null, 2));
  }
}
