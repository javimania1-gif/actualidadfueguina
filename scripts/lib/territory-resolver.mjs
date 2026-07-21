import { normalizeText } from './pipeline-utils.mjs';
import {
  CLASSIFICATION_VERSION,
  canonicalTerritory,
  scopeForTerritory,
  uniqueTerritories
} from './taxonomy.mjs';

const FOREIGN_PATTERN = /\b(gibraltar|espana|estados unidos|reino unido|iran|rusia|ucrania|venezuela|mexico|colombia|cuba|francia|alemania|italia|brasil|chile|uruguay|paraguay|bolivia|peru|ecuador|china|japon|corea|siria|israel|palestina|egipto|kenia|vaticano|papa|filipinas|guatemala|republica dominicana|india|australia|canada)\b/;
const NATIONAL_PATTERN = /\b(argentina|argentino|argentina|gobierno nacional|presidente argentino|javier milei|milei|luis caputo|caputo|adorni|banco central|bcra|seleccion argentina|afa|scaloni|copa del mundo|buenos aires|cordoba|mendoza|chaco|rosario|santa fe|tucuman|salta|jujuy|santa cruz|chubut|neuquen|rio negro|la pampa|rio gallegos|cabo virgenes|arroyo marea)\b/;
const STRONG_NATIONAL_SUBJECT = /\b(gobierno nacional|presidente argentino|javier milei|milei|luis caputo|caputo|adorni|banco central|bcra|anses|seleccion argentina|afa|lionel messi|messi|scaloni)\b/;
const LOCAL_SIGNAL_PATTERN = /\b(tierra del fuego|tdf|fueguin|gobierno provincial|gobierno de tierra del fuego|gustavo melella|rio grande|ushuaia|tolhuin|martin perez|walter vuoto|daniel harrington)\b/;

function result(primaryTerritory, location, confidence, reason, mentioned = []) {
  const primary = canonicalTerritory(primaryTerritory) || primaryTerritory || 'Provincia';
  const legacyCategory = primary === 'Río Grande' ? 'Rio Grande' : primary === 'Antártida' ? 'Antartida' : primary;
  return {
    category: legacyCategory,
    primaryTerritory: primary,
    secondaryTerritories: uniqueTerritories(mentioned, primary),
    scope: scopeForTerritory(primary),
    location,
    confidence,
    reason,
    classificationVersion: CLASSIFICATION_VERSION
  };
}

function mentionedTerritories(text) {
  const values = [];
  if (/\brio grande\b/.test(text)) values.push('Río Grande');
  if (/\bushuaia\b/.test(text)) values.push('Ushuaia');
  if (/\btolhuin\b/.test(text)) values.push('Tolhuin');
  if (/\b(tierra del fuego|tdf|fueguin)\b/.test(text)) values.push('Provincia');
  if (/\bmalvinas\b/.test(text)) values.push('Malvinas');
  if (/\bantartida\b/.test(text)) values.push('Antártida');
  if (NATIONAL_PATTERN.test(text)) values.push('Nacionales');
  if (FOREIGN_PATTERN.test(text)) values.push('Mundo');
  return values;
}

function countryLocation(match = '') {
  const display = {
    'estados unidos': 'Estados Unidos',
    'reino unido': 'Reino Unido',
    espana: 'España',
    iran: 'Irán',
    mexico: 'México',
    peru: 'Perú',
    japon: 'Japón',
    papa: 'Ciudad del Vaticano',
    vaticano: 'Ciudad del Vaticano'
  };
  return display[match] || match.charAt(0).toUpperCase() + match.slice(1);
}

export function resolvePublicationTerritory({
  title = '',
  description = '',
  body = '',
  verifiedFacts = {},
  agendaTerritory = '',
  source = {},
  sourceUrl = ''
}) {
  const centralText = normalizeText([title, description, verifiedFacts.rawSummary].filter(Boolean).join(' '));
  const fullText = normalizeText([
    centralText,
    String(body).slice(0, 5000),
    ...(verifiedFacts.places || []),
    ...(verifiedFacts.countries || []),
    ...(verifiedFacts.people || []),
    ...(verifiedFacts.organizations || [])
  ].join(' '));
  const mentioned = mentionedTerritories(fullText);

  // Homónimos de Río Grande se resuelven antes que cualquier señal local débil.
  if (/\brio grande\b/.test(centralText)) {
    if (/\b(zacatecas|claudia sheinbaum|david monreal|ricardo monreal|morena|mexico)\b/.test(fullText)
      && !/\b(martin perez|municipalidad de rio grande|tierra del fuego|tdf)\b/.test(fullText)) {
      return result('Mundo', 'Río Grande, Zacatecas, México', 'high', 'zacatecas-homonym', mentioned);
    }
    if (/\b(rio grande do sul|brasil|brasileno|gaucho)\b/.test(fullText)
      && !/\b(martin perez|municipalidad de rio grande|tierra del fuego|tdf)\b/.test(fullText)) {
      return result('Mundo', 'Rio Grande do Sul, Brasil', 'high', 'brazil-homonym', mentioned);
    }
  }

  // Malvinas y Antártida son territorios editoriales propios y tienen precedencia.
  const malvinasIndex = centralText.search(/\bmalvinas\b/);
  const antartidaIndex = centralText.search(/\bantartida\b/);
  if (malvinasIndex >= 0 || antartidaIndex >= 0) {
    if (antartidaIndex >= 0 && (malvinasIndex < 0 || antartidaIndex < malvinasIndex)) {
      return result('Antártida', 'Antártida Argentina', 'high', 'central-antartida', mentioned);
    }
    return result('Malvinas', 'Islas Malvinas', 'high', 'central-malvinas', mentioned);
  }

  // El protagonista define el territorio en viajes, visitas y reuniones.
  const protagonist = normalizeText(title).match(/^(municipio de |municipalidad de )?(rio grande|ushuaia|tolhuin)|^(martin perez|walter vuoto|daniel harrington|gobierno de tierra del fuego|gustavo melella)/)?.[0] || '';
  if (/rio grande|martin perez/.test(protagonist)) return result('Río Grande', 'Río Grande', 'high', 'protagonist-rio-grande', mentioned);
  if (/ushuaia|walter vuoto/.test(protagonist)) return result('Ushuaia', 'Ushuaia', 'high', 'protagonist-ushuaia', mentioned);
  if (/tolhuin|daniel harrington/.test(protagonist)) return result('Tolhuin', 'Tolhuin', 'high', 'protagonist-tolhuin', mentioned);
  if (/gobierno de tierra del fuego|gustavo melella/.test(protagonist)) return result('Provincia', 'Tierra del Fuego AIAS', 'high', 'protagonist-provincia', mentioned);

  const localCities = [
    ['Río Grande', /\b(rio grande|martin perez|municipalidad de rio grande|punta popper|riograndense)\b/],
    ['Ushuaia', /\b(ushuaia|walter vuoto|municipalidad de ushuaia|cerro castor|puerto de ushuaia|ushuaiense)\b/],
    ['Tolhuin', /\b(tolhuin|daniel harrington|municipalidad de tolhuin|tolhuinense)\b/]
  ].filter(([, pattern]) => pattern.test(centralText));

  if (localCities.length > 1 || /\b(las tres ciudades|los tres municipios|varias ciudades|toda la provincia)\b/.test(centralText)) {
    return result('Provincia', 'Tierra del Fuego AIAS', 'high', 'multi-city-provincia', mentioned);
  }
  if (/\b(tierra del fuego|tdf|fueguin|gobierno provincial|gobierno de la provincia|gustavo melella)\b/.test(centralText)) {
    return result('Provincia', 'Tierra del Fuego AIAS', 'high', 'central-provincia', mentioned);
  }
  if (localCities.length === 1) {
    const [territory] = localCities[0];
    return result(territory, territory, 'high', `central-${normalizeText(territory).replaceAll(' ', '-')}`, mentioned);
  }

  if (STRONG_NATIONAL_SUBJECT.test(centralText)) {
    return result('Nacionales', 'Argentina', 'high', 'central-argentine-subject', mentioned);
  }

  // Una mención extranjera explícita gana antes que palabras institucionales genéricas
  // (por ejemplo, "Senado de Colombia" no puede convertirse en Nacionales).
  const foreignMatch = centralText.match(FOREIGN_PATTERN)?.[1];
  if (foreignMatch && !LOCAL_SIGNAL_PATTERN.test(centralText)) {
    return result('Mundo', countryLocation(foreignMatch), 'high', 'central-foreign', mentioned);
  }

  if (NATIONAL_PATTERN.test(centralText)
    || (/\b(congreso|senado|diputados)\b/.test(centralText) && /\b(argentina|argentino|nacional)\b/.test(centralText))) {
    return result('Nacionales', 'Argentina', 'high', 'central-national', mentioned);
  }

  const sourceTerritory = canonicalTerritory(source.territory)
    || canonicalTerritory(source.forceCategory)
    || canonicalTerritory(source.defaultCategory)
    || canonicalTerritory(agendaTerritory);

  // En titulares ambiguos, el cuerpo manda sobre la procedencia del feed. Es la
  // barrera que evita publicar como fueguina una noticia extranjera levantada por
  // una fuente local. Los actores nacionales fuertes también tienen precedencia.
  if (foreignMatch || FOREIGN_PATTERN.test(fullText)) return result('Mundo', foreignMatch ? countryLocation(foreignMatch) : 'Internacional', 'low', 'body-foreign', mentioned);
  if (STRONG_NATIONAL_SUBJECT.test(fullText)) return result('Nacionales', 'Argentina', 'low', 'body-argentine-subject', mentioned);

  // Una fuente local sólo puede decidir por descarte cuando el contenido también
  // contiene una señal fueguina. Así no convertimos la ubicación del medio en la
  // ubicación de todos los hechos que ese medio cubre.
  if (sourceTerritory && ['local', 'provincial'].includes(scopeForTerritory(sourceTerritory))
    && LOCAL_SIGNAL_PATTERN.test(fullText)) {
    const bodyCities = [
      ['Río Grande', /\b(rio grande|martin perez|municipalidad de rio grande|punta popper|riograndense)\b/],
      ['Ushuaia', /\b(ushuaia|walter vuoto|municipalidad de ushuaia|cerro castor|puerto de ushuaia|ushuaiense)\b/],
      ['Tolhuin', /\b(tolhuin|daniel harrington|municipalidad de tolhuin|tolhuinense)\b/]
    ].filter(([, pattern]) => pattern.test(fullText));
    if (bodyCities.length === 1) {
      const [territory] = bodyCities[0];
      return result(territory, territory, 'low', 'body-local-signal', mentioned);
    }
    return result('Provincia', 'Tierra del Fuego AIAS', 'low', 'body-provincial-signal', mentioned);
  }

  if (NATIONAL_PATTERN.test(fullText)) return result('Nacionales', 'Argentina', 'low', 'body-national', mentioned);
  if (sourceTerritory) {
    const location = sourceTerritory === 'Provincia' ? 'Tierra del Fuego AIAS'
      : sourceTerritory === 'Nacionales' ? 'Argentina'
        : sourceTerritory === 'Mundo' ? (source.location || 'Internacional')
          : sourceTerritory;
    return result(sourceTerritory, location, 'low', 'source-territory-fallback', mentioned);
  }
  const sourceForeignMatch = normalizeText(source.location || '').match(FOREIGN_PATTERN)?.[1];
  if (sourceForeignMatch) return result('Mundo', countryLocation(sourceForeignMatch), 'lowest', 'source-foreign-location-fallback', mentioned);
  const locationTerritory = canonicalTerritory(source.location);
  if (locationTerritory) {
    const location = locationTerritory === 'Provincia' ? 'Tierra del Fuego AIAS'
      : locationTerritory === 'Nacionales' ? 'Argentina'
        : locationTerritory === 'Mundo' ? 'Internacional'
          : locationTerritory;
    return result(locationTerritory, location, 'lowest', 'source-location-fallback', mentioned);
  }
  return result('Provincia', source.location || 'Tierra del Fuego AIAS', 'lowest', 'editorial-default', mentioned);
}
