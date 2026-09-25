const MAX_VISIBLE_TRANSLATION_CHARS = 440;
const MAX_VISIBLE_TRANSLATION_LINES = 3;

/** Return only the newest bounded part of an accumulating live translation. */
export function recentTranslationLines(value) {
  let text = String(value || '').replace(/\s+/gu, ' ').trim();
  if (!text) return [];

  const truncated = text.length > MAX_VISIBLE_TRANSLATION_CHARS;
  if (truncated) {
    text = text.slice(-MAX_VISIBLE_TRANSLATION_CHARS);
    const firstWordBoundary = text.search(/\s/u);
    if (firstWordBoundary >= 0) text = text.slice(firstWordBoundary + 1);
    text = `… ${text.trimStart()}`;
  }

  const lines = text.split(/(?<=[.!?。！？])\s+/u).filter(Boolean);
  return lines.slice(-MAX_VISIBLE_TRANSLATION_LINES);
}
