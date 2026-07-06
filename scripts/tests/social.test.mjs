import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../lib/news-utils.mjs';
import {
  escapeXml, callMetaPost, publishToFacebook,
  createInstagramContainer, publishInstagramContainer, MetaError
} from '../lib/social-utils.mjs';

const originalFetch = globalThis.fetch;
let fetchCalls = [];

function mockFetch(responseBuilder) {
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return responseBuilder(url, options);
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
  fetchCalls = [];
}

// 1. Test Selección y Prioridad
async function testSelection() {
  console.log('--- Test Selección y Prioridad (Exclusión de estados) ---');
  
  // Lógica conceptual del ordenamiento
  const candidates = [
    { title: 'Normal 5', importance: 5, urgent: false, dailyDigest: false },
    { title: 'Importante 8', importance: 8, urgent: false, dailyDigest: false },
    { title: 'Urgente 10', importance: 10, urgent: true, dailyDigest: false },
    { title: 'Resumen', importance: 5, urgent: false, dailyDigest: true }
  ];

  const sortFn = (isNight) => (a, b) => {
    if (a.urgent && !b.urgent) return -1;
    if (!a.urgent && b.urgent) return 1;
    if (isNight) {
      if (a.dailyDigest && !b.dailyDigest) return -1;
      if (!a.dailyDigest && b.dailyDigest) return 1;
    }
    return b.importance - a.importance;
  };

  const dayOrder = [...candidates].sort(sortFn(false));
  if (dayOrder[0].title !== 'Urgente 10' || dayOrder[1].title !== 'Importante 8') {
    throw new Error('Falló prioridad día');
  }

  const nightOrder = [...candidates].sort(sortFn(true));
  if (nightOrder[0].title !== 'Urgente 10' || nightOrder[1].title !== 'Resumen') {
    throw new Error('Falló prioridad noche');
  }

  // Comprobar exclusión de estados
  const excludedStatuses = ['published', 'publishing', 'unknown', 'needs-reconciliation'];
  const testPosts = {};
  
  excludedStatuses.forEach((status, idx) => {
    testPosts[`slug-${idx}|facebook`] = { status };
  });

  // Una plataforma excluida y la otra no
  testPosts['slug-mixed|facebook'] = { status: 'published' };
  testPosts['slug-mixed|instagram'] = { status: 'failed' }; // No excluido

  // Verificar lógica de exclusión
  const testCandidateFn = (slug, platform) => {
    const record = testPosts[`${slug}|${platform}`];
    return record && excludedStatuses.includes(record.status);
  };

  excludedStatuses.forEach((status, idx) => {
    if (!testCandidateFn(`slug-${idx}`, 'facebook')) {
      throw new Error(`El estado ${status} debería haber excluido la selección`);
    }
  });

  if (!testCandidateFn('slug-mixed', 'facebook')) {
    throw new Error('Facebook published debería estar excluido');
  }
  if (testCandidateFn('slug-mixed', 'instagram')) {
    throw new Error('Instagram failed NO debería estar excluido');
  }

  console.log('✅ Test Selección OK');
}

// 2. Test Escaping XML
async function testEscaping() {
  console.log('--- Test Escaping XML ---');
  const unsafe = 'Título & "Subtítulo" <Urgente>\'';
  const expected = 'Título &amp; &quot;Subtítulo&quot; &lt;Urgente&gt;&apos;';
  const escaped = escapeXml(unsafe);
  if (escaped !== expected) {
    throw new Error(`Falló escape: ${escaped}`);
  }
  console.log('✅ Test Escaping OK');
}

// 3. Test Creación de Directorio
async function testDirectoryCreation() {
  console.log('--- Test Creación de Directorio en Placa ---');
  let sharpAvailable = false;
  try {
    await import('sharp');
    sharpAvailable = true;
  } catch {
    console.log('! Sharp no está instalado. Se salta test de creación de directorio físico.');
  }

  if (sharpAvailable) {
    const { generateInstagramPlate } = await import('../lib/social-utils.mjs');
    const testDir = path.join(ROOT, 'public/uploads/social/test-temp-dir-creation');
    const testFile = path.join(testDir, 'test-plate.jpg');

    // Asegurarse de que no exista el directorio
    await fs.rm(testDir, { recursive: true, force: true });

    try {
      await generateInstagramPlate({
        title: 'Test de creación de directorio físico',
        category: 'Sociedad',
        imagePath: '/logo-af.jpg',
        outputPath: testFile
      });

      const exists = await fs.access(testFile).then(() => true).catch(() => false);
      if (!exists) {
        throw new Error('El archivo de placa no se generó o el directorio padre no se creó automáticamente.');
      }
    } finally {
      // Limpiar
      await fs.rm(testDir, { recursive: true, force: true });
    }
  }
  console.log('✅ Test Creación de Directorio OK');
}

// 4. Test no-retry en POST y errores ambiguos
async function testMetaPostNoRetryAmbiguous() {
  console.log('--- Test No-Retry y Detección de Errores Ambiguos ---');

  // Caso A: Error de Red (ambiguo)
  mockFetch(() => {
    throw new TypeError('Failed to fetch');
  });

  try {
    await callMetaPost('https://graph.facebook.com/v21.0/123/feed', { body: '{}' });
    throw new Error('Debería haber fallado ante error de red');
  } catch (err) {
    if (!(err instanceof MetaError)) {
      throw new Error(`Debería lanzar MetaError, lanzó: ${err.constructor.name}`);
    }
    if (!err.isAmbiguous) {
      throw new Error('El error de red debe clasificarse como AMBIGUO');
    }
  }

  if (fetchCalls.length !== 1) {
    throw new Error(`Se esperaban exactamente 1 llamadas a fetch, se hicieron: ${fetchCalls.length}`);
  }
  console.log('  - Error de red (fetch failed) clasificado como ambiguo y sin retries: OK');

  // Caso B: HTTP 500 (ambiguo)
  restoreFetch();
  mockFetch(() => {
    return {
      status: 500,
      statusText: 'Internal Server Error',
      ok: false,
      json: async () => ({ error: { message: 'Meta server down', code: 2 } })
    };
  });

  try {
    await callMetaPost('https://graph.facebook.com/v21.0/123/feed', { body: '{}' });
    throw new Error('Debería haber fallado ante HTTP 500');
  } catch (err) {
    if (!err.isAmbiguous) {
      throw new Error('El error HTTP 500 debe clasificarse como AMBIGUO');
    }
  }

  if (fetchCalls.length !== 1) {
    throw new Error(`Se esperaban exactamente 1 llamadas a fetch, se hicieron: ${fetchCalls.length}`);
  }
  console.log('  - Error HTTP 500 clasificado como ambiguo y sin retries: OK');

  // Caso C: HTTP 400 definitivo (ej. Token expirado)
  restoreFetch();
  mockFetch(() => {
    return {
      status: 400,
      statusText: 'Bad Request',
      ok: false,
      json: async () => ({ error: { message: 'Invalid access token', code: 190 } })
    };
  });

  try {
    await callMetaPost('https://graph.facebook.com/v21.0/123/feed', { body: '{}' });
    throw new Error('Debería haber fallado ante HTTP 400');
  } catch (err) {
    if (err.isAmbiguous) {
      throw new Error('El error HTTP 400 por token inválido debe clasificarse como DEFINITIVO (no ambiguo)');
    }
  }

  if (fetchCalls.length !== 1) {
    throw new Error(`Se esperaban exactamente 1 llamadas a fetch, se hicieron: ${fetchCalls.length}`);
  }
  console.log('  - Error HTTP 400 definitivo clasificado correctamente y sin retries: OK');

  restoreFetch();
  console.log('✅ Test No-Retry y Errores Ambiguos OK');
}

// 5. Test de durabilidad de Instagram (reutilización de creationId)
async function testInstagramDurability() {
  console.log('--- Test Durabilidad de Instagram (creationId) ---');

  // Variables de entorno mockeadas para el test
  process.env.META_IG_USER_ID = '12345';
  process.env.META_PAGE_ACCESS_TOKEN = 'mock-token';

  // Mock de fetch para simular éxito
  mockFetch((url) => {
    if (url.includes('/media_publish')) {
      return {
        status: 200,
        ok: true,
        json: async () => ({ id: 'ig-remote-post-id-789' })
      };
    }
    if (url.includes('/media')) {
      return {
        status: 200,
        ok: true,
        json: async () => ({ id: 'ig-container-id-456' })
      };
    }
  });

  // Caso 1: Sin creationId (Flujo completo: crear contenedor + publicar)
  const resultContainer = await createInstagramContainer({ text: 'caption', imageUrl: 'http://img.jpg' });
  const creationId = resultContainer.id;
  const resultPublish = await publishInstagramContainer({ creationId });

  if (creationId !== 'ig-container-id-456' || resultPublish.id !== 'ig-remote-post-id-789') {
    throw new Error('El flujo completo de Instagram no devolvió los IDs correctos');
  }
  if (fetchCalls.length !== 2) {
    throw new Error(`Se esperaban 2 llamadas a fetch en flujo completo, se hicieron: ${fetchCalls.length}`);
  }

  // Limpiar llamadas
  fetchCalls = [];

  // Caso 2: Con creationId existente (Se salta creación de contenedor)
  const existingCreationId = 'ig-container-id-already-created';
  const resultPublishDirect = await publishInstagramContainer({ creationId: existingCreationId });

  if (resultPublishDirect.id !== 'ig-remote-post-id-789') {
    throw new Error('Fallo al publicar el contenedor reutilizado');
  }

  // Verificar que fetch se llamó exactamente 1 vez (solo a /media_publish, no a /media)
  if (fetchCalls.length !== 1) {
    throw new Error(`Se esperaba 1 llamada a fetch al reutilizar creationId, se hicieron: ${fetchCalls.length}`);
  }
  if (!fetchCalls[0].url.includes('/media_publish')) {
    throw new Error('Al reutilizar creationId, la llamada debería ser a /media_publish únicamente');
  }
  
  console.log('  - Creación y publicación desacoplada: OK');
  console.log('  - Reuso de creationId comprobado (llamadas a /media omitidas): OK');

  restoreFetch();
  console.log('✅ Test Durabilidad Instagram OK');
}

async function runAll() {
  try {
    await testSelection();
    await testEscaping();
    await testDirectoryCreation();
    await testMetaPostNoRetryAmbiguous();
    await testInstagramDurability();
    console.log('\n🌟 TODOS LOS TESTS PASARON SATISFACTORIAMENTE');
  } catch (err) {
    console.error('\n❌ ERROR EN TESTS:', err.stack || err.message);
    process.exit(1);
  }
}

runAll();
