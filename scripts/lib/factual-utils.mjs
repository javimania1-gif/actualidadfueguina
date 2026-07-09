import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, cleanText } from './news-utils.mjs';
import {
  SOURCE_TIERS,
  countIndependentEditorialSources,
  isSourceCompetentForEvent,
  isTrustedLocalRoutineSource
} from './source-policy.mjs';
import { extractFingerprint, normalizeText } from './pipeline-utils.mjs';

export const EVENTS_PATH = path.join(ROOT, 'data/events.json');

const HIGH_RISK_PATTERNS = [
  /\b(eleccion|elecciones|electoral|votos?|escrutinio|convencionales?)\b/i,
  /\b(fallecio|murio|muerte|victimas?|heridos?|accidente fatal)\b/i,
  /\b(resultado|marcador|gano|vencio|derroto|elimino|clasifico|final|cuartos|octavos)\b/i,
  /\b(judicial|condena|imputado|denuncia penal|causa)\b/i,
  /\b(inflacion|dolar|tarifa|salario|paritaria|reforma constitucional)\b/i,
  /\b(guerra|ataque|conflicto internacional|crisis sanitaria)\b/i,
  /\b(ley|decreto|resolucion|norma|vigencia)\b/i,
  /\b(policiales?|homicidio|detenido|allanamiento|secuestro|robo|drogas|contrabando|desaparecido)\b/i,
  /\b(incendio grave|sismo|evacuacion|alerta meteorologica severa|naufragio|violencia|busqueda de personas)\b/i
];

const LOW_RISK_PATTERNS = [
  /\b(agenda|curso|inscripcion|actividad|taller|corte programado|capacitacion)\b/i,
  /\b(fiesta|festival|muestra|propuesta cultural|convocatoria)\b/i
];

const KNOWN_COUNTRIES = [
  'Argentina', 'Egipto', 'Ecuador', 'Brasil', 'Chile', 'Uruguay', 'Paraguay',
  'Bolivia', 'Peru', 'Colombia', 'Venezuela', 'Mexico', 'Estados Unidos',
  'Reino Unido', 'Inglaterra', 'Francia', 'Alemania', 'Italia', 'Espana',
  'Cuba'
];

const KNOWN_SPORTS_TEAMS = [
  'Boca Juniors', 'River Plate', 'Rosario Central', 'Independiente',
  'Racing', 'San Lorenzo'
];

const KNOWN_PLACES = [
  'Rio Grande', 'Río Grande', 'Ushuaia', 'Tolhuin', 'Tierra del Fuego',
  'Tierra del Fuego AIAS', 'Islas Malvinas', 'Malvinas', 'Antartida',
  'Antártida', 'Cerro Castor', 'Pasaje Drake', 'Casa de Gobierno',
  'Polideportivo Ezequiel Rivero', 'Buenos Aires', 'Atlantico Sur',
  'Atlántico Sur', 'Hito XIII', 'Zaporiyia', 'Moscu', 'Moscú',
  'Paris', 'París', 'Londres', 'Kansas', 'La Guaira', 'Jalisco'
];

const KNOWN_PEOPLE = [
  'Melella', 'Gustavo Melella', 'Martin Perez', 'Martín Perez',
  'Walter Vuoto', 'Daniel Harrington', 'Javier Milei', 'Milei',
  'Villarruel', 'Donald Trump', 'Giorgia Meloni', 'Delcy Rodriguez',
  'Delcy Rodríguez', 'Carlos III', 'Lionel Messi'
];

const GENERIC_ENTITY_WORDS = new Set([
  'actualidad', 'actualidad tdf', 'ai', 'ambos', 'alerta', 'ano', 'anos',
  'actividad', 'actividades', 'banco', 'copa', 'cultura', 'de', 'del',
  'dia', 'durante', 'el', 'en', 'es', 'este', 'festival', 'fiesta',
  'fuego', 'futbol', 'gobierno', 'independencia', 'invierno', 'julio',
  'la', 'las', 'los', 'mayo', 'monitoreo', 'mundial', 'musica',
  'nacional', 'no', 'otro', 'pena', 'provincia', 'rio', 'se', 'sismo',
  'su', 'tierra', 'total', 'tras', 'un', 'una', 'vivo'
]);

const ORGANIZATION_HINTS = [
  'gobierno', 'municipio', 'municipalidad', 'concejo', 'legislatura',
  'justicia', 'ministerio', 'secretaria', 'universidad', 'utn', 'uom',
  'onu', 'otan', 'anses', 'smn', 'banco', 'camara', 'sindicato',
  'club', 'federacion', 'policia', 'fiscalia', 'conicet'
];

export const FACTUAL_VALIDATION_VERSION = 3;

export const EDITORIAL_LANES = Object.freeze({
  FAST: 'fast',
  STANDARD: 'standard',
  STRICT: 'strict'
});

const CRITICAL_FIELDS = [
  'teams',
  'sportsTeams',
  'people',
  'organizations',
  'places',
  'countries',
  'numbers',
  'money',
  'percentages',
  'dates',
  'times',
  'casualties',
  'scores',
  'laws'
];

const MONTHS_ES = new Map([
  ['enero', '01'],
  ['febrero', '02'],
  ['marzo', '03'],
  ['abril', '04'],
  ['mayo', '05'],
  ['junio', '06'],
  ['julio', '07'],
  ['agosto', '08'],
  ['septiembre', '09'],
  ['octubre', '10'],
  ['noviembre', '11'],
  ['diciembre', '12']
]);

const STRICT_LANE_PATTERNS = [
  /\b(resultados?|marcador|vencio|derroto|elimino|clasifico|final|cuartos|octavos)\b/,
  /\b(fallecio|murio|muerte|victimas?|heridos?|accidente fatal|femicidio)\b/,
  /\b(eleccion|elecciones|electoral|votos?|escrutinio|convencionales?)\b/,
  /\b(policial|policiales|homicidio|detenido|allanamiento|secuestro|robo|drogas|contrabando|desaparecido)\b/,
  /\b(judicial|condena|imputado|denuncia penal|causa judicial|demanda judicial)\b/,
  /\b(guerra|ataque|conflicto internacional|crisis sanitaria)\b/
];

const STANDARD_LANE_PATTERNS = [
  /\b(politica|gobernador|intendenta?|legislatura|concejo|senado|diputados)\b/,
  /\b(economia|inflacion|dolar|tarifa|salario|paritaria|millones?|pesos?|presupuesto)\b/,
  /\b(declaraciones?|critico|cuestiono|denuncio|reclamo|oposicion)\b/,
  /\b(ley|decreto|resolucion|norma|boletin oficial|reforma constitucional)\b/,
  /\b(decision administrativa|licitacion|adjudicacion|fisco|ministerio)\b/
];

const FAST_LANE_PATTERNS = [
  /\b(agenda|inscripcion|inscripciones|curso|cursos|taller|talleres|capacitacion|capacitaciones)\b/,
  /\b(actividad|actividades|servicio|servicios|atencion|operativo|cronograma)\b/,
  /\b(convocatoria|convoca|feria|muestra|festival|fiesta|pena|propuesta cultural)\b/,
  /\b(programa|programas|obra|obras|pavimentad[oa]|inaugura|habilita|presenta|lanza|abre)\b/
];

export async function loadEvents() {
  try {
    return JSON.parse(await fs.readFile(EVENTS_PATH, 'utf8'));
  } catch {
    return { version: 1, events: {} };
  }
}

export async function saveEvents(events) {
  await fs.mkdir(path.dirname(EVENTS_PATH), { recursive: true });
  const entries = Object.entries(events.events || {});
  entries.sort((a, b) => String(b[1]?.lastSeenAt || '').localeCompare(String(a[1]?.lastSeenAt || '')));
  events.events = Object.fromEntries(entries.slice(0, 1000));
  await fs.writeFile(EVENTS_PATH, JSON.stringify(events, null, 2) + '\n', 'utf8');
}

function unique(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values.map((v) => cleanText(v)).filter(Boolean)) {
    const key = normalizeText(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function pickKnown(text, dictionary) {
  const normalized = normalizeText(text);
  return dictionary.filter((value) => normalized.includes(normalizeText(value)));
}

function normalizedIncludesAny(value = '', dictionary = []) {
  const normalized = normalizeText(value);
  return dictionary.some((item) => normalized === normalizeText(item));
}

function hasAnyToken(value = '', dictionary = []) {
  const normalized = normalizeText(value);
  return dictionary.some((item) => new RegExp(`\\b${normalizeText(item)}\\b`).test(normalized));
}

function extractCapitalizedPhrases(text) {
  const normalizedText = cleanText(text).replace(/\s+/g, ' ');
  const matches = normalizedText.match(/\b[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,3}/g) || [];
  return unique(matches)
    .filter((value) => !/^(El|La|Los|Las|Un|Una|En|Del|Con|Actualidad Fueguina)$/.test(value))
    .slice(0, 12);
}

function extractScores(text) {
  const values = cleanText(text).match(/\b\d{1,2}\s?[-–]\s?\d{1,2}\b/g) || [];
  return unique(values);
}

function hasOrganizationSignal(value = '') {
  const normalized = normalizeText(value);
  return ORGANIZATION_HINTS.some((hint) => new RegExp(`\\b${hint}\\b`).test(normalized));
}

function isGenericEntityPhrase(value = '') {
  const normalized = normalizeText(value);
  if (!normalized) return true;
  if (normalized.includes('actualidad tdf')) return true;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  return words.every((word) => GENERIC_ENTITY_WORDS.has(word));
}

function isKnownPlace(value = '') {
  return normalizedIncludesAny(value, KNOWN_PLACES);
}

function isKnownCountry(value = '') {
  return normalizedIncludesAny(value, KNOWN_COUNTRIES);
}

function extractOrganizations(text, capitalized = []) {
  const normalizedText = cleanText(text).replace(/\s+/g, ' ');
  const explicit = normalizedText.match(/\b(?:Gobierno|Municipio|Municipalidad|Concejo|Legislatura|Justicia|Ministerio|Secretar(?:ia|ía)|Universidad|UTN|UOM|ONU|OTAN|ANSES|SMN|Banco|C[aá]mara|Sindicato|Club|Federaci[oó]n|Polic[ií]a|Fiscal[ií]a|CONICET)(?:\s+(?:de|del|la|las|los|y|[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ]+)){0,5}/g) || [];
  const fromPhrases = capitalized.filter((value) => hasOrganizationSignal(value));
  return unique([...explicit, ...fromPhrases]).slice(0, 10);
}

function looksLikePersonName(value = '') {
  if (!normalizeText(value)) return false;
  if (normalizedIncludesAny(value, KNOWN_PEOPLE)) return true;
  if (isGenericEntityPhrase(value) || isKnownCountry(value) || isKnownPlace(value)) return false;
  if (hasOrganizationSignal(value)) return false;
  if (hasAnyToken(value, ['cerro', 'polideportivo', 'pasaje', 'casa', 'hito', 'atlantico', 'banco', 'copa', 'mundial'])) return false;
  const words = cleanText(value).split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  const normalizedWords = words.map(normalizeText);
  if (normalizedWords.some((word) => GENERIC_ENTITY_WORDS.has(word))) return false;
  return true;
}

function extractPeople(capitalized = []) {
  return unique(capitalized.filter(looksLikePersonName)).slice(0, 8);
}

function extractSportsTeams(text, eventType) {
  if (eventType !== 'sports-result') return [];
  return unique([
    ...pickKnown(text, KNOWN_SPORTS_TEAMS),
    ...pickKnown(text, KNOWN_COUNTRIES)
  ]).slice(0, 8);
}

function extractMoney(text) {
  const values = cleanText(text).match(/\b(?:[$]\s*)?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?\s?(?:millones?|millon|pesos?|d[óo]lares?|usd|ars)(?:\s+de\s+(?:pesos?|d[óo]lares?))?\b/gi) || [];
  return unique(values).slice(0, 10);
}

function extractPercentages(text) {
  const values = cleanText(text).match(/\b\d{1,3}(?:[.,]\d+)?\s?%|\b\d{1,3}(?:[.,]\d+)?\s?por ciento\b/gi) || [];
  return unique(values).slice(0, 10);
}

function extractCasualties(text) {
  const values = cleanText(text).match(/\b(?:sin|no hubo)\s+(?:v[íi]ctimas?|heridos?|fallecidos?|muertos?)\b|\b\d{1,4}(?:[.,]\d{3})?\s?(?:v[íi]ctimas?|heridos?|fallecidos?|muertos?)\b/gi) || [];
  return unique(values).slice(0, 10);
}

function extractTimes(text) {
  const values = cleanText(text).match(/\b(?:[01]?\d|2[0-3])[:.]\d{2}\b|\b\d{1,2}\s?(?:h|hs|horas)\b/gi) || [];
  return unique(values).slice(0, 10);
}

function extractLaws(text) {
  const values = cleanText(text).match(/\b(?:ley|decreto|resoluci[óo]n|ordenanza)\s+(?:n[°º.]?\s*)?\d{1,6}(?:[\/-]\d{1,4})?\b|\breforma constitucional\b/gi) || [];
  return unique(values).slice(0, 10);
}

function extractNumbers(text, { money = [], percentages = [], casualties = [], times = [], scores = [] } = {}) {
  const values = cleanText(text).match(/\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?\s?(?:personas?|familias?|vecinos?|usuarios?|estudiantes?|trabajadores?|viviendas?|hect[aá]reas?|kil[oó]metros?|km|metros?|vuelos?|dias?|días?|meses?|a[ñn]os?)\b/gi) || [];
  const excluded = new Set([...money, ...percentages, ...casualties, ...times, ...scores].map(normalizeText));
  return unique(values).filter((value) => !excluded.has(normalizeText(value))).slice(0, 12);
}

function extractCountries(text) {
  return unique(pickKnown(text, KNOWN_COUNTRIES)).slice(0, 12);
}

function extractPlaces(text, source = {}) {
  const values = [
    ...pickKnown(text, KNOWN_PLACES),
    source.location || ''
  ].filter((value) => value && !isKnownCountry(value));
  return unique(values).slice(0, 10);
}

function extractSemanticFacts(text, eventType, source = {}) {
  const scores = extractScores(text);
  const money = extractMoney(text);
  const percentages = extractPercentages(text);
  const casualties = extractCasualties(text);
  const times = extractTimes(text);
  return {
    sportsTeams: extractSportsTeams(text, eventType),
    countries: extractCountries(text),
    places: extractPlaces(text, source),
    money,
    percentages,
    times,
    casualties,
    scores,
    laws: extractLaws(text),
    numbers: extractNumbers(text, { money, percentages, casualties, times, scores })
  };
}

function extractDates(text, articleDate = '') {
  const values = cleanText(text).match(/\b\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+de\s+\d{4})?|\b(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/gi) || [];
  if (articleDate) values.push(String(articleDate).slice(0, 10));
  return unique(values).slice(0, 8);
}

export function isOrdinaryWeatherForecastText(text = '') {
  const normalized = normalizeText(text);
  if (!/\b(clima|pronostico|temperaturas?|servicio meteorologico|smn)\b/.test(normalized)) return false;
  return !/\b(alerta|temporal|nevadas? extraordinarias?|viento fuerte|sismo|evacuacion|naufragio|corte de ruta|emergencia)\b/.test(normalized);
}

export function getWeatherForecastDateKey(text = '', fallbackDates = []) {
  const normalized = normalizeText(text);
  const monthAlternatives = [...MONTHS_ES.keys()].join('|');
  const wordDate = normalized.match(new RegExp(`\\b(\\d{1,2})(?:\\s+de)?\\s+(${monthAlternatives})(?:\\s+(?:de\\s+)?(\\d{4}))?\\b`, 'i'));
  if (wordDate) {
    const day = String(wordDate[1]).padStart(2, '0');
    const month = MONTHS_ES.get(wordDate[2]) || '01';
    const fallbackYear = String(fallbackDates.find((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value))) || '').slice(0, 4);
    const year = wordDate[3] || fallbackYear || new Date().getFullYear();
    return `${year}-${month}-${day}`;
  }

  const slashDate = normalized.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (slashDate) {
    const day = String(slashDate[1]).padStart(2, '0');
    const month = String(slashDate[2]).padStart(2, '0');
    const year = slashDate[3].length === 2 ? `20${slashDate[3]}` : slashDate[3];
    return `${year}-${month}-${day}`;
  }

  const iso = fallbackDates.find((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value)));
  return iso || '';
}

function matchesAny(value = '', patterns = []) {
  return patterns.some((pattern) => pattern.test(value));
}

export function classifyEditorialLane({ title = '', text = '', category = '', source = {}, aiRisk = '' }) {
  const combined = normalizeText(`${title}\n${text.slice(0, 3000)}\n${category}`);
  const reasons = [];

  if (aiRisk === 'alto') {
    return { lane: EDITORIAL_LANES.STRICT, reasons: ['ai-high'] };
  }

  if (matchesAny(combined, STRICT_LANE_PATTERNS)) {
    reasons.push('strict-sensitive-topic');
    return { lane: EDITORIAL_LANES.STRICT, reasons };
  }

  if (matchesAny(combined, STANDARD_LANE_PATTERNS)) {
    reasons.push('standard-sensitive-institutional');
    return { lane: EDITORIAL_LANES.STANDARD, reasons };
  }

  if (matchesAny(combined, FAST_LANE_PATTERNS)) {
    const sourceText = normalizeText(`${source.id || ''} ${source.name || ''} ${source.location || ''} ${source.defaultCategory || ''}`);
    const hasLocalSignal = /\b(rio grande|ushuaia|tolhuin|tierra del fuego|malvinas|antartida|tdf|fueguin)\b/.test(`${combined} ${sourceText}`);
    const hasForeignSignal = /\b(cdmx|mexico|colombia|cuba|iran|teheran|moscu|rusia|ucrania|francia|estados unidos|reino unido|brasil|chile|uruguay|paraguay|bolivia|peru|venezuela)\b/.test(combined);
    if (hasForeignSignal && !hasLocalSignal && source.mode !== 'official-auto') {
      return { lane: EDITORIAL_LANES.STANDARD, reasons: ['foreign-routine-standard'] };
    }
    reasons.push(source.mode === 'official-auto' ? 'official-routine-fast-lane' : 'routine-fast-lane');
    return { lane: EDITORIAL_LANES.FAST, reasons };
  }

  if (source.mode === 'official-auto') {
    reasons.push('official-routine-default');
    return { lane: EDITORIAL_LANES.FAST, reasons };
  }

  return { lane: EDITORIAL_LANES.STANDARD, reasons: ['default-standard'] };
}

export function classifyRisk({ title = '', text = '', category = '', source = {}, aiRisk = '' }) {
  const combined = `${title}\n${text.slice(0, 3000)}\n${category}`;
  const lane = classifyEditorialLane({ title, text, category, source, aiRisk });
  const reasons = [];

  if (aiRisk === 'alto') reasons.push('ai-high');
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(combined)) reasons.push(pattern.source);
  }

  if (lane.lane !== EDITORIAL_LANES.FAST) {
    return { level: 'high', reasons: unique([...lane.reasons, ...reasons]), editorialLane: lane.lane };
  }

  if (source.mode === 'official-auto') {
    for (const pattern of LOW_RISK_PATTERNS) {
      if (pattern.test(combined)) return { level: 'low', reasons: unique(['official-routine', ...lane.reasons]), editorialLane: lane.lane };
    }
  }

  return { level: 'low', reasons: unique(['fast-lane', ...lane.reasons]), editorialLane: lane.lane };
}

export function extractFacts({ article = {}, item = {}, source = {}, category = '' }) {
  const title = article.title || item.title || '';
  const text = `${title}\n${article.description || item.description || ''}\n${article.text || ''}`;
  const risk = classifyRisk({ title, text, category: category || source.defaultCategory, source });
  const capitalized = extractCapitalizedPhrases(`${title}\n${article.description || ''}`);
  const eventTypeText = `${title}\n${article.description || item.description || ''}\n${(article.text || '').slice(0, 1200)}`;
  const inferredEventType = inferEventType(eventTypeText);
  const safeInferredEventType = inferredEventType === 'high-risk' ? 'general' : inferredEventType;
  const eventType = risk.level === 'high' || ['weather-forecast', 'agenda', 'service'].includes(safeInferredEventType)
    ? safeInferredEventType
    : 'general';
  const semanticFacts = extractSemanticFacts(text, eventType, source);
  const teams = semanticFacts.sportsTeams;
  const dates = extractDates(text, article.date || item.pubDate);
  const weatherForecastDateKey = inferredEventType === 'weather-forecast'
    ? getWeatherForecastDateKey(text, dates)
    : '';

  return {
    title,
    riskLevel: risk.level,
    riskReasons: risk.reasons,
    editorialLane: risk.editorialLane || EDITORIAL_LANES.STANDARD,
    eventType,
    teams,
    sportsTeams: semanticFacts.sportsTeams,
    people: extractPeople(capitalized),
    organizations: extractOrganizations(text, capitalized),
    places: semanticFacts.places,
    countries: semanticFacts.countries,
    numbers: semanticFacts.numbers,
    money: semanticFacts.money,
    percentages: semanticFacts.percentages,
    dates,
    times: semanticFacts.times,
    casualties: semanticFacts.casualties,
    scores: semanticFacts.scores,
    laws: semanticFacts.laws,
    weatherForecastDateKey,
    action: inferAction(title || text),
    rawSummary: cleanText(article.description || item.description || '').slice(0, 500)
  };
}

function isSpecificEventType(eventType = '') {
  return Boolean(eventType && !['general', 'high-risk'].includes(eventType));
}

function resolveEventType(previous = 'general', refreshed = 'general') {
  const left = previous === 'high-risk' ? 'general' : previous;
  const right = refreshed === 'high-risk' ? 'general' : refreshed;
  if (isSpecificEventType(left) && isSpecificEventType(right) && left !== right) {
    return { eventType: right, conflict: { field: 'eventType', previous: left, refreshed: right } };
  }
  if (isSpecificEventType(right)) return { eventType: right, conflict: null };
  if (isSpecificEventType(left)) return { eventType: left, conflict: null };
  return { eventType: 'general', conflict: null };
}

function mergePersistedFactValues(field, previous = [], refreshed = []) {
  const oldValues = unique(previous);
  const newValues = unique(refreshed);
  if (['sportsTeams', 'teams', 'scores', 'money', 'percentages', 'casualties', 'laws'].includes(field)) {
    return newValues;
  }
  if (field === 'numbers' || field === 'dates' || field === 'times') {
    return newValues.length ? unique([...newValues, ...oldValues].slice(0, 12)) : oldValues;
  }
  return unique([...oldValues, ...newValues]);
}

function stricterLane(left = EDITORIAL_LANES.STANDARD, right = EDITORIAL_LANES.STANDARD) {
  const rank = {
    [EDITORIAL_LANES.FAST]: 1,
    [EDITORIAL_LANES.STANDARD]: 2,
    [EDITORIAL_LANES.STRICT]: 3
  };
  return (rank[right] || 2) > (rank[left] || 2) ? right : left;
}

export function refreshPersistedFacts(facts = {}, sourceRef = {}) {
  const article = {
    title: facts.title || sourceRef.title || '',
    description: facts.rawSummary || '',
    text: facts.rawSummary || '',
    date: (facts.dates || []).find((value) => /^\d{4}-\d{2}-\d{2}/.test(String(value))) || sourceRef.publishedAt || ''
  };
  const source = {
    id: sourceRef.sourceId || '',
    name: sourceRef.sourceName || '',
    mode: sourceRef.sourceMode || '',
    defaultCategory: '',
    location: ''
  };
  const refreshed = extractFacts({ article, source });
  const eventTypeResolution = resolveEventType(facts.eventType || 'general', refreshed.eventType || 'general');
  const semanticConflicts = unique([
    ...(facts.semanticConflicts || []),
    eventTypeResolution.conflict ? `${eventTypeResolution.conflict.field}:${eventTypeResolution.conflict.previous}->${eventTypeResolution.conflict.refreshed}` : ''
  ]);
  const merged = {
    ...facts,
    ...refreshed,
    title: facts.title || refreshed.title,
    eventType: eventTypeResolution.eventType,
    editorialLane: stricterLane(facts.editorialLane, refreshed.editorialLane),
    riskLevel: facts.riskLevel === 'high' || refreshed.riskLevel === 'high' ? 'high' : refreshed.riskLevel,
    rawSummary: facts.rawSummary || refreshed.rawSummary,
    semanticConflicts
  };
  for (const field of CRITICAL_FIELDS) {
    merged[field] = mergePersistedFactValues(field, facts[field] || [], refreshed[field] || []);
  }
  return merged;
}

function inferEventType(text) {
  const value = normalizeText(text);
  const lead = normalizeText(cleanText(text).split(/\n/).slice(0, 2).join(' '));
  if (/\b(resultado|marcador|vencio|derroto|elimino|clasifico|octavos|cuartos)\b/.test(value)) return 'sports-result';
  if (/\b(eleccion|electoral|votos|convencionales)\b/.test(value)) return 'election';
  if (/\b(homicidio|detenido|allanamiento|secuestro|robo|drogas|contrabando|desaparecido|violencia|busqueda de personas)\b/.test(value)) return 'crime';
  if (/\b(guerra|ataque|misiles?|iran|teheran|conflicto internacional|crisis internacional)\b/.test(value)) return 'international-conflict';
  if (/\b(buque|fragata|warship|britanic[oa]|reino unido|malvinas|soberania)\b/.test(value)) return 'territorial-sovereignty';
  if (/\b(antartida|antartico)\b/.test(value) && /\b(estrategic[oa]|militar|defensa|geopolitic[oa]|base)\b/.test(value)) return 'defense';
  if (/\b(alerta meteorologica|temporal|viento|nevadas?|sismo|evacuacion|naufragio)\b/.test(value)) return 'weather';
  if (isOrdinaryWeatherForecastText(value)) return 'weather-forecast';
  if (/\b(servicio|servicios|tramite|tramites|beca|becas|empleo|corte programado|operativo|rutas?|vuelos?|transporte|escuelas?|salud|hospital|medicos?|sanitaria|tarifas?)\b/.test(lead)) return 'service';
  if (/\b(agenda|inscripcion|inscripciones|curso|cursos|taller|capacitacion|actividad|actividades|feria|muestra|festival|fiesta|pena|convocatoria|agenda cultural)\b/.test(value)) return 'agenda';
  if (/\b(servicio|servicios|tramite|tramites|beca|becas|empleo|corte programado|operativo|rutas?|vuelos?|transporte|escuelas?|salud|tarifas?)\b/.test(value)) return 'service';
  if (/\b(ciencia|cientifico|investigacion|hallazgo|conicet)\b/.test(value)) return 'scientific';
  if (/\b(fallecio|murio|muerte|victima|herido|accidente)\b/.test(value)) return 'casualty';
  if (/\b(legislatura|senado|diputados|sesion|proyecto de ley)\b/.test(value)) return 'legislative';
  if (/\b(ley|decreto|resolucion|norma|reforma constitucional)\b/.test(value)) return 'legal-policy';
  return 'general';
}

function inferAction(text) {
  const value = normalizeText(text);
  if (value.includes('reforma constitucional')) return 'reforma-constitucional';
  const candidates = [
    'vencio', 'derroto', 'elimino', 'clasifico', 'convoca', 'reactiva',
    'anuncia', 'presenta', 'lanza', 'investiga', 'aprueba', 'rechaza',
    'suspende', 'restaura', 'capacita', 'inaugura', 'abre', 'inscribe',
    'convoca', 'advierte', 'denuncia', 'detiene'
  ];
  return candidates.find((word) => value.includes(word)) || 'informa';
}

export function generateEventKey({ facts = {}, title = '', sourceRef = {} }) {
  if (facts.eventType === 'weather-forecast') {
    const date = facts.weatherForecastDateKey || getWeatherForecastDateKey(`${title}\n${facts.rawSummary || ''}`, facts.dates || []);
    return ['weather-forecast', date || 'sin-fecha', 'tierra-del-fuego'].join('|').slice(0, 180);
  }

  const sportsTeams = facts.sportsTeams || facts.teams || [];
  if (facts.eventType === 'sports-result' && sportsTeams.length > 0) {
    const primary = sportsTeams.map(normalizeText).sort()[0];
    const date = (facts.dates || []).map(normalizeText).find(Boolean) || '';
    return ['sports-result', primary, date].filter(Boolean).join('|').slice(0, 180);
  }

  const important = [
    facts.eventType,
    ...((facts.sportsTeams || []).length ? facts.sportsTeams : []),
    ...((facts.organizations || []).slice(0, 3)),
    ...((facts.people || []).slice(0, 3)),
    ...((facts.places || []).slice(0, 2)),
    ...((facts.countries || []).slice(0, 2)),
    facts.action,
    (facts.dates || [])[0]
  ].filter(Boolean);

  const normalized = important.map(normalizeText).filter(Boolean).join('|');
  if (normalized.length >= 12) return normalized.slice(0, 180);
  return `${sourceRef.publisherDomain || 'unknown'}|${extractFingerprint(title || facts.title || '')}`.slice(0, 180);
}

function normalizedSet(values = []) {
  return new Set(values.map(normalizeText).filter(Boolean));
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  return [...a].every((value) => b.has(value));
}

function isCriticalNumber(value) {
  const normalized = normalizeText(value);
  return /\b(victima|victimas|herido|heridos|fallecido|fallecidos|muerto|muertos|%|por ciento|millones?|pesos?|dolares?|usuarios?)\b/.test(normalized);
}

function isCriticalDate(value) {
  const normalized = normalizeText(value);
  if (!normalized || /^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false;
  return /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|\d{1,2}\/\d{1,2}\/\d{2,4})\b/.test(normalized);
}

function comparableFactValues(field, values = []) {
  if (field === 'numbers') return unique(values).filter(isCriticalNumber);
  if (field === 'dates') return unique(values).filter(isCriticalDate);
  if (['sportsTeams', 'teams', 'scores', 'money', 'percentages', 'casualties', 'laws'].includes(field)) return unique(values);
  return unique(values);
}

function diffValues(field, a = [], b = []) {
  const leftValues = comparableFactValues(field, a);
  const rightValues = comparableFactValues(field, b);
  const setA = normalizedSet(leftValues);
  const setB = normalizedSet(rightValues);
  if (setA.size === 0 || setB.size === 0) return [];
  if (setsEqual(setA, setB)) return [];

  if (['teams', 'sportsTeams', 'scores', 'numbers', 'money', 'percentages', 'dates', 'casualties', 'laws'].includes(field)) {
    return [...leftValues, ...rightValues].filter(Boolean);
  }

  const shared = [...setA].some((value) => setB.has(value));
  if (shared) return [];
  return [...leftValues, ...rightValues].filter(Boolean);
}

export function findFactConflicts(factSets = []) {
  const conflicts = [];
  for (let i = 0; i < factSets.length; i++) {
    for (let j = i + 1; j < factSets.length; j++) {
      const left = factSets[i];
      const right = factSets[j];
      for (const field of ['sportsTeams', 'teams', 'scores', 'money', 'percentages', 'casualties', 'numbers', 'dates', 'laws']) {
        if (['sportsTeams', 'teams'].includes(field) && left.eventType !== 'sports-result' && right.eventType !== 'sports-result') continue;
        const values = diffValues(field, left[field], right[field]);
        if (values.length > 0) {
          conflicts.push({
            field,
            values: unique(values),
            severity: 'critical'
          });
        }
      }
    }
  }
  return conflicts;
}

function consensusValues(factSets = [], field) {
  if (factSets.length === 0) return [];
  if (factSets.length === 1) return unique(factSets[0]?.[field] || []);
  const counts = new Map();
  const original = new Map();
  for (const facts of factSets) {
    for (const value of unique(facts?.[field] || [])) {
      const key = normalizeText(value);
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!original.has(key)) original.set(key, value);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([key]) => original.get(key))
    .filter(Boolean);
}

export function mergeVerifiedFacts(factSets = []) {
  const merged = {};
  for (const field of CRITICAL_FIELDS) {
    merged[field] = unique(factSets.flatMap((facts) => facts[field] || []));
  }
  merged.eventType = factSets.find((facts) => isSpecificEventType(facts.eventType))?.eventType || 'general';
  merged.action = factSets.find((facts) => facts.action)?.action || 'informa';
  merged.rawSummary = cleanText(factSets.map((facts) => facts.rawSummary).filter(Boolean).join(' ')).slice(0, 1000);
  return merged;
}

export function compareFactSets(factSets = []) {
  const unionFacts = mergeVerifiedFacts(factSets);
  const consensusFacts = {};
  for (const field of CRITICAL_FIELDS) {
    consensusFacts[field] = consensusValues(factSets, field);
  }
  consensusFacts.eventType = unionFacts.eventType;
  consensusFacts.action = unionFacts.action;
  consensusFacts.rawSummary = unionFacts.rawSummary;

  return {
    unionFacts,
    consensusFacts,
    sourceSpecificFacts: factSets.map((facts) => {
      const sourceFacts = {};
      for (const field of CRITICAL_FIELDS) sourceFacts[field] = unique(facts[field] || []);
      sourceFacts.eventType = facts.eventType === 'high-risk' ? 'general' : (facts.eventType || 'general');
      sourceFacts.action = facts.action || 'informa';
      sourceFacts.rawSummary = facts.rawSummary || '';
      return sourceFacts;
    }),
    conflictingFacts: findFactConflicts(factSets)
  };
}

export function corroborateEvent({ eventKey, candidates = [] }) {
  const factSets = candidates.map((candidate) => candidate.facts);
  const sourceRefs = candidates.map((candidate) => candidate.sourceRef);
  const editorialLane = factSets.some((facts) => facts.editorialLane === EDITORIAL_LANES.STRICT)
    ? EDITORIAL_LANES.STRICT
    : factSets.some((facts) => facts.editorialLane === EDITORIAL_LANES.STANDARD || (!facts.editorialLane && facts.riskLevel === 'high'))
      ? EDITORIAL_LANES.STANDARD
      : EDITORIAL_LANES.FAST;
  const riskLevel = editorialLane === EDITORIAL_LANES.FAST ? 'low' : 'high';
  const comparison = compareFactSets(factSets);
  const conflicts = comparison.conflictingFacts;
  const hasCriticalConflict = conflicts.some((conflict) => conflict.severity === 'critical');
  const eventType = factSets.find((facts) => isSpecificEventType(facts.eventType))?.eventType || 'general';
  const verifiedFacts = riskLevel === 'high' ? comparison.consensusFacts : comparison.unionFacts;

  if (hasCriticalConflict) {
    return {
      eventKey,
      status: 'conflicting-sources',
      editorialLane,
      riskLevel,
      verified: false,
      conflicts,
      consensusFacts: comparison.consensusFacts,
      sourceSpecificFacts: comparison.sourceSpecificFacts,
      conflictingFacts: conflicts,
      verifiedFacts
    };
  }

  const hasCompetentTierA = sourceRefs.some((ref) => ref.tier === SOURCE_TIERS.A && isSourceCompetentForEvent(ref, eventType));
  const independentTierB = countIndependentEditorialSources(sourceRefs);

  if (editorialLane === EDITORIAL_LANES.FAST) {
    const hasTrustedLocalRoutineSource = sourceRefs.some(isTrustedLocalRoutineSource);
    if (!hasCompetentTierA && !hasTrustedLocalRoutineSource) {
      return {
        eventKey,
        status: 'pending-verification',
        editorialLane,
        riskLevel,
        verified: false,
        conflicts: [],
        consensusFacts: comparison.consensusFacts,
        sourceSpecificFacts: comparison.sourceSpecificFacts,
        conflictingFacts: [],
        verifiedFacts
      };
    }

    return {
      eventKey,
      status: hasCompetentTierA ? 'verified-fast-lane' : 'verified-local-routine',
      editorialLane,
      riskLevel,
      verified: true,
      conflicts: [],
      consensusFacts: comparison.consensusFacts,
      sourceSpecificFacts: comparison.sourceSpecificFacts,
      conflictingFacts: [],
      verifiedFacts
    };
  }

  if (hasCompetentTierA) {
    return {
      eventKey,
      status: 'verified-tier-a',
      editorialLane,
      riskLevel,
      verified: true,
      conflicts: [],
      consensusFacts: comparison.consensusFacts,
      sourceSpecificFacts: comparison.sourceSpecificFacts,
      conflictingFacts: [],
      verifiedFacts
    };
  }

  if (independentTierB >= 2) {
    return {
      eventKey,
      status: editorialLane === EDITORIAL_LANES.STRICT ? 'verified-strict' : 'verified-standard',
      editorialLane,
      riskLevel,
      verified: true,
      conflicts: [],
      consensusFacts: comparison.consensusFacts,
      sourceSpecificFacts: comparison.sourceSpecificFacts,
      conflictingFacts: [],
      verifiedFacts
    };
  }

  return {
    eventKey,
    status: 'pending-verification',
    editorialLane,
    riskLevel,
    verified: false,
    conflicts: [],
    consensusFacts: comparison.consensusFacts,
    sourceSpecificFacts: comparison.sourceSpecificFacts,
    conflictingFacts: [],
    verifiedFacts
  };
}

export function selectBaseCandidate(candidates = []) {
  const tierScore = { A: 100, B: 60, C: 10 };
  return [...candidates].sort((a, b) => {
    const left = (tierScore[b.sourceRef?.tier] || 0) - (tierScore[a.sourceRef?.tier] || 0);
    if (left !== 0) return left;
    const body = (b.bodyLength || 0) - (a.bodyLength || 0);
    if (body !== 0) return body;
    return (b.pubDate || new Date(0)) - (a.pubDate || new Date(0));
  })[0];
}

export function validateArticleAgainstFacts(ai = {}, verification = {}) {
  const text = normalizeText(`${ai.title || ''}\n${ai.description || ''}\n${ai.body || ''}`);
  const verifiedFacts = verification.verifiedFacts || verification;
  const eventType = verification.eventType || verifiedFacts.eventType || 'general';
  const mismatches = [];
  const sportsFacts = unique([...(verifiedFacts.sportsTeams || []), ...(verifiedFacts.teams || [])]);

  if (eventType === 'sports-result') {
    for (const value of sportsFacts) {
      const normalized = normalizeText(value);
      if (!normalized || normalized.length < 2) continue;
      if (!text.includes(normalized)) {
        mismatches.push({ field: 'sportsTeams', value, reason: 'missing-critical-sports-fact' });
      }
    }
  }

  for (const value of verifiedFacts.laws || []) {
    const normalized = normalizeText(value);
    if (normalized && normalized.length >= 2 && !text.includes(normalized)) {
      mismatches.push({ field: 'laws', value, reason: 'missing-critical-law' });
    }
  }

  const allowedTeams = normalizedSet(sportsFacts);

  for (const team of unique([...KNOWN_SPORTS_TEAMS, ...KNOWN_COUNTRIES])) {
    const normalized = normalizeText(team);
    const hasSportsFacts = eventType === 'sports-result' || sportsFacts.length > 0;
    if (hasSportsFacts && text.includes(normalized) && !allowedTeams.has(normalized)) {
      mismatches.push({ field: 'sportsTeams', value: team, reason: 'unsupported-critical-term' });
    }
  }

  const allowedScores = normalizedSet(verifiedFacts.scores || []);
  for (const score of extractScores(text)) {
    const normalized = normalizeText(score);
    if (allowedScores.size > 0 && normalized && !allowedScores.has(normalized)) {
      mismatches.push({ field: 'scores', value: score, reason: 'unsupported-score' });
    }
  }

  const outputScores = extractScores(text);
  const money = extractMoney(text);
  const percentages = extractPercentages(text);
  const casualties = extractCasualties(text);
  const times = extractTimes(text);
  const outputNumbers = extractNumbers(text, { money, percentages, casualties, times, scores: outputScores }).filter(isCriticalNumber);
  const allowedNumbers = normalizedSet((verifiedFacts.numbers || []).filter(isCriticalNumber));
  for (const value of outputNumbers) {
    const normalized = normalizeText(value);
    if (normalized && !allowedNumbers.has(normalized)) {
      mismatches.push({ field: 'numbers', value, reason: 'unsupported-critical-number' });
    }
  }

  const semanticChecks = [
    {
      field: 'money',
      allowed: unique([...(verifiedFacts.money || []), ...(verifiedFacts.numbers || []).filter(isCriticalNumber)]),
      output: money,
      reason: 'unsupported-money'
    },
    {
      field: 'percentages',
      allowed: unique([...(verifiedFacts.percentages || []), ...(verifiedFacts.numbers || []).filter(isCriticalNumber)]),
      output: percentages,
      reason: 'unsupported-percentage'
    },
    {
      field: 'casualties',
      allowed: unique([...(verifiedFacts.casualties || []), ...(verifiedFacts.numbers || []).filter(isCriticalNumber)]),
      output: casualties,
      reason: 'unsupported-casualty'
    }
  ];
  for (const check of semanticChecks) {
    const allowed = normalizedSet(check.allowed || []);
    for (const value of check.output || []) {
      const normalized = normalizeText(value);
      if (normalized && !allowed.has(normalized)) {
        mismatches.push({ field: check.field, value, reason: check.reason });
      }
    }
  }

  const allowedDates = normalizedSet((verifiedFacts.dates || []).filter(isCriticalDate));
  for (const date of extractDates(text).filter(isCriticalDate)) {
    const normalized = normalizeText(date);
    if (allowedDates.size > 0 && normalized && !allowedDates.has(normalized)) {
      mismatches.push({ field: 'dates', value: date, reason: 'unsupported-critical-date' });
    }
  }

  for (const conflict of verification.conflicts || []) {
    for (const value of conflict.values || []) {
      const normalized = normalizeText(value);
      if (normalized && text.includes(normalized)) {
        mismatches.push({ field: conflict.field, value, reason: 'conflicting-source-value-in-output' });
      }
    }
  }

  return {
    ok: mismatches.length === 0,
    code: mismatches.length > 0 ? 'BLOCKED_FACTUAL_MISMATCH' : 'OK',
    mismatches
  };
}

export function buildEventRecord({ existing = {}, eventKey, candidates = [], verification }) {
  const now = new Date();
  const firstDetectedAt = existing.firstDetectedAt || now.toISOString();
  const expiresAt = existing.expiresAt || new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();
  const nextRetryAt = verification.verified
    ? null
    : new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString();

  return {
    eventKey,
    firstDetectedAt,
    lastSeenAt: now.toISOString(),
    lastAttemptAt: now.toISOString(),
    nextRetryAt,
    expiresAt,
    editorialLane: verification.editorialLane || EDITORIAL_LANES.STANDARD,
    riskLevel: verification.riskLevel,
    status: verification.status,
    publisherDomains: unique(candidates.map((candidate) => candidate.sourceRef.publisherDomain)),
    sources: candidates.map((candidate) => candidate.sourceRef),
    factsBySource: candidates.map((candidate) => ({
      publisherDomain: candidate.sourceRef.publisherDomain,
      url: candidate.sourceRef.url,
      facts: candidate.facts
    })),
    conflicts: verification.conflicts || [],
    consensusFacts: verification.consensusFacts || {},
    sourceSpecificFacts: verification.sourceSpecificFacts || [],
    conflictingFacts: verification.conflictingFacts || verification.conflicts || [],
    verifiedFacts: verification.verifiedFacts || {}
  };
}
