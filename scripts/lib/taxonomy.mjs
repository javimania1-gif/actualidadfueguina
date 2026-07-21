import { normalizeText } from './pipeline-utils.mjs';

export const TOPIC_CATEGORIES = Object.freeze([
  'Actualidad',
  'Política',
  'Economía',
  'Sociedad',
  'Policiales',
  'Deportes'
]);

export const PUBLICATION_CATEGORIES = Object.freeze([
  ...TOPIC_CATEGORIES,
  'Nacionales',
  'Mundo'
]);

export const TERRITORIES = Object.freeze([
  'Río Grande',
  'Ushuaia',
  'Tolhuin',
  'Provincia',
  'Malvinas',
  'Antártida',
  'Nacionales',
  'Mundo'
]);

export const CLASSIFICATION_VERSION = 2;

const TOPIC_ALIASES = new Map([
  ['actualidad', 'Actualidad'],
  ['agenda', 'Actualidad'],
  ['politica', 'Política'],
  ['economia', 'Economía'],
  ['sociedad', 'Sociedad'],
  ['policiales', 'Policiales'],
  ['deportes', 'Deportes'],
  ['salud', 'Sociedad'],
  ['educacion', 'Sociedad'],
  ['cultura', 'Sociedad'],
  ['turismo', 'Actualidad'],
  ['ambiente', 'Sociedad'],
  ['medio ambiente', 'Sociedad'],
  ['servicios', 'Actualidad'],
  ['institucional', 'Política']
]);

const TERRITORY_ALIASES = new Map([
  ['rio grande', 'Río Grande'],
  ['ushuaia', 'Ushuaia'],
  ['tolhuin', 'Tolhuin'],
  ['provincia', 'Provincia'],
  ['tierra del fuego', 'Provincia'],
  ['tierra del fuego aias', 'Provincia'],
  ['malvinas', 'Malvinas'],
  ['islas malvinas', 'Malvinas'],
  ['antartida', 'Antártida'],
  ['antartida argentina', 'Antártida'],
  ['nacionales', 'Nacionales'],
  ['argentina', 'Nacionales'],
  ['mundo', 'Mundo'],
  ['internacional', 'Mundo']
]);

export function canonicalTopic(value = '') {
  return TOPIC_ALIASES.get(normalizeText(value)) || '';
}

export function canonicalTerritory(value = '') {
  return TERRITORY_ALIASES.get(normalizeText(value)) || '';
}

export function scopeForTerritory(territory = '') {
  const canonical = canonicalTerritory(territory) || territory;
  if (['Río Grande', 'Ushuaia', 'Tolhuin'].includes(canonical)) return 'local';
  if (['Provincia', 'Malvinas', 'Antártida'].includes(canonical)) return 'provincial';
  if (canonical === 'Nacionales') return 'national';
  if (canonical === 'Mundo') return 'international';
  return 'unknown';
}

export function categoryForPublication(topic = 'Actualidad', scope = 'provincial') {
  if (scope === 'international') return 'Mundo';
  if (scope === 'national') return 'Nacionales';
  return canonicalTopic(topic) || 'Actualidad';
}

export function slugifyTaxonomy(value = '') {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function has(text, pattern) {
  return pattern.test(text);
}

export function inferCanonicalTopic({ title = '', description = '', body = '', facts = {}, current = '' } = {}) {
  const eventType = normalizeText(facts.eventType || '');
  const central = normalizeText([title, description, facts.rawSummary].filter(Boolean).join(' '));

  if (eventType === 'sports-result' || has(central, /\b(futbol|mundial de futbol|mundial 20\d{2}|copa del mundo|seleccion argentina|afa|partido|club|torneo|campeonato|deport\w*|atleta|rugby|hockey|automovilismo)\b/)) return 'Deportes';
  if (eventType === 'crime' || has(central, /\b(policial\w*|detenido|detenida|allanamiento|homicidio|robo|abuso sexual|narcotrafico|imputado|condenado|fiscalia|comisaria)\b/)) return 'Policiales';
  if (has(central, /\b(salud|hospital|medicamento|farmacia|vacuna|medico|sanitari\w*|osef|enfermedad|paciente)\b/)) return 'Sociedad';
  if (has(central, /\b(educacion|escuela|universidad|docente|alumno|estudiante|beca|curso|capacitacion|colegio|utn)\b/)) return 'Sociedad';
  if (has(central, /\b(economia|dolar|inflacion|tarifa|salario|paritaria|presupuesto|impuesto|fisco|empleo|industria|comercio|inversion|produccion|productiv\w*|credito|banco)\b/)) return 'Economía';
  if (eventType === 'weather' || eventType === 'weather-forecast' || eventType === 'service'
    || has(central, /\b(pronostico|alerta meteorologica|corte de luz|corte de agua|transito|estado de rutas|servicio publico|tramite|cronograma)\b/)) return 'Actualidad';
  if (has(central, /\b(ambiente|ambiental|conservacion|reserva natural|fauna|flora|bosque|incendio forestal|contaminacion|biodiversidad|ecosistema)\b/)) return 'Sociedad';
  if (has(central, /\b(turismo|turistico|temporada de invierno|cerro castor|hotel|vuelo|aeropuerto|visitante|destino|excursion)\b/)) return 'Actualidad';
  if (has(central, /\b(cultura|festival|musica|teatro|cine|museo|mural|artista|libro|pena|fiesta nacional|patrimonio)\b/)) return 'Sociedad';
  if (['international-conflict', 'territorial-sovereignty', 'defense', 'election', 'legislative', 'legal-policy'].includes(eventType)
    || has(central, /\b(politica|gobernador|concejo deliberante|legislatura|congreso|senado|diputados|presidente|ministro|eleccion|soberania|decreto|reforma constitucional|partido politico|gabinete)\b/)) return 'Política';

  const existing = canonicalTopic(current);
  return existing && existing !== 'Actualidad' ? existing : 'Sociedad';
}

export function uniqueTerritories(values = [], primary = '') {
  const primaryCanonical = canonicalTerritory(primary) || primary;
  return [...new Set(values.map(canonicalTerritory).filter(Boolean))]
    .filter((value) => value !== primaryCanonical);
}
