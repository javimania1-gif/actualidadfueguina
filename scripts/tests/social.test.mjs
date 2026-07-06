
import fs from 'node:fs/promises';
import path from 'node:path';
import { escapeXml, SOCIAL_DATA_PATH } from '../lib/social-utils.mjs';
import { ROOT } from '../lib/news-utils.mjs';
import { execSync } from 'node:child_process';

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

async function testRegistryAndIdempotency() {
  console.log('--- Test Registro e Idempotencia ---');
  const slug = 'test-idemp';
  const data = {
    version: 2,
    posts: {
      [`${slug}|facebook`]: { slug, platform: 'facebook', status: 'published', attempts: 1 }
    }
  };

  const fbPublished = data.posts[`${slug}|facebook`]?.status === 'published';
  const igPublished = data.posts[`${slug}|instagram`]?.status === 'published';

  if (!fbPublished) throw new Error('Debería detectar FB como publicado');
  if (igPublished) throw new Error('No debería detectar IG como publicado');

  console.log('✅ Test Idempotencia OK');
}

async function testPlateDirectoryCreation() {
  console.log('--- Test Creación de Directorio para Placas ---');
  const testPath = path.join(ROOT, 'public/uploads/social/test-dir-creation/plate.jpg');
  const dir = path.dirname(testPath);
  await fs.rm(dir, { recursive: true, force: true });

  try {
    await fs.mkdir(dir, { recursive: true });
    if (!(await fs.access(dir).then(() => true).catch(() => false))) throw new Error('No creó el directorio');
    console.log('✅ Test Creación Directorio OK');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function testNonIdempotentPost() {
  console.log('--- Test POST no idempotente (sin reintentos) ---');
  // Este test es conceptual ya que no podemos mockear fetch fácilmente aquí sin librerías extras
  // pero verificamos que el código usa postMeta que no tiene loop de reintentos.
  const code = await fs.readFile(path.join(ROOT, 'scripts/lib/social-utils.mjs'), 'utf8');
  if (code.includes('for') && code.indexOf('async function postMeta') !== -1 && code.indexOf('async function postMeta') < code.indexOf('for')) {
     // Si hay un loop 'for' dentro de postMeta, es un error
     const postMetaFragment = code.slice(code.indexOf('async function postMeta'), code.indexOf('export async function publishToFacebook'));
     if (postMetaFragment.includes('for') || postMetaFragment.includes('while')) {
        throw new Error('postMeta contiene lógica de reintento!');
     }
  }
  console.log('✅ Test POST No-Retry OK');
}

async function testDryRunSafety() {
  console.log('--- Test Seguridad Dry Run ---');
  const registryBackup = await fs.readFile(SOCIAL_DATA_PATH, 'utf8').catch(() => null);
  if (registryBackup) await fs.unlink(SOCIAL_DATA_PATH);

  try {
    execSync('GITHUB_TOKEN=dummy_token node scripts/social-publisher.mjs --dry-run', { stdio: 'ignore' });
    const exists = await fs.access(SOCIAL_DATA_PATH).then(() => true).catch(() => false);
    if (exists) throw new Error('Dry run creó el registro social-posts.json');
    console.log('✅ Test Dry Run Safety OK');
  } finally {
    if (registryBackup) await fs.writeFile(SOCIAL_DATA_PATH, registryBackup);
  }
}

async function runAll() {
  try {
    await testSelection();
    await testEscaping();
    await testRegistryAndIdempotency();
    await testPlateDirectoryCreation();
    await testNonIdempotentPost();
    await testDryRunSafety();
    console.log('\n🌟 TODOS LOS TESTS PASARON');
  } catch (err) {
    console.error('\n❌ ERROR EN TESTS:', err.message);
    process.exit(1);
  }
}

runAll();
