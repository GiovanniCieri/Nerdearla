const SPEAKER_ID_PATTERN = /^speaker-(\d{1,2})$/u;

export function speakerIdFor(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 32 ? `speaker-${number}` : '';
}

export function cleanSpeakerAlias(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 80);
}

export function normalizeSpeakerAliases(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([id]) => {
      const match = SPEAKER_ID_PATTERN.exec(id);
      return match && Number(match[1]) >= 1 && Number(match[1]) <= 32;
    })
    .map(([id, name]) => [id, cleanSpeakerAlias(name)])
    .filter(([, name]) => name));
}

export function suggestSelfIntroducedSpeakerName(text, roster = []) {
  const value = String(text || '').trim();
  if (!value) return '';
  const cue = /\b(?:mi nombre es|me llamo|soy|my name is|i am|i'm|this is|meu nome é|me chamo|sou)\s+([^,;.!?\n]{1,80})/iu;
  const match = value.match(cue);
  if (!match) return '';

  const candidate = cleanSpeakerAlias(match[1].replace(/\s+(?:and|y|e)\s+(?:i|yo|eu)\b.*$/iu, ''));
  const rosterNames = roster.map(cleanSpeakerAlias).filter(Boolean);
  if (rosterNames.length) return rosterNames.find((name) => name.toLocaleLowerCase('und') === candidate.toLocaleLowerCase('und')) || '';

  const words = candidate.split(/\s+/u);
  const properName = /^(?:\p{Lu}[\p{L}'’.-]*|de|del|la|van|von|da|dos)(?:\s+(?:\p{Lu}[\p{L}'’.-]*|de|del|la|van|von|da|dos)){0,3}$/u;
  const isExplicitNameCue = /\b(?:mi nombre es|me llamo|soy|my name is|i am|i'm|this is|meu nome é|me chamo|sou)\b/iu.test(value);
  if (!properName.test(candidate) || (words.length < 2 && !isExplicitNameCue)) return '';
  return candidate;
}
