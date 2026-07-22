import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, cleanText } from './news-utils.mjs';
import { normalizeText } from './pipeline-utils.mjs';
import { SOURCE_TIERS, countIndependentEditorialSources } from './source-policy.mjs';
import { resolvePublicationTerritory } from './territory-resolver.mjs';

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

const LOCAL_TERRITORIES = new Set(['Rio Grande', 'Ushuaia', 'Tolhuin', 'Provincia', 'Malvinas', 'Antartida']);
const COMMUNITY_TOPICS = new Set(['deportes', 'cultura', 'agenda', 'educacion']);

function opportunityText({ facts = {}, title = '', category = '', source = {} } = {}) {
  return normalizeText([
    factText(facts, title, category),
    source.id,
    source.name,
    source.editorialFocus,
    ...(source.specialties || [])
  ].filter(Boolean).join(' '));
}

export function analyzeEditorialOpportunity({
  facts = {},
  title = '',
  category = '',
  source = {},
  topic = '',
  territory = '',
  impactMagnitudeScore = 0,
  socialPotentialScore = 0
} = {}) {
  const text = opportunityText({ facts, title, category, source });
  const eventText = normalizeText(factText(facts, title, category));
  const headlineText = normalizeText(title);
  const local = LOCAL_TERRITORIES.has(territory);
  const explicitLocalSignal = /\b(rio grande|ushuaia|tolhuin|tierra del fuego|fueguin)\b/.test(eventText);
  const namedCommunity = (facts.people || []).length > 0 ||
    (facts.organizations || []).length > 0 ||
    (facts.sportsTeams || facts.teams || []).length > 0;
  const communitySource = source.communitySource === true;
  const localCommunity = local && (communitySource || explicitLocalSignal);
  const communityTopic = COMMUNITY_TOPICS.has(topic);
  const youthOrVeterans = /\b(c ?13|c ?15|sub ?13|sub ?15|juvenil|infantil|veteran|femenin|formativas?)\b/.test(text);
  const tournament = /\b(nacional|patagonico|torneo|campeonato|liga|copa|fixture|fecha|semifinal|final|resultado|posiciones)\b/.test(text);
  const localSport = topic === 'deportes' && /\b(futsal|club|seleccion|liga|equipo|jugador|jugadora)\b/.test(text);
  const localCompetition = explicitLocalSignal && /\b(futsal|liga local|torneo local|club fueguino|club de rio grande|seleccion de rio grande|hockey|handball|basquet local)\b/.test(eventText);
  const emergingVoice = /\b(artista|musico|musica|banda|cantante|escritor|emprendedor|deportista|investigador|estudiante|proyecto cultural)\b/.test(text);
  const dataInstitution = /\b(indec|ipc|emae|ripte|canasta basica|estadisticas? oficiales?|indice de precios)\b/.test(text);
  const economicData = /\b(inflacion|salarios?|jubilaciones?|tarifas?|empleo|desempleo|pobreza|actividad economica|poder adquisitivo)\b/.test(text);
  const hasNumbers = (facts.percentages || []).length > 0 || (facts.money || []).length > 0 || (facts.numbers || []).length >= 2;
  const qualifiedDataExplainer = dataInstitution || (topic === 'economia' && economicData && hasNumbers && territory !== 'Mundo');
  const contrastConnector = /\b(mientras|al mismo tiempo|en paralelo|en medio de|contraste|contradiccion|paradoja|hipocres)\b/.test(headlineText);
  const crisisImage = /\b(guerra|bombarde|misil|ataque militar|ataud|muert|victimas?|iran|gaza|ucrania)\b/.test(headlineText) ||
    ['international-conflict', 'casualty', 'defense'].includes(facts.eventType);
  const celebratoryImage = /\b(love|amor|paz|premio|trofeo|festej|celebracion|ceremonia|gala|final del mundial)\b/.test(headlineText);

  let communityMobilizationScore = 0;
  if (localCommunity) communityMobilizationScore += 5;
  if (communityTopic) communityMobilizationScore += 4;
  if (namedCommunity) communityMobilizationScore += 3;
  if (communitySource) communityMobilizationScore += 4;
  if (youthOrVeterans) communityMobilizationScore += 2;
  if (localSport || emergingVoice) communityMobilizationScore += 2;
  communityMobilizationScore = clamp(communityMobilizationScore, 0, 20);

  let originalReportingPotentialScore = 0;
  if (localCommunity) originalReportingPotentialScore += 4;
  if (communitySource) originalReportingPotentialScore += 4;
  if (namedCommunity) originalReportingPotentialScore += 4;
  if (localSport || emergingVoice) originalReportingPotentialScore += 5;
  if (youthOrVeterans) originalReportingPotentialScore += 3;
  originalReportingPotentialScore = clamp(originalReportingPotentialScore, 0, 20);

  let dataExplainerPotentialScore = 0;
  if (topic === 'economia') dataExplainerPotentialScore += 4;
  if (dataInstitution) dataExplainerPotentialScore += 7;
  if (economicData) dataExplainerPotentialScore += 5;
  if (hasNumbers) dataExplainerPotentialScore += 4;
  dataExplainerPotentialScore = clamp(dataExplainerPotentialScore, 0, 20);

  let contrastPotentialScore = 0;
  if (contrastConnector) contrastPotentialScore += 6;
  if (crisisImage) contrastPotentialScore += 5;
  if (celebratoryImage) contrastPotentialScore += 5;
  if (contrastConnector && crisisImage && celebratoryImage) contrastPotentialScore += 4;
  contrastPotentialScore = clamp(contrastPotentialScore, 0, 20);

  const reasons = [];
  if (communitySource) reasons.push('community-specialist-source');
  if (communityMobilizationScore >= 12) reasons.push('mobilizable-local-community');
  if (youthOrVeterans) reasons.push('undercovered-age-or-gender-category');
  if (emergingVoice) reasons.push('undercovered-protagonist');
  if (dataExplainerPotentialScore >= 12) reasons.push('official-data-needs-explanation');
  if (contrastPotentialScore >= 14) reasons.push('verified-symbolic-contrast-candidate');
  if (impactMagnitudeScore >= 20) reasons.push('high-impact-event');
  if (socialPotentialScore >= 12) reasons.push('strong-sharing-potential');

  let opportunityType = 'standard-news';
  let recommendedFormat = 'noticia';
  let recommendedAction = 'publish-if-verified';
  let followUpFormat = '';
  let requiresHumanReview = false;

  if (contrastPotentialScore >= 14) {
    opportunityType = 'contrast-analysis';
    recommendedFormat = 'analisis';
    recommendedAction = 'draft-for-editorial-review';
    requiresHumanReview = true;
  } else if (dataExplainerPotentialScore >= 12 && qualifiedDataExplainer) {
    opportunityType = 'data-explainer';
    recommendedFormat = 'claves-af';
    recommendedAction = 'publish-factual-explainer-if-verified';
    followUpFormat = 'analisis-comparativo-con-series-verificadas';
  } else if (topic === 'deportes' && localCommunity && tournament && (communitySource || youthOrVeterans || localCompetition)) {
    opportunityType = 'live-community-coverage';
    recommendedFormat = 'cobertura-central-actualizable';
    recommendedAction = 'update-central-coverage-or-publish-milestone';
    followUpFormat = 'historia-humana-o-entrevista';
  } else if (communityMobilizationScore >= 12 && localCommunity && (communitySource || emergingVoice || youthOrVeterans)) {
    opportunityType = emergingVoice ? 'emerging-voice' : 'community-amplification';
    recommendedAction = 'publish-and-notify-protagonists';
    followUpFormat = 'perfil-o-entrevista';
  } else if (impactMagnitudeScore >= 20) {
    opportunityType = 'high-impact-news';
  }

  const strategicValueScore = clamp(Math.round(Math.max(
    communityMobilizationScore,
    originalReportingPotentialScore,
    dataExplainerPotentialScore,
    contrastPotentialScore
  ) * 0.6), 0, 12);

  return {
    opportunityType,
    recommendedFormat,
    recommendedAction,
    followUpFormat,
    requiresHumanReview,
    communityMobilizationScore,
    originalReportingPotentialScore,
    dataExplainerPotentialScore,
    contrastPotentialScore,
    strategicValueScore,
    reasons: unique(reasons)
  };
}

export function inferAgendaTopic({ facts = {}, title = '', category = '' } = {}) {
  const eventType = facts.eventType || 'general';
  const text = factText(facts, title, category);
  if (eventType === 'sports-result' || hasAny(text, ['deportes', 'futbol', 'futsal', 'mundial de futbol', 'copa del mundo', 'partido', 'seleccion', 'club', 'torneo', 'campeonato'])) return 'deportes';
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
  return resolvePublicationTerritory({
    title,
    description: facts.rawSummary || '',
    verifiedFacts: facts,
    agendaTerritory: category,
    source
  }).category;
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

export function scoreImpactMagnitude({ facts = {}, title = '', topic = '', territory = '' } = {}) {
  const eventType = facts.eventType || 'general';
  const text = normalizeText(factText(facts, title));
  let score = 0;

  if (eventType === 'international-conflict') score = 25;
  else if (eventType === 'election') score = 23;
  else if (eventType === 'casualty') score = 21;
  else if (eventType === 'sports-result') {
    score = /\b(argentina|seleccion|mundial|copa america|copa del mundo|final)\b/.test(text) ? 25 : 12;
  } else if (['legislative', 'legal-policy'].includes(eventType)) {
    score = /\b(presidente|congreso|senado|diputados|decreto|reforma|corte suprema)\b/.test(text) ? 20 : 8;
  } else if (eventType === 'crime') {
    score = /\b(masacre|atentado|homicidio multiple|narcotrafico internacional)\b/.test(text) ? 21 : 5;
  }

  if (/\b(guerra|invasion|ataque militar|misiles|escalada militar|catastrofe|terremoto|tsunami|crisis mundial)\b/.test(text)) {
    score = Math.max(score, 23);
  }
  if (/\b(elecciones presidenciales|ballotage|segunda vuelta|fallecio|murio)\b/.test(text)) {
    score = Math.max(score, 21);
  }
  if (territory === 'Nacionales' && ['politica', 'economia'].includes(topic) && /\b(nacional|argentina|gobierno|presidente)\b/.test(text)) {
    score = Math.max(score, 16);
  }

  return clamp(score, 0, 25);
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

function publicationDateFromSources(sourceRefs = []) {
  const dates = sourceRefs
    .map((ref) => ref?.publishedAt)
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());
  return dates[0] || null;
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
  const publicationDate = publicationDateFromSources(sourceRefs);
  const freshness = freshnessFromHours(hoursOld(candidate.pubDate || candidate.article?.date || publicationDate || now, now), lane);
  const publicInterestScore = scorePublicInterest({ facts, topic, eventType });
  const localRelevanceScore = scoreLocalRelevance(territory);
  const impactMagnitudeScore = scoreImpactMagnitude({ facts, title, topic, territory });
  const serviceValueScore = scoreServiceValue({ topic, eventType, facts });
  const socialPotentialScore = scoreSocialPotential({ topic, facts, territory });
  const searchPotentialScore = scoreSearchPotential({ topic, facts, territory });
  const sourceStrengthScore = sourceScore(sourceRefs);
  const editorialOpportunity = analyzeEditorialOpportunity({
    facts,
    title,
    category,
    source,
    topic,
    territory,
    impactMagnitudeScore,
    socialPotentialScore
  });
  const strategicValueScore = editorialOpportunity.strategicValueScore;
  const diversityBonus = byCategory[category] ? 0 : 4;
  let newsworthinessScore = Math.round(
    publicInterestScore +
    localRelevanceScore +
    impactMagnitudeScore +
    serviceValueScore +
    socialPotentialScore +
    searchPotentialScore +
    freshness.score +
    sourceStrengthScore +
    strategicValueScore +
    diversityBonus
  );
  if (territory === 'Mundo' && impactMagnitudeScore < 18) newsworthinessScore = Math.min(newsworthinessScore - 8, 55);
  if (territory === 'Nacionales' && impactMagnitudeScore < 16) newsworthinessScore = Math.min(newsworthinessScore - 4, 60);
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
    impactMagnitudeScore,
    serviceValueScore,
    socialPotentialScore,
    searchPotentialScore,
    sourceStrengthScore,
    strategicValueScore,
    editorialOpportunity,
    recencyScore: freshness.score,
    scoreBreakdown: {
      publicInterest: publicInterestScore,
      localRelevance: localRelevanceScore,
      impactMagnitude: impactMagnitudeScore,
      serviceValue: serviceValueScore,
      socialPotential: socialPotentialScore,
      searchPotential: searchPotentialScore,
      recency: freshness.score,
      sourceStrength: sourceStrengthScore,
      strategicValue: strategicValueScore,
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
      pubDate: publicationDateFromSources(sourceRefs) || event.publishedAt || event.verifiedAt || event.firstDetectedAt || event.lastSeenAt || now
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
    people: unique(facts.people || []).slice(0, 8),
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
    impactMagnitudeScore: score.impactMagnitudeScore,
    serviceValueScore: score.serviceValueScore,
    socialPotentialScore: score.socialPotentialScore,
    searchPotentialScore: score.searchPotentialScore,
    strategicValueScore: score.strategicValueScore,
    editorialOpportunity: score.editorialOpportunity,
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

function storyPeople(story = {}) {
  return new Map((story.people || []).map((value) => [normalizeText(value), value]).filter(([key]) => key));
}

function isRecentOpportunityStory(story = {}) {
  return ['breaking', 'today', 'recent-hard-news', 'recent-context'].includes(story.freshness);
}

export function buildCrossStoryOpportunities(stories = []) {
  const candidates = stories
    .filter((story) => story.status !== 'agenda-invalid' && isRecentOpportunityStory(story))
    .slice(0, 60);
  const opportunities = [];
  const seenPairs = new Set();

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex++) {
    const left = candidates[leftIndex];
    const leftPeople = storyPeople(left);
    if (leftPeople.size === 0) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex++) {
      const right = candidates[rightIndex];
      const sharedPeople = [...storyPeople(right).entries()]
        .filter(([key]) => leftPeople.has(key))
        .map(([key, value]) => leftPeople.get(key) || value);
      if (sharedPeople.length === 0) continue;

      const leftText = normalizeText(`${left.headlineSeed} ${left.eventType} ${left.topic}`);
      const rightText = normalizeText(`${right.headlineSeed} ${right.eventType} ${right.topic}`);
      const crisisTypes = new Set(['international-conflict', 'casualty', 'defense']);
      const publicSpectacle = /\b(final|mundial|premio|trofeo|ceremonia|gala|festej|love|paz)\b/;
      const leftIsCrisis = crisisTypes.has(left.eventType);
      const rightIsCrisis = crisisTypes.has(right.eventType);
      const leftIsSpectacle = ['deportes', 'cultura'].includes(left.topic) && publicSpectacle.test(leftText);
      const rightIsSpectacle = ['deportes', 'cultura'].includes(right.topic) && publicSpectacle.test(rightText);
      const hasContrast = (leftIsCrisis && rightIsSpectacle) || (rightIsCrisis && leftIsSpectacle);
      if (!hasContrast) continue;

      const pairKey = [normalizeText(left.headlineSeed), normalizeText(right.headlineSeed)].sort().join('|');
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      opportunities.push({
        opportunityId: `contrast|${[left.storyId, right.storyId].sort().join('|')}`,
        opportunityType: 'cross-story-contrast',
        storyIds: [left.storyId, right.storyId],
        headlineSeeds: [left.headlineSeed, right.headlineSeed],
        sharedPeople: unique(sharedPeople),
        recommendedFormat: 'analisis',
        recommendedAction: 'verify-context-and-draft-for-editorial-review',
        requiresHumanReview: true,
        priorityScore: clamp(Math.round(((left.newsworthinessScore || 0) + (right.newsworthinessScore || 0)) / 2 + 8)),
        reasons: ['shared-person', 'simultaneous-crisis-and-public-spectacle', 'do-not-infer-intent']
      });
    }
  }

  return opportunities
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, 30);
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
  const storyOpportunities = rankableStories
    .filter((story) => !['standard-news', 'high-impact-news'].includes(story.editorialOpportunity?.opportunityType))
    .map((story) => ({
      opportunityId: `story|${story.storyId}`,
      storyIds: [story.storyId],
      headlineSeeds: [story.headlineSeed],
      priorityScore: story.newsworthinessScore,
      ...story.editorialOpportunity
    }));
  const crossStoryOpportunities = buildCrossStoryOpportunities(rankableStories);
  const opportunities = [...crossStoryOpportunities, ...storyOpportunities]
    .sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));

  return {
    version: 2,
    generatedAt: asDate(now).toISOString(),
    summary: {
      totalStories: stories.length,
      byStatus: countBy(stories, 'status'),
      byTopic: countBy(stories, 'topic'),
      byTerritory: countBy(stories, 'territory'),
      invalidStories: stories.filter((story) => story.status === 'agenda-invalid').length,
      editorialOpportunities: opportunities.length,
      topOpportunities: opportunities.slice(0, 10),
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
    stories: stories.slice(0, 300),
    opportunities: opportunities.slice(0, 100)
  };
}

export async function saveEditorialAgenda(agenda) {
  await fs.mkdir(path.dirname(EDITORIAL_AGENDA_PATH), { recursive: true });
  await fs.writeFile(EDITORIAL_AGENDA_PATH, JSON.stringify(agenda, null, 2) + '\n', 'utf8');
}
