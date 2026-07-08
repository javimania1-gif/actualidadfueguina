import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ROOT, normalizeImageBuffer, normalizeImageAsset } from '../lib/news-utils.mjs';
import { buildImagePlan, scoreMediaAsset, evaluateImageContext } from '../lib/image-plan.mjs';

let passed = 0;
let failed = 0;
const tmpDir = path.join(ROOT, 'scratch/test-images');
const originalFetch = globalThis.fetch;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ok ${name}`);
      passed++;
    })
    .catch((err) => {
      console.error(`  fail ${name}`);
      console.error(`    ${err.message}`);
      failed++;
    });
}

console.log('\n--- Image Normalization ---');
await fs.rm(tmpDir, { recursive: true, force: true });
await fs.mkdir(tmpDir, { recursive: true });

await test('404 remoto falla sin archivo', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  const result = await normalizeImageAsset('https://example.com/missing.jpg', { outputDir: tmpDir });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'http-404');
});

await test('HTML servido como imagen se rechaza', async () => {
  const result = await normalizeImageBuffer({
    buffer: Buffer.from('<html></html>'),
    contentType: 'text/html',
    seed: 'html',
    outputDir: tmpDir
  });
  assert.equal(result.ok, false);
});

await test('JPEG valido se convierte a WebP local', async () => {
  const input = await sharp({ create: { width: 800, height: 450, channels: 3, background: '#204060' } }).jpeg().toBuffer();
  const result = await normalizeImageBuffer({
    buffer: input,
    contentType: 'image/jpeg',
    seed: 'jpg',
    outputDir: tmpDir
  });
  assert.equal(result.ok, true);
  assert.equal(result.format, 'webp');
  await fs.access(result.filePath);
});

await test('WebP valido se normaliza', async () => {
  const input = await sharp({ create: { width: 800, height: 450, channels: 3, background: '#406020' } }).webp().toBuffer();
  const result = await normalizeImageBuffer({
    buffer: input,
    contentType: 'image/webp',
    seed: 'webp',
    outputDir: tmpDir
  });
  assert.equal(result.ok, true);
});

await test('SVG se rasteriza para Meta como JPEG', async () => {
  const svg = Buffer.from('<svg width="800" height="450" xmlns="http://www.w3.org/2000/svg"><rect width="800" height="450" fill="#123456"/></svg>');
  const result = await normalizeImageBuffer({
    buffer: svg,
    contentType: 'image/svg+xml',
    seed: 'svg',
    purpose: 'meta',
    outputDir: tmpDir
  });
  assert.equal(result.ok, true);
  assert.equal(result.format, 'jpeg');
  assert(result.publicPath.endsWith('.jpg'));
});

await test('imagen demasiado chica se rechaza', async () => {
  const input = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#000000' } }).jpeg().toBuffer();
  const result = await normalizeImageBuffer({
    buffer: input,
    contentType: 'image/jpeg',
    seed: 'small',
    outputDir: tmpDir
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'image-too-small');
});

await test('bytes corruptos se rechazan', async () => {
  const result = await normalizeImageBuffer({
    buffer: Buffer.from('not a real image'),
    contentType: 'image/jpeg',
    seed: 'corrupt',
    outputDir: tmpDir
  });
  assert.equal(result.ok, false);
  assert(result.reason.startsWith('decode-error'));
});

await test('plan semantico prioriza entidad principal Melella', async () => {
  const plan = buildImagePlan({
    title: 'Melella reactiva la reforma constitucional en Tierra del Fuego',
    verifiedFacts: { people: ['Gustavo Melella'], places: ['Tierra del Fuego'] },
    category: 'Provincia'
  });
  assert.equal(plan[0].query, 'Gustavo Melella');
});

await test('score de biblioteca favorece lugar exacto y no categoria generica', async () => {
  const plan = buildImagePlan({
    title: 'Parque Termal Municipal de Tolhuin cierra temporada de invierno',
    verifiedFacts: { places: ['Tolhuin'] },
    category: 'Tolhuin'
  });
  const exact = scoreMediaAsset({
    label: 'Termas de Tolhuin',
    aliases: ['termas de tolhuin', 'parque termal tolhuin'],
    tags: ['tolhuin', 'termas', 'parque termal'],
    priority: 90
  }, plan, 'Parque Termal Municipal de Tolhuin');
  const generic = scoreMediaAsset({
    label: 'Tolhuin',
    aliases: ['tolhuin'],
    tags: ['tolhuin'],
    priority: 20
  }, plan, 'Parque Termal Municipal de Tolhuin');
  assert(exact.score > generic.score);
});

await test('contexto visual rechaza obra para competencia deportiva en Casa del Deporte', async () => {
  const result = evaluateImageContext({
    label: 'Casa del Deporte de Tolhuin',
    contextTags: ['obra', 'construccion', 'cancha en obra'],
    alt: 'Interior de la Casa del Deporte durante trabajos en su cancha'
  }, 'Competencias deportivas en la Casa del Deporte de Tolhuin con partidos de futsal y voley');
  assert.equal(result.ok, false);
  assert(result.reasons.includes('construction-context-for-sports-event'));
});

await test('contexto visual acepta obra si la noticia trata sobre construccion o inauguracion', async () => {
  const result = evaluateImageContext({
    label: 'Casa del Deporte de Tolhuin',
    contextTags: ['obra', 'construccion', 'cancha en obra']
  }, 'Avanza la obra de ampliacion de la Casa del Deporte de Tolhuin');
  assert.equal(result.ok, true);
});

await test('contexto visual rechaza foto de reunion turistica para reforma constitucional', async () => {
  const result = evaluateImageContext({
    label: 'Gustavo Melella',
    contextTags: ['reunion anterior', 'turismo', 'lammens']
  }, 'Melella reactiva la reforma constitucional y convoca elecciones de convencionales constituyentes');
  assert.equal(result.ok, false);
  assert(result.reasons.includes('person-match-but-wrong-political-context'));
});

await test('contexto visual acepta Termas como lugar para capacitacion realizada alli', async () => {
  const result = evaluateImageContext({
    label: 'Termas de Tolhuin',
    contextTags: ['lugar exacto', 'parque termal']
  }, 'Capacitacion para operadores en el Parque Termal de Tolhuin');
  assert.equal(result.ok, true);
});

await test('biblioteca prioriza ONU para nota de descolonizacion de Malvinas', async () => {
  const plan = buildImagePlan({
    title: 'La ONU exige negociar la soberania de las Islas Malvinas',
    verifiedFacts: { organizations: ['ONU'], places: ['Islas Malvinas'] },
    category: 'Malvinas'
  });
  const onu = scoreMediaAsset({
    label: 'Asamblea General de Naciones Unidas',
    aliases: ['onu', 'naciones unidas', 'asamblea general', 'comite de descolonizacion'],
    tags: ['malvinas', 'onu', 'soberania', 'descolonizacion'],
    priority: 88
  }, plan, 'Comite de Descolonizacion de la ONU exige al Reino Unido negociar por Malvinas');
  const generic = scoreMediaAsset({
    label: 'Bandera argentina',
    aliases: ['argentina'],
    tags: ['soberania'],
    priority: 20
  }, plan, 'Comite de Descolonizacion de la ONU exige al Reino Unido negociar por Malvinas');
  assert(onu.score > generic.score);
});

await test('biblioteca prioriza Base Marambio para Antartida Argentina', async () => {
  const plan = buildImagePlan({
    title: 'Argentina presenta un plan de turismo antartico',
    verifiedFacts: { places: ['Antartida Argentina', 'Base Marambio'] },
    category: 'Antartida'
  });
  const marambio = scoreMediaAsset({
    label: 'Base Marambio',
    aliases: ['base marambio', 'antartida argentina'],
    tags: ['antartida', 'antartida argentina', 'turismo antartico'],
    priority: 90
  }, plan, 'Plan nacional de turismo en la Antartida Argentina y bases argentinas');
  const plate = scoreMediaAsset({
    label: 'Placa Antartida',
    aliases: ['antartida'],
    tags: ['antartida'],
    priority: 15
  }, plan, 'Plan nacional de turismo en la Antartida Argentina y bases argentinas');
  assert(marambio.score > plate.score);
});

globalThis.fetch = originalFetch;
await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

console.log(`\n=== IMAGE TESTS: ${passed} pasados, ${failed} fallados ===`);
if (failed > 0) process.exit(1);
