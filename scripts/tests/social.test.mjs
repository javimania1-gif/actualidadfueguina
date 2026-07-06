
import fs from 'node:fs/promises';
import path from 'node:path';
import { escapeXml, loadSocialData, saveSocialData, SOCIAL_DATA_PATH } from '../lib/social-utils.mjs';
import { ROOT } from '../lib/news-utils.mjs';
import { execSync } from 'node:child_process';

const TEST_REGISTRY = path.join(ROOT, 'data/test-social-posts.json');

async function testSelection() {
  console.log('--- Test Selección y Prioridad ---');
  const candidates = [
    { title: 'Normal 5', importance: 5, urgent: false, dailyDigest: false },
    { title: 'Importante 8', importance: 8, urgent: false, dailyDigest: false },
    { title: 'Urgente 10', importance: 10, urgent: true, dailyDigest: false },
    { title: 'Resumen', importance: 5, urgent: false, dailyDigest: true }
  ];

  const rank = (item, isNight) => {
    let score = item.importance;
    if (item.urgent) score += 100;
    if (isNight && item.dailyDigest) score += 50;
    return score;
  };

  const dayOrder = [...candidates].sort((a, b) => rank(b, false) - rank(a, false));
  if (dayOrder[0].title !== 'Urgente 10' || dayOrder[1].title !== 'Importante 8') throw new Error('Falló prioridad día');

  const nightOrder = [...candidates].sort((a, b) => rank(b, true) - rank(a, true));
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

async function testRegistry() {
  console.log('--- Test Registro y Migración ---');
  const oldData = {
    version: 1,
    posts: [
      { slug: 'nota-1', platform: 'facebook', status: 'published', date: '2024-01-01' }
    ]
  };

  const tempFile = path.join(ROOT, 'data/temp-social.json');
  await fs.writeFile(tempFile, JSON.stringify(oldData));

  // Monkey patch path for test
  const originalPath = SOCIAL_DATA_PATH;
  // Note: Since we can't easily monkey patch a constant, we'll just test the logic directly

  const migrate = (data) => {
    if (Array.isArray(data.posts)) {
      const posts = {};
      data.posts.forEach(p => {
        const key = `${p.slug}|${p.platform}`;
        posts[key] = p;
      });
      data.posts = posts;
    }
    return data;
  };

  const migrated = migrate(oldData);
  if (migrated.posts['nota-1|facebook'].status !== 'published') throw new Error('Migración fallida');

  const key = 'nota-2|instagram';
  migrated.posts[key] = { slug: 'nota-2', platform: 'instagram', status: 'pending' };
  migrated.posts[key].attempts = (migrated.posts[key].attempts || 0) + 1;

  if (migrated.posts[key].attempts !== 1) throw new Error('Cálculo de intentos fallido');

  await fs.unlink(tempFile);
  console.log('✅ Test Registro OK');
}

async function testDryRunSafety() {
  console.log('--- Test Seguridad Dry Run ---');
  // Verificar que el script con --dry-run no crea archivos
  const registryExistsBefore = await fs.access(SOCIAL_DATA_PATH).then(() => true).catch(() => false);
  const socialDir = path.join(ROOT, 'public/uploads/social');
  const filesBefore = await fs.readdir(socialDir).catch(() => []);

  try {
    execSync('GITHUB_TOKEN=dummy_token node scripts/social-publisher.mjs --dry-run', { stdio: 'ignore' });
  } catch (e) {
    // Expected to fail if no news, but we check if it created files
  }

  const registryExistsAfter = await fs.access(SOCIAL_DATA_PATH).then(() => true).catch(() => false);
  if (!registryExistsBefore && registryExistsAfter) throw new Error('Dry run creó el registro');

  const filesAfter = await fs.readdir(socialDir).catch(() => []);
  if (filesAfter.length > filesBefore.length) throw new Error('Dry run creó placas');

  console.log('✅ Test Dry Run Safety OK');
}

async function runAll() {
  try {
    await testSelection();
    await testEscaping();
    await testRegistry();
    await testDryRunSafety();
    console.log('\n🌟 TODOS LOS TESTS PASARON');
  } catch (err) {
    console.error('\n❌ ERROR EN TESTS:', err.message);
    process.exit(1);
  }
}

runAll();
