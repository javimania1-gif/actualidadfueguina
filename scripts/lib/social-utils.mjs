
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, callModel, extractJsonObject, cleanText } from './news-utils.mjs';

export const SOCIAL_DATA_PATH = path.join(ROOT, 'data/social-posts.json');

/**
 * Carga el registro de publicaciones sociales.
 */
export async function loadSocialData() {
  try {
    const content = await fs.readFile(SOCIAL_DATA_PATH, 'utf8');
    return JSON.parse(content);
  } catch {
    return { version: 1, posts: [] };
  }
}

/**
 * Guarda el registro de publicaciones sociales.
 */
export async function saveSocialData(data) {
  await fs.mkdir(path.dirname(SOCIAL_DATA_PATH), { recursive: true });
  // Mantener los últimos 1000 registros para no crecer infinitamente
  if (data.posts.length > 1000) {
    data.posts = data.posts.slice(-1000);
  }
  await fs.writeFile(SOCIAL_DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Genera textos para redes sociales usando IA.
 */
export async function generateSocialCopy({ title, description, category, location, tags, body, platform }) {
  const isInstagram = platform === 'instagram';

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
- No inventar información que no esté en el texto base.

Reglas para INSTAGRAM:
- Caption visual y estructurado.
- Párrafos breves.
- Generar conversación.
- Incluir de 3 a 8 hashtags relevantes al final.
- No saturar de emojis, usar 1 o 2 máximo.
- Invitar a leer la nota en el link de la biografía o sitio web.
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
 * Genera una placa visual para Instagram.
 * Requiere 'sharp'.
 */
export async function generateInstagramPlate({ title, category, imagePath, outputPath }) {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch (e) {
    console.warn('Sharp no está instalado. Saltando generación de imagen.');
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

    // Si no hay imagen, usamos un fondo sólido con el color de AF
    const background = baseImage
      ? await sharp(baseImage).resize(width, height, { fit: 'cover' }).blur(5).toBuffer()
      : { create: { width, height, channels: 4, background: { r: 0, g: 48, b: 87, alpha: 1 } } };

    const words = title.split(' ');
    let line1 = '';
    let line2 = '';
    for (const word of words) {
      if ((line1 + word).length < 25) line1 += (line1 ? ' ' : '') + word;
      else if ((line2 + word).length < 25) line2 += (line2 ? ' ' : '') + word;
      else if (line2 && !line2.endsWith('...')) line2 += '...';
    }

    const overlay = Buffer.from(`
      <svg width="${width}" height="${height}">
        <defs>
          <linearGradient id="grad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:rgba(0,0,0,0.1);stop-opacity:1" />
            <stop offset="50%" style="stop-color:rgba(0,0,0,0.5);stop-opacity:1" />
            <stop offset="100%" style="stop-color:rgba(0,0,0,0.9);stop-opacity:1" />
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#grad)" />

        <text x="50" y="100" font-family="sans-serif" font-size="32" font-weight="bold" fill="#ffffff">
          ${category.toUpperCase()}
        </text>

        <text x="50" y="850" font-family="sans-serif" font-size="64" font-weight="bold" fill="#ffffff">
          ${line1}
        </text>
        ${line2 ? `<text x="50" y="930" font-family="sans-serif" font-size="64" font-weight="bold" fill="#ffffff">${line2}</text>` : ''}

        <text x="50" y="1280" font-family="sans-serif" font-size="24" fill="#cccccc">
          actualidadfueguina.com.ar
        </text>
      </svg>
    `);

    await sharp(background)
      .composite([{ input: overlay, top: 0, left: 0 }])
      .toFile(outputPath);

    return outputPath;
  } catch (error) {
    console.error('Error generando placa Instagram:', error);
    return null;
  }
}

/**
 * Publica en Facebook Page.
 */
export async function publishToFacebook({ text, link, dryRun = false }) {
  const pageId = process.env.META_PAGE_ID;
  const accessToken = process.env.META_PAGE_ACCESS_TOKEN;
  const version = process.env.META_GRAPH_API_VERSION || 'v21.0';

  if (dryRun) {
    console.log(`[DRY-RUN FB] Publicando: ${text.slice(0, 50)}... URL: ${link}`);
    return { id: 'dry-run-fb-' + Date.now() };
  }

  if (!pageId || !accessToken) {
    throw new Error('Faltan credenciales de Facebook (META_PAGE_ID, META_PAGE_ACCESS_TOKEN)');
  }

  const url = `https://graph.facebook.com/${version}/${pageId}/feed`;
  const message = text.replace('[URL]', link);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: message,
      link: link,
      access_token: accessToken
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Facebook API Error: ${data.error?.message || response.statusText}`);
  }

  return data;
}

/**
 * Publica en Instagram Business.
 * Requiere dos pasos: crear contenedor y publicar.
 */
export async function publishToInstagram({ text, imageUrl, dryRun = false }) {
  const igUserId = process.env.META_IG_USER_ID;
  const accessToken = process.env.META_PAGE_ACCESS_TOKEN; // Usualmente el mismo token de página funciona si están vinculadas
  const version = process.env.META_GRAPH_API_VERSION || 'v21.0';

  if (dryRun) {
    console.log(`[DRY-RUN IG] Publicando: ${text.slice(0, 50)}... Image: ${imageUrl}`);
    return { id: 'dry-run-ig-' + Date.now() };
  }

  if (!igUserId || !accessToken) {
    throw new Error('Faltan credenciales de Instagram (META_IG_USER_ID, META_PAGE_ACCESS_TOKEN)');
  }

  // 1. Crear contenedor de media
  const containerUrl = `https://graph.facebook.com/${version}/${igUserId}/media`;
  const containerRes = await fetch(containerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: imageUrl,
      caption: text,
      access_token: accessToken
    })
  });

  const containerData = await containerRes.json();
  if (!containerRes.ok) {
    throw new Error(`Instagram Container Error: ${containerData.error?.message || containerRes.statusText}`);
  }

  const creationId = containerData.id;

  // 2. Publicar el contenedor
  const publishUrl = `https://graph.facebook.com/${version}/${igUserId}/media_publish`;
  const publishRes = await fetch(publishUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      creation_id: creationId,
      access_token: accessToken
    })
  });

  const publishData = await publishRes.json();
  if (!publishRes.ok) {
    throw new Error(`Instagram Publish Error: ${publishData.error?.message || publishRes.statusText}`);
  }

  return publishData;
}
