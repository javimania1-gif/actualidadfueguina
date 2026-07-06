
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

export const ROOT = process.cwd();
export const NEWS_DIR = path.join(ROOT, 'src/content/noticias');
export const DRAFTS_DIR = path.join(ROOT, 'src/content/borradores');
export const UPLOADS_DIR = path.join(ROOT, 'public/uploads/auto');
export const SEEN_PATH = path.join(ROOT, 'data/seen.json');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 18);
}

export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80) || `nota-${Date.now()}`;
}

export function safeDate(value) {
  const d = value ? new Date(value) : new Date();
  return Number.isNaN(d.valueOf()) ? new Date() : d;
}

export function datePrefix(value = new Date()) {
  const d = safeDate(value);
  return d.toISOString().slice(0, 10);
}

export function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

export function yamlArray(values = []) {
  return `[${values.map((v) => yamlString(v)).join(', ')}]`;
}

export async function ensureDirs() {
  await Promise.all([
    fs.mkdir(NEWS_DIR, { recursive: true }),
    fs.mkdir(DRAFTS_DIR, { recursive: true }),
    fs.mkdir(UPLOADS_DIR, { recursive: true }),
    fs.mkdir(path.dirname(SEEN_PATH), { recursive: true })
  ]);
}

export async function loadSeen() {
  try {
    return JSON.parse(await fs.readFile(SEEN_PATH, 'utf8'));
  } catch {
    return { version: 1, items: {} };
  }
}

export async function saveSeen(seen) {
  const entries = Object.entries(seen.items || {});
  entries.sort((a, b) => String(b[1]?.seenAt || '').localeCompare(String(a[1]?.seenAt || '')));
  seen.items = Object.fromEntries(entries.slice(0, 2500));
  await fs.writeFile(SEEN_PATH, JSON.stringify(seen, null, 2) + '\n', 'utf8');
}

export function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripHtml(html) {
  const $ = cheerio.load(html || '');
  $('script,style,noscript,svg,nav,footer,header,aside,form').remove();
  return cleanText($.text());
}

export async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 25000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'ActualidadFueguinaBot/1.0 (+https://actualidadfueguina.com.ar)',
        'accept-language': 'es-AR,es;q=0.9',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} en ${url}`);
    return { text: await response.text(), finalUrl: response.url, response };
  } finally {
    clearTimeout(timeout);
  }
}

export function extractIndexLinks(html, baseUrl, linkPattern = '') {
  const $ = cheerio.load(html);
  const result = new Map();
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    const title = cleanText($(element).text());
    if (!href || !title || title.length < 20) return;
    let absolute;
    try { absolute = new URL(href, baseUrl).toString(); } catch { return; }
    if (linkPattern && !absolute.includes(linkPattern)) return;
    if (!result.has(absolute)) result.set(absolute, { link: absolute, title });
  });
  return [...result.values()];
}

export function extractArticle(html, finalUrl) {
  const $ = cheerio.load(html);
  $('script,style,noscript,svg,nav,footer,header,aside,form,.share,.social,.related,.comments').remove();

  const title =
    cleanText($('meta[property="og:title"]').attr('content')) ||
    cleanText($('h1').first().text()) ||
    cleanText($('title').text());

  const description =
    cleanText($('meta[name="description"]').attr('content')) ||
    cleanText($('meta[property="og:description"]').attr('content'));

  const image =
    $('meta[property="og:image"]').attr('content') ||
    $('article img').first().attr('src') ||
    $('main img').first().attr('src') ||
    '';

  const date =
    $('meta[property="article:published_time"]').attr('content') ||
    $('time[datetime]').first().attr('datetime') ||
    '';

  const candidates = [
    'article .entry-content',
    'article .post-content',
    'article .article-body',
    '.entry-content',
    '.post-content',
    '.article-body',
    'article',
    'main'
  ];

  let contentHtml = '';
  for (const selector of candidates) {
    const node = $(selector).first();
    if (node.length && cleanText(node.text()).length > 500) {
      contentHtml = node.html() || '';
      break;
    }
  }

  if (!contentHtml) {
    const paragraphs = $('p').map((_, p) => `<p>${$(p).html() || ''}</p>`).get();
    contentHtml = paragraphs.join('\n');
  }

  const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
  turndown.remove(['script', 'style', 'nav', 'footer', 'form']);
  const markdown = cleanText(turndown.turndown(contentHtml));

  let absoluteImage = '';
  if (image) {
    try { absoluteImage = new URL(image, finalUrl).toString(); } catch { absoluteImage = ''; }
  }

  return {
    title,
    description,
    date,
    image: absoluteImage,
    text: markdown.slice(0, 16000),
    finalUrl
  };
}

export function isOfficialDomain(url, domains = []) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export async function downloadImage(url, seed) {
  if (!url) return '';
  
  // Descartar imágenes corporativas de gacetillas repetitivas
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes('company_logo') || lowerUrl.includes('logo-af') || lowerUrl.includes('/logo') || lowerUrl.includes('favicon') || lowerUrl.includes('avatar')) {
    console.log(`! Descartando imagen corporativa: ${url}`);
    return '';
  }

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'ActualidadFueguinaBot/1.0' }
    });
    if (!response.ok) return '';
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return '';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 6_000_000) return '';

    const extMap = {
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif'
    };
    const ext = extMap[contentType.split(';')[0].trim()] || '.jpg';
    const filename = `${datePrefix()}-${hash(seed)}${ext}`;
    const fullPath = path.join(UPLOADS_DIR, filename);
    await fs.writeFile(fullPath, buffer);
    return `/uploads/auto/${filename}`;
  } catch (error) {
    console.warn(`No se pudo descargar imagen ${url}: ${error.message}`);
    return '';
  }
}

export function extractJsonObject(value) {
  const raw = String(value || '').trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(unfenced); } catch {}
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(unfenced.slice(first, last + 1));
  throw new Error('La IA no devolvió JSON válido');
}

export async function callModel({ sourceName, sourceUrl, sourceTitle, sourceDescription, sourceText, defaultCategory, defaultLocation }) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Falta GITHUB_TOKEN');

  const system = `Sos editor periodístico de Actualidad Fueguina, portal provincial de Tierra del Fuego AIAS.
Tu tarea es transformar material fuente en una nota periodística ORIGINAL, factual y útil.
Reglas obligatorias:
- No copies frases extensas ni la estructura del texto fuente.
- No inventes datos, citas, cifras, antecedentes ni consecuencias.
- Si un dato no está en el material, no lo afirmes.
- No menciones "según el texto" ni expliques el proceso de IA.
- Priorizá el impacto concreto para lectores de Río Grande, Ushuaia, Tolhuin, Malvinas y Antártida.
- Título informativo y atractivo, sin clickbait engañoso.
- Bajada SEO entre 100 y 170 caracteres.
- Cuerpo en Markdown, de 5 a 9 párrafos breves; podés usar un subtítulo si mejora la lectura.
- Cerrá, solo cuando corresponda naturalmente, con una pregunta o invitación breve a la comunidad.
- Elegí una categoría de: Provincia, Río Grande, Ushuaia, Tolhuin, Malvinas, Antártida, Política, Economía, Sociedad, Policiales, Institucional.
- Entregá exclusivamente JSON válido con: title, description, category, location, tags, imageAlt, body, importance.
- tags debe ser un array de 3 a 6 strings.
- importance debe ser un entero de 1 a 10.`;

  const user = `FUENTE: ${sourceName}
URL: ${sourceUrl}
TÍTULO FUENTE: ${sourceTitle}
DESCRIPCIÓN FUENTE: ${sourceDescription || ''}
CATEGORÍA SUGERIDA: ${defaultCategory || 'Provincia'}
UBICACIÓN SUGERIDA: ${defaultLocation || 'Tierra del Fuego AIAS'}

MATERIAL FUENTE:
${sourceText.slice(0, 14000)}`;

  const response = await fetch('https://models.github.ai/inference/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      model: process.env.AF_MODEL || 'openai/gpt-4o-mini',
      temperature: 0.35,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`GitHub Models HTTP ${response.status}: ${details.slice(0, 500)}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = extractJsonObject(content);

  return {
    title: cleanText(parsed.title),
    description: cleanText(parsed.description).slice(0, 180),
    category: cleanText(parsed.category || defaultCategory || 'Provincia'),
    location: cleanText(parsed.location || defaultLocation || 'Tierra del Fuego AIAS'),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(cleanText).filter(Boolean).slice(0, 6) : [],
    imageAlt: cleanText(parsed.imageAlt || parsed.title),
    body: cleanText(parsed.body),
    importance: Math.max(1, Math.min(10, Number(parsed.importance) || 5))
  };
}

export function makeNewsMarkdown({ ai, date, image, sourceName, sourceUrl, featured = false, automated = true }) {
  const importance = ai.importance || 5;
  const urgent = importance >= 9;
  return `---
title: ${yamlString(ai.title)}
description: ${yamlString(ai.description)}
date: ${yamlString(safeDate(date).toISOString())}
category: ${yamlString(ai.category)}
location: ${yamlString(ai.location)}
tags: ${yamlArray(ai.tags)}
image: ${yamlString(image || '')}
imageAlt: ${yamlString(ai.imageAlt || ai.title)}
author: "Actualidad Fueguina"
featured: ${featured ? 'true' : 'false'}
importance: ${importance}
social:
  enabled: true
  urgent: ${urgent ? 'true' : 'false'}
sourceName: ${yamlString(sourceName)}
sourceUrl: ${yamlString(sourceUrl)}
automated: ${automated ? 'true' : 'false'}
---

${ai.body.trim()}
`;
}

export function makeDraftMarkdown({ item, article, source, mode }) {
  const summary = cleanText(article.description || item.description || '').slice(0, 180);
  const material = cleanText(article.text || item.description || '').slice(0, 14000);
  return `---
title: ${yamlString(article.title || item.title || 'Sin título')}
description: ${yamlString(summary || 'Material detectado automáticamente para evaluación editorial.')}
date: ${yamlString(safeDate(item.pubDate || article.date).toISOString())}
category: ${yamlString(source.defaultCategory || 'Provincia')}
location: ${yamlString(source.location || 'Tierra del Fuego AIAS')}
sourceName: ${yamlString(source.name)}
sourceUrl: ${yamlString(article.finalUrl || item.link)}
originalImage: ${yamlString(article.image || '')}
status: "draft"
detectedAt: ${yamlString(new Date().toISOString())}
mode: ${yamlString(mode)}
---

## Material fuente detectado

${material || 'No se pudo extraer el cuerpo completo. Revisar la URL de origen antes de publicar.'}
`;
}

export function escapeXml(unsafe) {
  return String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function generateWebPlate({ title, category, outputPath }) {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch (e) {
    console.warn('Sharp no disponible para placas web.');
    return null;
  }

  const width = 800;
  const height = 450;

  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    
    const background = { create: { width, height, channels: 4, background: { r: 0, g: 48, b: 87, alpha: 1 } } };

    const words = title.split(' ');
    let lines = [''];
    let currentLine = 0;
    for (const word of words) {
      if ((lines[currentLine] + word).length < 28) {
        lines[currentLine] += (lines[currentLine] ? ' ' : '') + word;
      } else if (currentLine < 2) {
        currentLine++;
        lines[currentLine] = word;
      } else {
        if (!lines[currentLine].endsWith('...')) lines[currentLine] += '...';
        break;
      }
    }

    const logoPath = path.join(ROOT, 'public/logo-af.jpg');
    const hasLogo = await fs.access(logoPath).then(() => true).catch(() => false);
    const composites = [];

    if (hasLogo) {
      const logoBuffer = await sharp(logoPath).resize(80, 80).toBuffer();
      composites.push({ input: logoBuffer, top: 25, left: 695 });
    }

    const escapedCategory = escapeXml(category.toUpperCase());
    const escapedLines = lines.map(escapeXml);

    const overlaySvg = `
      <svg width="${width}" height="${height}">
        <defs>
          <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#003057;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#001529;stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#grad)" />
        <text x="40" y="60" font-family="sans-serif" font-size="20" font-weight="bold" fill="#38bdf8" letter-spacing="1">${escapedCategory}</text>
        <text x="40" y="200" font-family="sans-serif" font-size="36" font-weight="bold" fill="#ffffff">${escapedLines[0]}</text>
        ${escapedLines[1] ? `<text x="40" y="260" font-family="sans-serif" font-size="36" font-weight="bold" fill="#ffffff">${escapedLines[1]}</text>` : ''}
        ${escapedLines[2] ? `<text x="40" y="320" font-family="sans-serif" font-size="36" font-weight="bold" fill="#ffffff">${escapedLines[2]}</text>` : ''}
        <text x="40" y="410" font-family="sans-serif" font-size="18" fill="#94a3b8">actualidadfueguina.com.ar</text>
      </svg>
    `;

    composites.push({ input: Buffer.from(overlaySvg), top: 0, left: 0 });

    await sharp(background).composite(composites).toFile(outputPath);
    return outputPath;
  } catch (error) {
    console.error('Error generando placa web:', error);
    return null;
  }
}

export async function searchWebImage(query) {
  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(query)}&gsrlimit=10&prop=imageinfo&iiprop=url&format=json&origin=*`;
    const res = await fetch(url, { headers: { 'user-agent': 'ActualidadFueguinaBot/1.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    const pages = data.query?.pages || {};
    const urls = Object.values(pages)
      .map(p => p.imageinfo?.[0]?.url)
      .filter(Boolean)
      .filter(u => {
        const lower = u.toLowerCase();
        return lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png');
      });
    if (urls.length > 0) {
      const randomIndex = Math.floor(Math.random() * Math.min(urls.length, 5));
      return urls[randomIndex];
    }
  } catch (error) {
    console.warn('Error buscando imagen en Commons:', error.message);
  }
  return null;
}
