
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, callModel, extractJsonObject, cleanText, sleep } from './news-utils.mjs';

export const SOCIAL_DATA_PATH = path.join(ROOT, 'data/social-posts.json');
export const META_GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || 'v21.0';

/**
 * Escapa caracteres especiales para XML/SVG.
 */
export function escapeXml(unsafe) {
  return String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Carga el registro de publicaciones sociales.
 */
export async function loadSocialData() {
  try {
    const content = await fs.readFile(SOCIAL_DATA_PATH, 'utf8');
    const data = JSON.parse(content);
    // Migración de array a objeto si es necesario
    if (Array.isArray(data.posts)) {
      const posts = {};
      data.posts.forEach(p => {
        const key = `${p.slug}|${p.platform}`;
        posts[key] = p;
      });
      data.posts = posts;
    }
    return data;
  } catch {
    return { version: 2, posts: {} };
  }
}

/**
 * Guarda el registro de publicaciones sociales.
 */
export async function saveSocialData(data) {
  await fs.mkdir(path.dirname(SOCIAL_DATA_PATH), { recursive: true });
  // Limpieza básica si hay demasiados
  const keys = Object.keys(data.posts);
  if (keys.length > 2000) {
    const sorted = keys.sort((a, b) => new Date(data.posts[b].date).getTime() - new Date(data.posts[a].date).getTime());
    const newPosts = {};
    sorted.slice(0, 1000).forEach(k => newPosts[k] = data.posts[k]);
    data.posts = newPosts;
  }
  await fs.writeFile(SOCIAL_DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Genera textos para redes sociales usando IA.
 */
export async function generateSocialCopy({ title, description, category, location, tags, body, platform }) {
  const system = `Sos el Community Manager de Actualidad Fueguina.
Tu tarea es escribir el copy para una publicación de ${platform.toUpperCase()}.
Actualidad Fueguina es un medio serio, cercano y profesional de Tierra del Fuego.

Reglas para FACEBOOK:
- Presentar el hecho de forma clara.
- Explicar por qué importa al lector local.
- Lenguaje periodístico pero cercano.
- Favorecer comentarios con una pregunta natural al final.
- Evitar clickbait falso.
- Incluir un placeholder para el enlace: [URL].
- No inventar información.

Reglas para INSTAGRAM:
- Caption visual y estructurado.
- Párrafos breves.
- Generar conversación e invitar a leer la nota en la bio.
- Incluir de 3 a 8 hashtags relevantes.
- Máximo 2 emojis.
- No inventar información.

Entregá exclusivamente JSON con el campo "text".`;

  const user = `TÍTULO: ${title}
BAJADA: ${description}
CATEGORÍA: ${category}
UBICACIÓN: ${location}
TAGS: ${tags.join(', ')}
CUERPO: ${body.slice(0, 4000)}`;

  const response = await fetch('https://models.github.ai/inference/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`
    },
    body: JSON.stringify({
      model: process.env.AF_MODEL || 'openai/gpt-4o-mini',
      temperature: 0.7,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Error IA Social: ${response.status}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  const parsed = extractJsonObject(content);
  return cleanText(parsed.text);
}

/**
 * Genera una placa visual para Instagram con logo AF.
 */
export async function generateInstagramPlate({ title, category, imagePath, outputPath }) {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch (e) {
    console.warn('Sharp no disponible.');
    return null;
  }

  const width = 1080;
  const height = 1350;

  try {
    let baseImage;
    if (imagePath && imagePath.startsWith('/')) {
      const fullPath = path.join(ROOT, 'public', imagePath);
      if (await fs.access(fullPath).then(() => true).catch(() => false)) {
        baseImage = fullPath;
      }
    }

    const background = baseImage
      ? await sharp(baseImage).resize(width, height, { fit: 'cover' }).blur(5).toBuffer()
      : { create: { width, height, channels: 4, background: { r: 0, g: 48, b: 87, alpha: 1 } } };

    const words = title.split(' ');
    let lines = [''];
    let currentLine = 0;
    for (const word of words) {
      if ((lines[currentLine] + word).length < 24) {
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
      const logoBuffer = await sharp(logoPath).resize(120, 120).toBuffer();
      composites.push({ input: logoBuffer, top: 40, left: 920 });
    }

    const escapedCategory = escapeXml(category.toUpperCase());
    const escapedLines = lines.map(escapeXml);

    const overlaySvg = `
      <svg width="${width}" height="${height}">
        <defs>
          <linearGradient id="grad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:rgba(0,0,0,0.2);stop-opacity:1" />
            <stop offset="60%" style="stop-color:rgba(0,0,0,0.5);stop-opacity:1" />
            <stop offset="100%" style="stop-color:rgba(0,0,0,0.9);stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#grad)" />
        <text x="50" y="100" font-family="sans-serif" font-size="32" font-weight="bold" fill="#ffffff">${escapedCategory}</text>
        <text x="50" y="850" font-family="sans-serif" font-size="64" font-weight="bold" fill="#ffffff">${escapedLines[0]}</text>
        ${escapedLines[1] ? `<text x="50" y="940" font-family="sans-serif" font-size="64" font-weight="bold" fill="#ffffff">${escapedLines[1]}</text>` : ''}
        ${escapedLines[2] ? `<text x="50" y="1030" font-family="sans-serif" font-size="64" font-weight="bold" fill="#ffffff">${escapedLines[2]}</text>` : ''}
        <text x="50" y="1280" font-family="sans-serif" font-size="28" fill="#ffffff">actualidadfueguina.com.ar</text>
      </svg>
    `;

    composites.push({ input: Buffer.from(overlaySvg), top: 0, left: 0 });

    await sharp(background).composite(composites).toFile(outputPath);
    return outputPath;
  } catch (error) {
    console.error('Error generando placa:', error);
    return null;
  }
}

/**
 * Llama a la API con reintentos para errores recuperables.
 */
async function callMetaWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      const data = await res.json();
      if (res.ok) return data;

      const errorMsg = data.error?.message || res.statusText;
      const isRecoverable = [408, 429, 500, 502, 503, 504].includes(res.status) || errorMsg.includes('limit');

      if (isRecoverable && i < retries - 1) {
        const delay = Math.pow(2, i) * 2000;
        console.warn(`Reintentando en ${delay}ms... (${errorMsg})`);
        await sleep(delay);
        continue;
      }
      throw new Error(errorMsg);
    } catch (err) {
      if (i === retries - 1) throw err;
      await sleep(2000);
    }
  }
}

export async function publishToFacebook({ text, link, dryRun = false }) {
  if (dryRun) return { id: 'dry-run-fb-' + Date.now() };

  const pageId = process.env.META_PAGE_ID;
  const accessToken = process.env.META_PAGE_ACCESS_TOKEN;
  const version = META_GRAPH_API_VERSION;

  if (!pageId || !accessToken) throw new Error('Credenciales faltantes');

  const url = `https://graph.facebook.com/${version}/${pageId}/feed`;
  return callMetaWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text.replace('[URL]', link), link, access_token: accessToken })
  });
}

export async function publishToInstagram({ text, imageUrl, dryRun = false }) {
  if (dryRun) return { id: 'dry-run-ig-' + Date.now() };

  const igUserId = process.env.META_IG_USER_ID;
  const accessToken = process.env.META_PAGE_ACCESS_TOKEN;
  const version = META_GRAPH_API_VERSION;

  if (!igUserId || !accessToken) throw new Error('Credenciales faltantes');

  const containerUrl = `https://graph.facebook.com/${version}/${igUserId}/media`;
  const containerData = await callMetaWithRetry(containerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: imageUrl, caption: text, access_token: accessToken })
  });

  const publishUrl = `https://graph.facebook.com/${version}/${igUserId}/media_publish`;
  return callMetaWithRetry(publishUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: containerData.id, access_token: accessToken })
  });
}
