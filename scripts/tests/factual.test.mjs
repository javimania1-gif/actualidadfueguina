import assert from 'node:assert/strict';
import { isHomepage } from '../lib/news-utils.mjs';

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

console.log('\n--- Test 6: Verificación de Factualidad ---');

test('isHomepage bloquea la raíz del dominio', () => {
  assert.equal(isHomepage('https://www.infobae.com'), true);
  assert.equal(isHomepage('https://www.infobae.com/'), true);
});

test('isHomepage bloquea rutas genéricas como /home o /noticias', () => {
  assert.equal(isHomepage('https://www.surenio.com.ar/home/'), true);
  assert.equal(isHomepage('https://www.tierradelfuego.gob.ar/noticias'), true);
});

test('isHomepage permite URLs específicas de noticias', () => {
  assert.equal(isHomepage('https://www.infobae.com/politica/2026/07/08/una-noticia-real/'), false);
  assert.equal(isHomepage('https://www.surenio.com.ar/accidente-en-la-ruta-3/'), false);
});

console.log(`\n=== FACTUAL TESTS: ${passed} pasados, ${failed} fallados ===\n`);
if (failed > 0) process.exit(1);
