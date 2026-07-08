import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, cleanText } from './news-utils.mjs';
import { SOURCE_TIERS, countIndependentEditorialSources, isSourceCompetentForEvent } from './source-policy.mjs';
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

const KNOWN_TEAMS_AND_COUNTRIES = [
  'Argentina', 'Egipto', 'Ecuador', 'Brasil', 'Chile', 'Uruguay', 'Paraguay',
  'Bolivia', 'Peru', 'Colombia', 'Venezuela', 'Mexico', 'Estados Unidos',
  'Reino Unido', 'Inglaterra', 'Francia', 'Alemania', 'Italia', 'Espana'
];

const KNOWN_PLACES = [
  'Rio Grande', 'Río Grande', 'Ushuaia', 'Tolhuin', 'Tierra del Fuego',
  'Islas Malvinas', 'Malvinas', 'Antartida', 'Antártida', 'Argentina'
];

export const FACTUAL_VALIDATION_VERSION = 2;

const CRITICAL_FIELDS = [
  'teams',
  'people',
  'organizations',
  'places',
  'numbers',
  'dates',
  'scores',
  'laws'
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

function extractCapitalizedPhrases(text) {
  const normalizedText = cleanText(text).replace(/\s+/g, ' ');
  const matches = normalizedText.match(/\b[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,3}/g) || [];
  return unique(matches)
    .filter((value) => !/^(El|La|Los|Las|Un|Una|En|Del|Con|Actualidad Fueguina)$/.test(value))
    .slice(0, 12);
}

function extractNumbers(text) {
  const values = cleanText(text).match(/\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?\s?(?:%|por ciento|millones?|pesos?|d[óo]lares?|usuarios?|v[íi]ctimas?|heridos?|fallecidos?|muertos?)?\b/gi) || [];
  return unique(values).slice(0, 12);
}

function extractScores(text) {
  const values = cleanText(text).match(/\b\d{1,2}\s?[-–]\s?\d{1,2}\b/g) || [];
  return unique(values);
}

function extractDates(text, articleDate = '') {
  const values = cleanText(text).match(/\b(?:\d{1,2}\s+de\s+)?(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+de\s+\d{4})?|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/gi) || [];
  if (articleDate) values.push(String(articleDate).slice(0, 10));
  return unique(values).slice(0, 8);
}

export function classifyRisk({ title = '', text = '', category = '', source = {}, aiRisk = '' }) {
  const combined = `${title}\n${text.slice(0, 3000)}\n${category}`;
  const reasons = [];

  if (aiRisk === 'alto') reasons.push('ai-high');
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(combined)) reasons.push(pattern.source);
  }

  if (reasons.length > 0) return { level: 'high', reasons };

  if (source.mode === 'official-auto') {
    for (const pattern of LOW_RISK_PATTERNS) {
      if (pattern.test(combined)) return { level: 'low', reasons: ['official-routine'] };
    }
  }

  return { level: 'low', reasons: ['default-low'] };
}

export function extractFacts({ article = {}, item = {}, source = {}, category = '' }) {
  const title = article.title || item.title || '';
  const text = `${title}\n${article.description || item.description || ''}\n${article.text || ''}`;
  const risk = classifyRisk({ title, text, category: category || source.defaultCategory, source });
  const capitalized = extractCapitalizedPhrases(`${title}\n${article.description || ''}`);
  const teams = unique(pickKnown(text, KNOWN_TEAMS_AND_COUNTRIES));

  return {
    title,
    riskLevel: risk.level,
    riskReasons: risk.reasons,
    eventType: risk.level === 'high' ? inferEventType(text) : 'general',
    teams,
    people: capitalized.filter((value) => !teams.some((team) => normalizeText(team) === normalizeText(value))).slice(0, 8),
    organizations: unique(capitalized.filter((value) => /(Municipio|Municipalidad|Gobierno|Discord|ONU|UTN|Justicia|Legislatura)/i.test(value))),
    places: unique([...pickKnown(text, KNOWN_PLACES), source.location || '']).slice(0, 8),
    numbers: extractNumbers(text),
    scores: extractScores(text),
    dates: extractDates(text, article.date || item.pubDate),
    action: inferAction(title || text),
    rawSummary: cleanText(article.description || item.description || '').slice(0, 500)
  };
}

function inferEventType(text) {
  const value = normalizeText(text);
  if (/\b(resultado|marcador|vencio|derroto|elimino|clasifico|octavos|cuartos)\b/.test(value)) return 'sports-result';
  if (/\b(eleccion|electoral|votos|convencionales)\b/.test(value)) return 'election';
  if (/\b(homicidio|detenido|allanamiento|secuestro|robo|drogas|contrabando|desaparecido|violencia|busqueda de personas)\b/.test(value)) return 'crime';
  if (/\b(alerta meteorologica|temporal|viento|nevadas?|sismo|evacuacion|naufragio)\b/.test(value)) return 'weather';
  if (/\b(ciencia|cientifico|investigacion|hallazgo|conicet)\b/.test(value)) return 'scientific';
  if (/\b(fallecio|murio|muerte|victima|herido|accidente)\b/.test(value)) return 'casualty';
  if (/\b(legislatura|senado|diputados|sesion|proyecto de ley)\b/.test(value)) return 'legislative';
  if (/\b(ley|decreto|resolucion|norma|reforma constitucional)\b/.test(value)) return 'legal-policy';
  return 'high-risk';
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
  if (facts.eventType === 'sports-result' && (facts.teams || []).length > 0) {
    const primary = (facts.teams || []).map(normalizeText).sort()[0];
    const date = (facts.dates || []).map(normalizeText).find(Boolean) || '';
    return ['sports-result', primary, date].filter(Boolean).join('|').slice(0, 180);
  }

  const important = [
    facts.eventType,
    ...((facts.teams || []).length ? facts.teams : []),
    ...((facts.organizations || []).slice(0, 3)),
    ...((facts.people || []).slice(0, 3)),
    ...((facts.places || []).slice(0, 2)),
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
  return unique(values);
}

function diffValues(field, a = [], b = []) {
  const leftValues = comparableFactValues(field, a);
  const rightValues = comparableFactValues(field, b);
  const setA = normalizedSet(leftValues);
  const setB = normalizedSet(rightValues);
  if (setA.size === 0 || setB.size === 0) return [];
  if (setsEqual(setA, setB)) return [];

  if (['teams', 'scores', 'numbers', 'dates', 'laws'].includes(field)) {
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
      for (const field of ['teams', 'scores', 'numbers', 'dates', 'laws']) {
        if (field === 'teams' && left.eventType !== 'sports-result' && right.eventType !== 'sports-result') continue;
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
  merged.eventType = factSets.find((facts) => facts.eventType)?.eventType || 'general';
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
      sourceFacts.eventType = facts.eventType || 'general';
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
  const riskLevel = factSets.some((facts) => facts.riskLevel === 'high') ? 'high' : 'low';
  const comparison = compareFactSets(factSets);
  const conflicts = comparison.conflictingFacts;
  const hasCriticalConflict = conflicts.some((conflict) => conflict.severity === 'critical');
  const eventType = factSets.find((facts) => facts.eventType)?.eventType || 'general';
  const verifiedFacts = riskLevel === 'high' ? comparison.consensusFacts : comparison.unionFacts;

  if (hasCriticalConflict) {
    return {
      eventKey,
      status: 'conflicting-sources',
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

  if (riskLevel === 'low') {
    return {
      eventKey,
      status: 'verified',
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
      status: 'verified',
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

  if (eventType === 'sports-result') {
    for (const value of verifiedFacts.teams || []) {
      const normalized = normalizeText(value);
      if (!normalized || normalized.length < 2) continue;
      if (!text.includes(normalized)) {
        mismatches.push({ field: 'teams', value, reason: 'missing-critical-sports-fact' });
      }
    }
  }

  for (const value of verifiedFacts.laws || []) {
    const normalized = normalizeText(value);
    if (normalized && normalized.length >= 2 && !text.includes(normalized)) {
      mismatches.push({ field: 'laws', value, reason: 'missing-critical-law' });
    }
  }

  const allowedTeams = normalizedSet([
    ...(verifiedFacts.teams || []),
    ...(verifiedFacts.places || []),
    ...(verifiedFacts.people || [])
  ]);

  for (const team of KNOWN_TEAMS_AND_COUNTRIES) {
    const normalized = normalizeText(team);
    const hasSportsFacts = eventType === 'sports-result' || (verifiedFacts.teams || []).length > 0;
    if (hasSportsFacts && text.includes(normalized) && !allowedTeams.has(normalized)) {
      mismatches.push({ field: 'teams', value: team, reason: 'unsupported-critical-term' });
    }
  }

  const allowedScores = normalizedSet(verifiedFacts.scores || []);
  for (const score of extractScores(text)) {
    const normalized = normalizeText(score);
    if (allowedScores.size > 0 && normalized && !allowedScores.has(normalized)) {
      mismatches.push({ field: 'scores', value: score, reason: 'unsupported-score' });
    }
  }

  const allowedNumbers = normalizedSet((verifiedFacts.numbers || []).filter(isCriticalNumber));
  const outputNumbers = extractNumbers(text).filter(isCriticalNumber);
  for (const value of outputNumbers) {
    const normalized = normalizeText(value);
    if (normalized && !allowedNumbers.has(normalized)) {
      mismatches.push({ field: 'numbers', value, reason: 'unsupported-critical-number' });
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
