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

const VERBOSE = !process.argv.includes('--quiet');
const JSON_OUTPUT = process.argv.includes('--json');
const MIN_BODY_LEN = 400;
const GENERIC_TITLE_WORDS = new Set([
  'noticias', 'inicio', 'home', 'bienvenido', 'portada', 'hoy',
  'municipio', 'rio', 'grande', 'ushuaia', 'tolhuin', 'fuego', 'tierra',
  'novedades', 'actualidad', 'informacion', 'bing', 'google', 'msn', 'inicio'
]);

const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config/sources.json'), 'utf8'));
const parser = new Parser();

function isGenericTitle(title) {
  if (!title || title.length < 15) return true;
  const words = (title.toLowerCase().match(/\b\w{4,}\b/g) || []);
  return words.filter(w => !GENERIC_TITLE_WORDS.has(w)).length < 2;
}

async function readSourceItems(source) {
  if (source.type === 'rss') {
    const { text } = await fetchText(source.url, { timeoutMs: source.timeoutMs || 15000 });
    const feed = await parser.parseString(text);
    let items = (feed.items || []).map(item => ({
      title: item.title || '',
      link: item.link || item.guid || '',
      pubDate: item.isoDate || item.pubDate || '',
      description: stripHtml(item.contentSnippet || item.content || item.summary || '')
    }));
    if (source.filterKeywords?.length > 0) {
      const kw = source.filterKeywords.map(k => k.toLowerCase());
      items = items.filter(i => kw.some(k => `${i.title} ${i.description}`.toLowerCase().includes(k)));
    }
    return items.slice(0, source.maxItems || 5);
  }
  if (source.type === 'html-index') {
    const { text } = await fetchText(source.url, { timeoutMs: 20000 });
    return extractIndexLinks(text, source.url, source.linkPattern)
      .slice(0, source.maxItems || 5)
      .map(item => ({ ...item, pubDate: '', description: '' }));
  }
  return [];
}

const results = [];

if (VERBOSE && !JSON_OUTPUT) {
  console.log('\n=== SOURCE HEALTH CHECK ===\n');
}

for (const source of config.sources) {
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
    results.push(result);
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

  results.push(result);

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
  const healthy = results.filter(r => r.healthy).length;
  const total = results.length;
  console.log(`\n=== RESUMEN: ${healthy}/${total} fuentes HEALTHY ===`);
  if (healthy < total) {
    console.log('Fuentes UNHEALTHY (no consumirán presupuesto IA):');
    results.filter(r => !r.healthy).forEach(r => console.log(`  - ${r.id}: ${r.error || '0 artículos válidos'}`));
  }
}

// Exportar lista de IDs unhealthy para que collect-news pueda leerla
const unhealthyIds = results.filter(r => !r.healthy).map(r => r.id);
const healthDataPath = path.join(ROOT, 'data/sources-health.json');
await fs.mkdir(path.dirname(healthDataPath), { recursive: true });
await fs.writeFile(healthDataPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  sources: results,
  unhealthyIds
}, null, 2));

process.exit(unhealthyIds.length > 0 && results.every(r => !r.healthy) ? 1 : 0);
