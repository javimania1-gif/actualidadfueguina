import assert from 'node:assert/strict';
import {
  editorialScore,
  isRetryEligible,
  getNextRetryAt,
  extractFingerprint,
  isEventAlreadyPublished
} from '../lib/pipeline-utils.mjs';

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

console.log(`\n=== NEWS TESTS: ${passed} pasados, ${failed} fallados ===`);
if (failed > 0) process.exit(1);
