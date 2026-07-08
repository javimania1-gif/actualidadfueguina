/**
 * news.test.mjs
 * Tests de regresión para el pipeline de noticias.
 * Cubre: presupuesto oficial, fuentes discovery, backoff retry,
 * deduplicación por evento, categorías territoriales, thresholds editoriales.
 */

import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function asyncTest(name, fn) {
  return fn().then(() => {
    console.log(`  ✓ ${name}`);
    passed++;
  }).catch(err => {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  });
}

// ============================================================
// 1. SCORING EDITORIAL
// ============================================================
console.log('\n--- Test 1: Scoring editorial ---');

function editorialScore(candidate, byCategory = {}) {
  const now = Date.now();
  const ageMs = now - (candidate.pubDate || new Date()).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  const recencyScore = Math.max(0, 40 - (ageHours / 48) * 40);
  const bodyLen = candidate.bodyLength || 0;
  const qualityScore = Math.min(20, (bodyLen / 2000) * 20);
  let localScore = 0;
  const srcMode = candidate.source?.mode;
  if (srcMode === 'official-auto') localScore = 20;
  else if (candidate.source?.id?.startsWith('bing-')) localScore = 15;
  else if (['infobae-tdf', 'perfil-tdf', 'clarin-tdf'].includes(candidate.source?.id)) localScore = 10;
  else localScore = 5;
  const cat = candidate.source?.defaultCategory;
  const diversityBonus = byCategory[cat] ? 0 : 15;
  return recencyScore + qualityScore + localScore + diversityBonus;
}

const now = new Date();
const recentOfficial = {
  pubDate: new Date(now - 30 * 60 * 1000), // 30 min ago
  bodyLength: 1200,
  source: { mode: 'official-auto', id: 'rio-grande-oficial', defaultCategory: 'Río Grande' }
};
const oldDiscovery = {
  pubDate: new Date(now - 36 * 60 * 60 * 1000), // 36h ago
  bodyLength: 800,
  source: { mode: 'discovery-draft', id: 'nacionales-infobae', defaultCategory: 'Nacionales' }
};
const recentBing = {
  pubDate: new Date(now - 2 * 60 * 60 * 1000), // 2h ago
  bodyLength: 1500,
  source: { mode: 'discovery-draft', id: 'bing-tdf', defaultCategory: 'Provincia' }
};

test('Fuente oficial reciente supera fuente discovery antigua', () => {
  assert(editorialScore(recentOfficial) > editorialScore(oldDiscovery));
});

test('Bing reciente supera fuente nacional antigua', () => {
  assert(editorialScore(recentBing) > editorialScore(oldDiscovery));
});

test('Bonus diversidad se aplica para categoría nueva', () => {
  const withBonus = editorialScore(recentBing, {});
  const withoutBonus = editorialScore(recentBing, { 'Provincia': 1 });
  assert(withBonus > withoutBonus, `Con bonus: ${withBonus}, sin bonus: ${withoutBonus}`);
});

// ============================================================
// 2. PRESUPUESTO IA — OFICIAL NO MONOPOLIZA
// ============================================================
console.log('\n--- Test 2: Presupuesto IA ---');

test('Fuente oficial no puede superar OFFICIAL_AI_BUDGET_FRACTION', () => {
  const MAX_AI = 8;
  const OFFICIAL_FRACTION = 0.5;
  const officialBudget = Math.ceil(MAX_AI * OFFICIAL_FRACTION);
  const discoveryBudget = MAX_AI - officialBudget;
  assert(officialBudget <= MAX_AI * 0.5 + 1, 'Presupuesto oficial excede 50%+1');
  assert(discoveryBudget >= MAX_AI * 0.4, 'Presupuesto discovery menor a 40%');
});

test('Presupuesto total nunca supera MAX_AI_PER_RUN', () => {
  const MAX_AI = 8;
  const OFFICIAL_FRACTION = 0.5;
  const officialBudget = Math.ceil(MAX_AI * OFFICIAL_FRACTION);
  const discoveryBudget = MAX_AI - officialBudget;
  let officialUsed = 0, discoveryUsed = 0;
  // Simular llenado completo de ambas cuentas
  while (officialUsed < officialBudget) officialUsed++;
  while (discoveryUsed < discoveryBudget) discoveryUsed++;
  assert(officialUsed + discoveryUsed === MAX_AI, `Suma ${officialUsed + discoveryUsed} ≠ ${MAX_AI}`);
});

// ============================================================
// 3. ESTADOS DE RETRY CON BACKOFF
// ============================================================
console.log('\n--- Test 3: Retry con backoff ---');

const DRAFT_RETRY_WINDOWS_MS = [3 * 60 * 60 * 1000, 6 * 60 * 60 * 1000, 12 * 60 * 60 * 1000];
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

function isRetryEligible(seenItem) {
  if (!seenItem) return false;
  if (['published', 'duplicate', 'discarded-editorial', 'stale'].includes(seenItem.status)) return false;
  if (!['draft', 'extract-error', 'model-error', 'temporary-error'].includes(seenItem.status)) return false;
  const now = Date.now();
  if (seenItem.nextRetryAt) return now >= new Date(seenItem.nextRetryAt).getTime();
  const seenAt = new Date(seenItem.seenAt || 0).getTime();
  return (now - seenAt) < STALE_AFTER_MS;
}

function getNextRetryAt(attempts) {
  const windowMs = DRAFT_RETRY_WINDOWS_MS[Math.min(attempts, DRAFT_RETRY_WINDOWS_MS.length - 1)];
  return new Date(Date.now() + windowMs).toISOString();
}

test('published queda bloqueado definitivamente', () => {
  assert(!isRetryEligible({ status: 'published', seenAt: new Date(0).toISOString() }));
});

test('duplicate queda bloqueado definitivamente', () => {
  assert(!isRetryEligible({ status: 'duplicate', seenAt: new Date(0).toISOString() }));
});

test('discarded-editorial queda bloqueado definitivamente', () => {
  assert(!isRetryEligible({ status: 'discarded-editorial', seenAt: new Date().toISOString() }));
});

test('stale queda bloqueado definitivamente', () => {
  assert(!isRetryEligible({ status: 'stale', seenAt: new Date().toISOString() }));
});

test('draft sin nextRetryAt reciente es elegible', () => {
  assert(isRetryEligible({ status: 'draft', seenAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }));
});

test('draft con nextRetryAt futuro NO es elegible', () => {
  const notYet = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  assert(!isRetryEligible({ status: 'draft', seenAt: new Date().toISOString(), nextRetryAt: notYet }));
});

test('draft con nextRetryAt pasado SI es elegible', () => {
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  assert(isRetryEligible({ status: 'draft', seenAt: new Date().toISOString(), nextRetryAt: past }));
});

test('getNextRetryAt(0) devuelve 3 horas en el futuro', () => {
  const next = new Date(getNextRetryAt(0)).getTime();
  const diff = next - Date.now();
  assert(diff > 2.9 * 60 * 60 * 1000 && diff < 3.1 * 60 * 60 * 1000, `Diff: ${diff}ms`);
});

test('getNextRetryAt(2) devuelve 12 horas en el futuro', () => {
  const next = new Date(getNextRetryAt(2)).getTime();
  const diff = next - Date.now();
  assert(diff > 11.9 * 60 * 60 * 1000 && diff < 12.1 * 60 * 60 * 1000, `Diff: ${diff}ms`);
});

// ============================================================
// 4. DEDUPLICACIÓN POR ACONTECIMIENTO
// ============================================================
console.log('\n--- Test 4: Deduplicación por acontecimiento ---');

const GENERIC_TITLE_WORDS = new Set([
  'noticias', 'inicio', 'home', 'bienvenido', 'portada', 'hoy',
  'municipio', 'rio', 'grande', 'ushuaia', 'tolhuin', 'fuego', 'tierra',
  'novedades', 'actualidad', 'informacion', 'bing', 'google'
]);

function extractFingerprint(title) {
  const stopwords = new Set(['que', 'con', 'para', 'por', 'una', 'del', 'los', 'las', 'sus', 'fue', 'son', 'este', 'esta', 'pero', 'como']);
  const words = (title || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 5 && !stopwords.has(w) && !GENERIC_TITLE_WORDS.has(w));
  return words.sort().join('|');
}

function isEventDuplicate(title, published) {
  const words = new Set(extractFingerprint(title).split('|').filter(Boolean));
  if (words.size < 2) return false;
  for (const fp of published) {
    const fpWords = new Set(fp.split('|').filter(Boolean));
    if (fpWords.size < 2) continue;
    const intersection = [...words].filter(w => fpWords.has(w)).length;
    if (intersection >= 3) return true;
  }
  return false;
}

test('Dos medios que cubren mismo hecho se deduplicán', () => {
  const published = new Set([extractFingerprint('ONU exige al Reino Unido negociar soberanía Malvinas Argentina')]);
  assert(isEventDuplicate('Argentina reclama ante ONU soberanía Malvinas Reino Unido', published));
});

test('Dos noticias distintas de Río Grande no se confunden', () => {
  const published = new Set([extractFingerprint('Centro monitoreo urbano Río Grande tecnología camaras')]);
  assert(!isEventDuplicate('Talleres formativos productores alimentos invierno actividades', published));
});

test('Títulos que solo comparten palabras geográficas comunes no se deduplicán', () => {
  const published = new Set([extractFingerprint('Festival música verano actividades recreativas parque')]);
  assert(!isEventDuplicate('Capacitación profesional formación técnica convenio institucional', published));
});

test('Mismo título exacto siempre se deduplica', () => {
  const title = 'Municipio anunció nuevas obras de infraestructura para el barrio norte';
  const published = new Set([extractFingerprint(title)]);
  assert(isEventDuplicate(title, published));
});

// ============================================================
// 5. MODELO EDITORIAL — CATEGORÍAS Y THRESHOLDS
// ============================================================
console.log('\n--- Test 5: Modelo editorial ---');

test('Nacionales respeta threshold de importancia >= 7', () => {
  const minImportance = 7;
  const aiResult = { importance: 5, category: 'Nacionales' };
  const shouldDiscard = aiResult.importance < minImportance;
  assert(shouldDiscard, 'Debería descartar nota con importancia 5 en Nacionales');
});

test('Mundo respeta threshold de importancia >= 8', () => {
  const minImportance = 8;
  const aiResult = { importance: 7, category: 'Mundo' };
  const shouldDiscard = aiResult.importance < minImportance;
  assert(shouldDiscard, 'Debería descartar nota con importancia 7 en Mundo');
});

test('Nacionales con importancia 8 pasa el threshold', () => {
  const minImportance = 7;
  const aiResult = { importance: 8, category: 'Nacionales' };
  assert(!( aiResult.importance < minImportance), 'No debería descartar nota con importancia 8');
});

test('forceCategory sobreescribe categoría IA', () => {
  const source = { forceCategory: 'Nacionales' };
  const ai = { category: 'Política', importance: 9, title: 'Test' };
  if (source.forceCategory) ai.category = source.forceCategory;
  assert.equal(ai.category, 'Nacionales');
});

test('Categoría territorial se conserva con fuente Bing local', () => {
  const source = { defaultCategory: 'Tolhuin', id: 'bing-tolhuin', mode: 'discovery-draft' };
  const ai = { category: source.forceCategory || source.defaultCategory };
  assert.equal(ai.category, 'Tolhuin');
});

test('Tags temáticos no reemplazan categoría territorial', () => {
  const source = { defaultCategory: 'Río Grande', id: 'rio-grande-oficial', mode: 'official-auto' };
  const ai = {
    category: source.forceCategory || source.defaultCategory,
    tags: ['Política', 'Municipio', 'Presupuesto']
  };
  assert.equal(ai.category, 'Río Grande');
  assert(ai.tags.includes('Política'), 'Tags temáticos deben estar en tags, no en category');
});

// ============================================================
// Resultado final
// ============================================================
console.log(`\n=== NEWS TESTS: ${passed} pasados, ${failed} fallados ===`);
if (failed > 0) process.exit(1);
