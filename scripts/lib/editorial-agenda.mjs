import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, cleanText } from './news-utils.mjs';
import { normalizeText } from './pipeline-utils.mjs';
import { SOURCE_TIERS, countIndependentEditorialSources } from './source-policy.mjs';

export const EDITORIAL_AGENDA_PATH = path.join(ROOT, 'data/editorial-agenda.json');

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

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

function asDate(value, fallback = new Date()) {
  const date = value ? new Date(value) : new Date(fallback);
  return Number.isFinite(date.getTime()) ? date : new Date(fallback);
}

function hoursOld(value, now = new Date()) {
  return Math.max(0, (asDate(now).getTime() - asDate(value, now).getTime()) / (60 * 60 * 1000));
}

function freshnessFromHours(ageHours, lane = 'standard') {
  if (ageHours <= 6) return { bucket: 'breaking', score: 15 };
  if (ageHours <= 24) return { bucket: 'today', score: 12 };
  if (ageHours <= 36) return { bucket: 'recent-hard-news', score: 9 };
  if (ageHours <= 72 && lane === 'fast') return { bucket: 'useful-institutional', score: 7 };
  if (ageHours <= 72) return { bucket: 'recent-context', score: 5 };
  return { bucket: 'stale-or-evergreen', score: 1 };
}

function hasAny(text, words = []) {
  const normalized = normalizeText(text);
  return words.some((word) => new RegExp(`\\b${normalizeText(word)}\\b`).test(normalized));
}

function factText(facts = {}, title = '', category = '') {
  return [
    title,
    category,
    facts.rawSummary,
    ...(facts.people || []),
    ...(facts.organizations || []),
    ...(facts.places || []),
    ...(facts.countries || []),
    ...(facts.sportsTeams || facts.teams || [])
  ].join(' ');
}

export function inferAgendaTopic({ facts = {}, title = '', category = '' } = {}) {
  const eventType = facts.eventType || 'general';
  const text = factText(facts, title, category);
  if (eventType === 'sports-result' || hasAny(text, ['deportes', 'futbol', 'mundial', 'club'])) return 'deportes';
  if (eventType === 'crime') return 'policiales';
  if (['international-conflict', 'territorial-sovereignty', 'defense'].includes(eventType)) return 'politica';
  if (eventType === 'weather' || eventType === 'weather-forecast' || eventType === 'service') return 'servicios';
  if (eventType === 'agenda') return 'agenda';
  if (eventType === 'election' || eventType === 'legislative' || eventType === 'legal-policy') return 'politica';
  if (eventType === 'casualty') return 'sociedad';
  if (hasAny(text, ['economia', 'dolar', 'inflacion', 'tarifa', 'salario', 'paritaria', 'presupuesto', 'fisco'])) return 'economia';
  if (hasAny(text, ['salud', 'hospital', 'vacuna', 'medico', 'sanitaria'])) return 'salud';
  if (hasAny(text, ['educacion', 'escuela', 'universidad', 'beca', 'curso', 'capacitacion'])) return 'educacion';
  if (hasAny(text, ['turismo', 'invierno', 'cerro castor', 'hotel', 'aeropuerto'])) return 'turismo';
  if (hasAny(text, ['fiesta', 'festival', 'musica', 'cultura', 'pena', 'muestra'])) return 'cultura';
  return 'sociedad';
}

export function inferAgendaTerritory({ facts = {}, source = {}, category = '', title = '' } = {}) {
  const text = normalizeText([
    category,
    source.defaultCategory,
    source.location,
    title,
    facts.rawSummary,
    ...(facts.places || []),
    ...(facts.countries || [])
  ].join(' '));
  if (/\brio grande\b/.test(text)) return 'Rio Grande';
  if (/\bushuaia\b/.test(text)) return 'Ushuaia';
  if (/\btolhuin\b/.test(text)) return 'Tolhuin';
  if (/\bmalvinas\b/.test(text)) return 'Malvinas';
  if (/\bantartida\b/.test(text)) return 'Antartida';
  if (/\btierra del fuego\b|\bfueguin/.test(text)) return 'Provincia';
  if (/\b(cdmx|mexico|mexico df|colombia|cuba|iran|teheran|moscu|ucrania|rusia|estados unidos|reino unido|inglaterra|francia|alemania|italia|brasil|chile|uruguay|paraguay|bolivia|peru|venezuela)\b/.test(text)) return 'Mundo';
  if (/\bmundo\b|\binternacional\b/.test(text)) return 'Mundo';
  if (/\b(nacionales|argentina|milei|fmi|villa allende|chaco|cordoba|buenos aires|congreso|senado|diputados)\b/.test(text)) return 'Nacionales';
  if (/\bprovincia\b/.test(text) && (source.mode === 'official-auto' || /\b(provincial|gobierno|tdf)\b/.test(text))) return 'Provincia';
  return 'unknown';
}

function inferSubtopic({ topic, facts = {}, title = '', category = '' }) {
  const text = factText(facts, title, category);
  if (topic === 'servicios' && hasAny(text, ['clima', 'pronostico', 'alerta meteorologica'])) return 'clima';
  if (topic === 'servicios' && hasAny(text, ['ruta', 'vuelo', 'transporte', 'corte'])) return 'movilidad';
  if (topic === 'agenda' && hasAny(text, ['curso', 'inscripcion', 'capacitacion'])) return 'inscripciones';
  if (topic === 'agenda' && hasAny(text, ['fiesta', 'festival', 'pena', 'musica'])) return 'cultura';
  if (topic === 'politica' && hasAny(text, ['reforma constitucional', 'eleccion', 'legislatura'])) return 'institucional';
  if (topic === 'economia' && hasAny(text, ['fisco', 'demanda', 'millones', 'tarifa'])) return 'finanzas-publicas';
  return topic;
}

function scorePublicInterest({ facts = {}, topic = '', eventType = '' }) {
  let score = 8;
  if (['election', 'crime', 'legal-policy', 'legislative', 'casualty', 'weather'].includes(eventType)) score = 20;
  else if (topic === 'servicios') score = 18;
  else if (topic === 'politica' || topic === 'economia' || topic === 'salud') score = 17;
  else if (topic === 'agenda' || topic === 'turismo') score = 12;
  if ((facts.casualties || []).length) score += 5;
  if ((facts.money || []).length || (facts.percentages || []).length) score += 3;
  if ((facts.laws || []).length) score += 3;
  return clamp(score, 0, 25);
}

function scoreLocalRelevance(territory) {
  if (['Rio Grande', 'Ushuaia', 'Tolhuin'].includes(territory)) return 25;
  if (['Provincia', 'Malvinas', 'Antartida'].includes(territory)) return 22;
  if (territory === 'Nacionales') return 12;
  if (territory === 'Mundo') return 7;
  return 4;
}

function scoreServiceValue({ topic = '', eventType = '', facts = {} }) {
  let score = 0;
  if (topic === 'servicios' || eventType === 'weather-forecast') score = 20;
  else if (topic === 'agenda') score = 17;
  else if (['salud', 'educacion', 'turismo'].includes(topic)) score = 12;
  if ((facts.dates || []).length || (facts.times || []).length) score += 3;
  return clamp(score, 0, 20);
}

function scoreSocialPotential({ topic = '', facts = {}, territory = '' }) {
  let score = 4;
  if (['Rio Grande', 'Ushuaia', 'Tolhuin'].includes(territory)) score += 4;
  if (['deportes', 'cultura', 'turismo', 'agenda'].includes(topic)) score += 5;
  if ((facts.people || []).length || (facts.sportsTeams || facts.teams || []).length) score += 3;
  return clamp(score, 0, 15);
}

function scoreSearchPotential({ topic = '', facts = {}, territory = '' }) {
  let score = 5;
  if (['servicios', 'agenda', 'turismo', 'salud', 'educacion'].includes(topic)) score += 5;
  if (['Nacionales', 'Mundo'].includes(territory)) score += 2;
  if ((facts.places || []).length || (facts.organizations || []).length) score += 3;
  return clamp(score, 0, 15);
}

function sourceScore(sourceRefs = []) {
  const tiers = new Set(sourceRefs.map((ref) => ref?.tier).filter(Boolean));
  let score = 0;
  if (tiers.has(SOURCE_TIERS.A)) score += 8;
  score += Math.min(6, countIndependentEditorialSources(sourceRefs) * 3);
  score += Math.min(4, Math.max(0, sourceRefs.length - 1) * 2);
  return clamp(score, 0, 15);
}

function sourceRefsFromCandidate(candidate = {}) {
  const related = candidate.relatedCandidates?.length ? candidate.relatedCandidates : [candidate];
  return related.map((item) => item.sourceRef).filter(Boolean);
}

function candidateFacts(candidate = {}, verification = {}) {
  return verification.verifiedFacts || candidate.verification?.verifiedFacts || candidate.facts || {};
}

export function scoreCandidateNewsworthiness(candidate = {}, { verification = {}, byCategory = {}, now = new Date() } = {}) {
  const facts = candidateFacts(candidate, verification);
  const sourceRefs = sourceRefsFromCandidate(candidate);
  const source = candidate.source || {};
  const category = source.forceCategory || source.defaultCategory || '';
  const title = candidate.title || candidate.article?.title || candidate.item?.title || facts.title || '';
  const topic = inferAgendaTopic({ facts, title, category });
  const subtopic = inferSubtopic({ topic, facts, title, category });
  const territory = inferAgendaTerritory({ facts, source, category, title });
  const eventType = facts.eventType || 'general';
  const lane = verification.editorialLane || candidate.verification?.editorialLane || facts.editorialLane || 'standard';
  const freshness = freshnessFromHours(hoursOld(candidate.pubDate || candidate.article?.date || now, now), lane);
  const publicInterestScore = scorePublicInterest({ facts, topic, eventType });
  const localRelevanceScore = scoreLocalRelevance(territory);
  const serviceValueScore = scoreServiceValue({ topic, eventType, facts });
  const socialPotentialScore = scoreSocialPotential({ topic, facts, territory });
  const searchPotentialScore = scoreSearchPotential({ topic, facts, territory });
  const sourceStrengthScore = sourceScore(sourceRefs);
  const diversityBonus = byCategory[category] ? 0 : 4;
  let newsworthinessScore = Math.round(
    publicInterestScore +
    localRelevanceScore +
    serviceValueScore +
    socialPotentialScore +
    searchPotentialScore +
    freshness.score +
    sourceStrengthScore +
    diversityBonus
  );
  if (territory === 'Mundo' && publicInterestScore < 18) newsworthinessScore = Math.min(newsworthinessScore - 8, 55);
  if (territory === 'Nacionales' && publicInterestScore < 16) newsworthinessScore = Math.min(newsworthinessScore - 4, 60);
  newsworthinessScore = clamp(newsworthinessScore);

  return {
    topic,
    subtopic,
    territory,
    freshness: freshness.bucket,
    sourceCount: sourceRefs.length,
    independentPublisherCount: countIndependentEditorialSources(sourceRefs),
    sourceTiers: unique(sourceRefs.map((ref) => ref.tier)),
    publicInterestScore,
    localRelevanceScore,
    serviceValueScore,
    socialPotentialScore,
    searchPotentialScore,
    sourceStrengthScore,
    recencyScore: freshness.score,
    scoreBreakdown: {
      publicInterest: publicInterestScore,
      localRelevance: localRelevanceScore,
      serviceValue: serviceValueScore,
      socialPotential: socialPotentialScore,
      searchPotential: searchPotentialScore,
      recency: freshness.score,
      sourceStrength: sourceStrengthScore,
      diversity: diversityBonus
    },
    newsworthinessScore
  };
}

function factsFromEvent(event = {}) {
  return event.verifiedFacts || event.consensusFacts || event.factsBySource?.[0]?.facts || {};
}

function headlineSeedFromEvent(event = {}, candidate = null) {
  return cleanText(
    candidate?.title ||
    candidate?.article?.title ||
    event.factsBySource?.[0]?.facts?.title ||
    event.verifiedFacts?.title ||
    ''
  );
}

export function buildAgendaStory({ eventKey = '', event = {}, candidate = null, now = new Date(), byCategory = {} } = {}) {
  const facts = factsFromEvent(event);
  const sourceRefs = event.sources?.length ? event.sources : sourceRefsFromCandidate(candidate || {});
  const firstSource = sourceRefs[0] || {};
  const headlineSeed = headlineSeedFromEvent(event, candidate);
  const source = {
    id: firstSource.sourceId || '',
    name: firstSource.sourceName || '',
    mode: firstSource.sourceMode || '',
    defaultCategory: '',
    location: ''
  };
  const score = candidate
    ? scoreCandidateNewsworthiness(candidate, { verification: candidate.verification || {}, byCategory, now })
    : scoreCandidateNewsworthiness({
      title: headlineSeed,
      facts,
      source,
      sourceRef: firstSource,
      pubDate: event.lastSeenAt || now
    }, { byCategory, now });
  const primaryEntities = unique([
    ...(facts.people || []),
    ...(facts.organizations || []),
    ...(facts.sportsTeams || facts.teams || []),
    ...(facts.places || []),
    ...(facts.countries || [])
  ]).slice(0, 10);

  const story = {
    storyId: eventKey,
    headlineSeed,
    topic: score.topic,
    subtopic: score.subtopic,
    territory: score.territory,
    primaryEntities,
    eventType: facts.eventType || 'general',
    firstSeenAt: event.firstDetectedAt || event.lastSeenAt || null,
    lastSeenAt: event.lastSeenAt || null,
    sourceCount: sourceRefs.length,
    independentPublisherCount: countIndependentEditorialSources(sourceRefs),
    sourceTiers: unique(sourceRefs.map((ref) => ref.tier)),
    editorialLane: event.editorialLane || facts.editorialLane || 'standard',
    freshness: score.freshness,
    publicInterestScore: score.publicInterestScore,
    localRelevanceScore: score.localRelevanceScore,
    serviceValueScore: score.serviceValueScore,
    socialPotentialScore: score.socialPotentialScore,
    searchPotentialScore: score.searchPotentialScore,
    scoreBreakdown: score.scoreBreakdown,
    newsworthinessScore: score.newsworthinessScore,
    status: event.status || 'unknown'
  };
  const validation = validateAgendaStoryCoherence(story);
  if (!validation.ok) {
    story.sourceStatus = story.status;
    story.status = 'agenda-invalid';
    story.validationReasons = validation.reasons;
  } else {
    story.validationReasons = [];
  }
  return story;
}

export function validateAgendaStoryCoherence(story = {}) {
  const reasons = [];
  const eventType = story.eventType || 'general';
  const topic = story.topic || '';
  const territory = story.territory || '';
  const text = normalizeText([
    story.storyId,
    story.headlineSeed,
    topic,
    territory,
    ...(story.primaryEntities || [])
  ].join(' '));

  if (eventType === 'high-risk') reasons.push('eventtype-risk-confusion');
  const weatherKey = story.storyId?.startsWith('weather|') || story.storyId?.startsWith('weather-forecast|');
  const weatherHeadline = /\b(clima|pronostico|meteorologico|temperatura|viento|nieve|lluvia|alerta|sismo|temblor|epicentro|magnitud|temporal)\b/.test(text);
  const sovereigntyHeadline = /\b(buque|fragata|hms|britanic|reino unido|malvinas|soberania|aguas territoriales)\b/.test(text);

  if (story.storyId?.startsWith('weather-forecast|') && eventType !== 'weather-forecast') {
    reasons.push('story-headline-mismatch');
  }
  if (weatherKey && (!weatherHeadline || sovereigntyHeadline)) {
    reasons.push('story-headline-mismatch');
  }
  if (topic === 'servicios' && ['crime', 'election', 'legal-policy', 'international-conflict', 'territorial-sovereignty', 'defense', 'casualty'].includes(eventType)) {
    reasons.push('topic-event-mismatch');
  }
  if (topic === 'servicios' && sovereigntyHeadline) reasons.push('topic-event-mismatch');
  if (eventType === 'weather' && sovereigntyHeadline) reasons.push('topic-event-mismatch');
  if (eventType === 'crime' && topic !== 'policiales') reasons.push('topic-event-mismatch');
  if (eventType === 'international-conflict' && territory !== 'Mundo') reasons.push('territory-conflict');
  if (territory === 'Provincia' && /\b(cdmx|mexico|colombia|cuba|iran|teheran|moscu|ucrania|rusia|fmi|milei|villa allende|chaco|cordoba)\b/.test(text)) {
    reasons.push('foreign-story-local-territory');
  }
  if (territory === 'unknown' && story.newsworthinessScore >= 70) reasons.push('territory-conflict');

  return { ok: reasons.length === 0, reasons: unique(reasons) };
}

function countBy(stories = [], field) {
  const out = {};
  for (const story of stories) {
    const key = story[field] || 'unknown';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

export function buildEditorialAgenda(events = {}, { verifiedCandidates = [], metrics = {}, now = new Date() } = {}) {
  const candidateByKey = new Map();
  for (const candidate of verifiedCandidates) {
    if (candidate.eventKey && !candidateByKey.has(candidate.eventKey)) candidateByKey.set(candidate.eventKey, candidate);
  }
  const stories = Object.entries(events.events || {}).map(([eventKey, event]) =>
    buildAgendaStory({
      eventKey,
      event,
      candidate: candidateByKey.get(eventKey) || null,
      now,
      byCategory: metrics.byCategory || {}
    })
  ).filter((story) => story.headlineSeed || story.primaryEntities.length);

  stories.sort((a, b) => {
    const score = (b.newsworthinessScore || 0) - (a.newsworthinessScore || 0);
    if (score !== 0) return score;
    return String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || ''));
  });
  const rankableStories = stories.filter((story) => story.status !== 'agenda-invalid');

  return {
    version: 1,
    generatedAt: asDate(now).toISOString(),
    summary: {
      totalStories: stories.length,
      byStatus: countBy(stories, 'status'),
      byTopic: countBy(stories, 'topic'),
      byTerritory: countBy(stories, 'territory'),
      invalidStories: stories.filter((story) => story.status === 'agenda-invalid').length,
      topStories: rankableStories.slice(0, 10).map((story) => ({
        storyId: story.storyId,
        headlineSeed: story.headlineSeed,
        topic: story.topic,
        territory: story.territory,
        newsworthinessScore: story.newsworthinessScore,
        status: story.status,
        scoreBreakdown: story.scoreBreakdown
      }))
    },
    stories: stories.slice(0, 300)
  };
}

export async function saveEditorialAgenda(agenda) {
  await fs.mkdir(path.dirname(EDITORIAL_AGENDA_PATH), { recursive: true });
  await fs.writeFile(EDITORIAL_AGENDA_PATH, JSON.stringify(agenda, null, 2) + '\n', 'utf8');
}
