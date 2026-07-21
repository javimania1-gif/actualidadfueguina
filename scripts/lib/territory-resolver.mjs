import { normalizeText } from './pipeline-utils.mjs';

const FOREIGN_COUNTRIES = new Set([
  'mexico', 'colombia', 'cuba', 'iran', 'rusia', 'ucrania', 'estados unidos', 'reino unido', 'inglaterra',
  'francia', 'alemania', 'italia', 'brasil', 'chile', 'uruguay', 'paraguay', 'bolivia', 'peru', 'venezuela',
  'espana', 'gibraltar', 'ecuador', 'china', 'japon', 'corea', 'siria', 'israel', 'palestina', 'egipto'
]);

export function resolvePublicationTerritory({
  title = '',
  description = '',
  body = '',
  verifiedFacts = {},
  agendaTerritory = '',
  source = {},
  sourceUrl = ''
}) {
  const fullText = normalizeText([
    title, description, body,
    ...(verifiedFacts.places || []),
    ...(verifiedFacts.countries || []),
    ...(verifiedFacts.people || []),
    ...(verifiedFacts.organizations || [])
  ].join(' '));

  const explicitText = normalizeText([title, description].join(' '));
  
  const hasZacatecas = /\b(zacatecas|claudia sheinbaum|david monreal|ricardo monreal|cnte|morena|mexico|mexicano|mexicana)\b/.test(fullText);
  const hasTdFRioGrande = /\b(martin perez|municipalidad de rio grande|carlos margalot|punta popper|riograndense|tierra del fuego|tdf|concejo deliberante de rio grande|gobierno de tierra del fuego)\b/.test(fullText);

  // 1. Homonym Protection
  if (/\brio grande\b/.test(fullText)) {
    if (hasZacatecas && !hasTdFRioGrande) {
      return { category: 'Mundo', location: 'Río Grande, Zacatecas, México', confidence: 'high', reason: 'zacatecas-homonym' };
    }
    if (/\b(rio grande do sul|brasil|brasileno|gaucho)\b/.test(fullText) && !hasTdFRioGrande) {
      return { category: 'Mundo', location: 'Rio Grande do Sul, Brasil', confidence: 'high', reason: 'brazil-homonym' };
    }
  }

  // 1.5 Strict Geographic Guillotine (Discard Santa Cruz / Patagonia leaks)
  if (/\b(santa cruz|chubut|neuquen|rio negro|la pampa|rio gallegos|arroyo marea|cabo virgenes|punta arenas|magallanes)\b/i.test(explicitText)) {
    // If it's not a major national/sports event, discard it
    if (!/\b(congreso|senado|diputados|presidente argentino|gobierno nacional|milei|caputo|seleccion argentina|afa|mundial)\b/i.test(explicitText)) {
      return { category: 'unknown', location: 'Patagonia/Chile', confidence: 'high', reason: 'discard-patagonia-leak' };
    }
  }

  // 2. High confidence explicit locations from central facts (title/description/lead)
  
  // Foreign indicators
  const foreignMatches = explicitText.match(/\b(gibraltar|espana|estados unidos|reino unido|iran|rusia|ucrania|venezuela|mexico|colombia|cuba|francia|alemania|italia|brasil|chile|uruguay|paraguay|bolivia|peru|ecuador)\b/);
  if (foreignMatches || [...FOREIGN_COUNTRIES].some(c => (verifiedFacts.countries || []).map(normalizeText).includes(c))) {
    // Ensure it's not a local article mentioning a country briefly
    if (!/\b(argentina|malvinas|antartida|tierra del fuego|ushuaia|rio grande|tolhuin)\b/.test(explicitText) || foreignMatches?.[1] === 'gibraltar') {
      let loc = 'Mundo';
      if (foreignMatches) {
        loc = foreignMatches[1].charAt(0).toUpperCase() + foreignMatches[1].slice(1);
        if (loc === 'Estados unidos') loc = 'Estados Unidos';
        if (loc === 'Reino unido') loc = 'Reino Unido';
      } else if (verifiedFacts.countries?.length) {
        loc = verifiedFacts.countries[0];
      }
      return { category: 'Mundo', location: loc === 'Gibraltar' ? 'Gibraltar' : loc, confidence: 'high', reason: 'explicit-foreign' };
    }
  }

  // Nacionales
  if (/\b(congreso|senado|diputados|presidente argentino|gobierno nacional|buenos aires|cordoba|mendoza|chaco|rosario|santa fe|tucuman|salta|jujuy|banco central|bcra|javier milei|milei|ravier|adrian ravier|luis caputo|caputo|adorni|seleccion argentina|afa|mundial|messi|scaloni|copa del mundo)\b/i.test(explicitText)) {
    if (!/\b(tierra del fuego|ushuaia|rio grande|tolhuin|antartida|malvinas)\b/i.test(explicitText)) {
      return { category: 'Nacionales', location: 'Argentina', confidence: 'high', reason: 'explicit-national' };
    }
  }

  // 3. Multi-city (Provincia)
  const multiCityRegex = /\b(ushuaia y tolhuin|tolhuin y ushuaia|rio grande y ushuaia|ushuaia y rio grande|rio grande y tolhuin|tolhuin y rio grande|rio grande, tolhuin y ushuaia|rio grande, ushuaia y tolhuin|ushuaia, tolhuin y rio grande|ushuaia, rio grande y tolhuin|tolhuin, rio grande y ushuaia|tolhuin, ushuaia y rio grande|las tres ciudades|ambas ciudades|los tres municipios|dos ciudades|varias ciudades)\b/;
  const isMultiCity = multiCityRegex.test(explicitText);
  const isVisitor = /\b(visita|visitara|visitaran|viaja a|viajo a|viajara a|recibe a|recibio a|recibira a|participara en|llego a|llegara a|visitas|visitantes|represento a|representara a)\b/.test(explicitText);

  if (isMultiCity && !isVisitor) {
    return { category: 'Provincia', location: 'Tierra del Fuego AIAS', confidence: 'medium', reason: 'multi-city-provincia' };
  }

  // Protagonist Override (for visiting/receiving scenarios)
  if (isVisitor) {
    const titleProtagonistMatch = normalizeText(title).match(/^(tolhuin|ushuaia|rio grande|martin perez|walter vuoto|daniel harrington|municipio de tolhuin|municipalidad de ushuaia|municipalidad de rio grande)/);
    if (titleProtagonistMatch) {
      const p = titleProtagonistMatch[1];
      if (p.includes('tolhuin') || p.includes('harrington')) return { category: 'Tolhuin', location: 'Tolhuin', confidence: 'high', reason: 'protagonist-tolhuin' };
      if (p.includes('ushuaia') || p.includes('vuoto')) return { category: 'Ushuaia', location: 'Ushuaia', confidence: 'high', reason: 'protagonist-ushuaia' };
      if (p.includes('rio grande') || p.includes('perez')) return { category: 'Rio Grande', location: 'Río Grande', confidence: 'high', reason: 'protagonist-rio-grande' };
    }
  }

  // Local Cities Explicit Signals
  if (/\b(martin perez|punta popper|carlos margalot|municipio de rio grande|municipalidad de rio grande|vecinos de rio grande|aniversario de rio grande|riograndense)\b/.test(fullText)) {
    return { category: 'Rio Grande', location: 'Río Grande', confidence: 'high', reason: 'explicit-rio-grande' };
  }
  if (/\b(walter vuoto|municipalidad de ushuaia|municipio de ushuaia|cerro castor|puerto de ushuaia|aeropuerto de ushuaia|ushuaense)\b/.test(fullText)) {
    return { category: 'Ushuaia', location: 'Ushuaia', confidence: 'high', reason: 'explicit-ushuaia' };
  }
  if (/\b(daniel harrington|municipalidad de tolhuin|municipio de tolhuin|tolhuinense)\b/.test(fullText)) {
    return { category: 'Tolhuin', location: 'Tolhuin', confidence: 'high', reason: 'explicit-tolhuin' };
  }

  // Check Provincia first to avoid weather descriptions mentioning 3 cities from falling back to Rio Grande
  if (/\b(tierra del fuego|gobierno provincial|melella|gobernador|provincia)\b/.test(explicitText)) {
    return { category: 'Provincia', location: 'Tierra del Fuego AIAS', confidence: 'medium', reason: 'title-provincia' };
  }

  // Local Cities Title mentions
  if (/\brio grande\b/.test(explicitText)) return { category: 'Rio Grande', location: 'Río Grande', confidence: 'medium', reason: 'title-rio-grande' };
  if (/\bushuaia\b/.test(explicitText)) return { category: 'Ushuaia', location: 'Ushuaia', confidence: 'medium', reason: 'title-ushuaia' };
  if (/\btolhuin\b/.test(explicitText)) return { category: 'Tolhuin', location: 'Tolhuin', confidence: 'medium', reason: 'title-tolhuin' };
  
  if (/\bmalvinas\b/.test(explicitText) && !/\b(gibraltar|reino unido)\b/.test(explicitText)) {
      return { category: 'Malvinas', location: 'Islas Malvinas', confidence: 'high', reason: 'explicit-malvinas' };
  }
  if (/\bantartida\b/.test(explicitText)) return { category: 'Antartida', location: 'Antártida Argentina', confidence: 'high', reason: 'explicit-antartida' };

  // 3. Fallback to Source
  let cat = source.forceCategory || source.defaultCategory || agendaTerritory || 'Provincia';
  let loc = source.location || 'Tierra del Fuego AIAS';
  
  // Clean up source.location if it's identical to category
  if (cat === 'Ushuaia' && (loc === 'Ushuaia' || !source.location)) loc = 'Ushuaia';
  if (cat === 'Rio Grande' && (loc === 'Río Grande' || loc === 'Rio Grande' || !source.location)) loc = 'Río Grande';
  if (cat === 'Tolhuin' && (loc === 'Tolhuin' || !source.location)) loc = 'Tolhuin';

  // If forceCategory says Nacionales or Mundo, respect it (signal strength)
  if (source.forceCategory === 'Mundo' || source.forceCategory === 'Nacionales') {
      return { category: cat, location: loc, confidence: 'medium', reason: 'force-category-foreign' };
  }

  // Prevent local feeds from forcing foreign events into 'Provincia'
  if (agendaTerritory === 'Mundo' || agendaTerritory === 'Nacionales') {
      if (!/\b(tierra del fuego|ushuaia|rio grande|tolhuin)\b/.test(fullText)) {
          cat = agendaTerritory;
          loc = agendaTerritory === 'Mundo' ? 'Mundo' : 'Argentina';
          return { category: cat, location: loc, confidence: 'low', reason: 'agenda-territory-foreign' };
      }
  }

  return { category: cat, location: loc, confidence: 'lowest', reason: 'source-fallback' };
}
