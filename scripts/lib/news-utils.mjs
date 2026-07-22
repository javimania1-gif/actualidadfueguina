import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import sharp from 'sharp';
import TurndownService from 'turndown';
import { callAiJson } from './ai-provider.mjs';

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

  let canonicalUrl = finalUrl;
  const canonical =
    $('link[rel="canonical"]').attr('href') ||
    $('meta[property="og:url"]').attr('content') ||
    '';
  if (canonical) {
    try { canonicalUrl = new URL(canonical, finalUrl).toString(); } catch {}
  }

  return {
    title,
    description,
    date,
    image: absoluteImage,
    text: markdown.slice(0, 16000),
    finalUrl,
    canonicalUrl
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

export function isHomepage(urlStr) {
  try {
    const url = new URL(urlStr);
    const path = url.pathname.replace(/\/$/, '');
    return path === '' || path === '/home' || path === '/inicio' || path === '/noticias';
  } catch {
    return true; // invalid URLs are considered generic/homepages
  }
}

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'image/avif',
  'image/tiff'
]);

export async function normalizeImageBuffer({
  buffer,
  contentType,
  seed,
  sourceUrl = '',
  purpose = 'web',
  outputDir = UPLOADS_DIR,
  minWidth = 400,
  minHeight = 300,
  maxBytes = 8_000_000,
  canvasBackground = ''
}) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!mime || !mime.startsWith('image/')) return { ok: false, reason: 'not-image-content-type' };
  if (!SUPPORTED_IMAGE_TYPES.has(mime)) return { ok: false, reason: `unsupported-content-type:${mime}` };
  if (!buffer || buffer.length === 0) return { ok: false, reason: 'empty-buffer' };
  if (buffer.length > maxBytes) return { ok: false, reason: 'image-too-large' };

  let metadata;
  try {
    metadata = await sharp(buffer, { animated: false, limitInputPixels: 40_000_000 }).metadata();
  } catch (error) {
    return { ok: false, reason: `decode-error:${error.message}` };
  }

  if (!metadata?.width || !metadata?.height) return { ok: false, reason: 'missing-dimensions' };
  if (!canvasBackground && (metadata.width < minWidth || metadata.height < minHeight)) {
    return { ok: false, reason: 'image-too-small', width: metadata.width, height: metadata.height };
  }

  const format = purpose === 'meta' ? 'jpeg' : 'webp';
  const ext = format === 'jpeg' ? '.jpg' : '.webp';
  const filename = `${datePrefix()}-${hash(seed || sourceUrl || buffer.subarray(0, 32).toString('hex'))}${ext}`;
  const fullPath = path.join(outputDir, filename);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });

  let pipeline;

  if (canvasBackground) {
    const canvasWidth = 1600;
    const canvasHeight = 900;
    const logoBuffer = await sharp(buffer, { animated: false, limitInputPixels: 40_000_000 })
      .resize({ width: 980, height: 520, fit: 'inside', withoutEnlargement: true })
      .toBuffer();
    pipeline = sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 4,
        background: canvasBackground
      }
    }).composite([{ input: logoBuffer, gravity: 'center' }]);
  } else {
    pipeline = sharp(buffer, { animated: false, limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 1600, height: 1200, fit: 'inside', withoutEnlargement: true });
  }

  if (format === 'jpeg') {
    pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 88, mozjpeg: true });
  } else {
    pipeline = pipeline.webp({ quality: 82 });
  }

  await fs.rm(fullPath, { force: true }).catch(() => {});
  await pipeline.toFile(fullPath);
  const finalMetadata = await sharp(fullPath).metadata();
  return {
    ok: true,
    sourceUrl,
    originalContentType: mime,
    format,
    width: finalMetadata.width,
    height: finalMetadata.height,
    filePath: fullPath,
    publicPath: `/uploads/auto/${filename}`
  };
}

export async function normalizeImageAsset(url, options = {}) {
  if (!url) return { ok: false, reason: 'missing-url' };

  const lowerUrl = url.toLowerCase();
  if (!options.allowLogos && (
    lowerUrl.includes('company_logo') ||
    lowerUrl.includes('logo-af') ||
    lowerUrl.includes('/logo') ||
    lowerUrl.includes('favicon') ||
    lowerUrl.includes('avatar')
  )) {
    return { ok: false, reason: 'corporate-or-logo-image' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 20000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'ActualidadFueguinaBot/1.0 (+https://actualidadfueguina.com.ar)' }
    });
    if (!response.ok) return { ok: false, reason: `http-${response.status}` };
    const contentType = response.headers.get('content-type') || '';
    const contentLength = Number(response.headers.get('content-length') || 0);
    const maxBytes = options.maxBytes || 8_000_000;
    if (contentLength && contentLength > maxBytes) return { ok: false, reason: 'image-too-large' };
    const buffer = Buffer.from(await response.arrayBuffer());
    return normalizeImageBuffer({
      buffer,
      contentType,
      seed: options.seed || url,
      sourceUrl: response.url || url,
      purpose: options.purpose || 'web',
      outputDir: options.outputDir || UPLOADS_DIR,
      minWidth: options.minWidth || 400,
      minHeight: options.minHeight || 300,
      maxBytes,
      canvasBackground: options.canvasBackground || ''
    });
  } catch (error) {
    return { ok: false, reason: `fetch-error:${error.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

export async function downloadImage(url, seed) {
  const result = await normalizeImageAsset(url, { seed, purpose: 'web' });
  if (!result.ok) {
    if (url) console.warn(`No se pudo normalizar imagen ${url}: ${result.reason}`);
    return '';
  }
  return result.publicPath;

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

    try {
      const metadata = await sharp(buffer).metadata();
      if (!metadata || !metadata.width || !metadata.height) return '';
      if (metadata.width < 400 || metadata.height < 300) {
        console.log(`! Descartando imagen por dimensiones pequeñas (${metadata.width}x${metadata.height}): ${url}`);
        return '';
      }
    } catch (sharpError) {
      console.warn(`! Sharp no pudo decodificar la imagen ${url}: ${sharpError.message}`);
      return '';
    }

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

export async function writeArticleWithModel({
  sourceName,
  sourceUrl,
  sourceTitle,
  sourceDescription,
  sourceText,
  defaultCategory,
  defaultLocation,
  verifiedFacts = null,
  editorialOpportunity = null
}) {
  const system = `Sos un periodista senior y editor jefe de Actualidad Fueguina, un diario digital de Tierra del Fuego.
Tu objetivo es redactar una nota periodística original, precisa y útil, basándote exclusivamente en el material fuente y, cuando se entreguen, en los hechos verificados.
No inventes datos, citas, cifras, consecuencias ni contexto no respaldado. Si los hechos verificados contradicen o limitan el material, obedecen los hechos verificados.
No agregues rivales, resultados, fechas, cifras, cargos, victimas ni organismos que no esten respaldados.
Si el hecho central es una declaracion, critica o afirmacion atribuida, conserva la atribucion explicita y no la presentes como hecho probado independiente.
Parafrasea la fuente con estructura y lenguaje propios. No reproduzcas párrafos, títulos ni secuencias de la fuente. Como máximo usa una cita textual breve, menor a 20 palabras, solo cuando sea imprescindible y esté respaldada.

REGLAS DE ESTILO Y REDACCIÓN:
1. Longitud proporcional al material: 4 a 8 párrafos. No rellenes ni repitas para alcanzar una extensión.
2. Tono: Adopta un tono profesional, riguroso y de autoridad periodística. Usa vocabulario rico, variado y conectores narrativos fluidos.
3. Estructura Markdown: Debes organizar visualmente el cuerpo de la nota usando elementos de Markdown:
   - Usa Subtítulos (##) solo cuando existan al menos dos bloques informativos diferentes.
   - Usa Listas con viñetas (-) para desglosar datos duros, cifras, medidas o puntos clave, si aplica.
   - No uses citas en bloque ni una sección genérica de conclusiones.
4. Contexto: explica el impacto fueguino únicamente cuando esté respaldado por los hechos. No infieras consecuencias.
5. Usa titulo informativo, bajada SEO de 100 a 170 caracteres.
6. Si el material fuente incluye "TIPO: PRONOSTICO_PROVINCIAL", redacta una sola nota provincial de pronostico del tiempo para Tierra del Fuego. No generes una nota por localidad. El cuerpo debe incluir subtitulos breves para Rio Grande, Tolhuin, Ushuaia o las localidades disponibles, y no agregar localidades sin datos confiables.
7. Valor para el lector: entrega de 2 a 4 puntos clave estrictamente factuales. Explica "por qué importa" solo si el material respalda una consecuencia concreta; si no la respalda, usa una cadena vacía. No presentes opiniones, predicciones ni inferencias como valor agregado.
8. CRITERIO EDITORIAL PREVIO: recibirás, cuando corresponda, una evaluación estratégica. Usala para jerarquizar y estructurar la nota, pero nunca como fuente factual.
   - Si recomienda "claves-af", explica los datos en puntos claros sin compararlos con salarios, períodos o indicadores que no estén verificados.
   - Si detecta una comunidad movilizable, identifica con precisión protagonistas, categoría, club o institución, sin pedir que compartan.
   - Si recomienda "analisis", redacta solamente una base factual prudente: no atribuyas intenciones ni afirmes hipocresía o contradicción como hecho. El sistema la enviará a revisión humana.
   - Si recomienda cobertura central actualizable, prioriza fixture, resultados, posiciones, horarios y próximos hitos presentes en los hechos verificados; no inventes una tabla incompleta.

Entrega exclusivamente JSON con esta estructura:
{
  "news": {
    "title": "...",
    "description": "...",
    "category": "Actualidad|Política|Economía|Sociedad|Policiales|Deportes",
    "location": "...",
    "tags": ["...", "..."],
    "imageAlt": "...",
    "body": "...",
    "keyPoints": ["...", "..."],
    "whyItMatters": "...",
    "importance": 1-10
  }
}`;

  const user = `FUENTE: ${sourceName}
URL: ${sourceUrl}
TITULO FUENTE: ${sourceTitle}
DESCRIPCION FUENTE: ${sourceDescription || ''}
CATEGORIA SUGERIDA: ${defaultCategory || 'Provincia'}
UBICACION SUGERIDA: ${defaultLocation || 'Tierra del Fuego AIAS'}

HECHOS VERIFICADOS:
${verifiedFacts ? JSON.stringify(verifiedFacts, null, 2) : 'No hay registro externo adicional; no agregues hechos fuera del material fuente.'}

EVALUACION ESTRATEGICA PREVIA (NO ES FUENTE FACTUAL):
${editorialOpportunity ? JSON.stringify(editorialOpportunity, null, 2) : 'Sin recomendación especial; aplicar formato de noticia.'}

MATERIAL FUENTE:
${String(sourceText || '').slice(0, 14000)}`;

  const parsed = await callAiJson({ system, user, temperature: 0.35 });
  if (!parsed.news) throw new Error('Estructura JSON invalida: falta news');

  const n = parsed.news;
  return {
    title: cleanText(n.title),
    description: cleanText(n.description).slice(0, 180),
    category: cleanText(n.category || defaultCategory || 'Provincia'),
    location: cleanText(n.location || defaultLocation || 'Tierra del Fuego AIAS'),
    tags: Array.isArray(n.tags) ? n.tags.map(cleanText).filter(Boolean).slice(0, 6) : [],
    imageAlt: cleanText(n.imageAlt || n.title),
    body: cleanText(n.body),
    keyPoints: Array.isArray(n.keyPoints) ? n.keyPoints.map(cleanText).filter(Boolean).slice(0, 4) : [],
    whyItMatters: cleanText(n.whyItMatters || '').slice(0, 500),
    importance: Math.max(1, Math.min(10, Number(n.importance) || 5)),
    facts: verifiedFacts || null
  };
}

export async function callModel(args) {
  return writeArticleWithModel(args);

  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Falta GITHUB_TOKEN');

  const system = `Sos un editor periodístico riguroso de Actualidad Fueguina, enfocado en FACTUALIDAD y precisión.
Tu tarea se divide en DOS pasos obligatorios:
PASO 1: EXTRACCIÓN Y VERIFICACIÓN FACTUAL. Extraé los hechos estructurados del material fuente. Evaluá si la información es coherente, si tiene calidad suficiente y determiná su nivel de riesgo.
- Riesgo Bajo: agenda, comunicados oficiales, cortes programados, cursos, eventos.
- Riesgo Alto: resultados deportivos, elecciones, fallecimientos, accidentes, causas judiciales, estadísticas, conflictos.

PASO 2: REDACCIÓN. Solo si los hechos son sólidos, redactá una nota periodística ORIGINAL basada EXCLUSIVAMENTE en los hechos verificados.
Reglas de redacción:
- No inventes datos, citas, cifras, ni consecuencias que no estén en el texto.
- No uses frases como "según el texto".
- Título informativo y atractivo, sin clickbait. Bajada SEO (100-170 chars).
- Cuerpo en Markdown (5-9 párrafos).

Entregá EXCLUSIVAMENTE un JSON válido con esta estructura exacta:
{
  "verificacion": {
    "protagonistas": ["..."],
    "acontecimiento": "...",
    "lugar": "...",
    "fecha": "...",
    "cifras_clave": ["..."],
    "riesgo": "bajo" | "alto",
    "coherencia_titulo_cuerpo": true | false,
    "calidad_suficiente": true | false,
    "falta_info_central": true | false
  },
  "news": {
    "title": "...",
    "description": "...",
    "category": "Provincia|Río Grande|Ushuaia|Tolhuin|Malvinas|Antártida|Nacionales|Mundo|Política|Economía|Sociedad|Policiales|Institucional",
    "location": "...",
    "tags": ["...", "...", "..."],
    "imageAlt": "...",
    "body": "...",
    "importance": 1-10
  }
}`;

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
  
  if (!parsed.verificacion || !parsed.news) {
    throw new Error('Estructura JSON inválida: falta verificacion o news');
  }
  
  const v = parsed.verificacion;
  if (!v.coherencia_titulo_cuerpo) throw new Error('FACT_CHECK_FAILED: Baja coherencia entre título y cuerpo');
  if (!v.calidad_suficiente) throw new Error('FACT_CHECK_FAILED: Calidad insuficiente de extracción');
  if (v.falta_info_central) throw new Error('FACT_CHECK_FAILED: Falta información central del acontecimiento');
  if (v.riesgo === 'alto') throw new Error('HIGH_RISK_REQUIRES_CORROBORATION: Riesgo alto detectado por IA, requiere corroboración humana o fuente cruzada');

  const n = parsed.news;
  return {
    title: cleanText(n.title),
    description: cleanText(n.description).slice(0, 180),
    category: cleanText(n.category || defaultCategory || 'Provincia'),
    location: cleanText(n.location || defaultLocation || 'Tierra del Fuego AIAS'),
    tags: Array.isArray(n.tags) ? n.tags.map(cleanText).filter(Boolean).slice(0, 6) : [],
    imageAlt: cleanText(n.imageAlt || n.title),
    body: cleanText(n.body),
    importance: Math.max(1, Math.min(10, Number(n.importance) || 5)),
    facts: v
  };
}

export function makeNewsMarkdown({
  ai,
  date,
  image,
  sourceName,
  sourceUrl,
  featured = false,
  automated = true,
  imageMeta = null,
  sourcePublishedAt = null
}) {
  const importance = ai.importance || 5;
  const urgent = importance >= 9;
  const imageSourceLines = [];
  if (imageMeta?.strategy) imageSourceLines.push(`imageStrategy: ${yamlString(imageMeta.strategy)}`);
  if (imageMeta?.sourceUrl) imageSourceLines.push(`imageSourceUrl: ${yamlString(imageMeta.sourceUrl)}`);
  if (imageMeta?.credit) imageSourceLines.push(`imageCredit: ${yamlString(imageMeta.credit)}`);
  if (imageMeta?.license) imageSourceLines.push(`imageLicense: ${yamlString(imageMeta.license)}`);
  const imageSourceBlock = imageSourceLines.length ? `${imageSourceLines.join('\n')}\n` : '';
  const sourceDate = sourcePublishedAt ? new Date(sourcePublishedAt) : null;
  const sourcePublishedAtBlock = sourceDate && !Number.isNaN(sourceDate.valueOf())
    ? `sourcePublishedAt: ${yamlString(sourceDate.toISOString())}\n`
    : '';
  return `---
title: ${yamlString(ai.title)}
description: ${yamlString(ai.description)}
date: ${yamlString(safeDate(date).toISOString())}
${sourcePublishedAtBlock}category: ${yamlString(ai.category)}
topic: ${yamlString(ai.topic || ai.category)}
territory: ${yamlString(ai.territory || 'Provincia')}
scope: ${yamlString(ai.scope || 'provincial')}
secondaryTerritories: ${yamlArray(ai.secondaryTerritories || [])}
classificationConfidence: ${yamlString(ai.classificationConfidence || 'low')}
classificationReason: ${yamlString(ai.classificationReason || 'legacy')}
classificationVersion: ${Number(ai.classificationVersion) || 2}
storyId: ${yamlString(ai.storyId || '')}
storyVersion: ${Number(ai.storyVersion) || 1}
location: ${yamlString(ai.location)}
tags: ${yamlArray(ai.tags)}
contentType: ${yamlString(ai.contentType || 'noticia')}
editorialProcess: "automatico"
keyPoints: ${yamlArray(ai.keyPoints || [])}
whyItMatters: ${yamlString(ai.whyItMatters || '')}
image: ${yamlString(image || '')}
imageAlt: ${yamlString(ai.imageAlt || ai.title)}
${imageSourceBlock}author: "Redacción Actualidad Fueguina"
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

export function makeDraftMarkdown({ item, article, source, mode, reason = '', ai = null, opportunity = null }) {
  const title = cleanText(ai?.title || article.title || item.title || 'Sin título');
  const summary = cleanText(ai?.description || article.description || item.description || '').slice(0, 180);
  const material = cleanText(article.text || item.description || '').slice(0, 14000);
  const reasons = opportunity?.reasons || [];
  const opportunitySection = opportunity ? `## Análisis previo de oportunidad editorial

- Tipo: ${opportunity.opportunityType || 'standard-news'}
- Formato recomendado: ${opportunity.recommendedFormat || 'noticia'}
- Acción sugerida: ${opportunity.recommendedAction || 'revisar'}
- Revisión humana obligatoria: ${opportunity.requiresHumanReview ? 'sí' : 'no'}
${opportunity.followUpFormat ? `- Seguimiento posible: ${opportunity.followUpFormat}\n` : ''}${reasons.length ? `- Motivos: ${reasons.join(', ')}\n` : ''}
` : '';
  const draftSection = ai?.body ? `## Borrador factual generado

${ai.body.trim()}

` : '';
  return `---
title: ${yamlString(title)}
description: ${yamlString(summary || 'Material detectado automáticamente para evaluación editorial.')}
date: ${yamlString(safeDate(item.pubDate || article.date).toISOString())}
category: ${yamlString(ai?.category || source.defaultCategory || 'Provincia')}
location: ${yamlString(ai?.location || source.location || 'Tierra del Fuego AIAS')}
sourceName: ${yamlString(source.name)}
sourceUrl: ${yamlString(article.finalUrl || item.link)}
originalImage: ${yamlString(article.image || '')}
status: ${yamlString(opportunity?.requiresHumanReview ? 'review' : 'draft')}
detectedAt: ${yamlString(new Date().toISOString())}
mode: ${yamlString(mode)}
editorialReason: ${yamlString(reason)}
opportunityType: ${yamlString(opportunity?.opportunityType || '')}
recommendedFormat: ${yamlString(opportunity?.recommendedFormat || '')}
recommendedAction: ${yamlString(opportunity?.recommendedAction || '')}
opportunityReasons: ${yamlArray(reasons)}
requiresHumanReview: ${opportunity?.requiresHumanReview ? 'true' : 'false'}
---

${opportunitySection}${draftSection}## Material fuente detectado

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
