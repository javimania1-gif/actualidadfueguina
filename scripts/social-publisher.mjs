
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { ROOT, NEWS_DIR, sleep } from './lib/news-utils.mjs';
import {
  loadSocialData, saveSocialData, generateSocialCopy,
  generateInstagramPlate, publishToFacebook, publishToInstagram
} from './lib/social-utils.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const SITE_URL = 'https://actualidadfueguina.com.ar';

async function main() {
  console.log(`\n=== INICIO PUBLICACIÓN SOCIAL ${DRY_RUN ? '(DRY RUN)' : ''} ===`);

  const socialData = await loadSocialData();
  const files = (await fs.readdir(NEWS_DIR)).filter(f => f.endsWith('.md'));

  const newsItems = [];
  for (const file of files) {
    const fullPath = path.join(NEWS_DIR, file);
    const content = await fs.readFile(fullPath, 'utf8');
    const { data, content: body } = matter(content);
    const slug = file.replace('.md', '');
    if (data.social?.enabled === false) continue;

    newsItems.push({
      slug,
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
      fbKey: `${slug}|facebook`,
      igKey: `${slug}|instagram`
    });
  }

  const hourTDF = new Date(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Ushuaia',
    hour: 'numeric',
    hour12: false
  }).format(new Date())).getHours();
  const isNight = hourTDF >= 20 || hourTDF < 6;

  // Función de ordenamiento común
  const rank = (item) => {
    let score = item.importance;
    if (item.urgent) score += 100;
    if (isNight && item.dailyDigest) score += 50;
    return score;
  };

  // Candidatos para Facebook (no publicados)
  const fbCandidates = newsItems
    .filter(item => socialData.posts[item.fbKey]?.status !== 'published')
    .sort((a, b) => rank(b) - rank(a));

  // Candidatos para Instagram (no publicados, imp >= 5)
  const igCandidates = newsItems
    .filter(item => item.importance >= 5 && socialData.posts[item.igKey]?.status !== 'published')
    .sort((a, b) => rank(b) - rank(a));

  console.log(`Candidatos FB: ${fbCandidates.length}, IG: ${igCandidates.length}`);

  let actionsTaken = 0;

  // 1. Procesar Facebook (máximo 1 acción nueva por run)
  if (fbCandidates.length > 0) {
    const item = fbCandidates[0];
    const key = item.fbKey;
    const newsUrl = `${SITE_URL}/noticias/${item.slug}/`;

    console.log(`\n[FACEBOOK] Seleccionado: ${item.title}`);
    try {
      const fbText = await generateSocialCopy({ ...item, platform: 'facebook' });
      const result = await publishToFacebook({ text: fbText, link: newsUrl, dryRun: DRY_RUN });

      if (!DRY_RUN) {
        socialData.posts[key] = {
          slug: item.slug,
          platform: 'facebook',
          date: new Date().toISOString(),
          status: 'published',
          remoteId: result.id,
          attempts: (socialData.posts[key]?.attempts || 0) + 1,
          publishedAt: new Date().toISOString()
        };
        console.log('✓ Publicado en Facebook');
      } else {
        console.log('[DRY-RUN] Facebook OK');
      }
      actionsTaken++;
    } catch (error) {
      console.error(`✗ Error Facebook: ${error.message}`);
      if (!DRY_RUN) {
        socialData.posts[key] = {
          slug: item.slug,
          platform: 'facebook',
          date: new Date().toISOString(),
          status: 'failed',
          lastError: error.message,
          attempts: (socialData.posts[key]?.attempts || 0) + 1
        };
      }
    }
  }

  await sleep(1000);

  // 2. Procesar Instagram (máximo 1 acción nueva o de avance por run)
  if (igCandidates.length > 0) {
    const item = igCandidates[0];
    const key = item.igKey;
    console.log(`\n[INSTAGRAM] Seleccionado: ${item.title}`);

    try {
      const plateFilename = `plate-${item.slug}.jpg`;
      const platePath = path.join(ROOT, 'public/uploads/social', plateFilename);
      let imageUrl = null;

      if (item.image && item.image.startsWith('http')) {
        imageUrl = item.image;
      } else {
        const plateExists = await fs.access(platePath).then(() => true).catch(() => false);
        if (plateExists) {
          const publicUrl = `${SITE_URL}/uploads/social/${plateFilename}`;
          console.log(`- Verificando disponibilidad asset: ${publicUrl}`);
          const check = await fetch(publicUrl, { method: 'HEAD' }).catch(() => ({ ok: false }));
          if (check.ok) {
            imageUrl = publicUrl;
          } else {
            console.log('! Asset pendiente de deploy en Cloudflare.');
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
            if (DRY_RUN) await fs.unlink(platePath).catch(() => {});
          }
        }
      }

      if (imageUrl) {
        const igText = await generateSocialCopy({ ...item, platform: 'instagram' });
        const result = await publishToInstagram({ text: igText, imageUrl, dryRun: DRY_RUN });

        if (!DRY_RUN) {
          socialData.posts[key] = {
            slug: item.slug,
            platform: 'instagram',
            date: new Date().toISOString(),
            status: 'published',
            remoteId: result.id,
            attempts: (socialData.posts[key]?.attempts || 0) + 1,
            publishedAt: new Date().toISOString()
          };
          console.log('✓ Publicado en Instagram');
        } else {
          console.log('[DRY-RUN] Instagram OK');
        }
        actionsTaken++;
      } else {
        console.log('! Instagram en espera: asset no disponible.');
        if (!DRY_RUN && !socialData.posts[key]) {
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
          attempts: (socialData.posts[key]?.attempts || 0) + 1
        };
      }
    }
  }

  if (!DRY_RUN && (actionsTaken > 0 || Object.keys(socialData.posts).length > 0)) {
    await saveSocialData(socialData);
  }
  console.log(`\n=== FIN PROCESO SOCIAL (Acciones: ${actionsTaken}) ===`);
}

main().catch(console.error);
