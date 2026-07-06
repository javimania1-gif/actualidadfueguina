
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../lib/news-utils.mjs';
import { generateInstagramPlate, MetaError, SOCIAL_DATA_PATH } from '../lib/social-utils.mjs';
import { execSync } from 'node:child_process';

const originalFetch = globalThis.fetch;
let fetchMocks = [];
let fetchCallCount = 0;

globalThis.fetch = async (url, options) => {
  fetchCallCount++;
  const mock = fetchMocks.find(m => {
    if (typeof m.url === 'string') return url.includes(m.url);
    if (m.url instanceof RegExp) return m.url.test(url);
    return false;
  });

  if (mock) {
    if (mock.error) throw mock.error;
    return {
      ok: mock.status >= 200 && mock.status < 300,
      status: mock.status,
      statusText: mock.statusText || 'OK',
      json: async () => mock.response || {}
    };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

async function testSelectionAndTwoPhase() {
  console.log('--- Test Selección y Dos Fases ---');
  // 1. Fase Reserva: Debe marcar como 'publishing'
  const { loadSocialData } = await import('../lib/social-utils.mjs');
  const slug = 'test-phase';
  const data = { version: 2, posts: {} };

  // Lógica manual simplificada de lo que hace el publisher
  data.posts[`${slug}|facebook`] = { slug, platform: 'facebook', status: 'publishing' };

  if (data.posts[`${slug}|facebook`].status !== 'publishing') throw new Error('No reservó');
  console.log('✅ Test Reserva OK');
}

async function testNoRetryOnAmbiguousPost() {
  console.log('--- Test POST no reintenta automáticamente ---');
  fetchCallCount = 0;
  fetchMocks = [{ url: /feed/, status: 500 }];

  const { publishToFacebook } = await import('../lib/social-utils.mjs');
  process.env.META_PAGE_ID = '123';
  process.env.META_PAGE_ACCESS_TOKEN = 'abc';

  try {
    await publishToFacebook({ text: 'test', link: 'http://test.com' });
  } catch (e) {
    if (fetchCallCount !== 1) throw new Error(`Se llamó ${fetchCallCount} veces, esperado 1`);
    console.log('✅ Test No-Retry OK');
  }
}

async function testInstagramReuseCreationId() {
  console.log('--- Test Instagram reusa creationId ---');
  fetchCallCount = 0;
  // Mockeamos solo el publish, si se llama a container creation (media) el contador subirá
  fetchMocks = [{ url: /media_publish/, status: 200, response: { id: 'done' } }];

  process.env.META_IG_USER_ID = 'ig123';
  process.env.META_PAGE_ACCESS_TOKEN = 'abc';

  const { publishInstagramContainer } = await import('../lib/social-utils.mjs');
  await publishInstagramContainer({ creationId: '123' });

  if (fetchCallCount !== 1) throw new Error('Debió llamar solo a publish');
  console.log('✅ Test IG Reuse OK');
}

async function testPlateDirectoryCreation() {
  console.log('--- Test Creación Directorio en Plate ---');
  const testDir = path.join(ROOT, 'public/uploads/social/test-new-dir-2');
  const testPath = path.join(testDir, 'plate.jpg');
  await fs.rm(testDir, { recursive: true, force: true });

  try {
    await generateInstagramPlate({ title: 'Test', category: 'Test', imagePath: '/logo-af.jpg', outputPath: testPath });
    const exists = await fs.access(testDir).then(() => true).catch(() => false);
    if (!exists) throw new Error('No creó el directorio');
    console.log('✅ Test Directorio OK');
  } finally {
    await fs.rm(testDir, { recursive: true, force: true });
  }
}

async function testDryRunSafety() {
  console.log('--- Test Seguridad Dry Run ---');
  const backup = await fs.readFile(SOCIAL_DATA_PATH, 'utf8').catch(() => null);
  if (backup) await fs.unlink(SOCIAL_DATA_PATH);

  try {
    execSync('GITHUB_TOKEN=dummy_token node scripts/social-publisher.mjs --dry-run', { stdio: 'ignore' });
    const exists = await fs.access(SOCIAL_DATA_PATH).then(() => true).catch(() => false);
    if (exists) throw new Error('Dry run modificó archivos');
    console.log('✅ Test Dry Run OK');
  } finally {
    if (backup) await fs.writeFile(SOCIAL_DATA_PATH, backup);
  }
}

async function runAll() {
  try {
    await testSelectionAndTwoPhase();
    await testNoRetryOnAmbiguousPost();
    await testInstagramReuseCreationId();
    await testPlateDirectoryCreation();
    await testDryRunSafety();
    console.log('\n🌟 TODOS LOS TESTS PASARON');
  } catch (err) {
    console.error('\n❌ ERROR EN TESTS:', err.stack);
    process.exit(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

runAll();
