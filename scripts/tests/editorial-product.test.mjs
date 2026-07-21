import assert from 'node:assert/strict';
import { displayAuthor, resolveEditorialProcess, validateEditorialProduct } from '../lib/editorial-product.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
    passed++;
  } catch (error) {
    console.error(`  fail ${name}`);
    console.error(`    ${error.message}`);
    failed++;
  }
}

console.log('\n--- Editorial Products ---');

test('una noticia automática usa proceso y firma de redacción', () => {
  const note = { automated: true, contentType: 'noticia', author: 'Actualidad Fueguina' };
  assert.equal(resolveEditorialProcess(note), 'automatico');
  assert.equal(displayAuthor(note), 'Redacción Actualidad Fueguina');
  assert.equal(validateEditorialProduct(note).ok, true);
});

test('un análisis no puede atribuirse al sistema automático', () => {
  const result = validateEditorialProduct({
    automated: true,
    contentType: 'analisis',
    editorialProcess: 'automatico',
    author: 'Actualidad Fueguina'
  });
  assert.equal(result.ok, false);
  assert(result.errors.includes('automated-content-cannot-claim-original-format'));
});

test('una nota original exige una persona identificada', () => {
  const generic = validateEditorialProduct({ contentType: 'opinion', editorialProcess: 'original', author: 'Redacción' });
  const signed = validateEditorialProduct({ contentType: 'opinion', editorialProcess: 'original', author: 'Javier Rodrigo Hidalgo' });
  assert.equal(generic.ok, false);
  assert.equal(signed.ok, true);
});

test('Claves AF exige puntos clave y una consecuencia respaldada', () => {
  assert.equal(validateEditorialProduct({ contentType: 'claves-af', editorialProcess: 'revisado' }).ok, false);
  assert.equal(validateEditorialProduct({
    contentType: 'claves-af',
    editorialProcess: 'revisado',
    keyPoints: ['Dato confirmado', 'Plazo informado'],
    whyItMatters: 'La medida alcanza a usuarios del servicio en Río Grande.'
  }).ok, true);
});

test('el contenido patrocinado exige anunciante y aviso, y no sale automático', () => {
  const incomplete = validateEditorialProduct({ contentType: 'patrocinado', editorialProcess: 'revisado' });
  const complete = validateEditorialProduct({
    contentType: 'patrocinado',
    editorialProcess: 'revisado',
    automated: false,
    sponsorName: 'Comercio anunciante',
    disclosure: 'Contenido comercial producido para el anunciante.'
  });
  assert.equal(incomplete.ok, false);
  assert.equal(complete.ok, true);
});

console.log(`\n=== EDITORIAL PRODUCT TESTS: ${passed} pasados, ${failed} fallados ===`);
if (failed) process.exit(1);
