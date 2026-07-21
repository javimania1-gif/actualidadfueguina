import { normalizeText } from './pipeline-utils.mjs';

export const FEATURED_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const SPORTS_PREVIEW_MAX_AGE_MS = 36 * 60 * 60 * 1000;

function articleData(article = {}) {
  return article.data || article;
}

function articleAgeMs(article = {}, now = Date.now()) {
  const data = articleData(article);
  const timestamp = new Date(data.sourcePublishedAt || data.date || 0).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.max(0, now - timestamp) : Infinity;
}

export function isExpiredSportsPreview(article = {}, now = Date.now()) {
  const data = articleData(article);
  if (articleAgeMs(article, now) <= SPORTS_PREVIEW_MAX_AGE_MS) return false;

  const text = normalizeText(`${data.category || ''} ${data.title || ''} ${data.description || ''}`);
  const sportsContext = /\b(deportes|futbol|mundial|seleccion|partido|semifinal|final)\b/.test(text);
  const previewContext = /\b(previa|previo|se prepara|enfrentara|enfrenta|se medira|se vera|transmitira|transmision|pantalla gigante|convocatoria|comenzara|hoy|manana|este lunes|este martes|este miercoles|este jueves|este viernes|este sabado|este domingo)\b/.test(text);
  const resultContext = /\b(resultado|gano|vencio|derroto|empato|perdio|elimino|clasifico|campeon|subcampeon|tras la victoria|tras la derrota)\b/.test(text);

  return sportsContext && previewContext && !resultContext;
}

export function isHomepageEligible(article = {}, now = Date.now()) {
  const data = articleData(article);
  const expiresAt = data.expiresAt ? new Date(data.expiresAt).getTime() : NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= now) return false;
  return !isExpiredSportsPreview(article, now);
}

export function isCurrentFeatured(article = {}, now = Date.now()) {
  const data = articleData(article);
  return Boolean(data.featured)
    && isHomepageEligible(article, now)
    && articleAgeMs(article, now) <= FEATURED_MAX_AGE_MS;
}
