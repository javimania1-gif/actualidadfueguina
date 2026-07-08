import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ROOT, normalizeImageBuffer, normalizeImageAsset } from '../lib/news-utils.mjs';

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

globalThis.fetch = originalFetch;
await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

console.log(`\n=== IMAGE TESTS: ${passed} pasados, ${failed} fallados ===`);
if (failed > 0) process.exit(1);
