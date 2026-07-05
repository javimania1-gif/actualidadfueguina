
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { ROOT, NEWS_DIR, sleep } from './lib/news-utils.mjs';
import {
  loadSocialData, saveSocialData, generateSocialCopy,
  generateInstagramPlate, publishToFacebook, publishToInstagram
} from './lib/social-utils.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_POSTS_PER_RUN = 1;
const SITE_URL = 'https://actualidadfueguina.com.ar';

async function main() {
  console.log(`\n=== INICIO PUBLICACIÓN SOCIAL ${DRY_RUN ? '(DRY RUN)' : ''} ===`);

  const socialData = await loadSocialData();
  const files = (await fs.readdir(NEWS_DIR)).filter(f => f.endsWith('.md'));

  const candidates = [];

  for (const file of files) {
    const fullPath = path.join(NEWS_DIR, file);
    const content = await fs.readFile(fullPath, 'utf8');
    const { data, content: body } = matter(content);
    const slug = file.replace('.md', '');

    if (data.social?.enabled === false) continue;

    // Buscar historial de esta noticia
    const history = socialData.posts.filter(p => p.slug === slug);
    const fbPublished = history.some(p => p.platform === 'facebook' && p.status === 'published');
    const igPublished = history.some(p => p.platform === 'instagram' && p.status === 'published');

    if (fbPublished && igPublished) continue;

    candidates.push({
      slug,
      file,
      title: data.title,
      description: data.description,
      category: data.category,
      location: data.location,
      tags: data.tags || [],
      importance: data.importance || 5,
      urgent: data.social?.urgent || false,
      dailyDigest: !!data.dailyDigest,
      image: data.image,
      body,
      fbPublished,
      igPublished,
      history
    });
  }

  // Lógica de franja horaria para Tierra del Fuego
  const hourTDF = new Date(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Ushuaia',
    hour: 'numeric',
    hour12: false
  }).format(new Date())).getHours();

  const isNight = hourTDF >= 20 || hourTDF < 6;

  candidates.sort((a, b) => {
    if (a.urgent && !b.urgent) return -1;
    if (!a.urgent && b.urgent) return 1;
    if (isNight) {
      if (a.dailyDigest && !b.dailyDigest) return -1;
      if (!a.dailyDigest && b.dailyDigest) return 1;
    }
    return b.importance - a.importance;
  });

  const toProcess = candidates.slice(0, MAX_POSTS_PER_RUN);
  console.log(`Candidatos: ${candidates.length}. Procesando: ${toProcess.length}`);

  for (const item of toProcess) {
    console.log(`\nProcesando: ${item.title} (Imp: ${item.importance}${item.urgent ? ', URGENTE' : ''})`);
    const newsUrl = `${SITE_URL}/noticias/${item.slug}/`;

    // FACEBOOK
    if (!item.fbPublished) {
      try {
        console.log('- Generando copy Facebook...');
        const fbText = await generateSocialCopy({ ...item, platform: 'facebook' });
        const result = await publishToFacebook({ text: fbText, link: newsUrl, dryRun: DRY_RUN });

        if (!DRY_RUN) {
          socialData.posts.push({
            slug: item.slug,
            platform: 'facebook',
            date: new Date().toISOString(),
            status: 'published',
            remoteId: result.id,
            attempts: 1
          });
          console.log('✓ Publicado en Facebook');
        } else {
          console.log('[DRY-RUN] Facebook: ' + fbText.slice(0, 60) + '...');
        }
      } catch (error) {
        console.error(`✗ Error Facebook: ${error.message}`);
        if (!DRY_RUN) {
          socialData.posts.push({
            slug: item.slug,
            platform: 'facebook',
            date: new Date().toISOString(),
            status: 'failed',
            lastError: error.message,
            attempts: (item.history.find(h => h.platform === 'facebook')?.attempts || 0) + 1
          });
        }
      }
      await sleep(1000);
    }

    // INSTAGRAM
    if (!item.igPublished && item.importance >= 5) {
      try {
        const plateFilename = `plate-${item.slug}.jpg`;
        const platePath = path.join(ROOT, 'public/uploads/social', plateFilename);
        const plateExists = await fs.access(platePath).then(() => true).catch(() => false);

        let imageUrl = null;
        if (plateExists) {
          imageUrl = `${SITE_URL}/uploads/social/${plateFilename}`;
        } else {
          console.log('- Generando placa Instagram...');
          const generated = await generateInstagramPlate({
            title: item.title,
            category: item.category,
            imagePath: item.image,
            outputPath: platePath
          });

          if (generated && !DRY_RUN) {
             console.log('! Placa generada. Se publicará en el siguiente run tras el commit.');
          } else if (generated && DRY_RUN) {
             console.log('[DRY-RUN] Placa generada (no guardada persistentemente)');
             await fs.unlink(platePath).catch(() => {});
          }

          if (item.image && item.image.startsWith('http')) {
            imageUrl = item.image;
          }
        }

        if (imageUrl) {
          console.log('- Generando copy Instagram...');
          const igText = await generateSocialCopy({ ...item, platform: 'instagram' });
          const result = await publishToInstagram({ text: igText, imageUrl, dryRun: DRY_RUN });

          if (!DRY_RUN) {
            socialData.posts.push({
              slug: item.slug,
              platform: 'instagram',
              date: new Date().toISOString(),
              status: 'published',
              remoteId: result.id,
              attempts: 1
            });
            console.log('✓ Publicado en Instagram');
          } else {
            console.log('[DRY-RUN] Instagram: ' + igText.slice(0, 60) + '...');
          }
        } else {
          console.log('! Saltando Instagram: falta asset público (esperando placa o imagen remota).');
        }
      } catch (error) {
        console.error(`✗ Error Instagram: ${error.message}`);
        if (!DRY_RUN) {
          socialData.posts.push({
            slug: item.slug,
            platform: 'instagram',
            date: new Date().toISOString(),
            status: 'failed',
            lastError: error.message,
            attempts: (item.history.find(h => h.platform === 'instagram')?.attempts || 0) + 1
          });
        }
      }
      await sleep(1000);
    }
  }

  if (!DRY_RUN) {
    await saveSocialData(socialData);
  } else {
    console.log('\n[DRY-RUN] No se guardaron cambios en el registro.');
  }
  console.log('\n=== FIN PROCESO SOCIAL ===');
}

main().catch(console.error);
