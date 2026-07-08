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
  ROOT, NEWS_DIR, DRAFTS_DIR, ensureDirs, loadSeen, saveSeen, hash, slugify,
  safeDate, datePrefix, fetchText, stripHtml, extractIndexLinks, extractArticle,
  isOfficialDomain, writeArticleWithModel, makeNewsMarkdown, makeDraftMarkdown, sleep,
  generateWebPlate
} from './lib/news-utils.mjs';
import {
  extractFingerprint as extractFingerprintShared,
  isGenericTitle as isGenericTitleShared,
  isSimilarTitle as isSimilarTitleShared,
  isEventAlreadyPublished as isEventAlreadyPublishedShared,
  isRetryEligible as isRetryEligibleShared,
  getNextRetryAt as getNextRetryAtShared,
  editorialScore as editorialScoreShared
} from './lib/pipeline-utils.mjs';
import { buildSourceRef, validateArticleSource } from './lib/source-policy.mjs';
import {
  loadEvents,
  saveEvents,
  extractFacts,
  generateEventKey,
  corroborateEvent,
  selectBaseCandidate,
  validateArticleAgainstFacts,
  buildEventRecord
} from './lib/factual-utils.mjs';
import { selectImageForNews, logImageSelection } from './lib/image-plan.mjs';

const parser = new Parser();
const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config/sources.json'), 'utf8'));
const seen = await loadSeen();
const events = await loadEvents();
await ensureDirs();

// ============================================================
// Configuración
// ============================================================
const MAX_AI_PER_RUN = Number(process.env.AF_MAX_AI_PER_RUN || 8);
const MAX_DRAFTS_PER_RUN = Number(process.env.AF_MAX_DRAFTS_PER_RUN || 10);
const MAX_PER_SOURCE = Number(process.env.AF_MAX_PER_SOURCE || 2);
const MAX_MATERIALIZE_PER_RUN = Number(process.env.AF_MAX_MATERIALIZE_PER_RUN || 36);
const RSS_TIMEOUT_MS = Number(process.env.AF_RSS_TIMEOUT_MS || 15000);
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

// Retry window e backoff
const DRAFT_RETRY_WINDOWS_MS = [3 * 60 * 60 * 1000, 6 * 60 * 60 * 1000, 12 * 60 * 60 * 1000]; // 3h, 6h, 12h
const STALE_AFTER_MS = 48 * 60 * 60 * 1000; // 48h → pasa a stale

// Métricas
const metrics = {
  sourcesConsulted: 0,
  candidatesDetected: 0,
  discardedDuplicate: 0,
  discardedQuality: 0,
  discardedGenericTitle: 0,
  eventsGrouped: 0,
  verified: 0,
  pendingVerification: 0,
  conflicting: 0,
  published: 0,
  drafts: 0,
  modelErrors: 0,
  discardedImportance: 0,
  discardedSourceLimit: 0,
  discardedNoAiBudget: 0,
  extractErrors: 0,
  imageErrors: 0,
  aiCalls: 0,
  imageSelections: [],
  byCategory: {}
};

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
const publishedEventFingerprints = new Set();

function extractFingerprint(title) {
  return extractFingerprintShared(title);
}

function isEventAlreadyPublished(title) {
  return isEventAlreadyPublishedShared(title, publishedEventFingerprints);
}


async function indexPublishedDocs() {
  try {
    for (const file of await fs.readdir(NEWS_DIR)) {
      if (!file.endsWith('.md')) continue;
      const content = await fs.readFile(path.join(NEWS_DIR, file), 'utf8');
      const urlMatch = content.match(/^sourceUrl:\s*['"](.*?)['"]$/m);
      if (urlMatch) existingUrls.add(urlMatch[1].trim());
      const titleMatch = content.match(/^title:\s*['"](.*?)['"]$/m);
      if (titleMatch) {
        const titleStr = titleMatch[1].trim();
        existingTitles.add(titleStr.toLowerCase());
        const fp = extractFingerprint(titleStr);
        if (fp) publishedEventFingerprints.add(fp);
      }
    }
  } catch {}
}

function isGenericTitle(title) {
  return isGenericTitleShared(title);
}

function isSimilarTitle(newTitle) {
  return isSimilarTitleShared(newTitle, existingTitles);
}

await indexPublishedDocs();
console.log(`Índice de deduplicación (solo publicadas): ${existingUrls.size} URLs y ${existingTitles.size} títulos.`);

// ============================================================
// FASE A — Recolección global en paralelo
// ============================================================

async function readSource(source) {
  if (source.type === 'rss') {
    const { text } = await fetchText(source.url, { timeoutMs: source.timeoutMs || RSS_TIMEOUT_MS });
    const feed = await parser.parseString(text);
    let items = (feed.items || []).map((item) => ({
      title: item.title || '',
      link: item.link || item.guid || '',
      pubDate: item.isoDate || item.pubDate || '',
      description: stripHtml(item.contentSnippet || item.content || item.summary || '')
    }));

    // Filtrar por palabras clave si la fuente lo requiere (fuentes nacionales)
    if (source.filterKeywords && source.filterKeywords.length > 0) {
      const keywords = source.filterKeywords.map(k => k.toLowerCase());
      items = items.filter(item => {
        const text = `${item.title} ${item.description}`.toLowerCase();
        return keywords.some(k => text.includes(k));
      });
    }

    return items.slice(0, source.maxItems || 5);
  }
  if (source.type === 'html-index') {
    const { text } = await fetchText(source.url, { timeoutMs: 30000 });
    return extractIndexLinks(text, source.url, source.linkPattern)
      .slice(0, source.maxItems || 5)
      .map((item) => ({ ...item, pubDate: '', description: '' }));
  }
  throw new Error(`Tipo de fuente no soportado: ${source.type}`);
}

async function materialize(item) {
  const { text, finalUrl } = await fetchText(item.link, { timeoutMs: 20000 });
  return extractArticle(text, finalUrl);
}

// Verificar si un item en seen.json es elegible para retry (con backoff)
function isRetryEligible(seenItem) {
  return isRetryEligibleShared(seenItem);

  if (!seenItem) return false;
  if (['published', 'duplicate', 'discarded-editorial', 'stale'].includes(seenItem.status)) return false;
  if (!['draft', 'extract-error', 'model-error', 'temporary-error'].includes(seenItem.status)) return false;
  const now = Date.now();
  // Si tiene nextRetryAt explícito, respetarlo
  if (seenItem.nextRetryAt) return now >= new Date(seenItem.nextRetryAt).getTime();
  // Fallback: si fue visto hace menos de 48h, es elegible
  const seenAt = new Date(seenItem.seenAt || 0).getTime();
  return (now - seenAt) < STALE_AFTER_MS;
}

function getNextRetryAt(attempts) {
  return getNextRetryAtShared(attempts);

  const windowMs = DRAFT_RETRY_WINDOWS_MS[Math.min(attempts, DRAFT_RETRY_WINDOWS_MS.length - 1)];
  return new Date(Date.now() + windowMs).toISOString();
}

console.log(`\n=== FASE A: Recolección global de ${config.sources.length} fuentes ===`);

const allCandidates = []; // { source, item, initialKey }

await Promise.all(config.sources.map(async (source) => {
  metrics.sourcesConsulted++;
  let items = [];
  try {
    items = await readSource(source);
  } catch (error) {
    console.warn(`[${source.name}] omitida: ${error.message}`);
    return;
  }
  for (const item of items) {
    if (!item.link) continue;
    const initialKey = hash(item.link);
    const seenItem = seen.items[initialKey];

    // Bloquear si ya fue publicado o marcado como duplicado definitivamente
    if (seenItem && ['published', 'duplicate'].includes(seenItem.status)) continue;
    // Si está en estado reintentable, verificar si está dentro de la ventana
    if (seenItem && !isRetryEligible(seenItem)) continue;

    allCandidates.push({ source, item, initialKey });
  }
}));

console.log(`Candidatos pre-filtro de todas las fuentes: ${allCandidates.length}`);
metrics.candidatesDetected = allCandidates.length;
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
for (const candidate of candidatesToMaterialize) {
  const { source, item, initialKey } = candidate;
  let article;
  try {
    article = await materialize(item);
    await sleep(300);
  } catch (error) {
    console.warn(`[${source.name}] Error extracción ${item.link}: ${error.message}`);
    metrics.extractErrors++;
    const attempts = (seen.items[initialKey]?.attempts || 0) + 1;
    seen.items[initialKey] = {
      seenAt: new Date().toISOString(),
      status: 'extract-error',
      source: source.id,
      attempts,
      lastAttemptAt: new Date().toISOString(),
      nextRetryAt: getNextRetryAt(attempts),
      lastError: error.message.slice(0, 200)
    };
    continue;
  }

  const finalUrl = article.finalUrl || item.link;

  const sourceValidation = validateArticleSource({ article, item, source, finalUrl });
  if (!sourceValidation.ok) {
    console.log(`[${source.name}] Descartado por fuente invalida (${sourceValidation.errors.join(', ')}): ${sourceValidation.url}`);
    seen.items[initialKey] = {
      status: 'discarded-quality',
      reason: sourceValidation.errors.join(','),
      seenAt: new Date().toISOString(),
      source: source.id
    };
    metrics.discardedQuality++;
    continue;
  }

  const currentTitle = (article.title || item.title || '').trim();
  const sourceRef = buildSourceRef({ source, item, article, officialDomains: config.officialDomains });
  const facts = extractFacts({
    article,
    item,
    source,
    category: source.forceCategory || source.defaultCategory
  });
  const eventKey = generateEventKey({
    facts,
    title: currentTitle,
    sourceRef
  });

  const canonicalKey = hash(sourceRef.url || finalUrl);

  // Descartar si URL canónica ya vista como publicada
  if (seen.items[canonicalKey] && ['published', 'duplicate', 'discarded-editorial', 'stale'].includes(seen.items[canonicalKey].status)) {
    seen.items[initialKey] = { seenAt: new Date().toISOString(), status: 'duplicate', source: source.id };
    metrics.discardedDuplicate++;
    continue;
  }

  // Descartar si URL ya existe en archivos publicados
  if (existingUrls.has(finalUrl)) {
    seen.items[initialKey] = { seenAt: new Date().toISOString(), status: 'duplicate', source: source.id };
    metrics.discardedDuplicate++;
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

  // Deduplicación por evento (acontecimiento)
  if (isEventAlreadyPublished(currentTitle)) {
    seen.items[initialKey] = { seenAt: new Date().toISOString(), status: 'duplicate', source: source.id };
    metrics.discardedDuplicate++;
    continue;
  }

  const bodyLength = (article.text || '').length;
  if (bodyLength < 400) {
    metrics.discardedQuality++;
    const attempts = (seen.items[initialKey]?.attempts || 0) + 1;
    seen.items[initialKey] = {
      seenAt: new Date().toISOString(),
      status: 'extract-error',
      source: source.id,
      attempts,
      lastAttemptAt: new Date().toISOString(),
      nextRetryAt: getNextRetryAt(attempts),
      lastError: `Texto insuficiente: ${bodyLength} chars`
    };
    continue;
  }

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
    pubDate: safeDate(article.date || item.pubDate || new Date()),
    bodyLength
  });
  
  // Agregar al índice de eventos para deduplicar siguientes candidatos de la misma corrida
  // Intentionally left out: this index is only updated after publication.
}

console.log(`Candidatos válidos después de extracción: ${extracted.length}`);

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

for (const [eventKey, group] of eventsByKey) {
  const existingEvent = events.events?.[eventKey] || {};
  const persistedCandidates = (existingEvent.factsBySource || []).map((entry) => ({
    sourceRef: {
      ...(existingEvent.sources || []).find((source) => source.url === entry.url),
      publisherDomain: entry.publisherDomain,
      url: entry.url
    },
    facts: entry.facts || {},
    bodyLength: 0,
    pubDate: new Date(existingEvent.lastSeenAt || 0)
  }));

  const seenUrls = new Set();
  const combinedForVerification = [...persistedCandidates, ...group].filter((candidate) => {
    const url = candidate.sourceRef?.url || '';
    if (url && seenUrls.has(url)) return false;
    if (url) seenUrls.add(url);
    return true;
  });

  const verification = corroborateEvent({ eventKey, candidates: combinedForVerification });
  events.events[eventKey] = buildEventRecord({
    existing: existingEvent,
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
        lastError: 'Conflicto factual critico entre fuentes'
      };
      seen.items[candidate.initialKey] = seen.items[candidate.canonicalKey];
    }
    continue;
  }

  if (!verification.verified) {
    metrics.pendingVerification++;
    for (const candidate of group) {
      seen.items[candidate.canonicalKey] = {
        seenAt: new Date().toISOString(),
        status: 'pending-verification',
        source: candidate.source.id,
        eventKey,
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
  const baseCandidate = selectBaseCandidate(group);
  baseCandidate.verification = verification;
  verifiedCandidates.push(baseCandidate);
}

console.log(`Eventos agrupados: ${metrics.eventsGrouped}; verificados: ${metrics.verified}; pendientes: ${metrics.pendingVerification}; conflictos: ${metrics.conflicting}`);

function editorialScore(candidate) {
  return editorialScoreShared(candidate, metrics.byCategory);

  const now = Date.now();
  const ageMs = now - (candidate.pubDate || new Date()).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  // Recencia (0-40): decae linealmente en 48h
  const recencyScore = Math.max(0, 40 - (ageHours / 48) * 40);

  // Calidad de extracción (0-20): más texto = mejor
  const bodyLen = candidate.bodyLength || 0;
  const qualityScore = Math.min(20, (bodyLen / 2000) * 20);

  // Relevancia local (0-20): fuentes fueguinas valen más
  let localScore = 0;
  const srcMode = candidate.source?.mode;
  if (srcMode === 'official-auto') localScore = 20;
  else if (candidate.source?.id?.startsWith('bing-')) localScore = 15;
  else if (['infobae-tdf', 'perfil-tdf', 'clarin-tdf'].includes(candidate.source?.id)) localScore = 10;
  else localScore = 5; // nacionales, mundo

  // Bonus diversidad territorial (0-15): categoría no vista aún en este run
  const cat = candidate.source?.defaultCategory;
  const diversityBonus = metrics.byCategory[cat] ? 0 : 15;

  return recencyScore + qualityScore + localScore + diversityBonus;
}

// Ordenar usando scoring editorial
verifiedCandidates.sort((a, b) => editorialScore(b) - editorialScore(a));

// Calcular presupuesto IA por tipo de fuente
const officialAiBudget = Math.ceil(MAX_AI_PER_RUN * OFFICIAL_AI_BUDGET_FRACTION);
const discoveryAiBudget = MAX_AI_PER_RUN - officialAiBudget;

// Contar por fuente para respetar MAX_PER_SOURCE
const publishedPerSource = {};

// ============================================================
// FASE C — Redacción y publicación con presupuesto balanceado
// ============================================================

console.log(`\n=== FASE C: Redacción y publicación (presupuesto IA: ${MAX_AI_PER_RUN}, oficial: ${officialAiBudget}, descubrimiento: ${discoveryAiBudget}) ===`);

let officialAiUsed = 0;
let discoveryAiUsed = 0;
let draftCount = 0;

for (const candidate of verifiedCandidates) {
  const { source, item, article, initialKey, canonicalKey, title, isOfficial, pubDate, sourceRef, verification } = candidate;

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

  const canPublish = totalUsed < MAX_AI_PER_RUN && used < budget;
  if (!canPublish) metrics.discardedNoAiBudget++;

  if (canPublish) {
    try {
      const ai = await writeArticleWithModel({
        sourceName: source.name,
        sourceUrl: sourceRef.url || article.finalUrl,
        sourceTitle: article.title || item.title,
        sourceDescription: article.description || item.description,
        sourceText: article.text,
        defaultCategory: source.forceCategory || source.defaultCategory,
        defaultLocation: source.location,
        verifiedFacts: verification?.verifiedFacts || null
      });

      const factualValidation = validateArticleAgainstFacts(ai, verification || {});
      if (!factualValidation.ok) {
        throw new Error(`${factualValidation.code}: ${JSON.stringify(factualValidation.mismatches).slice(0, 300)}`);
      }

      // Si la fuente tiene forceCategory, sobreescribir la categoría IA
      if (source.forceCategory) ai.category = source.forceCategory;

      // Si la fuente tiene minImportance, descartar si la IA le dio importancia menor
      if (source.minImportance && ai.importance < source.minImportance) {
        console.log(`  DESCARTADA por threshold editorial (importance ${ai.importance} < ${source.minImportance}): ${ai.title}`);
        if (isOfficial) officialAiUsed++; else discoveryAiUsed++; // se consumíó presupuesto igual
        metrics.aiCalls++;
        metrics.discardedImportance++;
        seen.items[initialKey] = { seenAt: new Date().toISOString(), status: 'discarded-editorial', source: source.id };
        continue;
      }

      if (isOfficial) officialAiUsed++;
      else discoveryAiUsed++;
      metrics.aiCalls++;

      if (!PERSIST_OUTPUTS) {
        console.log(`[DIAGNOSTICO] Publicaria [${source.id}]: ${ai.title}`);
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

      if (!image) {
        const plateFilename = `plate-${datePrefix(pubDate)}-${canonicalKey.slice(0, 8)}.jpg`;
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

      const filename = `${datePrefix(pubDate)}-${slugify(ai.title)}.md`;
      const target = path.join(NEWS_DIR, filename);
      const featured = ai.importance >= 9;

      await fs.writeFile(target, makeNewsMarkdown({
        ai, date: pubDate, image,
        sourceName: source.name, sourceUrl: sourceRef.url || article.finalUrl, featured, imageMeta
      }), 'utf8');

      // Actualizar índice en memoria para deduplicar dentro del mismo run
      existingUrls.add(article.finalUrl);
      existingTitles.add(ai.title.toLowerCase());
      publishedEventFingerprints.add(extractFingerprint(ai.title));

      publishedPerSource[source.id] = (publishedPerSource[source.id] || 0) + 1;
      metrics.published++;
      metrics.byCategory[ai.category] = (metrics.byCategory[ai.category] || 0) + 1;

      seen.items[canonicalKey] = {
        seenAt: new Date().toISOString(),
        status: 'published',
        source: source.id,
        file: path.relative(ROOT, target)
      };
      seen.items[initialKey] = seen.items[canonicalKey];

      console.log(`✓ PUBLICADA [${source.id}]: ${ai.title}`);
      await sleep(1200);
      continue;

    } catch (error) {
      console.warn(`Falló redacción automática (${source.name}): ${error.message}`);
      metrics.modelErrors++;
      
      if (error.message.includes('FACT_CHECK_FAILED') || error.message.includes('BLOCKED_FACTUAL_MISMATCH')) {
        seen.items[initialKey] = {
          seenAt: new Date().toISOString(),
          status: 'discarded-editorial',
          source: source.id,
          lastError: error.message.slice(0, 200)
        };
        continue; // descartar permanentemente
      }

      seen.items[initialKey] = {
        seenAt: new Date().toISOString(),
        status: 'model-error',
        source: source.id,
        lastError: error.message.slice(0, 200)
      };
      // Caer en borrador
    }
  }

  // Guardar como borrador (por falta de cupo IA o por error de modelo)
  if (draftCount < MAX_DRAFTS_PER_RUN) {
    await saveDraft(candidate, canPublish ? 'model-error' : 'no-ai-budget');
    draftCount++;
    metrics.drafts++;
  }
}

async function saveDraft(candidate, reason) {
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
    seenAt: new Date().toISOString(),
    status: 'draft',
    source: source.id,
    draftReason: reason,
    file: path.relative(ROOT, target)
  };
  seen.items[initialKey] = seen.items[canonicalKey];
  console.log(`  BORRADOR [${reason}]: ${title}`);
}

if (PERSIST_OUTPUTS) {
  await saveSeen(seen);
  await saveEvents(events);
  await saveRunMetrics(metrics, {
    maxAiPerRun: MAX_AI_PER_RUN,
    officialAiUsed,
    officialAiBudget,
    discoveryAiUsed,
    discoveryAiBudget,
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
  Descartados (duplicados): ${metrics.discardedDuplicate}
  Descartados (genérico): ${metrics.discardedGenericTitle}
  Descartados (calidad): ${metrics.discardedQuality}
  Errores de extracción: ${metrics.extractErrors}
  Eventos agrupados: ${metrics.eventsGrouped}
  Eventos verificados: ${metrics.verified}
  Pending-verification: ${metrics.pendingVerification}
  Conflictos: ${metrics.conflicting}
  Errores de imagen: ${metrics.imageErrors}
  Noticias publicadas: ${metrics.published}
  Borradores generados: ${metrics.drafts}
  IA usada: ${metrics.aiCalls}/${MAX_AI_PER_RUN} (oficial: ${officialAiUsed}/${officialAiBudget}, descubrimiento: ${discoveryAiUsed}/${discoveryAiBudget})
  Por categoría: ${categoryStr}
`);

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

function explainNoMorePublished(currentMetrics, extra = {}) {
  const reasons = [];
  if (currentMetrics.pendingVerification > 0) reasons.push(`${currentMetrics.pendingVerification} evento(s) quedaron pendientes de segunda fuente`);
  if (currentMetrics.conflicting > 0) reasons.push(`${currentMetrics.conflicting} evento(s) tuvieron conflicto factual`);
  if (currentMetrics.discardedDuplicate > 0) reasons.push(`${currentMetrics.discardedDuplicate} candidato(s) descartados por duplicado/similitud`);
  if (currentMetrics.discardedQuality > 0) reasons.push(`${currentMetrics.discardedQuality} candidato(s) descartados por calidad o fuente invalida`);
  if (currentMetrics.discardedImportance > 0) reasons.push(`${currentMetrics.discardedImportance} candidato(s) descartados por importancia editorial`);
  if (currentMetrics.discardedSourceLimit > 0) reasons.push(`${currentMetrics.discardedSourceLimit} candidato(s) quedaron por limite por fuente`);
  if (currentMetrics.discardedNoAiBudget > 0) reasons.push(`${currentMetrics.discardedNoAiBudget} candidato(s) quedaron sin presupuesto IA`);
  if (currentMetrics.modelErrors > 0) reasons.push(`${currentMetrics.modelErrors} error(es) de modelo`);
  if ((extra.totalCandidatesBeforeLimit || 0) > (extra.candidatesMaterialized || 0)) {
    reasons.push(`${extra.totalCandidatesBeforeLimit - extra.candidatesMaterialized} candidato(s) no se materializaron por limite anti-timeout`);
  }
  return reasons.length ? reasons : ['No habia mas candidatos verificados y publicables en este run'];
}
