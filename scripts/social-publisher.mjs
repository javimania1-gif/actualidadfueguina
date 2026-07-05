
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

    // Buscar historial determinista
    const fbKey = `${slug}|facebook`;
    const igKey = `${slug}|instagram`;

    const fbRecord = socialData.posts[fbKey];
    const igRecord = socialData.posts[igKey];

    const fbPublished = fbRecord?.status === 'published';
    const igPublished = igRecord?.status === 'published';

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
      fbRecord,
      igRecord
    });
  }

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
      const key = `${item.slug}|facebook`;
      try {
        console.log('- Generando copy Facebook...');
        const fbText = await generateSocialCopy({ ...item, platform: 'facebook' });
        const result = await publishToFacebook({ text: fbText, link: newsUrl, dryRun: DRY_RUN });

        if (!DRY_RUN) {
          socialData.posts[key] = {
            slug: item.slug,
            platform: 'facebook',
            date: new Date().toISOString(),
            status: 'published',
            remoteId: result.id,
            attempts: (item.fbRecord?.attempts || 0) + 1,
            publishedAt: new Date().toISOString()
          };
          console.log('✓ Publicado en Facebook');
        } else {
          console.log('[DRY-RUN] Facebook: ' + fbText.slice(0, 60) + '...');
        }
      } catch (error) {
        console.error(`✗ Error Facebook: ${error.message}`);
        if (!DRY_RUN) {
          socialData.posts[key] = {
            slug: item.slug,
            platform: 'facebook',
            date: new Date().toISOString(),
            status: 'failed',
            lastError: error.message,
            attempts: (item.fbRecord?.attempts || 0) + 1
          };
        }
      }
      await sleep(1000);
    }

    // INSTAGRAM
    if (!item.igPublished && item.importance >= 5) {
      const key = `${item.slug}|instagram`;
      try {
        const plateFilename = `plate-${item.slug}.jpg`;
        const platePath = path.join(ROOT, 'public/uploads/social', plateFilename);

        // Verificar si el asset es accesible públicamente
        let imageUrl = null;

        if (item.image && item.image.startsWith('http')) {
          imageUrl = item.image;
        } else {
          // Intentar placa local
          const plateExists = await fs.access(platePath).then(() => true).catch(() => false);
          if (plateExists) {
            const publicUrl = `${SITE_URL}/uploads/social/${plateFilename}`;
            console.log(`- Verificando disponibilidad de asset: ${publicUrl}`);
            const check = await fetch(publicUrl, { method: 'HEAD' }).catch(() => ({ ok: false }));
            if (check.ok) {
              imageUrl = publicUrl;
            } else {
              console.log('! Asset aún no disponible públicamente en Cloudflare.');
            }
          } else {
            console.log('- Generando placa Instagram...');
            const generated = await generateInstagramPlate({
              title: item.title,
              category: item.category,
              imagePath: item.image,
              outputPath: platePath
            });
            if (generated) {
              console.log('! Placa generada. Estará disponible tras el commit y deploy.');
            }
          }
        }

        if (imageUrl) {
          console.log('- Generando copy Instagram...');
          const igText = await generateSocialCopy({ ...item, platform: 'instagram' });
          const result = await publishToInstagram({ text: igText, imageUrl, dryRun: DRY_RUN });

          if (!DRY_RUN) {
            socialData.posts[key] = {
              slug: item.slug,
              platform: 'instagram',
              date: new Date().toISOString(),
              status: 'published',
              remoteId: result.id,
              attempts: (item.igRecord?.attempts || 0) + 1,
              publishedAt: new Date().toISOString()
            };
            console.log('✓ Publicado en Instagram');
          } else {
            console.log('[DRY-RUN] Instagram: ' + igText.slice(0, 60) + '...');
          }
        } else {
          console.log('! Saltando Instagram: esperando disponibilidad del asset.');
          if (!DRY_RUN && !item.igRecord) {
             socialData.posts[key] = {
               slug: item.slug,
               platform: 'instagram',
               date: new Date().toISOString(),
               status: 'pending-asset',
               attempts: 0
             };
          }
        }
      } catch (error) {
        console.error(`✗ Error Instagram: ${error.message}`);
        if (!DRY_RUN) {
          socialData.posts[key] = {
            slug: item.slug,
            platform: 'instagram',
            date: new Date().toISOString(),
            status: 'failed',
            lastError: error.message,
            attempts: (item.igRecord?.attempts || 0) + 1
          };
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
