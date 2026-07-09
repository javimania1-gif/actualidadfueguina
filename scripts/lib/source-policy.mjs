import { normalizeText } from './pipeline-utils.mjs';

export const SOURCE_TIERS = Object.freeze({
  A: 'A',
  B: 'B',
  C: 'C'
});

const AGGREGATOR_DOMAINS = new Set([
  'news.google.com',
  'www.google.com',
  'google.com',
  'www.bing.com',
  'bing.com',
  'www.msn.com',
  'msn.com'
]);

const GENERIC_PATH_SEGMENTS = new Set([
  '',
  'home',
  'inicio',
  'noticias',
  'news',
  'politica',
  'sociedad',
  'economia',
  'deportes',
  'mundo',
  'nacionales',
  'provincia',
  'rio-grande',
  'ushuaia',
  'tolhuin',
  'category',
  'categoria',
  'tag'
]);

export function getDomain(urlStr) {
  try {
    return new URL(urlStr).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function getPathSegments(urlStr) {
  try {
    return new URL(urlStr).pathname
      .split('/')
      .map((segment) => segment.trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function isAggregatorDomain(urlStr) {
  const host = getDomain(urlStr);
  return AGGREGATOR_DOMAINS.has(host) || AGGREGATOR_DOMAINS.has(`www.${host}`);
}

export function isOfficialDomain(url, domains = []) {
  const host = getDomain(url);
  return domains.some((domain) => {
    const clean = String(domain).toLowerCase().replace(/^www\./, '');
    return host === clean || host.endsWith(`.${clean}`);
  });
}

export function isHomepage(urlStr) {
  try {
    const url = new URL(urlStr);
    const path = url.pathname.replace(/\/+$/, '');
    return path === '' || path === '/home' || path === '/inicio' || path === '/noticias';
  } catch {
    return true;
  }
}

export function isGenericListingUrl(urlStr) {
  if (isHomepage(urlStr)) return true;
  const segments = getPathSegments(urlStr);
  if (segments.length === 0) return true;
  if (segments.length > 2) return false;
  return segments.every((segment) => GENERIC_PATH_SEGMENTS.has(segment));
}

export function classifySourceTier({ source = {}, finalUrl = '', officialDomains = [] }) {
  if (source.tier && SOURCE_TIERS[source.tier]) return source.tier;
  if (source.mode === 'official-auto' || isOfficialDomain(finalUrl, officialDomains)) {
    return SOURCE_TIERS.A;
  }
  if (isAggregatorDomain(finalUrl)) return SOURCE_TIERS.C;
  return SOURCE_TIERS.B;
}

export function buildSourceRef({ source = {}, item = {}, article = {}, officialDomains = [] }) {
  const finalUrl = article.canonicalUrl || article.finalUrl || item.link || '';
  const publisherDomain = getDomain(finalUrl);
  const tier = classifySourceTier({ source, finalUrl, officialDomains });
  const discoveredBy = isAggregatorDomain(item.link || '') ? getDomain(item.link) : '';
  const competence = inferSourceCompetence({ source, publisherDomain, finalUrl });
  return {
    sourceId: source.id || '',
    sourceName: source.name || '',
    sourceMode: source.mode || '',
    tier,
    competence,
    publisherDomain,
    discoveredBy,
    url: finalUrl,
    originalUrl: item.link || finalUrl,
    title: article.title || item.title || '',
    publishedAt: article.date || item.pubDate || ''
  };
}

export function inferSourceCompetence({ source = {}, publisherDomain = '', finalUrl = '' } = {}) {
  const publisherText = normalizeText([
    publisherDomain,
    finalUrl
  ].filter(Boolean).join(' '));
  const sourceText = normalizeText([
    source.id,
    source.name,
    source.mode
  ].filter(Boolean).join(' '));
  const text = source.mode === 'official-auto'
    ? `${sourceText} ${publisherText}`
    : publisherText;
  const competence = new Set();

  if (/\b(riogrande|ushuaia|tolhuin|municipio|municipalidad)\b/.test(text)) competence.add('municipal');
  if (/\b(tierradelfuego|gobierno|provincia|gobernacion)\b/.test(text)) competence.add('provincial');
  if (/\b(electoral|juzgado electoral|camara nacional electoral)\b/.test(text)) competence.add('electoral');
  if (/\b(justicia|judicial|ministerio publico|policia|fiscalia)\b/.test(text)) competence.add('judicial');
  if (/\b(afa|fifa|conmebol|deportes|club|federacion)\b/.test(text)) competence.add('sports');
  if (/\b(servicio meteorologico|smn|weather|meteorologico)\b/.test(text)) competence.add('weather');
  if (/\b(conicet|universidad|cientifico|ciencia|investigacion)\b/.test(text)) competence.add('scientific');
  if (/\b(legislatura|congreso|senado|diputados|boletin oficial)\b/.test(text)) competence.add('legislative');

  return [...competence];
}

export function isSourceCompetentForEvent(sourceRef = {}, eventType = 'general') {
  const competence = new Set(sourceRef.competence || []);
  if (sourceRef.tier !== SOURCE_TIERS.A) return false;
  if (eventType === 'general') return competence.has('municipal') || competence.has('provincial');
  if (eventType === 'agenda') return competence.has('municipal') || competence.has('provincial');
  if (eventType === 'sports-result') return competence.has('sports');
  if (eventType === 'election') return competence.has('electoral');
  if (eventType === 'crime') return competence.has('judicial');
  if (eventType === 'weather') return competence.has('weather');
  if (eventType === 'scientific') return competence.has('scientific');
  if (eventType === 'legislative') return competence.has('legislative');
  if (eventType === 'legal-policy') {
    return competence.has('provincial') || competence.has('municipal') || competence.has('legislative');
  }
  if (eventType === 'casualty') {
    return competence.has('judicial') || competence.has('provincial') || competence.has('municipal');
  }
  return competence.size > 0;
}

export function isTrustedLocalRoutineSource(sourceRef = {}) {
  if (sourceRef.tier !== SOURCE_TIERS.B) return false;
  if (/^(bing|google)-/i.test(sourceRef.sourceId || '') || /\b(bing news|google news)\b/i.test(sourceRef.sourceName || '')) {
    return false;
  }
  const text = normalizeText([
    sourceRef.sourceId,
    sourceRef.sourceName,
    sourceRef.publisherDomain,
    sourceRef.url
  ].filter(Boolean).join(' '));
  return /\b(actualidadtdf|elrompehielos|radiofueguina|sur54|fueguina|fueguino|riogrande|rio grande|ushuaia|tolhuin|tdf)\b/.test(text);
}

export function validateArticleSource({ article = {}, item = {}, source = {}, finalUrl = '' }) {
  const url = article.canonicalUrl || finalUrl || article.finalUrl || item.link || '';
  const title = article.title || item.title || '';
  const text = article.text || item.description || '';
  const errors = [];

  if (!url) errors.push('missing-url');
  if (isHomepage(url)) errors.push('homepage');
  if (isGenericListingUrl(url)) errors.push('listing-url');
  if (!title || normalizeText(title).length < 15) errors.push('weak-title');
  if (!text || text.length < 400) errors.push('short-body');

  const titleNorm = normalizeText(title);
  const bodyNorm = normalizeText(`${article.description || item.description || ''}\n${text.slice(0, 3000)}`);
  const titleWords = titleNorm
    .split(/\s+/)
    .filter((word) => word.length >= 5 && !GENERIC_PATH_SEGMENTS.has(word));
  const matchingWords = titleWords.filter((word) => bodyNorm.includes(word));
  const matchRatio = titleWords.length ? matchingWords.length / titleWords.length : 1;
  if (source.mode !== 'official-auto' && titleWords.length >= 5 && matchRatio < 0.15 && text.length < 1200) {
    errors.push('title-body-mismatch');
  }

  return {
    ok: errors.length === 0,
    errors,
    url,
    sourceId: source.id || ''
  };
}

export function countIndependentEditorialSources(sourceRefs = []) {
  const domains = new Set();
  for (const ref of sourceRefs) {
    if (ref.tier !== SOURCE_TIERS.B) continue;
    if (!ref.publisherDomain || isAggregatorDomain(ref.url)) continue;
    domains.add(ref.publisherDomain);
  }
  return domains.size;
}
