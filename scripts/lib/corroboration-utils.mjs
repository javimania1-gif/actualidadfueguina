import { cleanText } from './news-utils.mjs';
import { extractFingerprint, normalizeText } from './pipeline-utils.mjs';
import { buildEventRecord, corroborateEvent, getEarthquakeSignature } from './factual-utils.mjs';
import { inferAgendaTerritory } from './editorial-agenda.mjs';

const LOCAL_TERRITORIES = new Set(['Rio Grande', 'Ushuaia', 'Tolhuin', 'Provincia', 'Malvinas', 'Antartida']);
const WORLD_TERRITORIES = new Set(['Mundo', 'Nacionales']);

function unique(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values.map((item) => cleanText(item)).filter(Boolean)) {
    const key = normalizeText(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function overlapCount(left = [], right = []) {
  const a = new Set(left.map(normalizeText).filter(Boolean));
  const b = new Set(right.map(normalizeText).filter(Boolean));
  return [...a].filter((value) => b.has(value)).length;
}

export function fingerprintOverlap(leftTitle = '', rightTitle = '') {
  const left = extractFingerprint(leftTitle).split('|').filter(Boolean);
  const right = extractFingerprint(rightTitle).split('|').filter(Boolean);
  return overlapCount(left, right);
}

function inferTerritory({ facts = {}, source = {}, category = '', title = '' } = {}) {
  return inferAgendaTerritory({ facts, source, category, title });
}

function localTermsForTerritory(territory, facts = {}) {
  if (!LOCAL_TERRITORIES.has(territory)) return [];
  if (territory === 'Provincia') return ['Tierra del Fuego'];
  if (territory === 'Malvinas') return ['Malvinas', 'Argentina'];
  if (territory === 'Antartida') return ['Antartida Argentina'];
  const places = facts.places || [];
  return unique([...places, territory]).slice(0, 2);
}

function eventTerms(eventType = '', title = '') {
  const normalizedTitle = normalizeText(title);
  if (eventType === 'sports-result') {
    return unique([
      normalizedTitle.includes('mundial') ? 'Mundial' : '',
      'resultado'
    ]);
  }
  if (eventType === 'election') return ['elecciones', 'resultado'];
  if (eventType === 'international-conflict') return ['conflicto'];
  if (eventType === 'legal-policy') return normalizedTitle.includes('reforma') ? ['reforma constitucional'] : [];
  return [];
}

export function buildCorroborationQuery(base = {}, score = {}) {
  const facts = base.facts || {};
  const title = base.title || facts.title || base.article?.title || base.item?.title || '';
  const territory = score.territory || inferTerritory({
    facts,
    source: base.source,
    category: base.source?.forceCategory || base.source?.defaultCategory || '',
    title
  });
  const titleWords = extractFingerprint(title)
    .split('|')
    .filter((word) => word.length > 4)
    .slice(0, 6);
  const teams = facts.sportsTeams || facts.teams || [];
  const coreEntities = [
    ...(facts.people || []),
    ...(facts.organizations || []),
    ...(facts.countries || []),
    ...teams
  ].slice(0, 5);
  const localTerms = localTermsForTerritory(territory, facts);
  const parts = [
    ...coreEntities,
    ...eventTerms(facts.eventType || 'general', title),
    ...localTerms,
    ...titleWords
  ];
  return unique(parts).join(' ').slice(0, 180);
}

function compatibleTerritory(left, right) {
  if (!left || !right || left === 'unknown' || right === 'unknown') return true;
  if (left === right) return true;
  if (left === 'Provincia' && LOCAL_TERRITORIES.has(right)) return true;
  if (right === 'Provincia' && LOCAL_TERRITORIES.has(left)) return true;
  if (WORLD_TERRITORIES.has(left) && WORLD_TERRITORIES.has(right)) return true;
  return false;
}

function compatibleEventType(left = 'general', right = 'general') {
  if (left === right) return true;
  if (left === 'general' || right === 'general') return true;
  if (left === 'service' && right === 'agenda') return true;
  if (left === 'agenda' && right === 'service') return true;
  return false;
}

export function isCompatibleCorroboration(base = {}, candidate = {}, existingDomains = new Set()) {
  const domain = candidate.sourceRef?.publisherDomain || '';
  if (!domain || existingDomains.has(domain)) return false;
  const baseFacts = base.facts || {};
  const candidateFacts = candidate.facts || {};
  const baseType = baseFacts.eventType || 'general';
  const candidateType = candidateFacts.eventType || 'general';
  if (!compatibleEventType(baseType, candidateType)) return false;

  const baseTitle = base.title || baseFacts.title || '';
  const candidateTitle = candidate.title || candidateFacts.title || '';
  const titleOverlap = fingerprintOverlap(baseTitle, candidateTitle);
  const entityOverlap =
    overlapCount(baseFacts.organizations, candidateFacts.organizations) +
    overlapCount(baseFacts.people, candidateFacts.people) +
    overlapCount(baseFacts.places, candidateFacts.places) +
    overlapCount(baseFacts.countries, candidateFacts.countries) +
    overlapCount(baseFacts.sportsTeams || baseFacts.teams, candidateFacts.sportsTeams || candidateFacts.teams);

  const baseTerritory = inferTerritory({ facts: baseFacts, source: base.source, title: baseTitle });
  const candidateTerritory = inferTerritory({ facts: candidateFacts, source: candidate.source, title: candidateTitle });
  if (!compatibleTerritory(baseTerritory, candidateTerritory) && titleOverlap < 3 && entityOverlap < 2) return false;
  return titleOverlap >= 2 || entityOverlap > 0;
}

function ageHours(dateValue, now = new Date()) {
  const date = dateValue ? new Date(dateValue) : null;
  if (!date || Number.isNaN(date.getTime())) return 72;
  return Math.max(0, (new Date(now).getTime() - date.getTime()) / (60 * 60 * 1000));
}

export function scoreCorroborationPriority({ base = {}, verification = {}, newsworthiness = {}, existingEvent = {}, now = new Date() } = {}) {
  const territory = newsworthiness.territory || inferTerritory({
    facts: base.facts || {},
    source: base.source,
    category: base.source?.forceCategory || base.source?.defaultCategory || '',
    title: base.title || ''
  });
  const age = ageHours(base.pubDate || base.article?.date || existingEvent.lastSeenAt, now);
  const pendingAge = ageHours(existingEvent.firstDetectedAt || existingEvent.lastSeenAt || base.pubDate, now);
  const freshnessScore = age <= 6 ? 18 : age <= 24 ? 14 : age <= 36 ? 10 : age <= 72 ? 5 : 0;
  const territoryScore = ['Rio Grande', 'Ushuaia', 'Tolhuin'].includes(territory) ? 16 : LOCAL_TERRITORIES.has(territory) ? 13 : territory === 'Nacionales' ? 7 : territory === 'Mundo' ? 5 : 1;
  const impactScore = Math.round(((newsworthiness.publicInterestScore || 0) + (newsworthiness.serviceValueScore || 0)) / 2);
  const corroborabilityScore = (base.facts?.people?.length || base.facts?.organizations?.length || base.facts?.countries?.length || base.facts?.places?.length) > 0 ? 10 : 4;
  const attempts = Number(existingEvent.corroborationAttempts || 0);
  const retryScore = Math.max(0, 8 - attempts * 2);
  const pendingAgeScore = Math.min(8, Math.floor(pendingAge / 6));
  const score = Math.round(
    (newsworthiness.newsworthinessScore || 0) * 0.45 +
    freshnessScore +
    territoryScore +
    impactScore +
    corroborabilityScore +
    pendingAgeScore +
    retryScore
  );
  const reasons = [
    `newsworthiness=${newsworthiness.newsworthinessScore || 0}`,
    `freshness=${Math.round(age)}h`,
    `territory=${territory}`,
    `impact=${impactScore}`,
    `corroborability=${corroborabilityScore}`,
    `pendingAge=${Math.round(pendingAge)}h`,
    `attempts=${attempts}`
  ];
  return { score, territory, reasons };
}

function factsFromRecord(record = {}) {
  return record.verifiedFacts || record.consensusFacts || record.factsBySource?.[0]?.facts || {};
}

function titlesFromRecord(record = {}) {
  return (record.factsBySource || []).map((entry) => entry.facts?.title || '').filter(Boolean);
}

function earthquakeSignatureKey(record = {}) {
  const signature = getEarthquakeSignature({
    facts: factsFromRecord(record),
    title: titlesFromRecord(record).join(' '),
    sourceRef: record.sources?.[0] || {}
  });
  return signature ? ['earthquake', signature.magnitude, signature.date, signature.location].join('|') : '';
}

function sameEarthquakeEvent(left = {}, right = {}) {
  const leftSignature = getEarthquakeSignature(left);
  const rightSignature = getEarthquakeSignature(right);
  if (!leftSignature || !rightSignature) return false;
  return leftSignature.magnitude === rightSignature.magnitude
    && leftSignature.date === rightSignature.date
    && leftSignature.location === rightSignature.location;
}

function uniqueBy(items = [], keyFn = (item) => JSON.stringify(item)) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function recordCandidates(record = {}) {
  return (record.factsBySource || []).map((entry) => {
    const sourceRef = (record.sources || []).find((source) =>
      (entry.url && source.url === entry.url) ||
      (entry.publisherDomain && source.publisherDomain === entry.publisherDomain)
    ) || {};
    return {
      facts: {
        ...(entry.facts || {}),
        riskLevel: entry.facts?.riskLevel || record.riskLevel,
        editorialLane: entry.facts?.editorialLane || record.editorialLane
      },
      sourceRef: {
        ...sourceRef,
        publisherDomain: entry.publisherDomain || sourceRef.publisherDomain || '',
        url: entry.url || sourceRef.url || ''
      }
    };
  }).filter((candidate) => candidate.facts && candidate.sourceRef.publisherDomain);
}

function mergePendingRecord(target = {}, incoming = {}) {
  target.sources = uniqueBy([...(target.sources || []), ...(incoming.sources || [])], (source) => source.url || source.publisherDomain);
  target.factsBySource = uniqueBy([...(target.factsBySource || []), ...(incoming.factsBySource || [])], (entry) => entry.url || entry.publisherDomain);
  target.publisherDomains = unique([...(target.publisherDomains || []), ...(incoming.publisherDomains || [])]);
  target.firstDetectedAt = [target.firstDetectedAt, incoming.firstDetectedAt].filter(Boolean).sort()[0] || target.firstDetectedAt || incoming.firstDetectedAt;
  target.lastSeenAt = [target.lastSeenAt, incoming.lastSeenAt].filter(Boolean).sort().at(-1) || target.lastSeenAt || incoming.lastSeenAt;
  target.lastAttemptAt = [target.lastAttemptAt, incoming.lastAttemptAt].filter(Boolean).sort().at(-1) || target.lastAttemptAt || incoming.lastAttemptAt;
  target.expiresAt = [target.expiresAt, incoming.expiresAt].filter(Boolean).sort().at(-1) || target.expiresAt || incoming.expiresAt;
  return target;
}

export function terminalizeExpiredPendingEvents(records = {}, { now = new Date(), maxAttempts = 4 } = {}) {
  const nowMs = new Date(now).getTime();
  let expired = 0;
  let attemptsExhausted = 0;
  for (const record of Object.values(records || {})) {
    if (record.status !== 'pending-verification') continue;
    const expiresAt = new Date(record.expiresAt || 0).getTime();
    const exhausted = (Number(record.corroborationAttempts) || 0) >= maxAttempts;
    const timedOut = Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= nowMs;
    if (!timedOut && !exhausted) continue;
    record.status = 'rejected-terminal';
    record.terminalReason = timedOut ? 'pending-verification-expired' : 'corroboration-attempts-exhausted';
    record.resolvedAt = new Date(nowMs).toISOString();
    record.nextRetryAt = null;
    if (timedOut) expired++;
    else attemptsExhausted++;
  }
  return { changed: expired + attemptsExhausted > 0, expired, attemptsExhausted };
}

export function selectPendingRecoverySources(records = {}, { now = new Date(), max = 4, maxAttempts = 4 } = {}) {
  const nowMs = new Date(now).getTime();
  const lanePriority = { fast: 3, standard: 2, strict: 1 };
  return Object.entries(records || {})
    .filter(([, record]) => record.status === 'pending-verification')
    .filter(([, record]) => (Number(record.corroborationAttempts) || 0) < maxAttempts)
    .filter(([, record]) => !record.expiresAt || new Date(record.expiresAt).getTime() > nowMs)
    .filter(([, record]) => !record.nextRetryAt || new Date(record.nextRetryAt).getTime() <= nowMs)
    .map(([eventKey, record]) => ({
      eventKey,
      record,
      sourceRef: (record.sources || [])
        .filter((source) => source?.url)
        .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))[0] || null
    }))
    .filter((item) => item.sourceRef)
    .sort((a, b) => {
      const lane = (lanePriority[b.record.editorialLane] || 0) - (lanePriority[a.record.editorialLane] || 0);
      if (lane !== 0) return lane;
      return String(b.record.lastSeenAt || '').localeCompare(String(a.record.lastSeenAt || ''));
    })
    .slice(0, Math.max(0, Number(max) || 0));
}

export function compactEquivalentPendingEvents(records = {}) {
  const canonicalBySignature = new Map();
  const changedKeys = new Set();
  let merged = 0;
  let verified = 0;

  for (const [eventKey, record] of Object.entries(records || {})) {
    if (record.status !== 'pending-verification') continue;
    const signatureKey = earthquakeSignatureKey(record);
    if (!signatureKey) continue;
    const canonicalKey = canonicalBySignature.get(signatureKey);
    if (!canonicalKey) {
      canonicalBySignature.set(signatureKey, eventKey);
      continue;
    }
    records[canonicalKey] = mergePendingRecord(records[canonicalKey], record);
    delete records[eventKey];
    changedKeys.add(canonicalKey);
    merged++;
  }

  for (const eventKey of changedKeys) {
    const record = records[eventKey];
    const candidates = recordCandidates(record);
    if (candidates.length < 2) continue;
    const verification = corroborateEvent({ eventKey, candidates });
    records[eventKey] = {
      ...buildEventRecord({ existing: record, eventKey, candidates, verification }),
      publishedAt: record.publishedAt || null,
      publishedFile: record.publishedFile || ''
    };
    if (verification.verified) verified++;
  }

  return { changed: merged > 0, merged, verified };
}

export function findMatchingPendingEventKeyInRecords({ records = {}, eventKey, facts = {}, title = '', sourceRef = {}, now = new Date() } = {}) {
  if (records?.[eventKey]?.status === 'pending-verification') return eventKey;
  const nowMs = new Date(now).getTime();
  const candidateTerritory = inferTerritory({ facts, title });
  for (const [existingKey, record] of Object.entries(records || {})) {
    if (record.status !== 'pending-verification') continue;
    if (record.expiresAt && new Date(record.expiresAt).getTime() < nowMs) continue;
    const existingDomains = new Set(record.publisherDomains || []);
    if (sourceRef.publisherDomain && existingDomains.has(sourceRef.publisherDomain)) continue;

    const existingFacts = factsFromRecord(record);
    if (!compatibleEventType(existingFacts.eventType || 'general', facts.eventType || 'general')) continue;
    const existingTerritory = inferTerritory({ facts: existingFacts, title: titlesFromRecord(record).join(' ') });
    if (!compatibleTerritory(candidateTerritory, existingTerritory)) continue;

    const titles = titlesFromRecord(record);
    const earthquakeCandidate = { facts, title, sourceRef };
    const earthquakeExisting = { facts: existingFacts, title: titles.join(' '), sourceRef: record.sources?.[0] || {} };
    const hasEarthquakeSignature = getEarthquakeSignature(earthquakeCandidate) || getEarthquakeSignature(earthquakeExisting);
    if (hasEarthquakeSignature) {
      if (sameEarthquakeEvent(earthquakeCandidate, earthquakeExisting)) return existingKey;
      continue;
    }

    const titleMatch = titles.some((existingTitle) => fingerprintOverlap(title, existingTitle) >= 2);
    const entityOverlap =
      overlapCount(facts.organizations, existingFacts.organizations) +
      overlapCount(facts.people, existingFacts.people) +
      overlapCount(facts.places, existingFacts.places) +
      overlapCount(facts.countries, existingFacts.countries) +
      overlapCount(facts.sportsTeams || facts.teams, existingFacts.sportsTeams || existingFacts.teams);

    if ((facts.eventType || existingFacts.eventType) === 'sports-result') {
      const teamsOverlap = overlapCount(facts.sportsTeams || facts.teams, existingFacts.sportsTeams || existingFacts.teams);
      if (teamsOverlap >= 2 && titleMatch) return existingKey;
      continue;
    }

    if (titleMatch && entityOverlap > 0) return existingKey;
    if (entityOverlap >= 2 && fingerprintOverlap(title, titles.join(' ')) >= 1) return existingKey;
  }
  return eventKey;
}
