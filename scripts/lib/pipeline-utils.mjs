export const DRAFT_RETRY_WINDOWS_MS = [
  3 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000
];

export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

export const GENERIC_TITLE_WORDS = new Set([
  'noticias', 'inicio', 'home', 'bienvenido', 'portada', 'hoy',
  'municipio', 'rio', 'grande', 'ushuaia', 'tolhuin', 'fuego', 'tierra',
  'novedades', 'actualidad', 'informacion', 'bing', 'google', 'msn'
]);

const STOPWORDS = new Set([
  'que', 'con', 'para', 'por', 'una', 'del', 'los', 'las', 'sus', 'fue',
  'son', 'este', 'esta', 'pero', 'como', 'desde', 'sobre', 'entre', 'ante'
]);

export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractFingerprint(title) {
  const words = normalizeText(title)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) =>
      word.length >= 5 &&
      !STOPWORDS.has(word) &&
      !GENERIC_TITLE_WORDS.has(word)
    );
  return [...new Set(words)].sort().join('|');
}

export function isGenericTitle(title) {
  if (!title || title.length < 15) return true;
  const words = normalizeText(title).match(/\b[a-z0-9]{4,}\b/g) || [];
  const meaningfulWords = words.filter((word) => !GENERIC_TITLE_WORDS.has(word));
  return meaningfulWords.length < 2;
}

export function isSimilarTitle(newTitle, existingTitles = new Set()) {
  if (!newTitle || isGenericTitle(newTitle)) return false;
  const words1 = new Set(normalizeText(newTitle).match(/\b[a-z0-9]{5,}\b/g) || []);
  if (words1.size < 2) return existingTitles.has(newTitle.toLowerCase());
  for (const oldTitle of existingTitles) {
    const words2 = new Set(normalizeText(oldTitle).match(/\b[a-z0-9]{5,}\b/g) || []);
    if (words2.size < 2) continue;
    const intersection = [...words1].filter((word) => words2.has(word)).length;
    const union = new Set([...words1, ...words2]).size;
    if (union > 0 && (intersection / union) > 0.55) return true;
  }
  return false;
}

export function isEventAlreadyPublished(title, publishedFingerprints = new Set()) {
  const words = new Set(extractFingerprint(title).split('|').filter(Boolean));
  if (words.size < 2) return false;
  for (const fingerprint of publishedFingerprints) {
    const fpWords = new Set(String(fingerprint).split('|').filter(Boolean));
    if (fpWords.size < 2) continue;
    const intersection = [...words].filter((word) => fpWords.has(word)).length;
    if (intersection >= 3) return true;
  }
  return false;
}

export function isRetryEligible(seenItem, now = Date.now()) {
  if (!seenItem) return false;
  if (seenItem.status === 'discarded-editorial') {
    return isRecoverableEditorialDiscard(seenItem, now);
  }
  if (['published', 'duplicate', 'stale'].includes(seenItem.status)) {
    return false;
  }
  if (![
    'draft',
    'extract-error',
    'model-error',
    'temporary-error',
    'pending-verification'
  ].includes(seenItem.status)) {
    return false;
  }
  if (seenItem.nextRetryAt) return now >= new Date(seenItem.nextRetryAt).getTime();
  const seenAt = new Date(seenItem.seenAt || 0).getTime();
  return (now - seenAt) < STALE_AFTER_MS;
}

export function isRecoverableEditorialDiscard(seenItem, now = Date.now()) {
  if (!seenItem || seenItem.status !== 'discarded-editorial') return false;
  if (seenItem.validationVersion) return false;
  if (!String(seenItem.lastError || '').startsWith('BLOCKED_FACTUAL_MISMATCH')) return false;
  const seenAt = new Date(seenItem.seenAt || 0).getTime();
  return Number.isFinite(seenAt) && (now - seenAt) < STALE_AFTER_MS;
}

export function getNextRetryAt(attempts, now = Date.now()) {
  const windowMs = DRAFT_RETRY_WINDOWS_MS[Math.min(attempts, DRAFT_RETRY_WINDOWS_MS.length - 1)];
  return new Date(now + windowMs).toISOString();
}

export function editorialScore(candidate, byCategory = {}) {
  const now = Date.now();
  const ageMs = now - (candidate.pubDate || new Date()).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  const recencyScore = Math.max(0, 40 - (ageHours / 48) * 40);
  const qualityScore = Math.min(20, ((candidate.bodyLength || 0) / 2000) * 20);

  let localScore = 0;
  const srcMode = candidate.source?.mode;
  if (srcMode === 'official-auto') localScore = 20;
  else if (candidate.source?.id?.startsWith('bing-')) localScore = 15;
  else if (['infobae-tdf', 'perfil-tdf', 'clarin-tdf'].includes(candidate.source?.id)) localScore = 10;
  else localScore = 5;

  const category = candidate.source?.defaultCategory;
  const diversityBonus = byCategory[category] ? 0 : 15;
  return recencyScore + qualityScore + localScore + diversityBonus;
}

export function canPublishWithinRunLimit({
  importance = 5,
  normalPublished = 0,
  target = 2,
  maxNormal = 3,
  extraSlotMinImportance = 8
} = {}) {
  const isUrgent = Number(importance) >= 9;
  if (isUrgent) return { ok: true, urgent: true, reason: 'urgent-outside-normal-cap' };
  if (normalPublished >= maxNormal) return { ok: false, urgent: false, reason: 'max-normal-cap' };
  if (normalPublished >= target && Number(importance) < extraSlotMinImportance) {
    return { ok: false, urgent: false, reason: 'target-reached-low-importance' };
  }
  return { ok: true, urgent: false, reason: 'within-normal-cap' };
}

export function isStaleRoutineWeatherForecast(facts = {}, now = Date.now()) {
  if (facts.eventType !== 'weather-forecast') return false;

  const forecastDateKey = facts.weatherForecastDateKey || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(forecastDateKey)) return true;

  const forecastNoon = new Date(`${forecastDateKey}T12:00:00Z`).getTime();
  const minForecastTime = now - 36 * 60 * 60 * 1000;
  const maxForecastTime = now + 48 * 60 * 60 * 1000;

  return forecastNoon < minForecastTime || forecastNoon > maxForecastTime;
}

export function isStaleDatedDiscoveryCandidate({
  source = {},
  title = '',
  description = '',
  pubDate = '',
  now = Date.now()
} = {}) {
  if (source.mode !== 'discovery-draft') return false;

  const currentYear = new Date(now).getUTCFullYear();
  const leadText = `${title}\n${description}`;
  const explicitYears = [...String(leadText).matchAll(/\b(19\d{2}|20\d{2})\b/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  const hasOldYear = explicitYears.some((year) => year < currentYear);
  const hasCurrentOrFutureYear = explicitYears.some((year) => year >= currentYear);
  if (hasOldYear && !hasCurrentOrFutureYear) return true;

  if (pubDate) {
    const publishedAt = new Date(pubDate).getTime();
    const maxAgeMs = 14 * 24 * 60 * 60 * 1000;
    if (Number.isFinite(publishedAt) && now - publishedAt > maxAgeMs) return true;
  }

  return false;
}
