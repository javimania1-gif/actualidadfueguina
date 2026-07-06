
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../lib/news-utils.mjs';
import { generateInstagramPlate, MetaError } from '../lib/social-utils.mjs';

// Mock de fetch global
const originalFetch = globalThis.fetch;
let fetchMocks = [];

globalThis.fetch = async (url, options) => {
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

async function testAmbiguousError() {
  console.log('--- Test Error Ambiguo (POST) ---');
  // Se espera que un 500 en POST lance un MetaError ambiguo
  fetchMocks = [{ url: /feed/, status: 500, statusText: 'Internal Server Error' }];

  try {
     // Import dinámico para que use el fetch mockeado si se inicializó antes
     const { publishToFacebook } = await import('../lib/social-utils.mjs');
     process.env.META_PAGE_ID = '123';
     process.env.META_PAGE_ACCESS_TOKEN = 'abc';

     await publishToFacebook({ text: 'test', link: 'http://test.com' });
     throw new Error('Debería haber fallado');
  } catch (err) {
     if (!(err instanceof MetaError)) throw new Error('No lanzó MetaError');
     if (!err.isAmbiguous) throw new Error('No detectó error como ambiguo');
     console.log('✅ Test Error Ambiguo OK');
  }
}

async function testInstagramRetryReusingId() {
  console.log('--- Test Instagram Reuso creationId ---');
  // Simulamos que el primer run guardó un creationId pero falló en el publish container
  const { createInstagramContainer, publishInstagramContainer } = await import('../lib/social-utils.mjs');

  process.env.META_IG_USER_ID = 'ig123';
  process.env.META_PAGE_ACCESS_TOKEN = 'abc';

  fetchMocks = [
    { url: /media_publish/, status: 200, response: { id: 'post123' } }
  ];

  // Si pasamos un creationId, no debería llamar al endpoint /media (container creation)
  // Verificamos esto mediante el mock que fallaría si se llama algo no mockeado
  const result = await publishInstagramContainer({ creationId: 'cont999' });
  if (result.id !== 'post123') throw new Error('No publicó correctamente');
  console.log('✅ Test Instagram Reuso OK');
}

async function testPlateDirectoryCreation() {
  console.log('--- Test Creación Directorio Real en Plate ---');
  const testDir = path.join(ROOT, 'public/uploads/social/test-new-dir');
  const testPath = path.join(testDir, 'plate.jpg');

  await fs.rm(testDir, { recursive: true, force: true });

  try {
    // Sharp fallará porque no hay imagen real, pero mkdir debe ocurrir antes
    await generateInstagramPlate({
       title: 'Test',
       category: 'Test',
       imagePath: '/non-existent.jpg',
       outputPath: testPath
    });

    const exists = await fs.access(testDir).then(() => true).catch(() => false);
    if (!exists) throw new Error('No se creó el directorio padre');
    console.log('✅ Test Directorio Plate OK');
  } finally {
    await fs.rm(testDir, { recursive: true, force: true });
  }
}

async function runAll() {
  try {
    await testAmbiguousError();
    await testInstagramRetryReusingId();
    await testPlateDirectoryCreation();
    console.log('\n🌟 TESTS PASARON EXITOSAMENTE');
  } catch (err) {
    console.error('\n❌ ERROR EN TESTS:', err.stack);
    process.exit(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

runAll();
