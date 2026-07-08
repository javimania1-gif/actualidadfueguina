import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ROOT,
  cleanText,
  hash,
  normalizeImageAsset
} from './news-utils.mjs';
import { normalizeText } from './pipeline-utils.mjs';

export const MEDIA_LIBRARY_PATH = path.join(ROOT, 'data/media-library.json');

const GENERIC_IMAGE_TERMS = new Set([
  'tierra del fuego',
  'provincia',
  'mundo',
  'internacional',
  'sociedad',
  'nacionales',
  'noticias',
  'actualidad',
  'rio grande',
  'ushuaia',
  'tolhuin'
]);

function uniqueByQuery(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const query = cleanText(item.query);
    const key = normalizeText(query);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, query });
  }
  return out;
}

function isGenericQuery(query) {
  const normalized = normalizeText(query);
  if (!normalized || GENERIC_IMAGE_TERMS.has(normalized)) return true;
  const words = normalized.split(/\s+/).filter(Boolean);
  return words.length <= 1 && GENERIC_IMAGE_TERMS.has(words[0]);
}

function addIntent(intents, query, reason, weight) {
  if (!query || isGenericQuery(query)) return;
  intents.push({ query: cleanText(query), reason, weight });
}

function textIncludesAny(text, values = []) {
  const normalized = normalizeText(text);
  return values.some((value) => {
    const key = normalizeText(value);
    return key && normalized.includes(key);
  });
}

export function buildImagePlan({
  title = '',
  verifiedFacts = {},
  category = '',
  location = '',
  organizations = [],
  people = [],
  places = [],
  eventType = '',
  sourceArticle = {}
} = {}) {
  const intents = [];
  const combined = [
    title,
    category,
    location,
    eventType,
    sourceArticle.title,
    sourceArticle.description,
    ...(verifiedFacts.people || []),
    ...(verifiedFacts.organizations || []),
    ...(verifiedFacts.places || []),
    ...(verifiedFacts.teams || []),
    ...organizations,
    ...people,
    ...places
  ].filter(Boolean).join(' ');

  if (textIncludesAny(combined, ['Gustavo Melella', 'Melella'])) {
    addIntent(intents, 'Gustavo Melella', 'person-main', 100);
    addIntent(intents, 'Gustavo Melella gobernador Tierra del Fuego', 'person-role', 95);
    addIntent(intents, 'Casa de Gobierno Tierra del Fuego Ushuaia', 'official-place', 70);
  }

  if (textIncludesAny(combined, ['Discord'])) {
    addIntent(intents, 'Discord official logo', 'organization-logo', 100);
    addIntent(intents, 'Discord platform interface', 'platform-interface', 85);
    addIntent(intents, 'Discord official brand', 'brand-resource', 80);
  }

  if (textIncludesAny(combined, ['Argentina', 'Egipto', 'Ecuador', 'Seleccion Argentina', 'Selección Argentina'])) {
    addIntent(intents, 'Selección Argentina fútbol', 'organization-main', 95);
    addIntent(intents, 'Argentina national football team', 'commons-exact', 90);
  }

  if (textIncludesAny(combined, ['Casa del Deporte', 'Casa de Deporte'])) {
    addIntent(intents, 'Casa del Deporte Tolhuin', 'place-exact', 100);
    addIntent(intents, 'Casa de Deporte de Tolhuin', 'official-place', 95);
    addIntent(intents, 'actividad deportiva Tolhuin Casa del Deporte', 'activity-place', 80);
  }

  if (textIncludesAny(combined, ['Parque Termal', 'Termas de Tolhuin', 'Termas del Rio Valdez', 'Termas del Río Valdez'])) {
    addIntent(intents, 'Termas de Tolhuin', 'place-exact', 100);
    addIntent(intents, 'Parque Termal Tolhuin', 'official-place', 95);
    addIntent(intents, 'Tolhuin termas Río Valdez', 'specific-location', 85);
  }

  for (const person of [...people, ...(verifiedFacts.people || [])].slice(0, 3)) {
    addIntent(intents, person, 'person-fact', 80);
  }
  for (const org of [...organizations, ...(verifiedFacts.organizations || [])].slice(0, 3)) {
    addIntent(intents, org, 'organization-fact', 75);
  }
  for (const place of [...places, ...(verifiedFacts.places || [])].slice(0, 3)) {
    addIntent(intents, place, 'place-fact', 65);
  }

  return uniqueByQuery(intents).sort((a, b) => b.weight - a.weight);
}

export async function loadMediaLibrary() {
  try {
    const parsed = JSON.parse(await fs.readFile(MEDIA_LIBRARY_PATH, 'utf8'));
    return Array.isArray(parsed.assets) ? parsed.assets : [];
  } catch {
    return [];
  }
}

function tokenizeForScore(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !GENERIC_IMAGE_TERMS.has(word));
}

export function scoreMediaAsset(entry = {}, plan = [], contextText = '') {
  const searchable = normalizeText([
    entry.label,
    ...(entry.aliases || []),
    ...(entry.tags || []),
    entry.type
  ].filter(Boolean).join(' '));
  let score = Number(entry.priority || 0);
  let matchedQuery = '';

  for (const intent of plan) {
    const query = normalizeText(intent.query);
    if (!query) continue;
    const tokens = tokenizeForScore(query);
    const matches = tokens.filter((token) => searchable.includes(token)).length;
    if (searchable.includes(query)) {
      score += Math.max(80, intent.weight);
      if (entry.type === 'person' && intent.reason?.startsWith('person')) score += 45;
      if (entry.type === 'place' && intent.reason?.includes('place')) score += 35;
      if (entry.type === 'organization' && intent.reason?.includes('organization')) score += 35;
      matchedQuery = intent.query;
      break;
    }
    if (tokens.length > 0 && matches >= Math.ceil(tokens.length * 0.6)) {
      score += Math.min(70, intent.weight);
      if (entry.type === 'person' && intent.reason?.startsWith('person')) score += 35;
      if (entry.type === 'place' && intent.reason?.includes('place')) score += 25;
      if (entry.type === 'organization' && intent.reason?.includes('organization')) score += 25;
      matchedQuery = intent.query;
    }
  }

  if (!matchedQuery) score -= 50;
  if (textIncludesAny(`${entry.label} ${(entry.tags || []).join(' ')}`, ['logo']) && !textIncludesAny(contextText, ['discord'])) score -= 80;
  return { score, matchedQuery };
}

function commonsMetadataText(page = {}) {
  const info = page.imageinfo?.[0] || {};
  const meta = info.extmetadata || {};
  return [
    page.title,
    meta.ObjectName?.value,
    meta.ImageDescription?.value,
    meta.Categories?.value,
    meta.Artist?.value
  ].filter(Boolean).join(' ');
}

export function scoreCommonsResult(page = {}, query = '') {
  const text = normalizeText(commonsMetadataText(page).replace(/<[^>]+>/g, ' '));
  const queryTokens = tokenizeForScore(query);
  const matches = queryTokens.filter((token) => text.includes(token)).length;
  if (queryTokens.length === 0) return 0;
  let score = Math.round((matches / queryTokens.length) * 100);
  if (text.includes(normalizeText(query))) score += 35;
  if (/\b(logo|map|flag|escudo)\b/.test(text) && !/\b(discord|bandera|escudo)\b/.test(normalizeText(query))) score -= 30;
  return score;
}

export async function searchCommonsExact(plan = [], { fetchImpl = fetch } = {}) {
  for (const intent of plan.slice(0, 6)) {
    const params = new URLSearchParams({
      action: 'query',
      generator: 'search',
      gsrsearch: intent.query,
      gsrnamespace: '6',
      gsrlimit: '8',
      prop: 'imageinfo',
      iiprop: 'url|mime|size|extmetadata',
      format: 'json'
    });
    const response = await fetchImpl(`https://commons.wikimedia.org/w/api.php?${params.toString()}`, {
      headers: { 'user-agent': 'ActualidadFueguinaBot/1.0 (+https://actualidadfueguina.com.ar)' }
    });
    if (!response.ok) continue;
    const payload = await response.json();
    const pages = Object.values(payload.query?.pages || {});
    const ranked = pages
      .map((page) => ({ page, score: scoreCommonsResult(page, intent.query) + Math.round(intent.weight / 10) }))
      .filter((result) => result.score >= 75)
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best) continue;
    const info = best.page.imageinfo?.[0] || {};
    if (!info.url) continue;
    const meta = info.extmetadata || {};
    return {
      imageUrl: info.url,
      sourceUrl: info.descriptionurl || best.page.fullurl || '',
      strategy: 'commons-exact',
      query: intent.query,
      score: best.score,
      credit: cleanText(String(meta.Attribution?.value || meta.Artist?.value || 'Wikimedia Commons').replace(/<[^>]+>/g, ' ')),
      license: cleanText(meta.LicenseShortName?.value || meta.UsageTerms?.value || 'Wikimedia Commons'),
      alt: cleanText(String(meta.ImageDescription?.value || best.page.title || intent.query).replace(/<[^>]+>/g, ' '))
    };
  }
  return null;
}

export async function selectImageForNews({
  article = {},
  ai = {},
  verification = {},
  sourceArticle = {}
} = {}) {
  const contextText = [
    ai.title,
    ai.description,
    ai.category,
    ai.location,
    article.title,
    sourceArticle.title,
    ...(ai.tags || [])
  ].filter(Boolean).join(' ');

  if (article.image) {
    const articleResult = await normalizeImageAsset(article.image, {
      seed: article.finalUrl || article.image,
      purpose: 'web',
      timeoutMs: 12000
    });
    if (articleResult.ok) {
      return {
        image: articleResult.publicPath,
        meta: {
          strategy: 'article-og',
          query: article.title || ai.title || '',
          score: 82,
          sourceUrl: articleResult.sourceUrl || article.image,
          credit: article.finalUrl || '',
          license: 'Imagen del articulo fuente; procedencia registrada'
        },
        plan: []
      };
    }
  }

  const verifiedFacts = verification?.verifiedFacts || verification?.consensusFacts || {};
  const plan = buildImagePlan({
    title: ai.title || article.title,
    verifiedFacts,
    category: ai.category,
    location: ai.location,
    organizations: verifiedFacts.organizations || [],
    people: verifiedFacts.people || [],
    places: verifiedFacts.places || [],
    eventType: verifiedFacts.eventType || '',
    sourceArticle: sourceArticle.title ? sourceArticle : article
  });

  const library = await loadMediaLibrary();
  const rankedLibrary = library
    .map((entry) => ({ entry, ...scoreMediaAsset(entry, plan, contextText) }))
    .filter((result) => result.score >= 75)
    .sort((a, b) => b.score - a.score);

  for (const result of rankedLibrary) {
    const entry = result.entry;
    const imageResult = await normalizeImageAsset(entry.imageUrl, {
      seed: entry.id || entry.imageUrl || hash(contextText),
      purpose: 'web',
      timeoutMs: 15000,
      allowLogos: !!entry.allowLogos,
      minWidth: entry.minWidth || (entry.allowLogos ? 80 : 400),
      minHeight: entry.minHeight || (entry.allowLogos ? 80 : 300),
      canvasBackground: entry.canvasBackground || ''
    });
    if (!imageResult.ok) continue;
    return {
      image: imageResult.publicPath,
      meta: {
        strategy: entry.strategy || 'media-library',
        query: result.matchedQuery || entry.label,
        score: result.score,
        sourceUrl: entry.sourceUrl || imageResult.sourceUrl || entry.imageUrl,
        credit: entry.credit || '',
        license: entry.license || '',
        rightsNote: entry.rightsNote || ''
      },
      imageAlt: entry.alt || ai.imageAlt || ai.title,
      plan
    };
  }

  const commons = await searchCommonsExact(plan).catch(() => null);
  if (commons?.imageUrl) {
    const imageResult = await normalizeImageAsset(commons.imageUrl, {
      seed: commons.sourceUrl || commons.imageUrl || hash(contextText),
      purpose: 'web',
      timeoutMs: 15000
    });
    if (imageResult.ok) {
      return {
        image: imageResult.publicPath,
        meta: {
          strategy: 'commons-exact',
          query: commons.query,
          score: commons.score,
          sourceUrl: commons.sourceUrl,
          credit: commons.credit,
          license: commons.license
        },
        imageAlt: commons.alt || ai.imageAlt || ai.title,
        plan
      };
    }
  }

  return {
    image: '',
    meta: {
      strategy: 'fallback-plate',
      query: plan[0]?.query || ai.title || article.title || '',
      score: 0,
      sourceUrl: '',
      credit: '',
      license: ''
    },
    plan
  };
}

export function logImageSelection(selection = {}) {
  const meta = selection.meta || {};
  console.log(
    `IMAGE SELECTED strategy=${meta.strategy || ''} query="${meta.query || ''}" score=${meta.score ?? ''} source=${meta.sourceUrl || ''}`
  );
}
