
import fs from 'node:fs/promises';
import path from 'node:path';
import Parser from 'rss-parser';
import {
  ROOT, NEWS_DIR, DRAFTS_DIR, ensureDirs, loadSeen, saveSeen, hash, slugify,
  safeDate, datePrefix, fetchText, stripHtml, extractIndexLinks, extractArticle,
  isOfficialDomain, downloadImage, callModel, makeNewsMarkdown, makeDraftMarkdown, sleep
} from './lib/news-utils.mjs';

const parser = new Parser();
const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config/sources.json'), 'utf8'));
const seen = await loadSeen();
await ensureDirs();

const MAX_AI_PER_RUN = Number(process.env.AF_MAX_AI_PER_RUN || 6);
const MAX_DRAFTS_PER_RUN = Number(process.env.AF_MAX_DRAFTS_PER_RUN || 8);
let aiCount = 0;
let draftCount = 0;
let publishedCount = 0;

async function readSource(source) {
  if (source.type === 'rss') {
    const feed = await parser.parseURL(source.url);
    return (feed.items || []).slice(0, source.maxItems || 5).map((item) => ({
      title: item.title || '',
      link: item.link || item.guid || '',
      pubDate: item.isoDate || item.pubDate || '',
      description: stripHtml(item.contentSnippet || item.content || item.summary || '')
    }));
  }

  if (source.type === 'html-index') {
    const { text } = await fetchText(source.url);
    return extractIndexLinks(text, source.url, source.linkPattern)
      .slice(0, source.maxItems || 5)
      .map((item) => ({ ...item, pubDate: '', description: '' }));
  }

  throw new Error(`Tipo de fuente no soportado: ${source.type}`);
}

async function materialize(item) {
  const { text, finalUrl } = await fetchText(item.link);
  return extractArticle(text, finalUrl);
}

for (const source of config.sources) {
  console.log(`\n=== ${source.name} ===`);
  let items = [];
  try {
    items = await readSource(source);
  } catch (error) {
    console.warn(`Fuente omitida: ${error.message}`);
    continue;
  }

  for (const item of items) {
    if (!item.link) continue;
    const initialKey = hash(item.link);
    if (seen.items[initialKey]) continue;

    let article;
    try {
      article = await materialize(item);
    } catch (error) {
      console.warn(`No se pudo extraer ${item.link}: ${error.message}`);
      seen.items[initialKey] = { seenAt: new Date().toISOString(), status: 'extract-error', source: source.id };
      continue;
    }

    const canonicalKey = hash(article.finalUrl || item.link);
    if (seen.items[canonicalKey]) {
      seen.items[initialKey] = { seenAt: new Date().toISOString(), status: 'duplicate', source: source.id };
      continue;
    }

    const enoughMaterial = (article.text || '').length >= 400;
    // Publicación 100% automática: omitimos la restricción de dominio oficial
    const canAutoPublish = enoughMaterial && aiCount < MAX_AI_PER_RUN;

    if (canAutoPublish) {
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
        aiCount += 1;

        const image = await downloadImage(article.image, article.finalUrl);
        const pubDate = safeDate(article.date || item.pubDate || new Date());
        const filename = `${datePrefix(pubDate)}-${slugify(ai.title)}.md`;
        const target = path.join(NEWS_DIR, filename);
        const featured = ai.importance >= 9;

        await fs.writeFile(target, makeNewsMarkdown({
          ai,
          date: pubDate,
          image,
          sourceName: source.name,
          sourceUrl: article.finalUrl,
          featured
        }), 'utf8');

        publishedCount += 1;
        seen.items[canonicalKey] = {
          seenAt: new Date().toISOString(),
          status: 'published',
          source: source.id,
          file: path.relative(ROOT, target)
        };
        seen.items[initialKey] = seen.items[canonicalKey];
        console.log(`PUBLICADA: ${ai.title}`);
        await sleep(1200);
        continue;
      } catch (error) {
        console.warn(`Falló redacción automática; pasa a borrador: ${error.message}`);
      }
    }

    if (draftCount < MAX_DRAFTS_PER_RUN) {
      const title = article.title || item.title || 'nota-detectada';
      const pubDate = safeDate(article.date || item.pubDate || new Date());
      const filename = `${datePrefix(pubDate)}-${slugify(title)}-${canonicalKey.slice(0, 6)}.md`;
      const target = path.join(DRAFTS_DIR, filename);
      await fs.writeFile(target, makeDraftMarkdown({
        item,
        article,
        source,
        mode: official ? 'official-review' : 'discovery-review'
      }), 'utf8');
      draftCount += 1;
      seen.items[canonicalKey] = {
        seenAt: new Date().toISOString(),
        status: 'draft',
        source: source.id,
        file: path.relative(ROOT, target)
      };
      seen.items[initialKey] = seen.items[canonicalKey];
      console.log(`BORRADOR: ${title}`);
    }
  }
}

await saveSeen(seen);
console.log(`\nResumen: ${publishedCount} publicadas, ${draftCount} borradores, ${aiCount} llamadas IA.`);
