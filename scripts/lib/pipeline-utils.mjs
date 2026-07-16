import crypto from 'node:crypto';

export const DRAFT_RETRY_WINDOWS_MS = [
  3 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000
];

export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
export const HARD_NEWS_MAX_AGE_MS = 36 * 60 * 60 * 1000;
export const INSTITUTIONAL_MAX_AGE_MS = 72 * 60 * 60 * 1000;
export const MAX_RETRY_ATTEMPTS = 3;

const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', 'ref', 'ref_src',
  'igshid'
]);

const EVENT_TITLE_STOPWORDS = new Set([
  'que', 'con', 'para', 'por', 'una', 'uno', 'del', 'los', 'las', 'sus', 'fue',
  'son', 'este', 'esta', 'como', 'desde', 'sobre', 'entre', 'ante', 'tras', 'hacia',
  'portal', 'noticias', 'actualidad'
]);

export function unwrapDiscoveryUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'bing.com' && /\/news\/apiclick\.aspx$/i.test(parsed.pathname)) {
      const target = parsed.searchParams.get('url');
      if (/^https?:\/\//i.test(target || '')) return target;
    }
    return parsed.toString();
  } catch {
    return String(value || '');
  }
}

export function canonicalizeNewsUrl(value) {
  try {
    const parsed = new URL(unwrapDiscoveryUrl(value));
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (parsed.protocol === 'http:' && !/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)) {
      parsed.protocol = 'https:';
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    const sortedParams = [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    parsed.search = '';
    for (const [key, val] of sortedParams) parsed.searchParams.append(key, val);
    parsed.pathname = parsed.pathname
      .replace(/\/{2,}/g, '/')
      .replace(/\/(?:amp|amp\/?)$/i, '')
      .replace(/\/$/, '') || '/';
    return parsed.toString();
  } catch {
    return String(value || '').trim();
  }
}

export function createContentFingerprint({ title = '', body = '', publisherDomain = '' } = {}) {
  const normalizedTitle = normalizeText(title);
  const normalizedBody = normalizeText(body).slice(0, 12000);
  if (!normalizedTitle || normalizedBody.length < 200) return '';
  const digest = crypto.createHash('sha256').update(`${normalizedTitle}\n${normalizedBody}`).digest('hex').slice(0, 20);
  return `${String(publisherDomain || 'unknown').toLowerCase()}|${digest}`;
}

function eventTitleWords(title = '') {
  return new Set(normalizeText(title).replace(/[.-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !EVENT_TITLE_STOPWORDS.has(word)));
}

function dateDistanceHours(left, right) {
  const a = new Date(left || 0).getTime();
  const b = new Date(right || 0).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || !a || !b) return null;
  return Math.abs(a - b) / (60 * 60 * 1000);
}

export function findLikelyPublishedStoryMatch({ title = '', publishedAt = '', facts = {} } = {}, publishedStories = []) {
  const words = eventTitleWords(title);
  if (words.size < 4 && Object.keys(facts).length === 0) return null;
  const numbers = new Set(normalizeText(title).match(/\b\d+(?:[.,]\d+)?\b/g) || []);

  const newEntities = new Set([
    ...(facts.people || []).map(normalizeText),
    ...(facts.places || []).map(normalizeText),
    ...(facts.organizations || []).map(normalizeText),
    ...(facts.teams || []).map(normalizeText),
    ...(facts.sportsTeams || []).map(normalizeText)
  ]);

  for (const story of publishedStories) {
    const ageDistance = dateDistanceHours(publishedAt, story.sourcePublishedAt || story.publishedAt);
    if (ageDistance === null || ageDistance > 48) continue;
    
    // Factual Deduplication
    if (newEntities.size > 0 && story.facts) {
      const existingEntities = new Set([
        ...(story.facts.people || []).map(normalizeText),
        ...(story.facts.places || []).map(normalizeText),
        ...(story.facts.organizations || []).map(normalizeText),
        ...(story.facts.teams || []).map(normalizeText),
        ...(story.facts.sportsTeams || []).map(normalizeText)
      ]);

      if (existingEntities.size > 0) {
         const intersection = [...newEntities].filter(e => existingEntities.has(e)).length;
         if (intersection >= 2) return story; // At least 2 critical entities match
      }
    }

    const otherWords = eventTitleWords(story.sourceTitle || story.title || '');
    if (otherWords.size < 4) continue;
    const intersection = [...words].filter((word) => otherWords.has(word)).length;
    const coverage = intersection / Math.min(words.size, otherWords.size);
    if (intersection < 4 || coverage < 0.4) continue;

    const otherNumbers = new Set(normalizeText(story.sourceTitle || story.title || '').match(/\b\d+(?:[.,]\d+)?\b/g) || []);
    if (assessPublishedStoryNovelty({ numbers, otherNumbers }).hasSubstantialNovelty) continue;
    return story;
  }
  return null;
}

export function assessPublishedStoryNovelty({ numbers = new Set(), otherNumbers = new Set() } = {}) {
  const left = numbers instanceof Set ? numbers : new Set(numbers || []);
  const right = otherNumbers instanceof Set ? otherNumbers : new Set(otherNumbers || []);
  if (left.size === 0 && right.size === 0) {
    return { hasSubstantialNovelty: false, reason: 'no-new-structured-fact' };
  }
  const sameNumbers = left.size === right.size && [...left].every((value) => right.has(value));
  if (sameNumbers) return { hasSubstantialNovelty: false, reason: 'same-numbers' };
  return { hasSubstantialNovelty: true, reason: 'changed-numbers' };
}

export function allocateAiBudget({ maxAi = 0, officialCandidates = 0, discoveryCandidates = 0, officialFraction = 0.5 } = {}) {
  const max = Math.max(0, Math.floor(Number(maxAi) || 0));
  const officialDemand = Math.max(0, Math.floor(Number(officialCandidates) || 0));
  const discoveryDemand = Math.max(0, Math.floor(Number(discoveryCandidates) || 0));
  const reservedOfficial = Math.min(officialDemand, Math.ceil(max * Math.max(0, Math.min(1, officialFraction))));
  let officialBudget = reservedOfficial;
  let discoveryBudget = Math.min(discoveryDemand, max - officialBudget);
  let remaining = max - officialBudget - discoveryBudget;

  const discoveryOverflow = Math.min(remaining, Math.max(0, discoveryDemand - discoveryBudget));
  discoveryBudget += discoveryOverflow;
  remaining -= discoveryOverflow;
  officialBudget += Math.min(remaining, Math.max(0, officialDemand - officialBudget));

  return { maxAi: max, officialBudget, discoveryBudget };
}

export function deriveEffectiveImportance(aiImportance = 5, newsworthiness = {}) {
  const current = Math.max(1, Math.min(10, Number(aiImportance) || 5));
  const territory = newsworthiness.territory || '';
  const magnitude = Number(newsworthiness.impactMagnitudeScore || 0);
  if (!['Nacionales', 'Mundo'].includes(territory) || magnitude < 18) return current;
  const score = Number(newsworthiness.newsworthinessScore || 0);
  const deterministicFloor = score >= 90 ? 9 : score >= 80 ? 8 : score >= 70 ? 7 : current;
  return Math.max(current, deterministicFloor);
}

export function classifyPipelineError(error) {
  const message = String(error?.message || error || 'unknown-error');
  if (/BLOCKED_FACTUAL_MISMATCH|FACT_CHECK_FAILED/i.test(message)) {
    return { retryable: false, reason: 'factual-validation' };
  }
  const httpStatus = Number(message.match(/HTTP\s+(\d{3})/i)?.[1] || 0);
  if (httpStatus && httpStatus < 500 && ![408, 409, 425, 429].includes(httpStatus)) {
    return { retryable: false, reason: `http-${httpStatus}` };
  }
  if (httpStatus === 429) return { retryable: true, reason: 'rate-limit' };
  if (httpStatus >= 500) return { retryable: true, reason: 'http-5xx' };
  if (/abort|timeout|timed out/i.test(message)) return { retryable: true, reason: 'timeout' };
  if (/JSON|estructura|fetch|network|socket|ECONN|ENOTFOUND/i.test(message)) return { retryable: true, reason: 'transient-provider' };
  return { retryable: true, reason: 'temporary-error' };
}

export function classifySourceValidationErrors(errors = []) {
  const recoverable = new Set(['short-body', 'weak-title', 'title-body-mismatch']);
  const reasons = [...new Set(errors.filter(Boolean))];
  return {
    retryable: reasons.length > 0 && reasons.every((reason) => recoverable.has(reason)),
    reasons
  };
}

export function buildRetryState({ previous = {}, error, stage = 'processing', now = Date.now(), maxAttempts = MAX_RETRY_ATTEMPTS, aiResult = null } = {}) {
  const classification = classifyPipelineError(error);
  const attempts = (Number(previous.attempts) || 0) + 1;
  const exhausted = !classification.retryable || attempts >= maxAttempts;
  const state = {
    status: exhausted ? 'failed-final' : 'failed-retryable',
    attempts,
    lastAttemptAt: new Date(now).toISOString(),
    lastError: String(error?.message || error || '').slice(0, 300),
    failureReason: classification.reason,
    resumeFrom: stage
  };
  if (!exhausted) state.nextRetryAt = getNextRetryAt(Math.max(0, attempts - 1), now);
  if (aiResult) state.aiResult = aiResult;
  return state;
}

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
  
  const norm = normalizeText(title);
  if (/(privacidad|publicidad|condiciones de uso|terms of service|pol[íi]tica de|cookie|legal|quienes somos|contacto)/.test(norm)) {
    return true;
  }
  
  const words = norm.match(/\b[a-z0-9]{4,}\b/g) || [];
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
  if (['published', 'duplicate', 'stale', 'failed-final'].includes(seenItem.status)) {
    return false;
  }
  if (![
    'draft',
    'extract-error',
    'model-error',
    'temporary-error',
    'pending-verification',
    'failed-retryable',
    'budget-deferred',
    'publication-deferred',
    'rescue-pending'
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
  extraSlotMinImportance = 8,
  dailyPublished = 0,
  dailyTargetMax = Infinity
} = {}) {
  const isUrgent = Number(importance) >= 9;
  if (isUrgent) return { ok: true, urgent: true, reason: 'urgent-outside-normal-cap' };
  if (Number.isFinite(dailyTargetMax) && dailyPublished >= dailyTargetMax) {
    return { ok: false, urgent: false, reason: 'daily-target-max' };
  }
  if (normalPublished >= maxNormal) return { ok: false, urgent: false, reason: 'max-normal-cap' };
  if (normalPublished >= target && Number(importance) < extraSlotMinImportance) {
    return { ok: false, urgent: false, reason: 'target-reached-low-importance' };
  }
  return { ok: true, urgent: false, reason: 'within-normal-cap' };
}

export function classifyCandidateFreshness({
  source = {},
  facts = {},
  pubDate = null,
  sourceHasDate = true,
  hasExplicitDate = false,
  now = Date.now()
} = {}) {
  const timestamp = pubDate ? new Date(pubDate).getTime() : NaN;
  const sourceMode = source.mode || '';
  const lane = facts.editorialLane || 'standard';

  if (!sourceHasDate || !Number.isFinite(timestamp)) {
    if (sourceMode === 'official-auto') return { ok: true, reason: 'official-undated', lane };
    return { ok: false, reason: 'undated-discovery', lane, bucket: 'quality' };
  }

  const ageMs = now - timestamp;
  if (ageMs < -6 * 60 * 60 * 1000) return { ok: false, reason: 'future-dated-source', lane, bucket: 'quality' };

  const maxAgeMs = lane === 'fast' ? INSTITUTIONAL_MAX_AGE_MS : HARD_NEWS_MAX_AGE_MS;
  if (ageMs <= maxAgeMs) return { ok: true, reason: lane === 'fast' ? 'fresh-institutional' : 'fresh-hard-news', lane };

  if (hasExplicitDate || ageMs > INSTITUTIONAL_MAX_AGE_MS) {
    return { ok: false, reason: 'evergreen-or-stale-outside-news-window', lane, bucket: 'evergreen' };
  }

  return { ok: false, reason: lane === 'fast' ? 'stale-institutional' : 'stale-hard-news', lane, bucket: 'quality' };
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
