/**
 * collect-news.mjs
 * Pipeline de recolección y publicación de noticias con arquitectura de 3 fases:
 *   Fase A — Recolección global en paralelo (todas las fuentes a la vez)
 *   Fase B — Ranking, deduplicación y balance de presupuesto IA
 *   Fase C — Redacción, imagen y publicación con presupuesto balanceado
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import Parser from 'rss-parser';
import {
  ROOT, NEWS_DIR, DRAFTS_DIR, ensureDirs, loadSeen, saveSeen, hash, slugify, cleanText,
  safeDate, datePrefix, fetchText, stripHtml, extractIndexLinks, extractArticle,
  isOfficialDomain, writeArticleWithModel, makeNewsMarkdown, makeDraftMarkdown, sleep,
  generateWebPlate
} from './lib/news-utils.mjs';
import { resolvePublicationTerritory } from './lib/territory-resolver.mjs';
import {
  isGenericTitle as isGenericTitleShared,
  isSimilarTitle as isSimilarTitleShared,
  isRetryEligible as isRetryEligibleShared,
  getNextRetryAt as getNextRetryAtShared,
  editorialScore as editorialScoreShared,
  canPublishWithinRunLimit,
  allocateAiBudget,
  buildRetryState,
  canonicalizeNewsUrl,
  createContentFingerprint,
  deriveEffectiveImportance,
  findLikelyPublishedStoryMatch,
  isStaleRoutineWeatherForecast,
  isStaleDatedDiscoveryCandidate,
  classifyCandidateFreshness,
  classifySourceValidationErrors,
  normalizeText,
  unwrapDiscoveryUrl
} from './lib/pipeline-utils.mjs';
import { buildSourceRef, validateArticleSource } from './lib/source-policy.mjs';
import {
  loadEvents,
  saveEvents,
  extractFacts,
  generateEventKey,
  corroborateEvent,
  refreshPersistedFacts,
  selectBaseCandidate,
  validateArticleAgainstFacts,
  buildEventRecord,
  FACTUAL_VALIDATION_VERSION
} from './lib/factual-utils.mjs';
import { selectImageForNews, logImageSelection } from './lib/image-plan.mjs';
import {
  buildEditorialAgenda,
  saveEditorialAgenda,
  scoreCandidateNewsworthiness
} from './lib/editorial-agenda.mjs';
import {
  buildCorroborationQuery,
  compactEquivalentPendingEvents,
  findMatchingPendingEventKeyInRecords,
  isCompatibleCorroboration,
  repairRecentPendingEventIdentity,
  scoreCorroborationPriority,
  selectPendingRecoverySources,
  terminalizeExpiredPendingEvents
} from './lib/corroboration-utils.mjs';
import { summarizeEditorialLatency } from './lib/latency-utils.mjs';
import { loadRescueQueue, saveRescueQueue, selectRunnableRescueItems } from './lib/rescue-utils.mjs';

const parser = new Parser();
const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config/sources.json'), 'utf8'));
const seen = await loadSeen();
const events = await loadEvents();
const rescueQueue = await loadRescueQueue();
await ensureDirs();

// ============================================================
// Configuración
// ============================================================
const MAX_AI_PER_RUN = Number(process.env.AF_MAX_AI_PER_RUN || 12);
const MAX_DRAFTS_PER_RUN = Number(process.env.AF_MAX_DRAFTS_PER_RUN || 10);
const MAX_PER_SOURCE = Number(process.env.AF_MAX_PER_SOURCE || 2);
const MAX_MATERIALIZE_PER_RUN = Number(process.env.AF_MAX_MATERIALIZE_PER_RUN || 36);
const TARGET_PUBLISHED_PER_RUN = Number(process.env.AF_TARGET_PUBLISHED_PER_RUN || 2);
const MAX_NORMAL_PUBLISHED_PER_RUN = Number(process.env.AF_MAX_NORMAL_PUBLISHED_PER_RUN || 3);
const EXTRA_SLOT_MIN_IMPORTANCE = Number(process.env.AF_EXTRA_SLOT_MIN_IMPORTANCE || 8);
const DAILY_TARGET_MIN = Number(process.env.AF_DAILY_TARGET_MIN || 12);
const DAILY_TARGET_MAX = Number(process.env.AF_DAILY_TARGET_MAX || 16);
const EXPECTED_RUNS_PER_DAY = Number(process.env.AF_EXPECTED_RUNS_PER_DAY || 12);
const RSS_TIMEOUT_MS = Number(process.env.AF_RSS_TIMEOUT_MS || 15000);
const MAX_CORROBORATION_SEARCHES = Number(process.env.AF_MAX_CORROBORATION_SEARCHES || 3);
const MAX_CORROBORATION_ITEMS_PER_SEARCH = Number(process.env.AF_CORROBORATION_ITEMS_PER_SEARCH || 3);
const MAX_RETRY_ATTEMPTS = Number(process.env.AF_MAX_RETRY_ATTEMPTS || 3);
const MAX_RESCUE_PER_RUN = Number(process.env.AF_MAX_RESCUE_PER_RUN || 4);
const MAX_PENDING_RECOVERY_PER_RUN = Number(process.env.AF_MAX_PENDING_RECOVERY_PER_RUN || 4);
const MAX_PENDING_CORROBORATION_ATTEMPTS = Number(process.env.AF_MAX_PENDING_CORROBORATION_ATTEMPTS || 4);
// Cuánto del presupuesto IA puede consumir las fuentes municipales/oficiales (0-1)
const OFFICIAL_AI_BUDGET_FRACTION = 0.5;
const PERSIST_OUTPUTS =
  process.env.GITHUB_ACTIONS === 'true' ||
  process.env.AF_WRITE_STATE === 'true' ||
  process.argv.includes('--write-state');

if (!PERSIST_OUTPUTS) {
  console.log('Modo diagnostico local: no se escribiran noticias, borradores ni estado persistente. Usar AF_WRITE_STATE=true o --write-state para persistir.');
}

// Títulos genéricos que NO deben usarse para deduplicación (evitar falsos positivos)
const GENERIC_TITLE_WORDS = new Set([
  'noticias', 'inicio', 'home', 'bienvenido', 'portada', 'hoy',
  'municipio', 'rio', 'grande', 'ushuaia', 'tolhuin', 'fuego', 'tierra',
  'novedades', 'actualidad', 'informacion'
]);

// Métricas
const metrics = {
  sourcesConfigured: config.sources.length,
  sourcesConsulted: 0,
  candidatesDetected: 0,
  candidatesIngested: 0,
  extractionSucceeded: 0,
  candidatesApproved: 0,
  discardedDuplicate: 0,
  duplicateExactUrl: 0,
  duplicateExactContent: 0,
  duplicatePublishedEvent: 0,
  discardedQuality: 0,
  discardedQualityByReason: {},
  discardedBySourceAndReason: {},
  discardedGenericTitle: 0,
  discardedEvergreen: 0,
  eventsGrouped: 0,
  verified: 0,
  pendingVerification: 0,
  pendingMatchedFromHistory: 0,
  recentEventRepair: {
    corrected: 0,
    compacted: 0,
    conservedPublished: 0
  },
  pendingEventsCompacted: 0,
  pendingCompactionVerified: 0,
  pendingRecoveryAttempted: 0,
  pendingTerminalizedExpired: 0,
  pendingTerminalizedAttempts: 0,
  pendingAudit: [],
  conflicting: 0,
  published: 0,
  publishedByLane: {},
  verifiedByLane: {},
  pendingByLane: {},
  eventsByTerritory: {},
  verifiedByTerritory: {},
  fastPendingAudit: [],
  freshCandidates: 0,
  staleDiscarded: 0,
  sourceHealth: {},
  sourceDeprioritized: [],
  drafts: 0,
  modelErrors: 0,
  publicationErrors: 0,
  factualValidationErrors: 0,
  discardedImportance: 0,
  discardedSourceLimit: 0,
  discardedNoAiBudget: 0,
  budgetDeferred: 0,
  failedRetryable: 0,
  failedTerminal: 0,
  failedRetryableByReason: {},
  failedTerminalByReason: {},
  aiReused: 0,
  rescueQueued: 0,
  rescueAttempted: 0,
  rescueSucceeded: 0,
  rescueExhausted: 0,
  discardedPublicationLimit: 0,
  extractErrors: 0,
  imageErrors: 0,
  aiAttempts: 0,
  aiCalls: 0,
  articlesDrafted: 0,
  imagesResolved: 0,
  approvedForPublication: 0,
  imageSelections: [],
  agendaStories: 0,
  newsworthinessAverage: 0,
  newsworthinessTop: [],
  corroborationSearches: 0,
  corroborationFound: 0,
  corroborationVerified: 0,
  corroborationConflicts: 0,
  corroborationNoResult: 0,
  corroborationAttempts: [],
  conflictsByField: {},
  criticalConflicts: 0,
  nonCriticalDifferences: 0,
  resolvedComplementaryFacts: 0,
  latency: {},
  byCategory: {}
};

function incrementMap(target, key, amount = 1) {
  const normalized = String(key || 'unspecified');
  target[normalized] = (target[normalized] || 0) + amount;
}

function sourceHealth(sourceId = '') {
  const id = sourceId || 'unknown';
  metrics.sourceHealth[id] ||= {
    detected: 0,
    materialized: 0,
    freshCandidates: 0,
    qualityDiscarded: 0,
    staleDiscarded: 0,
    consulted: 0,
    fetchErrors: 0,
    noItems: 0,
    lastError: '',
    status: 'not-consulted',
    issueCategory: '',
    verifiedContribution: 0,
    publicationContribution: 0
  };
  return metrics.sourceHealth[id];
}

const recentRepair = repairRecentPendingEventIdentity(events.events || {});
metrics.recentEventRepair = {
  corrected: recentRepair.corrected,
  compacted: recentRepair.compacted,
  conservedPublished: recentRepair.conservedPublished
};
if (recentRepair.changed) {
  console.log(`Eventos pendientes recientes reparados: ${recentRepair.corrected}; compactados por nueva identidad: ${recentRepair.compacted}`);
}
const pendingCompaction = compactEquivalentPendingEvents(events.events || {});
metrics.pendingEventsCompacted = pendingCompaction.merged;
metrics.pendingCompactionVerified = pendingCompaction.verified;
if (pendingCompaction.changed) {
  console.log(`Pendientes equivalentes compactados: ${pendingCompaction.merged}; verificados tras compactacion: ${pendingCompaction.verified}`);
}
const pendingTerminalization = terminalizeExpiredPendingEvents(events.events || {}, {
  maxAttempts: MAX_PENDING_CORROBORATION_ATTEMPTS
});
metrics.pendingTerminalizedExpired = pendingTerminalization.expired;
metrics.pendingTerminalizedAttempts = pendingTerminalization.attemptsExhausted;

function recordQualityDiscard(reason, { evergreen = false, sourceId = '' } = {}) {
  metrics.discardedQuality++;
  incrementMap(metrics.discardedQualityByReason, reason);
  if (sourceId) {
    metrics.discardedBySourceAndReason[sourceId] ||= {};
    incrementMap(metrics.discardedBySourceAndReason[sourceId], reason);
    const health = sourceHealth(sourceId);
    health.qualityDiscarded++;
    if (/^(stale|evergreen)/.test(reason)) {
      health.staleDiscarded++;
      metrics.staleDiscarded++;
    }
  }
  if (evergreen) metrics.discardedEvergreen++;
}

function getLane(value) {
  return value || 'standard';
}

// ============================================================
// Índice de deduplicación — SOLO de noticias PUBLICADAS
// Los borradores NO bloquean futuras publicaciones
// ============================================================
// ============================================================
// Índice de deduplicación — SOLO de noticias PUBLICADAS
// Los borradores NO bloquean futuras publicaciones
// ============================================================
const existingUrls = new Set();
const existingTitles = new Set();
const publishedStories = [];


async function indexPublishedDocs() {
  try {
    for (const file of await fs.readdir(NEWS_DIR)) {
      if (!file.endsWith('.md')) continue;
      const content = await fs.readFile(path.join(NEWS_DIR, file), 'utf8');
      const urlMatch = content.match(/^sourceUrl:\s*['"](.*?)['"]$/m);
      if (urlMatch) existingUrls.add(canonicalizeNewsUrl(urlMatch[1].trim()));
      const titleMatch = content.match(/^title:\s*['"](.*?)['"]$/m);
      if (titleMatch) {
        const titleStr = titleMatch[1].trim();
        existingTitles.add(titleStr.toLowerCase());
        publishedStories.push({
          title: titleStr,
          sourcePublishedAt: content.match(/^sourcePublishedAt:\s*['"]?([^'"\n]+)['"]?$/m)?.[1]?.trim() || '',
          publishedAt: content.match(/^date:\s*['"]?([^'"\n]+)['"]?$/m)?.[1]?.trim() || '',
          sourceUrl: urlMatch?.[1]?.trim() || '',
          file
        });
      }
    }
  } catch {}
}

async function countPublishedSince(sinceDate) {
  let count = 0;
  try {
    for (const file of await fs.readdir(NEWS_DIR)) {
      if (!file.endsWith('.md')) continue;
      const content = await fs.readFile(path.join(NEWS_DIR, file), 'utf8');
      const dateMatch = content.match(/^date:\s*['"]?([^'"\n]+)['"]?$/m);
      if (!dateMatch) continue;
      const publishedAt = new Date(dateMatch[1].trim());
      if (!Number.isNaN(publishedAt.valueOf()) && publishedAt >= sinceDate) count++;
    }
  } catch {}
  return count;
}

async function latestPublicationDate() {
  let latest = null;
  try {
    for (const file of await fs.readdir(NEWS_DIR)) {
      if (!file.endsWith('.md')) continue;
      const content = await fs.readFile(path.join(NEWS_DIR, file), 'utf8');
      const dateMatch = content.match(/^date:\s*['"]?([^'"\n]+)['"]?$/m);
      if (!dateMatch) continue;
      const publishedAt = new Date(dateMatch[1].trim());
      if (Number.isNaN(publishedAt.valueOf())) continue;
      if (!latest || publishedAt > latest) latest = publishedAt;
    }
  } catch {}
  return latest;
}

function isGenericTitle(title) {
  return isGenericTitleShared(title);
}

function isSimilarTitle(newTitle) {
  return isSimilarTitleShared(newTitle, existingTitles);
}

function findMatchingPendingEventKey({ eventKey, facts = {}, title = '', sourceRef = {} }) {
  return findMatchingPendingEventKeyInRecords({
    records: events.events || {},
    eventKey,
    facts,
    title,
    sourceRef
  });
}

await indexPublishedDocs();
for (const event of Object.values(events.events || {})) {
  if (event.status !== 'published') continue;
  for (const entry of event.factsBySource || []) {
    const source = (event.sources || []).find((item) => item.url === entry.url) || {};
    publishedStories.push({
      title: event.verifiedFacts?.title || '',
      sourceTitle: entry.facts?.title || source.title || '',
      sourcePublishedAt: source.publishedAt || '',
      publishedAt: event.publishedAt || '',
      sourceUrl: entry.url || source.url || '',
      file: event.publishedFile || ''
    });
  }
}

function recordFailure(retry = {}) {
  const reason = retry.failureReason || 'unspecified';
  if (retry.status === 'failed-retryable') {
    metrics.failedRetryable++;
    incrementMap(metrics.failedRetryableByReason, reason);
  } else {
    metrics.failedTerminal++;
    incrementMap(metrics.failedTerminalByReason, reason);
  }
}
const latestPublishedBeforeRun = await latestPublicationDate();
metrics.publishedLast3hBeforeRun = await countPublishedSince(new Date(Date.now() - 3 * 60 * 60 * 1000));
metrics.publishedLast6hBeforeRun = await countPublishedSince(new Date(Date.now() - 6 * 60 * 60 * 1000));
metrics.publishedLast12hBeforeRun = await countPublishedSince(new Date(Date.now() - 12 * 60 * 60 * 1000));
const publishedLast24hBeforeRun = await countPublishedSince(new Date(Date.now() - 24 * 60 * 60 * 1000));
metrics.publishedLast24hBeforeRun = publishedLast24hBeforeRun;
metrics.hoursSinceLastPublicationBeforeRun = latestPublishedBeforeRun
  ? Math.round(((Date.now() - latestPublishedBeforeRun.getTime()) / (60 * 60 * 1000)) * 10) / 10
  : null;

async function loadPreviousRunMetrics() {
  try {
    const payload = JSON.parse(await fs.readFile(path.join(ROOT, 'data/news-run-metrics.json'), 'utf8'));
    return payload.metrics || {};
  } catch {
    return {};
  }
}

const previousRunMetrics = await loadPreviousRunMetrics();

function bingFreshUrl(url = '') {
  if (!/bing\.com\/news\/search/i.test(url)) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('format', 'rss');
  parsed.searchParams.set('setlang', 'es-AR');
  parsed.searchParams.set('cc', 'AR');
  parsed.searchParams.set('freshness', 'Day');
  parsed.searchParams.set('sortBy', 'Date');
  return parsed.toString();
}

function sourcePenalty(source = {}) {
  const previous = previousRunMetrics.sourceHealth?.[source.id] || {};
  const persistentStale = (previous.detected || 0) >= 3 && (previous.staleDiscardRate || 0) >= 0.7 && (previous.freshCandidateRate || 0) <= 0.3;
  if (persistentStale && /^bing-/.test(source.id || '')) return 30;
  return 0;
}

function serviceRecoveryScore(candidate = {}) {
  if ((metrics.hoursSinceLastPublicationBeforeRun ?? 999) < 6) return 0;
  const text = normalizeText(`${candidate.item?.title || ''} ${candidate.item?.description || ''} ${candidate.source?.defaultCategory || ''}`);
  let score = 0;
  if (candidate.source?.mode === 'official-auto') score += 20;
  if (/\b(agenda|actividad|actividades|curso|inscripcion|servicio|corte|ruta|vuelo|transporte|salud|educacion|cultura|turismo|municipio)\b/.test(text)) score += 15;
  if (['Rio Grande', 'Ushuaia', 'Tolhuin', 'Provincia'].includes(candidate.source?.defaultCategory)) score += 8;
  return score;
}
console.log(`Índice de deduplicación (solo publicadas): ${existingUrls.size} URLs y ${existingTitles.size} títulos.`);

// ============================================================
// FASE A — Recolección global en paralelo
// ============================================================

async function readSource(source) {
  const filterItems = (items = []) => {
    if (!source.filterKeywords?.length) return items;
    const keywords = source.filterKeywords.map(k => normalizeText(k));
    return items.filter(item => {
      const text = normalizeText(`${item.title} ${item.description || ''}`);
      return keywords.some(k => text.includes(k));
    });
  };
  if (source.type === 'rss') {
    const { text } = await fetchText(bingFreshUrl(source.url), { timeoutMs: source.timeoutMs || RSS_TIMEOUT_MS });
    const feed = await parser.parseString(text);
    let items = (feed.items || []).map((item) => ({
      title: item.title || '',
      link: item.link || item.guid || '',
      pubDate: item.isoDate || item.pubDate || '',
      description: stripHtml(item.contentSnippet || item.content || item.summary || '')
    }));

    return filterItems(items).slice(0, source.maxItems || 5);
  }
  if (source.type === 'html-index') {
    const { text } = await fetchText(source.url, { timeoutMs: 30000 });
    const items = extractIndexLinks(text, source.url, source.linkPattern)
      .map((item) => ({ ...item, pubDate: '', description: '' }));
    return filterItems(items).slice(0, source.maxItems || 5);
  }
  throw new Error(`Tipo de fuente no soportado: ${source.type}`);
}

async function materialize(item) {
  const { text, finalUrl } = await fetchText(item.link, { timeoutMs: 20000 });
  return extractArticle(text, finalUrl);
}

let corroborationSearchesUsed = 0;

async function findActiveCorroborationCandidates({ eventKey, group = [], verification = {}, query = '', priorityRank = null, priorityReason = '' } = {}) {
  if (corroborationSearchesUsed >= MAX_CORROBORATION_SEARCHES) return [];
  const base = selectBaseCandidate(group);
  if (!base) return [];
  const score = scoreCandidateNewsworthiness(base, { verification, byCategory: metrics.byCategory });
  if ((score.newsworthinessScore || 0) < 65) return [];
  const corroborationQuery = query || buildCorroborationQuery(base, score);
  if (!corroborationQuery) return [];

  corroborationSearchesUsed++;
  metrics.corroborationSearches++;
  const attemptMetric = {
    eventKey,
    title: base.title || base.facts?.title || '',
    priorityRank,
    corroborationQuery,
    corroborationReason: priorityReason,
    found: 0,
    verified: false,
    status: 'searching'
  };
  metrics.corroborationAttempts.push(attemptMetric);
  const searchUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(corroborationQuery)}&format=rss&setlang=es-AR&cc=AR&freshness=Day&sortBy=Date`;
  const existingDomains = new Set(group.map((candidate) => candidate.sourceRef?.publisherDomain).filter(Boolean));
  const found = [];

  try {
    const { text } = await fetchText(searchUrl, { timeoutMs: RSS_TIMEOUT_MS });
    const feed = await parser.parseString(text);
    const items = (feed.items || []).slice(0, MAX_CORROBORATION_ITEMS_PER_SEARCH);
    const source = {
      id: 'active-corroboration',
      name: 'Corroboracion activa',
      mode: 'discovery-draft',
      defaultCategory: base.source?.defaultCategory || ''
    };
    for (const item of items) {
      try {
        const article = await materialize({
          link: item.link,
          title: item.title || '',
          description: stripHtml(item.contentSnippet || item.content || item.summary || ''),
          pubDate: item.pubDate || item.isoDate || ''
        });
        const finalUrl = article.finalUrl || item.link;
        const sourceValidation = validateArticleSource({ article, item, source, finalUrl });
        if (!sourceValidation.ok) continue;
        const sourceRef = buildSourceRef({ source, item, article, officialDomains: config.officialDomains });
        const currentTitle = (article.title || item.title || '').trim();
        const facts = extractFacts({
          article,
          item,
          source,
          category: source.defaultCategory
        });
        const candidate = {
          source,
          item,
          article,
          sourceRef,
          facts,
          eventKey,
          title: currentTitle,
          pubDate: safeDate(article.date || item.pubDate || new Date()),
          bodyLength: (article.text || '').length
        };
        if (!isCompatibleCorroboration(base, candidate, existingDomains)) continue;
        existingDomains.add(sourceRef.publisherDomain);
        found.push(candidate);
        metrics.corroborationFound++;
        attemptMetric.found++;
      } catch {
        // Corroboration is opportunistic; individual fetch failures should not block the run.
      }
    }
  } catch {
    metrics.corroborationNoResult++;
    attemptMetric.status = 'fetch-error';
  }

  if (found.length === 0) metrics.corroborationNoResult++;
  if (attemptMetric.status === 'searching') attemptMetric.status = found.length > 0 ? 'found' : 'no-result';
  return found;
}

// Verificar si un item en seen.json es elegible para retry (con backoff)
function isRetryEligible(seenItem) {
  return isRetryEligibleShared(seenItem);
}

function getNextRetryAt(attempts) {
  return getNextRetryAtShared(attempts);
}

console.log(`\n=== FASE A: Recolección global de ${config.sources.length} fuentes ===`);

const allCandidates = []; // { source, item, initialKey }
const runDiscoveryUrls = new Set();
const pendingRecoveryItems = selectPendingRecoverySources(events.events || {}, {
  max: MAX_PENDING_RECOVERY_PER_RUN,
  maxAttempts: MAX_PENDING_CORROBORATION_ATTEMPTS
});

for (const pendingItem of pendingRecoveryItems) {
  const sourceRef = pendingItem.sourceRef;
  const source = config.sources.find((item) => item.id === sourceRef.sourceId) || {
    id: sourceRef.sourceId || 'pending-recovery',
    name: sourceRef.sourceName || sourceRef.publisherDomain || 'Recuperacion de pending',
    mode: sourceRef.sourceMode || 'discovery-draft',
    defaultCategory: 'Provincia'
  };
  const canonicalDiscoveryUrl = canonicalizeNewsUrl(sourceRef.url);
  if (!canonicalDiscoveryUrl || runDiscoveryUrls.has(canonicalDiscoveryUrl)) continue;
  runDiscoveryUrls.add(canonicalDiscoveryUrl);
  allCandidates.push({
    source,
    item: {
      link: sourceRef.url,
      title: sourceRef.title || pendingItem.record.factsBySource?.[0]?.facts?.title || '',
      pubDate: sourceRef.publishedAt || '',
      description: ''
    },
    initialKey: hash(canonicalDiscoveryUrl),
    legacyKey: hash(sourceRef.originalUrl || sourceRef.url),
    fetchUrl: unwrapDiscoveryUrl(sourceRef.url),
    canonicalDiscoveryUrl,
    pendingRecoveryEventKey: pendingItem.eventKey
  });
  metrics.pendingRecoveryAttempted++;
}

const runnableRescueItems = selectRunnableRescueItems(rescueQueue, { max: MAX_RESCUE_PER_RUN });
metrics.rescueQueued = (rescueQueue.items || []).filter((item) => item.status === 'rescue-pending').length;

for (const rescueItem of runnableRescueItems) {
  const source = config.sources.find((item) => item.id === rescueItem.sourceId) || {
    id: rescueItem.sourceId || 'rescue-backfill',
    name: 'Rescate editorial',
    mode: 'discovery-draft',
    defaultCategory: rescueItem.category || 'Provincia',
    location: rescueItem.location || ''
  };
  const canonicalDiscoveryUrl = canonicalizeNewsUrl(rescueItem.sourceUrl);
  if (!canonicalDiscoveryUrl || runDiscoveryUrls.has(canonicalDiscoveryUrl)) continue;
  runDiscoveryUrls.add(canonicalDiscoveryUrl);
  const initialKey = hash(canonicalDiscoveryUrl);
  rescueItem.lastSeenKey = initialKey;
  allCandidates.push({
    source,
    item: {
      link: rescueItem.sourceUrl,
      title: rescueItem.title || '',
      pubDate: rescueItem.publishedAt || '',
      description: ''
    },
    initialKey,
    legacyKey: initialKey,
    fetchUrl: unwrapDiscoveryUrl(rescueItem.sourceUrl),
    canonicalDiscoveryUrl,
    rescueItem
  });
  metrics.rescueAttempted++;
}

await Promise.all(config.sources.map(async (source) => {
  metrics.sourcesConsulted++;
  const health = sourceHealth(source.id);
  health.consulted++;
  let items = [];
  try {
    items = await readSource(source);
  } catch (error) {
    health.fetchErrors++;
    health.lastError = String(error.message || error).slice(0, 160);
    console.warn(`[${source.name}] omitida: ${error.message}`);
    return;
  }
  if (items.length === 0) health.noItems++;
  for (const item of items) {
    if (!item.link) continue;
    sourceHealth(source.id).detected++;
    metrics.candidatesDetected++;
    const fetchUrl = unwrapDiscoveryUrl(item.link);
    const canonicalDiscoveryUrl = canonicalizeNewsUrl(fetchUrl);
    if (runDiscoveryUrls.has(canonicalDiscoveryUrl)) {
      metrics.discardedDuplicate++;
      metrics.duplicateExactUrl++;
      continue;
    }
    runDiscoveryUrls.add(canonicalDiscoveryUrl);
    const initialKey = hash(canonicalDiscoveryUrl);
    const legacyKey = hash(item.link);
    const seenItem = seen.items[initialKey] || seen.items[legacyKey];

    // Bloquear si ya fue publicado o marcado como duplicado definitivamente
    if (seenItem && ['published', 'duplicate'].includes(seenItem.status)) continue;
    // Si está en estado reintentable, verificar si está dentro de la ventana
    if (seenItem && !isRetryEligible(seenItem)) continue;

    allCandidates.push({ source, item, initialKey, legacyKey, fetchUrl, canonicalDiscoveryUrl });
  }
}));

console.log(`Candidatos pre-filtro de todas las fuentes: ${allCandidates.length}`);
metrics.candidatesIngested = allCandidates.length;
allCandidates.sort((a, b) => {
  const rescuePriority = Number(Boolean(b.rescueItem)) - Number(Boolean(a.rescueItem));
  if (rescuePriority !== 0) return rescuePriority;
  const pendingPriority = Number(Boolean(b.pendingRecoveryEventKey)) - Number(Boolean(a.pendingRecoveryEventKey));
  if (pendingPriority !== 0) return pendingPriority;
  const recovery = serviceRecoveryScore(b) - serviceRecoveryScore(a);
  if (recovery !== 0) return recovery;
  const penalty = sourcePenalty(a.source) - sourcePenalty(b.source);
  if (penalty !== 0) return penalty;
  return 0;
});
metrics.sourceDeprioritized = [...new Set(allCandidates
  .filter((candidate) => sourcePenalty(candidate.source) > 0)
  .map((candidate) => candidate.source.id))];
if (allCandidates.length > MAX_MATERIALIZE_PER_RUN) {
  console.log(`Limitando materializacion a ${MAX_MATERIALIZE_PER_RUN}/${allCandidates.length} candidatos para evitar timeout operativo.`);
}
const candidatesToMaterialize = allCandidates.slice(0, MAX_MATERIALIZE_PER_RUN);


// ==============================================================
// FASE B — Extracción, ranking, deduplicación y balance
// ==============================================================

console.log(`\n=== FASE B: Extracción y ranking ===`);

// Extraer contenido de cada candidato (en serie para no saturar)
const extracted = [];
const runMaterializedUrls = new Set();
const runContentFingerprints = new Set();
for (const candidate of candidatesToMaterialize) {
  const { source, item, initialKey, fetchUrl } = candidate;
  let article;
  try {
    article = await materialize({ ...item, link: fetchUrl || item.link });
    sourceHealth(source.id).materialized++;
    metrics.extractionSucceeded++;
    await sleep(300);
  } catch (error) {
    console.warn(`[${source.name}] Error extracción ${item.link}: ${error.message}`);
    metrics.extractErrors++;
    const retry = buildRetryState({ previous: seen.items[initialKey], error, stage: 'extraction', maxAttempts: MAX_RETRY_ATTEMPTS });
    recordFailure(retry);
    seen.items[initialKey] = {
      ...retry,
      seenAt: new Date().toISOString(),
      source: source.id,
      sourceUrl: fetchUrl || item.link,
      title: item.title || ''
    };
    continue;
  }

  if (normalizeText(article.title || '').length < 15 && normalizeText(item.title || '').length >= 15) {
    article = { ...article, title: item.title };
  }

  const finalUrl = article.finalUrl || item.link;

  const sourceValidation = validateArticleSource({ article, item, source, finalUrl });
  if (!sourceValidation.ok) {
    const reason = sourceValidation.errors.join(',');
    const failure = classifySourceValidationErrors(sourceValidation.errors);
    if (failure.retryable) {
      const error = new Error(`Extracción reparable: ${reason}`);
      const retry = buildRetryState({
        previous: seen.items[initialKey],
        error,
        stage: 'extraction',
        maxAttempts: MAX_RETRY_ATTEMPTS
      });
      retry.failureReason = reason;
      recordFailure(retry);
      metrics.extractErrors++;
      seen.items[initialKey] = {
        ...retry,
        seenAt: new Date().toISOString(),
        source: source.id,
        sourceUrl: finalUrl,
        title: article.title || item.title || '',
        failureReason: reason
      };
      continue;
    }
    console.log(`[${source.name}] Descartado por fuente invalida (${sourceValidation.errors.join(', ')}): ${sourceValidation.url}`);
    seen.items[initialKey] = {
      status: 'discarded-quality',
      reason,
      seenAt: new Date().toISOString(),
      source: source.id
    };
    recordQualityDiscard(reason, { sourceId: source.id });
    continue;
  }

  const canonicalFinalUrl = canonicalizeNewsUrl(sourceValidation.url || finalUrl);
  if (runMaterializedUrls.has(canonicalFinalUrl)) {
    seen.items[initialKey] = { seenAt: new Date().toISOString(), status: 'duplicate', reason: 'exact-url', source: source.id };
    metrics.discardedDuplicate++;
    metrics.duplicateExactUrl++;
    continue;
  }
  runMaterializedUrls.add(canonicalFinalUrl);

  const currentTitle = (article.title || item.title || '').trim();
  if (isStaleDatedDiscoveryCandidate({
    source,
    title: currentTitle,
    description: article.description || item.description || '',
    pubDate: article.date || item.pubDate || ''
  })) {
    seen.items[initialKey] = {
      status: 'discarded-quality',
      reason: 'stale-dated-discovery',
      seenAt: new Date().toISOString(),
      source: source.id
    };
    recordQualityDiscard('stale-dated-discovery', { evergreen: true, sourceId: source.id });
    continue;
  }
  const sourceRef = buildSourceRef({ source, item, article, officialDomains: config.officialDomains });
  const facts = extractFacts({
    article,
    item,
    source,
    category: source.forceCategory || source.defaultCategory
  });
  const sourceDateValue = article.date || item.pubDate || '';
  const pubDate = safeDate(sourceDateValue || new Date());
  const explicitDatedText = `${currentTitle}\n${article.description || item.description || ''}`;
  const freshness = classifyCandidateFreshness({
    source,
    facts,
    pubDate,
    sourceHasDate: Boolean(sourceDateValue),
    hasExplicitDate: /\b(19\d{2}|20\d{2})\b/.test(explicitDatedText)
  });
  if (!freshness.ok) {
    seen.items[initialKey] = {
      status: 'discarded-quality',
      reason: freshness.reason,
      seenAt: new Date().toISOString(),
      source: source.id,
      editorialLane: getLane(facts.editorialLane)
    };
    recordQualityDiscard(freshness.reason, { evergreen: freshness.bucket === 'evergreen', sourceId: source.id });
    continue;
  }
  if (isStaleRoutineWeatherForecast(facts)) {
    seen.items[initialKey] = {
      status: 'discarded-quality',
      reason: 'stale-weather-forecast',
      seenAt: new Date().toISOString(),
      source: source.id
    };
    recordQualityDiscard('stale-weather-forecast', { sourceId: source.id });
    continue;
  }
  sourceHealth(source.id).freshCandidates++;
  metrics.freshCandidates++;
  const publishedMatch = findLikelyPublishedStoryMatch({
    title: currentTitle,
    publishedAt: sourceRef.publishedAt || ''
  }, publishedStories);
  if (publishedMatch) {
    seen.items[initialKey] = {
      seenAt: new Date().toISOString(),
      status: 'duplicate',
      reason: 'published-event',
      source: source.id,
      matchedPublishedFile: publishedMatch.file || ''
    };
    metrics.discardedDuplicate++;
    metrics.duplicatePublishedEvent++;
    continue;
  }
  const generatedEventKey = generateEventKey({
    facts,
    title: currentTitle,
    sourceRef
  });
  const eventKey = findMatchingPendingEventKey({
    eventKey: generatedEventKey,
    facts,
    title: currentTitle,
    sourceRef
  });
  if (eventKey !== generatedEventKey) metrics.pendingMatchedFromHistory++;

  const canonicalKey = hash(canonicalFinalUrl);
  if (candidate.rescueItem) candidate.rescueItem.lastSeenKey = canonicalKey;

  // Descartar si URL canónica ya vista como publicada
  const canonicalSeen = seen.items[canonicalKey];
  const canonicalStatus = canonicalSeen?.status || '';
  if (
    canonicalSeen &&
    (
      ['published', 'duplicate', 'stale'].includes(canonicalStatus) ||
      (canonicalStatus === 'discarded-editorial' && !isRetryEligible(canonicalSeen))
    )
  ) {
    seen.items[initialKey] = { seenAt: new Date().toISOString(), status: 'duplicate', source: source.id };
    metrics.discardedDuplicate++;
    metrics.duplicateExactUrl++;
    continue;
  }

  // Descartar si URL ya existe en archivos publicados
  if (existingUrls.has(canonicalFinalUrl)) {
    seen.items[initialKey] = { seenAt: new Date().toISOString(), status: 'duplicate', source: source.id };
    metrics.discardedDuplicate++;
    metrics.duplicateExactUrl++;
    continue;
  }

  // Descartar títulos genéricos
  if (isGenericTitle(currentTitle)) {
    seen.items[initialKey] = { seenAt: new Date().toISOString(), status: 'duplicate', source: source.id };
    metrics.discardedGenericTitle++;
    continue;
  }

  // Descartar si título similar a publicada
  if (isSimilarTitle(currentTitle)) {
    seen.items[initialKey] = { seenAt: new Date().toISOString(), status: 'duplicate', source: source.id };
    metrics.discardedDuplicate++;
    continue;
  }

  const bodyLength = (article.text || '').length;
  const contentFingerprint = createContentFingerprint({
    title: currentTitle,
    body: article.text,
    publisherDomain: sourceRef.publisherDomain
  });
  if (contentFingerprint && runContentFingerprints.has(contentFingerprint)) {
    seen.items[initialKey] = { seenAt: new Date().toISOString(), status: 'duplicate', reason: 'exact-content', source: source.id };
    metrics.discardedDuplicate++;
    metrics.duplicateExactContent++;
    continue;
  }
  if (contentFingerprint) runContentFingerprints.add(contentFingerprint);

  extracted.push({
    source,
    item,
    article,
    initialKey,
    canonicalKey,
    sourceRef,
    facts,
    eventKey,
    title: currentTitle,
    isOfficial: source.mode === 'official-auto' || isOfficialDomain(finalUrl, config.officialDomains),
    pubDate,
    bodyLength,
    rescueItem: candidate.rescueItem || null
  });
  
  // Agregar al índice de eventos para deduplicar siguientes candidatos de la misma corrida
  // Intentionally left out: this index is only updated after publication.
}

console.log(`Candidatos válidos después de extracción: ${extracted.length}`);
metrics.candidatesApproved = extracted.length;

// ==============================================================
// Scoring editorial — factores: recencia, calidad, localidad, diversidad
// ==============================================================
const eventsByKey = new Map();
for (const candidate of extracted) {
  if (!eventsByKey.has(candidate.eventKey)) eventsByKey.set(candidate.eventKey, []);
  eventsByKey.get(candidate.eventKey).push(candidate);
}

metrics.eventsGrouped = eventsByKey.size;
const verifiedCandidates = [];

function uniqueStrings(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values.map((item) => cleanText(item)).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function formatForecastDate(dateKey = '') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return 'la jornada';
  const [year, month, day] = dateKey.split('-');
  const months = {
    '01': 'enero',
    '02': 'febrero',
    '03': 'marzo',
    '04': 'abril',
    '05': 'mayo',
    '06': 'junio',
    '07': 'julio',
    '08': 'agosto',
    '09': 'septiembre',
    '10': 'octubre',
    '11': 'noviembre',
    '12': 'diciembre'
  };
  return `${Number(day)} de ${months[month] || month} de ${year}`;
}

function buildProvincialWeatherCandidate(group = [], verification = {}) {
  const base = selectBaseCandidate(group);
  if (base?.facts?.eventType !== 'weather-forecast') return base;

  const forecastDateKey = base.facts.weatherForecastDateKey || group.find((candidate) => candidate.facts?.weatherForecastDateKey)?.facts.weatherForecastDateKey || '';
  const forecastDateLabel = formatForecastDate(forecastDateKey);
  const locations = uniqueStrings(
    group.flatMap((candidate) => [
      candidate.source?.location,
      ...(candidate.facts?.places || [])
    ])
  ).filter((value) => !/^argentina$/i.test(value) && !/^tierra del fuego/i.test(value));

  const sections = group.map((candidate) => {
    const location = candidate.source?.location || (candidate.facts?.places || [])[0] || 'Tierra del Fuego';
    return [
      `LOCALIDAD: ${location}`,
      `FUENTE: ${candidate.sourceRef?.sourceName || candidate.source?.name || ''}`,
      `URL: ${candidate.sourceRef?.url || candidate.article?.finalUrl || candidate.item?.link || ''}`,
      `TITULO: ${candidate.article?.title || candidate.item?.title || ''}`,
      `RESUMEN: ${candidate.article?.description || candidate.item?.description || ''}`,
      `TEXTO: ${String(candidate.article?.text || '').slice(0, 3000)}`
    ].join('\n');
  }).join('\n\n---\n\n');

  return {
    ...base,
    title: `Pronóstico del tiempo en Tierra del Fuego para ${forecastDateLabel}`,
    source: {
      ...base.source,
      defaultCategory: 'Provincia',
      forceCategory: '',
      location: 'Tierra del Fuego AIAS'
    },
    article: {
      ...base.article,
      title: `Pronóstico del tiempo en Tierra del Fuego para ${forecastDateLabel}`,
      description: `Resumen provincial del tiempo para ${forecastDateLabel}${locations.length ? ` en ${locations.join(', ')}` : ''}.`,
      text: [
        'TIPO: PRONOSTICO_PROVINCIAL',
        'INSTRUCCION EDITORIAL: redactar una sola nota provincial, no una nota por localidad. Usar secciones internas para cada localidad con datos disponibles.',
        `FECHA DEL PRONOSTICO: ${forecastDateLabel}`,
        `LOCALIDADES DETECTADAS: ${locations.join(', ') || 'Tierra del Fuego'}`,
        '',
        sections
      ].join('\n'),
      image: base.article?.image || group.find((candidate) => candidate.article?.image)?.article.image || ''
    },
    facts: {
      ...(base.facts || {}),
      eventType: 'weather-forecast',
      places: uniqueStrings(['Tierra del Fuego', ...locations]),
      weatherForecastDateKey: forecastDateKey
    },
    relatedCandidates: group
  };
}

const eventContexts = [];

for (const [eventKey, group] of eventsByKey) {
  const existingEvent = events.events?.[eventKey] || {};
  const persistedCandidates = (existingEvent.factsBySource || []).map((entry) => {
    const sourceRef = {
      ...(existingEvent.sources || []).find((source) => source.url === entry.url),
      publisherDomain: entry.publisherDomain,
      url: entry.url
    };
    return {
      sourceRef,
      facts: refreshPersistedFacts(entry.facts || {}, sourceRef),
      bodyLength: 0,
      pubDate: new Date(existingEvent.lastSeenAt || 0)
    };
  });

  const seenUrls = new Set();
  let combinedForVerification = [...persistedCandidates, ...group].filter((candidate) => {
    const url = candidate.sourceRef?.url || '';
    if (url && seenUrls.has(url)) return false;
    if (url) seenUrls.add(url);
    return true;
  });

  const verification = corroborateEvent({ eventKey, candidates: combinedForVerification });
  const base = selectBaseCandidate(combinedForVerification);
  const newsworthiness = base
    ? scoreCandidateNewsworthiness(base, { verification, byCategory: metrics.byCategory })
    : {};
  const priority = scoreCorroborationPriority({ base, verification, newsworthiness, existingEvent });
  incrementMap(metrics.eventsByTerritory, newsworthiness.territory || 'unknown');
  eventContexts.push({
    eventKey,
    group,
    existingEvent,
    combinedForVerification,
    verification,
    newsworthiness,
    corroborationQuery: base ? buildCorroborationQuery(base, newsworthiness) : '',
    corroborationPriority: priority
  });
}

const pendingForCorroboration = eventContexts
  .filter((context) => !context.verification.verified && context.verification.status !== 'conflicting-sources')
  .sort((a, b) => (b.corroborationPriority?.score || 0) - (a.corroborationPriority?.score || 0));

for (const [index, context] of pendingForCorroboration.entries()) {
  if (corroborationSearchesUsed >= MAX_CORROBORATION_SEARCHES) break;
  const priorityRank = index + 1;
  const priorityReason = (context.corroborationPriority?.reasons || []).join('; ');
  const activeCandidates = await findActiveCorroborationCandidates({
    eventKey: context.eventKey,
    group: context.combinedForVerification,
    verification: context.verification,
    query: context.corroborationQuery,
    priorityRank,
    priorityReason
  });
  if (activeCandidates.length > 0) {
    context.combinedForVerification = [...context.combinedForVerification, ...activeCandidates];
    context.verification = corroborateEvent({ eventKey: context.eventKey, candidates: context.combinedForVerification });
    const attemptMetric = metrics.corroborationAttempts.find((attempt) => attempt.eventKey === context.eventKey && attempt.priorityRank === priorityRank);
    if (attemptMetric) {
      attemptMetric.verified = Boolean(context.verification.verified);
      attemptMetric.status = context.verification.status;
    }
    if (context.verification.verified) metrics.corroborationVerified++;
    if (context.verification.status === 'conflicting-sources') metrics.corroborationConflicts++;
  }
}

for (const context of eventContexts) {
  const { eventKey, group, existingEvent } = context;
  const combinedForVerification = context.combinedForVerification;
  const verification = context.verification;
  for (const conflict of verification.conflictingFacts || verification.conflicts || []) {
    incrementMap(metrics.conflictsByField, conflict.field || 'unknown');
    if (conflict.severity === 'critical') metrics.criticalConflicts++;
  }
  for (const difference of verification.nonCriticalDifferences || []) {
    incrementMap(metrics.conflictsByField, difference.field || 'unknown');
    metrics.nonCriticalDifferences++;
  }
  metrics.resolvedComplementaryFacts += (verification.resolvedComplementaryFacts || []).length;

  events.events[eventKey] = buildEventRecord({
    existing: {
      ...existingEvent,
      corroborationAttempts: (existingEvent.corroborationAttempts || 0) + (metrics.corroborationAttempts.some((attempt) => attempt.eventKey === eventKey) ? 1 : 0),
      lastCorroborationQuery: context.corroborationQuery,
      corroborationPriorityRank: metrics.corroborationAttempts.find((attempt) => attempt.eventKey === eventKey)?.priorityRank || existingEvent.corroborationPriorityRank || null,
      corroborationReason: metrics.corroborationAttempts.find((attempt) => attempt.eventKey === eventKey)?.corroborationReason || existingEvent.corroborationReason || ''
    },
    eventKey,
    candidates: combinedForVerification,
    verification
  });

  if (verification.status === 'conflicting-sources') {
    metrics.conflicting++;
    for (const candidate of group) {
      seen.items[candidate.canonicalKey] = {
        seenAt: new Date().toISOString(),
        status: 'conflicting-sources',
        source: candidate.source.id,
        eventKey,
        editorialLane: getLane(verification.editorialLane),
        lastError: 'Conflicto factual critico entre fuentes'
      };
      seen.items[candidate.initialKey] = seen.items[candidate.canonicalKey];
    }
    continue;
  }

  if (!verification.verified) {
    metrics.pendingVerification++;
    incrementMap(metrics.pendingByLane, getLane(verification.editorialLane));
    const basePending = selectBaseCandidate(group);
    const pendingLane = getLane(verification.editorialLane);
    metrics.pendingAudit.push({
      eventKey,
      title: basePending?.title || '',
      sourceId: basePending?.source?.id || '',
      publisherDomain: basePending?.sourceRef?.publisherDomain || '',
      category: basePending?.source?.forceCategory || basePending?.source?.defaultCategory || '',
      eventType: basePending?.facts?.eventType || 'general',
      lane: pendingLane,
      riskLevel: verification.riskLevel,
      exactReason: pendingLane === 'strict'
        ? 'strict-requires-competent-tier-a-or-two-independent-tier-b'
        : pendingLane === 'standard'
          ? 'standard-requires-trusted-tier-b-or-two-independent-tier-b'
          : 'fast-requires-competent-tier-a-or-trusted-local-tier-b',
      missingCondition: 'additional-qualified-source',
      nextRetryAt: events.events[eventKey].nextRetryAt,
      expiresAt: events.events[eventKey].expiresAt,
      corroborationAttempts: events.events[eventKey].corroborationAttempts || 0
    });
    if (getLane(verification.editorialLane) === 'fast') {
      metrics.fastPendingAudit.push({
        eventKey,
        title: basePending?.title || '',
        sourceId: basePending?.source?.id || '',
        publisherDomain: basePending?.sourceRef?.publisherDomain || '',
        tier: basePending?.sourceRef?.tier || '',
        competence: basePending?.sourceRef?.competence || [],
        territory: context.corroborationPriority?.territory || '',
        topic: context.newsworthiness?.topic || '',
        eventType: basePending?.facts?.eventType || 'general',
        riskLevel: verification.riskLevel,
        pendingReason: verification.status,
        status: verification.status
      });
    }
    for (const candidate of group) {
      seen.items[candidate.canonicalKey] = {
        seenAt: new Date().toISOString(),
        status: 'pending-verification',
        source: candidate.source.id,
        eventKey,
        editorialLane: getLane(verification.editorialLane),
        riskLevel: verification.riskLevel,
        nextRetryAt: events.events[eventKey].nextRetryAt,
        expiresAt: events.events[eventKey].expiresAt
      };
      seen.items[candidate.initialKey] = seen.items[candidate.canonicalKey];
    }
    console.log(`  PENDIENTE VERIFICACION [${eventKey}]: ${group.map(c => c.title).join(' | ')}`);
    continue;
  }

  metrics.verified++;
  incrementMap(metrics.verifiedByLane, getLane(verification.editorialLane));
  for (const candidate of group) {
    sourceHealth(candidate.source?.id).verifiedContribution++;
  }
  const baseCandidate = buildProvincialWeatherCandidate(group, verification);
  baseCandidate.verification = verification;
  baseCandidate.newsworthiness = scoreCandidateNewsworthiness(baseCandidate, {
    verification,
    byCategory: metrics.byCategory
  });
  incrementMap(metrics.verifiedByTerritory, baseCandidate.newsworthiness.territory || 'unknown');
  verifiedCandidates.push(baseCandidate);
}

console.log(`Eventos agrupados: ${metrics.eventsGrouped}; verificados: ${metrics.verified}; pendientes: ${metrics.pendingVerification}; conflictos: ${metrics.conflicting}`);

function editorialScore(candidate) {
  if (Number.isFinite(candidate.newsworthiness?.newsworthinessScore)) {
    return candidate.newsworthiness.newsworthinessScore;
  }
  return editorialScoreShared(candidate, metrics.byCategory);
}

// Ordenar usando scoring editorial
verifiedCandidates.sort((a, b) => editorialScore(b) - editorialScore(a));
if (verifiedCandidates.length > 0) {
  const scores = verifiedCandidates.map((candidate) => editorialScore(candidate));
  metrics.newsworthinessAverage = Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
  metrics.newsworthinessTop = verifiedCandidates.slice(0, 10).map((candidate) => ({
    title: candidate.title,
    eventKey: candidate.eventKey,
    score: editorialScore(candidate),
    topic: candidate.newsworthiness?.topic || '',
    territory: candidate.newsworthiness?.territory || '',
    lane: getLane(candidate.verification?.editorialLane)
  }));
}

// Reservar capacidad por tipo sin inmovilizar cupo cuando una clase no tiene demanda.
const officialCandidateCount = verifiedCandidates.filter((candidate) => candidate.isOfficial).length;
const discoveryCandidateCount = verifiedCandidates.length - officialCandidateCount;
const aiBudget = allocateAiBudget({
  maxAi: MAX_AI_PER_RUN,
  officialCandidates: officialCandidateCount,
  discoveryCandidates: discoveryCandidateCount,
  officialFraction: OFFICIAL_AI_BUDGET_FRACTION
});
const officialAiBudget = aiBudget.officialBudget;
const discoveryAiBudget = aiBudget.discoveryBudget;

// Contar por fuente para respetar MAX_PER_SOURCE
const publishedPerSource = {};

// ============================================================
// FASE C — Redacción y publicación con presupuesto balanceado
// ============================================================

console.log(`\n=== FASE C: Redacción y publicación (presupuesto IA: ${MAX_AI_PER_RUN}, oficial: ${officialAiBudget}, descubrimiento: ${discoveryAiBudget}) ===`);

let officialAiUsed = 0;
let discoveryAiUsed = 0;
let draftCount = 0;
let normalPublished = 0;
const remainingToDailyMin = Math.max(0, DAILY_TARGET_MIN - publishedLast24hBeforeRun);
const dailySlotsRemaining = Math.max(0, DAILY_TARGET_MAX - publishedLast24hBeforeRun);
const effectiveRunTarget = Math.min(
  MAX_NORMAL_PUBLISHED_PER_RUN,
  Math.max(TARGET_PUBLISHED_PER_RUN, Math.ceil(remainingToDailyMin / Math.max(1, EXPECTED_RUNS_PER_DAY)))
);
const effectiveRunMaxNormal = Math.min(MAX_NORMAL_PUBLISHED_PER_RUN, dailySlotsRemaining);
metrics.dailyTarget = {
  min: DAILY_TARGET_MIN,
  max: DAILY_TARGET_MAX,
  publishedLast24hBeforeRun,
  remainingToMin: remainingToDailyMin,
  slotsRemaining: dailySlotsRemaining,
  effectiveRunTarget,
  effectiveRunMaxNormal
};

for (const candidate of verifiedCandidates) {
  const { source, item, article, initialKey, canonicalKey, title, isOfficial, pubDate, sourceRef, verification, eventKey } = candidate;

  // Verificar límite por fuente
  const sourceCount = publishedPerSource[source.id] || 0;
  if (sourceCount >= MAX_PER_SOURCE) {
    metrics.discardedSourceLimit++;
    // Guardar como borrador por límite de fuente, reintentable
    if (draftCount < MAX_DRAFTS_PER_RUN) {
      await saveDraft(candidate, 'source-limit');
      draftCount++;
    }
    continue;
  }

  // Verificar presupuesto IA por tipo
  const budget = isOfficial ? officialAiBudget : discoveryAiBudget;
  const used = isOfficial ? officialAiUsed : discoveryAiUsed;
  const totalUsed = officialAiUsed + discoveryAiUsed;
  const previousState = seen.items[canonicalKey] || seen.items[initialKey] || {};
  const cachedAi = previousState.aiResult || null;

  const canPublish = Boolean(cachedAi) || (totalUsed < MAX_AI_PER_RUN && used < budget);
  if (!canPublish) {
    metrics.discardedNoAiBudget++;
    metrics.budgetDeferred++;
    if (draftCount < MAX_DRAFTS_PER_RUN) {
      await saveDraft(candidate, 'no-ai-budget', {
        status: 'budget-deferred',
        nextRetryAt: getNextRetryAt(0),
        resumeFrom: 'ai'
      });
      draftCount++;
      metrics.drafts++;
    }
    continue;
  }

  if (canPublish) {
    let ai = cachedAi;
    let aiCompleted = Boolean(cachedAi);
    try {
      if (!ai) {
        if (isOfficial) officialAiUsed++;
        else discoveryAiUsed++;
        metrics.aiAttempts++;
        ai = await writeArticleWithModel({
          sourceName: source.name,
          sourceUrl: sourceRef.url || article.finalUrl,
          sourceTitle: article.title || item.title,
          sourceDescription: article.description || item.description,
          sourceText: article.text,
          defaultCategory: source.forceCategory || source.defaultCategory,
          defaultLocation: source.location,
          verifiedFacts: verification?.verifiedFacts || null
        });
        metrics.aiCalls++;
      } else {
        metrics.aiReused++;
      }

      const factualValidation = validateArticleAgainstFacts(ai, verification || {});
      if (!factualValidation.ok) {
        const validationError = new Error(`${factualValidation.code}: ${JSON.stringify(factualValidation.mismatches).slice(0, 300)}`);
        validationError.code = factualValidation.code;
        validationError.mismatches = factualValidation.mismatches;
        throw validationError;
      }
      aiCompleted = true;
      metrics.articlesDrafted++;

      // Resolver jerarquía territorial y de ubicación determinísticamente
      const territoryResolution = resolvePublicationTerritory({
        title: ai.title,
        description: ai.description,
        body: ai.body,
        verifiedFacts: verification?.verifiedFacts || {},
        agendaTerritory: candidate.newsworthiness?.territory || '',
        source,
        sourceUrl: sourceRef.url || article.finalUrl
      });
      ai.category = territoryResolution.category;
      ai.location = territoryResolution.location;

      ai.importance = deriveEffectiveImportance(ai.importance, candidate.newsworthiness || {});

      // Si la fuente tiene minImportance, descartar si la IA le dio importancia menor
      if (source.minImportance && ai.importance < source.minImportance) {
        console.log(`  DESCARTADA por threshold editorial (importance ${ai.importance} < ${source.minImportance}): ${ai.title}`);
        metrics.discardedImportance++;
        seen.items[canonicalKey] = {
          seenAt: new Date().toISOString(),
          status: 'discarded-editorial',
          source: source.id,
          editorialReason: 'importance-threshold'
        };
        seen.items[initialKey] = seen.items[canonicalKey];
        continue;
      }

      const publicationLimit = canPublishWithinRunLimit({
        importance: ai.importance,
        normalPublished,
        target: effectiveRunTarget,
        maxNormal: effectiveRunMaxNormal,
        extraSlotMinImportance: EXTRA_SLOT_MIN_IMPORTANCE,
        dailyPublished: publishedLast24hBeforeRun + normalPublished,
        dailyTargetMax: DAILY_TARGET_MAX
      });
      const isUrgent = publicationLimit.urgent;
      if (!publicationLimit.ok) {
        metrics.discardedPublicationLimit++;
        if (draftCount < MAX_DRAFTS_PER_RUN) {
          await saveDraft(candidate, publicationLimit.reason, {
            status: 'publication-deferred',
            nextRetryAt: getNextRetryAt(0),
            resumeFrom: 'publication',
            aiResult: ai
          });
          draftCount++;
          metrics.drafts++;
        }
        continue;
      }
      metrics.approvedForPublication++;

      if (!PERSIST_OUTPUTS) {
        console.log(`[DIAGNOSTICO] Publicaria [${source.id}]: ${ai.title}`);
        existingUrls.add(canonicalizeNewsUrl(sourceRef.url || article.finalUrl));
        existingTitles.add(ai.title.toLowerCase());
        publishedPerSource[source.id] = (publishedPerSource[source.id] || 0) + 1;
        sourceHealth(source.id).publicationContribution++;
        incrementMap(metrics.publishedByLane, getLane(verification?.editorialLane));
        metrics.published++;
        if (!isUrgent) normalPublished++;
        continue;
      }

      const imageSelection = await selectImageForNews({
        article,
        ai,
        verification,
        sourceArticle: {
          title: article.title || item.title,
          description: article.description || item.description
        }
      });
      let image = imageSelection.image;
      let imageMeta = imageSelection.meta;
      if (imageSelection.imageAlt) ai.imageAlt = imageSelection.imageAlt;
      logImageSelection(imageSelection);
      metrics.imageSelections.push({
        title: ai.title,
        strategy: imageMeta?.strategy || '',
        query: imageMeta?.query || '',
        score: imageMeta?.score || 0,
        source: imageMeta?.sourceUrl || ''
      });
      if (!image || imageMeta?.strategy === 'fallback-plate') metrics.imageErrors++;

      const publicationDate = new Date();

      if (!image) {
        const plateFilename = `plate-${datePrefix(publicationDate)}-${canonicalKey.slice(0, 8)}.jpg`;
        const localPath = path.join(ROOT, 'public/uploads/auto', plateFilename);
        const plateResult = await generateWebPlate({ title: ai.title, category: ai.category, outputPath: localPath });
        if (plateResult) image = `/uploads/auto/${plateFilename}`;
        imageMeta = {
          strategy: 'fallback-plate',
          query: imageMeta?.query || ai.title,
          score: 0,
          sourceUrl: '',
          credit: 'Actualidad Fueguina',
          license: 'Imagen generada internamente'
        };
      }
      if (image) metrics.imagesResolved++;

      const filename = `${datePrefix(publicationDate)}-${slugify(ai.title)}.md`;
      const target = path.join(NEWS_DIR, filename);
      const featured = ai.importance >= 9;

      await fs.writeFile(target, makeNewsMarkdown({
        ai,
        date: publicationDate,
        image,
        sourceName: source.name,
        sourceUrl: sourceRef.url || article.finalUrl,
        featured,
        imageMeta,
        sourcePublishedAt: pubDate
      }), 'utf8');

      if (events.events?.[eventKey]) {
        events.events[eventKey].status = 'published';
        events.events[eventKey].publishedAt = publicationDate.toISOString();
        events.events[eventKey].publishedFile = path.relative(ROOT, target);
        events.events[eventKey].newsworthiness = candidate.newsworthiness || null;
      }

      // Actualizar índice en memoria para deduplicar dentro del mismo run
      existingUrls.add(canonicalizeNewsUrl(sourceRef.url || article.finalUrl));
      existingTitles.add(ai.title.toLowerCase());

      publishedPerSource[source.id] = (publishedPerSource[source.id] || 0) + 1;
      sourceHealth(source.id).publicationContribution++;
      metrics.published++;
      incrementMap(metrics.publishedByLane, getLane(verification?.editorialLane));
      if (!isUrgent) normalPublished++;
      metrics.byCategory[ai.category] = (metrics.byCategory[ai.category] || 0) + 1;

      seen.items[canonicalKey] = {
        seenAt: new Date().toISOString(),
        status: 'published',
        source: source.id,
        file: path.relative(ROOT, target)
      };
      seen.items[initialKey] = seen.items[canonicalKey];
      for (const related of candidate.relatedCandidates || []) {
        const relatedRecord = {
          seenAt: new Date().toISOString(),
          status: 'published',
          source: related.source?.id || source.id,
          file: path.relative(ROOT, target),
          eventKey: candidate.eventKey
        };
        if (related.canonicalKey) seen.items[related.canonicalKey] = relatedRecord;
        if (related.initialKey) seen.items[related.initialKey] = relatedRecord;
      }

      console.log(`✓ PUBLICADA [${source.id}]: ${ai.title}`);
      await sleep(1200);
      continue;

    } catch (error) {
      console.warn(`Falló etapa ${aiCompleted ? 'de publicación' : 'de redacción'} (${source.name}): ${error.message}`);
      if (error.code === 'BLOCKED_FACTUAL_MISMATCH' || error.message.includes('FACT_CHECK_FAILED') || error.message.includes('BLOCKED_FACTUAL_MISMATCH')) {
        metrics.factualValidationErrors++;
        seen.items[canonicalKey] = {
          seenAt: new Date().toISOString(),
          status: 'discarded-editorial',
          source: source.id,
          validationVersion: FACTUAL_VALIDATION_VERSION,
          lastError: error.message.slice(0, 200)
        };
        seen.items[initialKey] = seen.items[canonicalKey];
        continue; // descartar permanentemente
      }

      if (aiCompleted) metrics.publicationErrors++;
      else metrics.modelErrors++;
      const retry = buildRetryState({
        previous: previousState,
        error,
        stage: aiCompleted ? 'publication' : 'ai',
        aiResult: aiCompleted ? ai : null,
        maxAttempts: MAX_RETRY_ATTEMPTS
      });
      recordFailure(retry);
      seen.items[canonicalKey] = {
        ...retry,
        seenAt: new Date().toISOString(),
        source: source.id
      };
      seen.items[initialKey] = seen.items[canonicalKey];
      if (retry.status === 'failed-retryable' && draftCount < MAX_DRAFTS_PER_RUN) {
        await saveDraft(candidate, retry.failureReason, retry);
        draftCount++;
        metrics.drafts++;
      }
    }
  }
}

async function saveDraft(candidate, reason, state = {}) {
  const { source, item, article, initialKey, canonicalKey, isOfficial } = candidate;
  const title = article.title || item.title || 'nota-detectada';
  const pubDate = safeDate(article.date || item.pubDate || new Date());
  const filename = `${datePrefix(pubDate)}-${slugify(title)}-${canonicalKey.slice(0, 6)}.md`;
  const target = path.join(DRAFTS_DIR, filename);
  if (!PERSIST_OUTPUTS) {
    console.log(`  DIAGNOSTICO BORRADOR [${reason}]: ${title}`);
    return;
  }
  await fs.writeFile(target, makeDraftMarkdown({
    item, article, source,
    mode: isOfficial ? 'official-review' : 'discovery-review'
  }), 'utf8');
  seen.items[canonicalKey] = {
    ...state,
    seenAt: new Date().toISOString(),
    status: state.status || 'draft',
    source: source.id,
    draftReason: reason,
    file: path.relative(ROOT, target)
  };
  seen.items[initialKey] = seen.items[canonicalKey];
  console.log(`  BORRADOR [${reason}]: ${title}`);
}

const agenda = buildEditorialAgenda(events, {
  verifiedCandidates,
  metrics
});

for (const item of runnableRescueItems) {
  const state = seen.items[item.lastSeenKey] || {};
  if (!state.status) continue;
  item.attempts = Number(state.attempts) || Number(item.attempts) || 0;
  item.lastAttemptAt = state.lastAttemptAt || new Date().toISOString();
  item.lastError = state.lastError || '';
  item.nextRetryAt = state.nextRetryAt || null;
  item.resumeFrom = state.resumeFrom || item.resumeFrom || 'extraction';
  if (state.status === 'published') {
    item.status = 'rescued';
    item.completedAt = new Date().toISOString();
    item.publishedFile = state.file || '';
    metrics.rescueSucceeded++;
  } else if (state.status === 'duplicate') {
    item.status = 'duplicate';
    item.completedAt = new Date().toISOString();
  } else if (['failed-final', 'discarded-quality', 'discarded-editorial', 'conflicting-sources'].includes(state.status)) {
    item.status = 'rejected-terminal';
    item.completedAt = new Date().toISOString();
    metrics.rescueExhausted++;
  } else {
    item.status = state.status === 'pending-verification' ? 'rescue-pending' : state.status;
  }
}
metrics.agendaStories = agenda.summary.totalStories;
metrics.agendaTop = agenda.summary.topStories.slice(0, 5);
metrics.agendaInvalidStories = agenda.summary.invalidStories || 0;
metrics.technicalSuccess = true;
metrics.editorialOutcome = classifyEditorialOutcome(metrics);

function finalizeSourceHealth() {
  for (const source of config.sources) sourceHealth(source.id);
  let healthy = 0;
  let productive = 0;
  let noResults = 0;
  let failed = 0;
  for (const health of Object.values(metrics.sourceHealth)) {
    const denominator = Math.max(health.detected, health.materialized, health.freshCandidates, health.verifiedContribution, health.publicationContribution, 1);
    health.freshCandidateRate = health.detected ? Math.round((health.freshCandidates / denominator) * 100) / 100 : 0;
    health.materializationSuccessRate = health.detected ? Math.round((health.materialized / denominator) * 100) / 100 : 0;
    health.verificationContributionRate = health.detected ? Math.round((health.verifiedContribution / denominator) * 100) / 100 : 0;
    health.publicationContributionRate = health.detected ? Math.round((health.publicationContribution / denominator) * 100) / 100 : 0;
    health.staleDiscardRate = health.detected ? Math.round((health.staleDiscarded / denominator) * 100) / 100 : 0;
    if (health.fetchErrors > 0 && health.detected === 0) {
      health.status = 'unhealthy';
      health.issueCategory = 'fetch-error';
      failed++;
    } else if (health.detected === 0) {
      health.status = 'unhealthy';
      health.issueCategory = 'zero-items';
      noResults++;
    } else if (health.materialized === 0) {
      health.status = 'idle';
      health.issueCategory = 'no-new-materializable-items';
      healthy++;
    } else if (health.freshCandidates === 0) {
      health.status = 'degraded';
      health.issueCategory = health.staleDiscarded > 0 ? 'stale-or-evergreen' : 'zero-useful-candidates';
      healthy++;
    } else {
      health.status = 'healthy';
      health.issueCategory = '';
      healthy++;
      productive++;
    }
  }
  metrics.sourceHealthSummary = {
    configured: config.sources.length,
    consulted: metrics.sourcesConsulted,
    healthy,
    productive,
    noResults,
    failed
  };
}

function summarizeLatency() {
  metrics.latency = summarizeEditorialLatency(events.events || {});
}

finalizeSourceHealth();
summarizeLatency();

if (PERSIST_OUTPUTS) {
  await saveSeen(seen);
  await saveEvents(events);
  await saveRescueQueue(rescueQueue);
  await saveEditorialAgenda(agenda);
  await saveRunMetrics(metrics, {
    maxAiPerRun: MAX_AI_PER_RUN,
    officialAiUsed,
    officialAiBudget,
    discoveryAiUsed,
    discoveryAiBudget,
    aiConcurrency: 1,
    maxRetryAttempts: MAX_RETRY_ATTEMPTS,
    maxRescuePerRun: MAX_RESCUE_PER_RUN,
    maxPendingRecoveryPerRun: MAX_PENDING_RECOVERY_PER_RUN,
    maxPendingCorroborationAttempts: MAX_PENDING_CORROBORATION_ATTEMPTS,
    targetPublishedPerRun: TARGET_PUBLISHED_PER_RUN,
    effectiveRunTarget,
    maxNormalPublishedPerRun: MAX_NORMAL_PUBLISHED_PER_RUN,
    effectiveRunMaxNormal,
    extraSlotMinImportance: EXTRA_SLOT_MIN_IMPORTANCE,
    dailyTargetMin: DAILY_TARGET_MIN,
    dailyTargetMax: DAILY_TARGET_MAX,
    publishedLast24hBeforeRun,
    candidatesMaterialized: candidatesToMaterialize.length,
    totalCandidatesBeforeLimit: allCandidates.length
  });
} else {
  console.log('Modo diagnostico: seen.json y events.json no fueron modificados.');
}

// ============================================================
// Métricas del run (visibles en GitHub Actions)
// ============================================================
const categoryStr = Object.entries(metrics.byCategory)
  .map(([k, v]) => `${k}: ${v}`)
  .join(' | ') || 'ninguna';

console.log(`
📊 RESUMEN DEL RUN
  Fuentes consultadas: ${metrics.sourcesConsulted}
  Candidatos detectados: ${metrics.candidatesDetected}
  Candidatos ingeridos/materializados/frescos/aprobados: ${metrics.candidatesIngested}/${metrics.extractionSucceeded}/${metrics.freshCandidates}/${metrics.candidatesApproved}
  Descartados (duplicados): ${metrics.discardedDuplicate}
  Descartados (genérico): ${metrics.discardedGenericTitle}
  Descartados (calidad): ${metrics.discardedQuality}
  Errores de extracción: ${metrics.extractErrors}
  Eventos agrupados: ${metrics.eventsGrouped}
  Eventos verificados: ${metrics.verified}
  Pending-verification: ${metrics.pendingVerification}
  Conflictos: ${metrics.conflicting}
  Bloqueos de validacion factual: ${metrics.factualValidationErrors}
  Errores reales de modelo: ${metrics.modelErrors}
  Errores posteriores de publicación: ${metrics.publicationErrors}
  Errores de imagen: ${metrics.imageErrors}
  Noticias publicadas: ${metrics.published}
  Redactadas/imagen resuelta/aprobadas para publicar: ${metrics.articlesDrafted}/${metrics.imagesResolved}/${metrics.approvedForPublication}
  Historias en agenda: ${metrics.agendaStories}
  Newsworthiness promedio verificado: ${metrics.newsworthinessAverage}
  Descartados por cupo editorial de corrida: ${metrics.discardedPublicationLimit}
  Borradores generados: ${metrics.drafts}
  IA intentada/respondida: ${metrics.aiAttempts}/${metrics.aiCalls} de ${MAX_AI_PER_RUN} (oficial: ${officialAiUsed}/${officialAiBudget}, descubrimiento: ${discoveryAiUsed}/${discoveryAiBudget})
  IA reutilizada sin nueva llamada: ${metrics.aiReused}
  Diferidos por presupuesto: ${metrics.budgetDeferred}
  Fallos reintentables/terminales: ${metrics.failedRetryable}/${metrics.failedTerminal}
  Rescate intentado/exitoso/agotado: ${metrics.rescueAttempted}/${metrics.rescueSucceeded}/${metrics.rescueExhausted}
  Cupo editorial: objetivo ${TARGET_PUBLISHED_PER_RUN}, maximo normal ${MAX_NORMAL_PUBLISHED_PER_RUN}, extra desde importancia ${EXTRA_SLOT_MIN_IMPORTANCE}
  Por categoría: ${categoryStr}
`);

console.log('RESUMEN ESTRUCTURADO DEL RUN', JSON.stringify({
  discardedQualityByReason: metrics.discardedQualityByReason,
  discardedBySourceAndReason: metrics.discardedBySourceAndReason,
  discardedEvergreen: metrics.discardedEvergreen,
  verifiedByLane: metrics.verifiedByLane,
  pendingByLane: metrics.pendingByLane,
  eventsByTerritory: metrics.eventsByTerritory,
  verifiedByTerritory: metrics.verifiedByTerritory,
  fastPendingAudit: metrics.fastPendingAudit,
  pendingAudit: metrics.pendingAudit,
  pendingLifecycle: {
    recoveryAttempted: metrics.pendingRecoveryAttempted,
    terminalizedExpired: metrics.pendingTerminalizedExpired,
    terminalizedAttempts: metrics.pendingTerminalizedAttempts
  },
  freshCandidates: metrics.freshCandidates,
  staleDiscarded: metrics.staleDiscarded,
  sourceHealth: metrics.sourceHealth,
  sourceHealthSummary: metrics.sourceHealthSummary,
  sourceDeprioritized: metrics.sourceDeprioritized,
  recentEventRepair: metrics.recentEventRepair,
  deduplication: {
    exactUrl: metrics.duplicateExactUrl,
    exactContent: metrics.duplicateExactContent,
    publishedEvent: metrics.duplicatePublishedEvent
  },
  retryAndRescue: {
    budgetDeferred: metrics.budgetDeferred,
    failedRetryable: metrics.failedRetryable,
    failedRetryableByReason: metrics.failedRetryableByReason,
    failedTerminal: metrics.failedTerminal,
    failedTerminalByReason: metrics.failedTerminalByReason,
    aiReused: metrics.aiReused,
    rescueQueued: metrics.rescueQueued,
    rescueAttempted: metrics.rescueAttempted,
    rescueSucceeded: metrics.rescueSucceeded,
    rescueExhausted: metrics.rescueExhausted
  },
  publishedByLane: metrics.publishedByLane,
  pendingMatchedFromHistory: metrics.pendingMatchedFromHistory,
  corroboration: {
    searches: metrics.corroborationSearches,
    found: metrics.corroborationFound,
    verified: metrics.corroborationVerified,
    conflicts: metrics.corroborationConflicts,
    noResult: metrics.corroborationNoResult,
    attempts: metrics.corroborationAttempts
  },
  conflictsByField: metrics.conflictsByField,
  criticalConflicts: metrics.criticalConflicts,
  nonCriticalDifferences: metrics.nonCriticalDifferences,
  resolvedComplementaryFacts: metrics.resolvedComplementaryFacts,
  latency: metrics.latency,
  agendaStories: metrics.agendaStories,
  agendaInvalidStories: metrics.agendaInvalidStories,
  newsworthinessTop: metrics.newsworthinessTop,
  publicationWindows: {
    publishedLast3hBeforeRun: metrics.publishedLast3hBeforeRun,
    publishedLast6hBeforeRun: metrics.publishedLast6hBeforeRun,
    publishedLast12hBeforeRun: metrics.publishedLast12hBeforeRun,
    publishedLast24hBeforeRun: metrics.publishedLast24hBeforeRun,
    hoursSinceLastPublicationBeforeRun: metrics.hoursSinceLastPublicationBeforeRun
  },
  dailyTarget: metrics.dailyTarget,
  technicalSuccess: metrics.technicalSuccess,
  editorialOutcome: metrics.editorialOutcome
}, null, 2));

async function saveRunMetrics(currentMetrics, extra = {}) {
  const metricsPath = path.join(ROOT, 'data/news-run-metrics.json');
  const payload = {
    generatedAt: new Date().toISOString(),
    run: {
      persistOutputs: PERSIST_OUTPUTS,
      githubActions: process.env.GITHUB_ACTIONS === 'true',
      eventName: process.env.GITHUB_EVENT_NAME || '',
      runId: process.env.GITHUB_RUN_ID || '',
      headSha: process.env.GITHUB_SHA || ''
    },
    metrics: currentMetrics,
    budget: extra,
    reasonNoMorePublished: explainNoMorePublished(currentMetrics, extra)
  };
  await fs.mkdir(path.dirname(metricsPath), { recursive: true });
  await fs.writeFile(metricsPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function classifyEditorialOutcome(currentMetrics = {}) {
  if ((currentMetrics.published || 0) > 0) return 'published';
  if ((currentMetrics.verified || 0) > 0 && (currentMetrics.discardedPublicationLimit || 0) > 0) return 'publication-limit';
  if ((currentMetrics.verified || 0) > 0 && (currentMetrics.discardedNoAiBudget || 0) > 0) return 'ai-budget-limit';
  if ((currentMetrics.pendingVerification || 0) > 0 && (currentMetrics.verified || 0) === 0) return 'verification-starved';
  if ((currentMetrics.discardedQuality || 0) > 0 && (currentMetrics.discardedQuality || 0) >= Math.max(1, (currentMetrics.candidatesDetected || 0) * 0.5)) {
    return 'quality-filter-dominated';
  }
  if ((currentMetrics.discardedDuplicate || 0) > 0 && (currentMetrics.discardedDuplicate || 0) >= Math.max(1, (currentMetrics.candidatesDetected || 0) * 0.5)) {
    return 'duplicate-dominated';
  }
  return 'no-publishable-story';
}

function explainNoMorePublished(currentMetrics, extra = {}) {
  const reasons = [];
  if (currentMetrics.pendingVerification > 0) reasons.push(`${currentMetrics.pendingVerification} evento(s) quedaron pendientes de segunda fuente`);
  if (currentMetrics.conflicting > 0) reasons.push(`${currentMetrics.conflicting} evento(s) tuvieron conflicto factual`);
  if (currentMetrics.discardedDuplicate > 0) reasons.push(`${currentMetrics.discardedDuplicate} candidato(s) descartados por duplicado/similitud`);
  if (currentMetrics.discardedQuality > 0) {
    const detail = Object.entries(currentMetrics.discardedQualityByReason || {})
      .map(([reason, count]) => `${reason}: ${count}`)
      .join(', ');
    reasons.push(`${currentMetrics.discardedQuality} candidato(s) descartados por causas especificas (${detail || 'sin detalle'})`);
  }
  if (currentMetrics.discardedImportance > 0) reasons.push(`${currentMetrics.discardedImportance} candidato(s) descartados por importancia editorial`);
  if (currentMetrics.discardedSourceLimit > 0) reasons.push(`${currentMetrics.discardedSourceLimit} candidato(s) quedaron por limite por fuente`);
  if (currentMetrics.discardedNoAiBudget > 0) reasons.push(`${currentMetrics.discardedNoAiBudget} candidato(s) quedaron sin presupuesto IA`);
  if (currentMetrics.discardedPublicationLimit > 0) reasons.push(`${currentMetrics.discardedPublicationLimit} candidato(s) quedaron por cupo editorial de corrida`);
  if (currentMetrics.factualValidationErrors > 0) reasons.push(`${currentMetrics.factualValidationErrors} candidato(s) bloqueados por validacion factual`);
  if (currentMetrics.modelErrors > 0) reasons.push(`${currentMetrics.modelErrors} error(es) reales de modelo`);
  if (currentMetrics.publicationErrors > 0) reasons.push(`${currentMetrics.publicationErrors} error(es) posteriores de publicacion quedaron para retry`);
  if ((extra.totalCandidatesBeforeLimit || 0) > (extra.candidatesMaterialized || 0)) {
    reasons.push(`${extra.totalCandidatesBeforeLimit - extra.candidatesMaterialized} candidato(s) no se materializaron por limite anti-timeout`);
  }
  return reasons.length ? reasons : ['No habia mas candidatos verificados y publicables en este run'];
}
