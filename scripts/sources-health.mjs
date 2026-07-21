/**
 * sources-health.mjs
 * Verifica la salud de cada fuente de noticias configurada.
 * Para cada fuente informa: items fetched, links resolved, articles extracted,
 * valid articles (body >= 400), generic titles, extract errors, avg body length.
 *
 * Este chequeo es diagnostico/preflight. collect-news no consume unhealthyIds
 * como filtro duro salvo que se implemente explicitamente esa lectura.
 *
 * Uso: npm run news:sources-health
 *       node scripts/sources-health.mjs [--json]
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import Parser from 'rss-parser';
import {
  ROOT, fetchText, extractArticle, stripHtml, extractIndexLinks, sleep
} from './lib/news-utils.mjs';
import { normalizeText } from './lib/pipeline-utils.mjs';

const VERBOSE = !process.argv.includes('--quiet');
const JSON_OUTPUT = process.argv.includes('--json');
const MIN_BODY_LEN = 400;
const GENERIC_TITLE_WORDS = new Set([
  'noticias', 'inicio', 'home', 'bienvenido', 'portada', 'hoy',
  'municipio', 'rio', 'grande', 'ushuaia', 'tolhuin', 'fuego', 'tierra',
  'novedades', 'actualidad', 'informacion', 'bing', 'google', 'msn', 'inicio'
]);

const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config/sources.json'), 'utf8'));
const sources = config.sources.filter((source) => source.enabled !== false);
const parser = new Parser();
let previousHealth = {};
try {
  const previous = JSON.parse(await fs.readFile(path.join(ROOT, 'data/sources-health.json'), 'utf8'));
  previousHealth = Object.fromEntries((previous.sources || []).map((source) => [source.id, source]));
} catch {}

function isGenericTitle(title) {
  if (!title || title.length < 15) return true;
  const words = (title.toLowerCase().match(/\b\w{4,}\b/g) || []);
  return words.filter(w => !GENERIC_TITLE_WORDS.has(w)).length < 2;
}

async function readSourceItems(source) {
  const filterItems = (items = []) => {
    if (!source.filterKeywords?.length) return items;
    const kw = source.filterKeywords.map(k => normalizeText(k));
    return items.filter(i => {
      const text = normalizeText(`${i.title} ${i.description || ''}`);
      return kw.some(k => text.includes(k));
    });
  };
  if (source.type === 'rss') {
    const { text } = await fetchText(source.url, { timeoutMs: source.timeoutMs || 15000 });
    const feed = await parser.parseString(text);
    let items = (feed.items || []).map(item => ({
      title: item.title || '',
      link: item.link || item.guid || '',
      pubDate: item.isoDate || item.pubDate || '',
      description: stripHtml(item.contentSnippet || item.content || item.summary || '')
    }));
    return filterItems(items).slice(0, source.maxItems || 5);
  }
  if (source.type === 'html-index') {
    const { text } = await fetchText(source.url, { timeoutMs: 20000 });
    const items = extractIndexLinks(text, source.url, source.linkPattern)
      .map(item => ({ ...item, pubDate: '', description: '' }));
    return filterItems(items).slice(0, source.maxItems || 5);
  }
  return [];
}

function classifyIssue(result, source = {}) {
  if (result.error) return /timeout|abort/i.test(result.error) ? 'temporary-error' : 'fetch-error';
  if (result.itemsFetched === 0) return source.filterKeywords?.length ? 'no-matching-items' : 'zero-items';
  if (result.linksResolved === 0) return 'zero-links-resolved';
  if (result.articlesExtracted === 0) return result.extractErrors > 0 ? 'extractor-incompatible' : 'zero-articles-extracted';
  if (result.validArticles === 0) return result.avgBodyLen < MIN_BODY_LEN ? 'zero-valid-articles' : 'generic-title-only';
  return '';
}

function finalizeResult(result, source = {}) {
  const previous = previousHealth[result.id] || {};
  result.issueCategory = classifyIssue(result, source);
  const idle = result.issueCategory === 'no-matching-items';
  result.status = result.healthy ? 'healthy' : idle ? 'idle' : 'unhealthy';
  result.operational = result.healthy || idle;
  result.consecutiveFailures = result.operational ? 0 : (Number(previous.consecutiveFailures) || 0) + 1;
  result.lastHealthyAt = result.operational
    ? new Date().toISOString()
    : previous.lastHealthyAt || null;
  return result;
}

const results = [];

if (VERBOSE && !JSON_OUTPUT) {
  console.log('\n=== SOURCE HEALTH CHECK ===\n');
}

for (const source of sources) {
  const result = {
    id: source.id,
    name: source.name,
    type: source.type,
    itemsFetched: 0,
    linksResolved: 0,
    articlesExtracted: 0,
    validArticles: 0,
    genericTitles: 0,
    extractErrors: 0,
    avgBodyLen: 0,
    healthy: false,
    error: null
  };

  let items = [];
  try {
    items = await readSourceItems(source);
    result.itemsFetched = items.length;
  } catch (err) {
    result.error = err.message.slice(0, 120);
    result.healthy = false;
    results.push(finalizeResult(result, source));
    if (VERBOSE && !JSON_OUTPUT) {
      console.log(`❌ [${source.id}] FETCH ERROR: ${result.error}`);
    }
    continue;
  }

  const bodyLens = [];

  for (const item of items) {
    if (!item.link) continue;

    // Resolver redirect de Bing
    let resolvedUrl = item.link;
    if (item.link.includes('bing.com/news/apiclick')) {
      try {
        const res = await fetch(item.link, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
        resolvedUrl = res.url;
        result.linksResolved++;
      } catch {
        result.extractErrors++;
        continue;
      }
    } else {
      result.linksResolved++;
    }

    if (isGenericTitle(item.title)) {
      result.genericTitles++;
    }

    let article;
    try {
      article = await fetchText(resolvedUrl, { timeoutMs: 15000 });
      const extracted = extractArticle(article.text, article.finalUrl);
      result.articlesExtracted++;
      const bodyLen = (extracted.text || '').length;
      bodyLens.push(bodyLen);
      if (bodyLen >= MIN_BODY_LEN && !isGenericTitle(extracted.title || item.title)) {
        result.validArticles++;
      }
    } catch {
      result.extractErrors++;
    }

    await sleep(400);
  }

  result.avgBodyLen = bodyLens.length > 0
    ? Math.round(bodyLens.reduce((a, b) => a + b, 0) / bodyLens.length)
    : 0;
  result.healthy = result.validArticles > 0;

  results.push(finalizeResult(result, source));

  if (VERBOSE && !JSON_OUTPUT) {
    const icon = result.healthy ? '✅' : '❌';
    const status = result.healthy ? 'HEALTHY' : 'UNHEALTHY';
    console.log(
      `${icon} [${source.id.padEnd(25)}] items:${String(result.itemsFetched).padStart(3)}  ` +
      `resolved:${String(result.linksResolved).padStart(3)}  extracted:${String(result.articlesExtracted).padStart(3)}  ` +
      `valid:${String(result.validArticles).padStart(3)}  generic:${String(result.genericTitles).padStart(2)}  ` +
      `errors:${String(result.extractErrors).padStart(2)}  avg-body:${String(result.avgBodyLen).padStart(6)}  ${status}`
    );
  }
}

if (JSON_OUTPUT) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const healthy = results.filter(r => r.operational).length;
  const total = results.length;
  console.log(`\n=== RESUMEN: ${healthy}/${total} fuentes HEALTHY ===`);
  if (healthy < total) {
    console.log('Fuentes UNHEALTHY (no consumirán presupuesto IA):');
    results.filter(r => !r.operational).forEach(r => console.log(`  - ${r.id}: ${r.error || '0 artículos válidos'}`));
  }
}

// Exportar lista de IDs unhealthy para que collect-news pueda leerla
const unhealthyIds = results.filter(r => !r.operational).map(r => r.id);
const healthDataPath = path.join(ROOT, 'data/sources-health.json');
await fs.mkdir(path.dirname(healthDataPath), { recursive: true });
await fs.writeFile(healthDataPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  summary: {
    configured: results.length,
    healthy: results.filter(r => r.operational).length,
    idle: results.filter(r => r.status === 'idle').length,
    unhealthy: results.filter(r => !r.operational).length,
    productive: results.filter(r => r.validArticles > 0).length,
    zeroResults: results.filter(r => r.issueCategory === 'zero-items').length,
    failed: results.filter(r => ['fetch-error', 'temporary-error', 'extractor-incompatible'].includes(r.issueCategory)).length
  },
  sources: results,
  unhealthyIds
}, null, 2));

process.exit(unhealthyIds.length > 0 && results.every(r => !r.healthy) ? 1 : 0);
