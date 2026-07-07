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
  isOfficialDomain, downloadImage, callModel, makeNewsMarkdown, makeDraftMarkdown, sleep,
  generateWebPlate, searchWebImage
} from './lib/news-utils.mjs';

const parser = new Parser();
const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config/sources.json'), 'utf8'));
const seen = await loadSeen();
await ensureDirs();

// ============================================================
// Configuración
// ============================================================
const MAX_AI_PER_RUN = Number(process.env.AF_MAX_AI_PER_RUN || 8);
const MAX_DRAFTS_PER_RUN = Number(process.env.AF_MAX_DRAFTS_PER_RUN || 10);
const MAX_PER_SOURCE = Number(process.env.AF_MAX_PER_SOURCE || 2);
// Cuánto del presupuesto IA puede consumir las fuentes municipales/oficiales (0-1)
const OFFICIAL_AI_BUDGET_FRACTION = 0.5;

// Títulos genéricos que NO deben usarse para deduplicación (evitar falsos positivos)
const GENERIC_TITLE_WORDS = new Set([
  'noticias', 'inicio', 'home', 'bienvenido', 'portada', 'hoy',
  'municipio', 'rio', 'grande', 'ushuaia', 'tolhuin', 'fuego', 'tierra',
  'novedades', 'actualidad', 'informacion'
]);

// Retry window para items en draft/extract-error (en ms)
const DRAFT_RETRY_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 horas

// Métricas
const metrics = {
  sourcesConsulted: 0,
  candidatesDetected: 0,
  discardedDuplicate: 0,
  discardedQuality: 0,
  discardedGenericTitle: 0,
  published: 0,
  drafts: 0,
  extractErrors: 0,
  aiCalls: 0,
  byCategory: {}
};

// ============================================================
// Índice de deduplicación — SOLO de noticias PUBLICADAS
// Los borradores NO bloquean futuras publicaciones
// ============================================================
const existingUrls = new Set();
const existingTitles = new Set();

async function indexPublishedDocs() {
  try {
    for (const file of await fs.readdir(NEWS_DIR)) {
      if (!file.endsWith('.md')) continue;
      const content = await fs.readFile(path.join(NEWS_DIR, file), 'utf8');
      const urlMatch = content.match(/^sourceUrl:\s*['"](.*?)['"]$/m);
      if (urlMatch) existingUrls.add(urlMatch[1].trim());
      const titleMatch = content.match(/^title:\s*['"](.*?)['"]$/m);
      if (titleMatch) existingTitles.add(titleMatch[1].trim().toLowerCase());
    }
  } catch {}
}

function isGenericTitle(title) {
  if (!title || title.length < 15) return true;
  const words = (title.toLowerCase().match(/\b\w{4,}\b/g) || []);
  const meaningfulWords = words.filter(w => !GENERIC_TITLE_WORDS.has(w));
  return meaningfulWords.length < 2;
}

function isSimilarTitle(newTitle) {
  if (!newTitle || isGenericTitle(newTitle)) return false;
  const words1 = new Set(newTitle.toLowerCase().match(/\b\w{5,}\b/g) || []);
  if (words1.size < 2) return existingTitles.has(newTitle.toLowerCase());
  for (const oldTitle of existingTitles) {
    const words2 = new Set(oldTitle.match(/\b\w{5,}\b/g) || []);
    if (words2.size < 2) continue;
    const intersection = [...words1].filter(x => words2.has(x)).length;
    const union = new Set([...words1, ...words2]).size;
    if (union > 0 && (intersection / union) > 0.55) return true;
  }
  return false;
}

await indexPublishedDocs();
console.log(`Índice de deduplicación (solo publicadas): ${existingUrls.size} URLs y ${existingTitles.size} títulos.`);

// ============================================================
// FASE A — Recolección global en paralelo
// ============================================================

async function readSource(source) {
  if (source.type === 'rss') {
    const feed = await parser.parseURL(source.url);
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

// Verificar si un item en seen.json es elegible para retry
function isRetryEligible(seenItem) {
  if (!seenItem) return false;
  if (['published', 'duplicate'].includes(seenItem.status)) return false;
  if (['draft', 'extract-error', 'model-error'].includes(seenItem.status)) {
    const seenAt = new Date(seenItem.seenAt || 0).getTime();
    return (Date.now() - seenAt) < DRAFT_RETRY_WINDOW_MS;
  }
  return false;
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

// ============================================================
// FASE B — Extracción, ranking, deduplicación y balance
// ============================================================

console.log(`\n=== FASE B: Extracción y ranking ===`);

// Extraer contenido de cada candidato (en serie para no saturar)
const extracted = [];
for (const candidate of allCandidates) {
  const { source, item, initialKey } = candidate;
  let article;
  try {
    article = await materialize(item);
    await sleep(300);
  } catch (error) {
    console.warn(`[${source.name}] Error extracción ${item.link}: ${error.message}`);
    metrics.extractErrors++;
    seen.items[initialKey] = {
      seenAt: new Date().toISOString(),
      status: 'extract-error',
      source: source.id,
      lastError: error.message.slice(0, 200)
    };
    continue;
  }

  const finalUrl = article.finalUrl || item.link;
  const canonicalKey = hash(finalUrl);
  const currentTitle = (article.title || item.title || '').trim();

  // Descartar si URL canónica ya vista como publicada
  if (seen.items[canonicalKey] && ['published', 'duplicate'].includes(seen.items[canonicalKey].status)) {
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

  const bodyLength = (article.text || '').length;
  if (bodyLength < 400) {
    metrics.discardedQuality++;
    seen.items[initialKey] = {
      seenAt: new Date().toISOString(),
      status: 'extract-error',
      source: source.id,
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
    title: currentTitle,
    isOfficial: source.mode === 'official-auto' || isOfficialDomain(finalUrl, config.officialDomains),
    pubDate: safeDate(article.date || item.pubDate || new Date()),
    bodyLength
  });
}

console.log(`Candidatos válidos después de extracción: ${extracted.length}`);

// Ordenar: más reciente primero, luego mayor cuerpo (proxy de importancia)
extracted.sort((a, b) => {
  const dateDiff = b.pubDate - a.pubDate;
  if (Math.abs(dateDiff) > 60 * 60 * 1000) return dateDiff; // Diferencia > 1h: priorizar más reciente
  return b.bodyLength - a.bodyLength;
});

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

for (const candidate of extracted) {
  const { source, item, article, initialKey, canonicalKey, title, isOfficial, pubDate } = candidate;

  // Verificar límite por fuente
  const sourceCount = publishedPerSource[source.id] || 0;
  if (sourceCount >= MAX_PER_SOURCE) {
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

  if (canPublish) {
    try {
      const ai = await callModel({
        sourceName: source.name,
        sourceUrl: article.finalUrl,
        sourceTitle: article.title || item.title,
        sourceDescription: article.description || item.description,
        sourceText: article.text,
        defaultCategory: source.defaultCategory,
        defaultLocation: source.location
      });

      if (isOfficial) officialAiUsed++;
      else discoveryAiUsed++;
      metrics.aiCalls++;

      let image = await downloadImage(article.image, article.finalUrl);

      if (!image) {
        console.log(`! Buscando foto real para: ${ai.location} ${ai.category}`);
        const commonsUrl = await searchWebImage(`${ai.location} ${ai.category}`);
        if (commonsUrl) {
          console.log(`! Foto Commons encontrada. Descargando...`);
          image = await downloadImage(commonsUrl, article.finalUrl);
        }
      }

      if (!image) {
        const plateFilename = `plate-${datePrefix(pubDate)}-${canonicalKey.slice(0, 8)}.jpg`;
        const localPath = path.join(ROOT, 'public/uploads/auto', plateFilename);
        const plateResult = await generateWebPlate({ title: ai.title, category: ai.category, outputPath: localPath });
        if (plateResult) image = `/uploads/auto/${plateFilename}`;
      }

      const filename = `${datePrefix(pubDate)}-${slugify(ai.title)}.md`;
      const target = path.join(NEWS_DIR, filename);
      const featured = ai.importance >= 9;

      await fs.writeFile(target, makeNewsMarkdown({
        ai, date: pubDate, image,
        sourceName: source.name, sourceUrl: article.finalUrl, featured
      }), 'utf8');

      // Actualizar índice en memoria para deduplicar dentro del mismo run
      existingUrls.add(article.finalUrl);
      existingTitles.add(ai.title.toLowerCase());

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

await saveSeen(seen);

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
  Noticias publicadas: ${metrics.published}
  Borradores generados: ${metrics.drafts}
  IA usada: ${metrics.aiCalls}/${MAX_AI_PER_RUN} (oficial: ${officialAiUsed}/${officialAiBudget}, descubrimiento: ${discoveryAiUsed}/${discoveryAiBudget})
  Por categoría: ${categoryStr}
`);
