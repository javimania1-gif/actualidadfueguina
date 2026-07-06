
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

const MAX_AI_PER_RUN = Number(process.env.AF_MAX_AI_PER_RUN || 6);
const MAX_DRAFTS_PER_RUN = Number(process.env.AF_MAX_DRAFTS_PER_RUN || 8);
let aiCount = 0;
let draftCount = 0;
let publishedCount = 0;

const existingUrls = new Set();
const existingTitles = new Set();

async function indexExistingDocs(dir) {
  try {
    for (const file of await fs.readdir(dir)) {
      if (!file.endsWith('.md')) continue;
      const content = await fs.readFile(path.join(dir, file), 'utf8');
      const urlMatch = content.match(/^sourceUrl:\s*['"]?(.*?)['"]?$/m);
      if (urlMatch) existingUrls.add(urlMatch[1].trim());
      const titleMatch = content.match(/^title:\s*['"]?(.*?)['"]?$/m);
      if (titleMatch) existingTitles.add(titleMatch[1].trim().toLowerCase());
    }
  } catch (error) {}
}

function isSimilarTitle(newTitle) {
  if (!newTitle) return false;
  const words1 = new Set(newTitle.toLowerCase().match(/\b\w{4,}\b/g) || []);
  if (words1.size < 3) return existingTitles.has(newTitle.toLowerCase());
  for (const oldTitle of existingTitles) {
    const words2 = new Set(oldTitle.match(/\b\w{4,}\b/g) || []);
    const intersection = [...words1].filter(x => words2.has(x)).length;
    const union = new Set([...words1, ...words2]).size;
    if (union > 0 && (intersection / union) > 0.45) return true;
  }
  return false;
}

await indexExistingDocs(NEWS_DIR);
await indexExistingDocs(DRAFTS_DIR);
console.log(`Índice de desduplicación: ${existingUrls.size} URLs y ${existingTitles.size} títulos registrados.`);

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

    const finalUrl = article.finalUrl || item.link;
    const canonicalKey = hash(finalUrl);
    const currentTitle = (article.title || item.title || '').trim();

    if (seen.items[canonicalKey] || existingUrls.has(finalUrl) || isSimilarTitle(currentTitle)) {
      seen.items[initialKey] = { seenAt: new Date().toISOString(), status: 'duplicate', source: source.id };
      continue;
    }

    const enoughMaterial = (article.text || '').length >= 400;
    const official = source.mode === 'official-auto' || isOfficialDomain(article.finalUrl, config.officialDomains);
    // El usuario solicitó explícitamente publicar de TODAS las fuentes si tienen suficiente material
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

        let image = await downloadImage(article.image, article.finalUrl);
        const pubDate = safeDate(article.date || item.pubDate || new Date());
        
        if (!image) {
          // Intentar buscar una imagen real de la ubicación o tema en Wikimedia Commons
          console.log(`! Buscando foto real para: ${ai.location} ${ai.category}`);
          const commonsUrl = await searchWebImage(`${ai.location} ${ai.category}`);
          if (commonsUrl) {
            console.log(`! Foto real encontrada en Commons: ${commonsUrl}. Descargando...`);
            image = await downloadImage(commonsUrl, article.finalUrl);
          }
        }

        // Generar una placa de portada web automatizada si no hay imagen real (o si fue descartada por ser institucional)
        if (!image) {
          const plateFilename = `plate-${datePrefix(pubDate)}-${canonicalKey.slice(0, 8)}.jpg`;
          const localPath = path.join(ROOT, 'public/uploads/auto', plateFilename);
          const plateResult = await generateWebPlate({
            title: ai.title,
            category: ai.category,
            outputPath: localPath
          });
          if (plateResult) {
            image = `/uploads/auto/${plateFilename}`;
          }
        }

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
