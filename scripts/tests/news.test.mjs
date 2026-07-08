import assert from 'node:assert/strict';
import {
  editorialScore,
  isRetryEligible,
  getNextRetryAt,
  extractFingerprint,
  isEventAlreadyPublished,
  canPublishWithinRunLimit,
  isStaleRoutineWeatherForecast,
  isStaleDatedDiscoveryCandidate
} from '../lib/pipeline-utils.mjs';
import {
  extractFacts,
  generateEventKey,
  isOrdinaryWeatherForecastText
} from '../lib/factual-utils.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
    passed++;
  } catch (err) {
    console.error(`  fail ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log('\n--- News Pipeline Utils ---');

test('fuente oficial reciente supera fuente discovery antigua', () => {
  const now = new Date();
  const official = {
    pubDate: new Date(now - 30 * 60 * 1000),
    bodyLength: 1200,
    source: { mode: 'official-auto', id: 'rio-grande-oficial', defaultCategory: 'Rio Grande' }
  };
  const oldDiscovery = {
    pubDate: new Date(now - 36 * 60 * 60 * 1000),
    bodyLength: 800,
    source: { mode: 'discovery-draft', id: 'nacionales-infobae', defaultCategory: 'Nacionales' }
  };
  assert(editorialScore(official) > editorialScore(oldDiscovery));
});

test('published y duplicate no son reintentables', () => {
  assert.equal(isRetryEligible({ status: 'published', seenAt: new Date().toISOString() }), false);
  assert.equal(isRetryEligible({ status: 'duplicate', seenAt: new Date().toISOString() }), false);
});

test('pending-verification respeta nextRetryAt', () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  assert.equal(isRetryEligible({ status: 'pending-verification', nextRetryAt: future }), false);
  assert.equal(isRetryEligible({ status: 'pending-verification', nextRetryAt: past }), true);
});

test('getNextRetryAt avanza con backoff inicial de 3 horas', () => {
  const next = new Date(getNextRetryAt(0)).getTime();
  const diff = next - Date.now();
  assert(diff > 2.9 * 60 * 60 * 1000 && diff < 3.1 * 60 * 60 * 1000);
});

test('deduplicacion editorial solo compara contra eventos publicados', () => {
  const published = new Set([
    extractFingerprint('ONU exige al Reino Unido negociar soberania de Malvinas con Argentina')
  ]);
  assert.equal(
    isEventAlreadyPublished('Argentina reclama soberania de Malvinas ante Reino Unido en la ONU', published),
    true
  );
  assert.equal(
    isEventAlreadyPublished('Productores locales reciben una nueva capacitacion alimentaria', published),
    false
  );
});

test('pronosticos ordinarios de distintas ciudades agrupan en una nota provincial diaria', () => {
  const rioGrande = extractFacts({
    article: {
      title: 'Clima hoy en Rio Grande, Tierra del Fuego: pronostico para el 8 julio de 2026',
      description: 'Temperaturas entre -2 y 4 grados.',
      text: 'El SMN anticipa cielo parcialmente nublado para Rio Grande.',
      date: '2026-07-08T03:20:46.000Z'
    },
    source: { location: 'Rio Grande', defaultCategory: 'Rio Grande' }
  });
  const ushuaia = extractFacts({
    article: {
      title: 'Clima hoy en Ushuaia, Tierra del Fuego: pronostico para el 8 julio de 2026',
      description: 'Temperaturas entre -4 y 3 grados.',
      text: 'El SMN anticipa cielo parcialmente nublado para Ushuaia.',
      date: '2026-07-08T03:07:09.000Z'
    },
    source: { location: 'Ushuaia', defaultCategory: 'Ushuaia' }
  });
  assert.equal(rioGrande.eventType, 'weather-forecast');
  assert.equal(ushuaia.eventType, 'weather-forecast');
  assert.equal(
    generateEventKey({ facts: rioGrande, title: rioGrande.title }),
    generateEventKey({ facts: ushuaia, title: ushuaia.title })
  );
});

test('alerta meteorologica no se trata como pronostico ordinario', () => {
  assert.equal(isOrdinaryWeatherForecastText('Alerta meteorologica severa por temporal en Ushuaia'), false);
});

test('pronostico rutinario viejo se descarta antes de publicar', () => {
  const now = new Date('2026-07-08T12:00:00Z').getTime();
  assert.equal(
    isStaleRoutineWeatherForecast({
      eventType: 'weather-forecast',
      weatherForecastDateKey: '2026-01-05'
    }, now),
    true
  );
  assert.equal(
    isStaleRoutineWeatherForecast({
      eventType: 'weather-forecast',
      weatherForecastDateKey: '2026-07-08'
    }, now),
    false
  );
  assert.equal(isStaleRoutineWeatherForecast({ eventType: 'weather' }, now), false);
});

test('descubrimiento con fecha vieja explicita no consume presupuesto editorial', () => {
  const now = new Date('2026-07-08T12:00:00Z').getTime();
  assert.equal(
    isStaleDatedDiscoveryCandidate({
      source: { mode: 'discovery-draft' },
      title: 'Turismo Carretera en la Antartida Argentina: calendario 2023',
      description: 'Presentacion historica sin novedad vigente',
      now
    }),
    true
  );
  assert.equal(
    isStaleDatedDiscoveryCandidate({
      source: { mode: 'official-auto' },
      title: 'Balance de gestion 2025',
      now
    }),
    false
  );
  assert.equal(
    isStaleDatedDiscoveryCandidate({
      source: { mode: 'discovery-draft' },
      title: 'Argentina anuncia medidas nacionales para julio de 2026',
      pubDate: '2026-07-08T10:00:00Z',
      now
    }),
    false
  );
});

test('cupo editorial permite dos normales, tercer cupo importante y urgentes aparte', () => {
  assert.deepEqual(
    canPublishWithinRunLimit({ importance: 6, normalPublished: 1, target: 2, maxNormal: 3, extraSlotMinImportance: 8 }),
    { ok: true, urgent: false, reason: 'within-normal-cap' }
  );
  assert.equal(
    canPublishWithinRunLimit({ importance: 6, normalPublished: 2, target: 2, maxNormal: 3, extraSlotMinImportance: 8 }).ok,
    false
  );
  assert.equal(
    canPublishWithinRunLimit({ importance: 8, normalPublished: 2, target: 2, maxNormal: 3, extraSlotMinImportance: 8 }).ok,
    true
  );
  assert.equal(
    canPublishWithinRunLimit({ importance: 9, normalPublished: 3, target: 2, maxNormal: 3, extraSlotMinImportance: 8 }).urgent,
    true
  );
});

console.log(`\n=== NEWS TESTS: ${passed} pasados, ${failed} fallados ===`);
if (failed > 0) process.exit(1);
