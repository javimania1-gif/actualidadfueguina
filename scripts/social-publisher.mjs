
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { ROOT, NEWS_DIR, sleep } from './lib/news-utils.mjs';
import {
  loadSocialData, saveSocialData, generateSocialCopy,
  generateInstagramPlate, publishToFacebook, publishToInstagram
} from './lib/social-utils.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_POSTS_PER_RUN = 1; // 4 veces al día * 1 post = 4 posts max
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

    // Saltamos si no está habilitado socialmente
    if (data.social?.enabled === false) continue;

    // Verificamos si ya se publicó en FB e IG
    const fbPost = socialData.posts.find(p => p.slug === slug && p.platform === 'facebook' && p.status === 'published');
    const igPost = socialData.posts.find(p => p.slug === slug && p.platform === 'instagram' && p.status === 'published');

    if (fbPost && igPost) continue;

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
      fbPublished: !!fbPost,
      igPublished: !!igPost
    });
  }

  // Hora local Tierra del Fuego
  const hourTDF = new Date(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Ushuaia',
    hour: 'numeric',
    hour12: false
  }).format(new Date())).getHours();

  const isNight = hourTDF >= 20 || hourTDF < 6;

  // Prioridad: Urgentes primero, luego resúmenes si es de noche, luego por importancia descendente
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
  console.log(`Candidatos encontrados: ${candidates.length}. Procesando: ${toProcess.length}`);

  for (const item of toProcess) {
    console.log(`\nProcesando: ${item.title} (Imp: ${item.importance}${item.urgent ? ', URGENTE' : ''})`);
    const newsUrl = `${SITE_URL}/noticias/${item.slug}/`;

    // FACEBOOK
    if (!item.fbPublished) {
      try {
        console.log('- Generando copy Facebook...');
        const fbText = await generateSocialCopy({ ...item, platform: 'facebook' });

        console.log('- Enviando a Facebook...');
        const result = await publishToFacebook({ text: fbText, link: newsUrl, dryRun: DRY_RUN });

        if (!DRY_RUN) {
          socialData.posts.push({
            slug: item.slug,
            platform: 'facebook',
            date: new Date().toISOString(),
            status: 'published',
            remoteId: result.id
          });
        } else {
          console.log('[DRY-RUN] Registro omitido');
        }
        console.log('✓ Publicado en Facebook');
      } catch (error) {
        console.error(`✗ Error en Facebook: ${error.message}`);
        socialData.posts.push({
          slug: item.slug,
          platform: 'facebook',
          date: new Date().toISOString(),
          status: 'failed',
          error: error.message
        });
      }
      await sleep(2000);
    }

    // INSTAGRAM
    if (!item.igPublished && item.importance >= 5) { // IG solo para notas de cierta importancia
      try {
        console.log('- Generando placa Instagram...');
        const plateFilename = `plate-${item.slug}.jpg`;
        const platePath = path.join(ROOT, 'public/uploads/social', plateFilename);
        await fs.mkdir(path.dirname(platePath), { recursive: true });

        // Comprobar si la placa ya existe localmente (fue subida en un run anterior)
        const plateExists = await fs.access(platePath).then(() => true).catch(() => false);
        let plateToUse = null;

        if (plateExists) {
          plateToUse = `${SITE_URL}/uploads/social/${plateFilename}`;
        } else {
          console.log('- Generando nueva placa Instagram...');
          const generatedPlate = await generateInstagramPlate({
            title: item.title,
            category: item.category,
            imagePath: item.image,
            outputPath: platePath
          });
          // Si acabamos de generarla, no estará disponible en el servidor hasta el próximo push
          console.log('! Placa generada. Estará disponible para el servidor en la próxima ejecución.');
        }

        if (plateToUse || (item.image && item.image.startsWith('http'))) {
          const imageUrl = plateToUse || item.image;

          if (imageUrl.includes('localhost') || imageUrl.includes('127.0.0.1')) {
             console.log('! Saltando Instagram: la URL de la imagen no es pública.');
             continue;
          }

          console.log('- Generando copy Instagram...');
          const igText = await generateSocialCopy({ ...item, platform: 'instagram' });

          console.log('- Enviando a Instagram...');
          const result = await publishToInstagram({ text: igText, imageUrl, dryRun: DRY_RUN });

          if (!DRY_RUN) {
            socialData.posts.push({
              slug: item.slug,
              platform: 'instagram',
              date: new Date().toISOString(),
              status: 'published',
              remoteId: result.id
            });
          } else {
            console.log('[DRY-RUN] Registro omitido');
          }
          console.log('✓ Publicado en Instagram');
        } else {
          console.log('! Saltando Instagram: no hay imagen ni se pudo generar placa.');
        }
      } catch (error) {
        console.error(`✗ Error en Instagram: ${error.message}`);
        socialData.posts.push({
          slug: item.slug,
          platform: 'instagram',
          date: new Date().toISOString(),
          status: 'failed',
          error: error.message
        });
      }
      await sleep(2000);
    }
  }

  await saveSocialData(socialData);
  console.log('\n=== FIN PROCESO SOCIAL ===');
}

main().catch(console.error);
