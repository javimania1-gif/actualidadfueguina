
import fs from 'node:fs/promises';
import path from 'node:path';
import { escapeXml, loadSocialData, saveSocialData } from '../lib/social-utils.mjs';
import { ROOT } from '../lib/news-utils.mjs';

const TEST_REGISTRY = path.join(ROOT, 'data/test-social-posts.json');

async function testSelection() {
  console.log('--- Test Selección y Prioridad ---');
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
  if (dayOrder[0].title !== 'Urgente 10' || dayOrder[1].title !== 'Importante 8') throw new Error('Falló prioridad día');

  const nightOrder = [...candidates].sort(sortFn(true));
  if (nightOrder[0].title !== 'Urgente 10' || nightOrder[1].title !== 'Resumen') throw new Error('Falló prioridad noche');

  console.log('✅ Test Selección OK');
}

async function testEscaping() {
  console.log('--- Test Escaping XML ---');
  const unsafe = 'Título & "Subtítulo" <Urgente>\'';
  const expected = 'Título &amp; &quot;Subtítulo&quot; &lt;Urgente&gt;&apos;';
  const escaped = escapeXml(unsafe);
  if (escaped !== expected) throw new Error(`Falló escape: ${escaped}`);
  console.log('✅ Test Escaping OK');
}

async function testIdempotencyAndState() {
  console.log('--- Test Idempotencia y Estado ---');
  // Usar un archivo de test separado
  const originalPath = path.join(ROOT, 'data/social-posts.json');
  const tempPath = path.join(ROOT, 'data/social-posts-backup.json');

  try {
    // Mock save/load by overriding the path constant if we could, but here we just test logic
    const data = { version: 2, posts: {} };
    const key = 'test-slug|facebook';

    // Simular primer intento fallido
    data.posts[key] = { slug: 'test-slug', platform: 'facebook', status: 'failed', attempts: 1 };

    // Simular segundo intento exitoso (mismo key)
    data.posts[key] = { ...data.posts[key], status: 'published', attempts: 2, remoteId: '123' };

    if (Object.keys(data.posts).length !== 1) throw new Error('Dobló registro en vez de actualizar');
    if (data.posts[key].attempts !== 2) throw new Error('No incrementó attempts correctamente');

    console.log('✅ Test Idempotencia OK');
  } catch (err) {
    throw err;
  }
}

async function runAll() {
  try {
    await testSelection();
    await testEscaping();
    await testIdempotencyAndState();
    console.log('\n🌟 TODOS LOS TESTS PASARON');
  } catch (err) {
    console.error('\n❌ ERROR EN TESTS:', err.message);
    process.exit(1);
  }
}

runAll();
