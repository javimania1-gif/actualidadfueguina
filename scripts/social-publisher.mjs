
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { ROOT, NEWS_DIR, sleep } from './lib/news-utils.mjs';
import {
  loadSocialData, saveSocialData, generateSocialCopy,
  generateInstagramPlate, publishToFacebook,
  createInstagramContainer, publishInstagramContainer, MetaError
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

  const rank = (item) => {
    let score = item.importance;
    if (item.urgent) score += 100;
    if (isNight && item.dailyDigest) score += 50;
    return score;
  };

  const isExcluded = (status) => ['published', 'unknown', 'needs-reconciliation'].includes(status);

  const fbCandidates = newsItems
    .filter(item => !isExcluded(socialData.posts[item.fbKey]?.status))
    .sort((a, b) => rank(b) - rank(a));

  const igCandidates = newsItems
    .filter(item => item.importance >= 5 && !isExcluded(socialData.posts[item.igKey]?.status))
    .sort((a, b) => rank(b) - rank(a));

  console.log(`Candidatos FB: ${fbCandidates.length}, IG: ${igCandidates.length}`);

  let actionsTaken = 0;

  // 1. FACEBOOK
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
      }
      actionsTaken++;
    } catch (error) {
      console.error(`✗ Error Facebook: ${error.message}`);
      if (!DRY_RUN) {
        const isAmbiguous = error instanceof MetaError && error.isAmbiguous;
        socialData.posts[key] = {
          slug: item.slug,
          platform: 'facebook',
          date: new Date().toISOString(),
          status: isAmbiguous ? 'unknown' : 'failed',
          lastError: error.message,
          attempts: (socialData.posts[key]?.attempts || 0) + 1
        };
      }
    }
  }

  await sleep(1000);

  // 2. INSTAGRAM
  if (igCandidates.length > 0) {
    const item = igCandidates[0];
    const key = item.igKey;
    const record = socialData.posts[key];
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
          if (check.ok) imageUrl = publicUrl;
          else console.log('! Asset pendiente de deploy.');
        } else {
          console.log('- Generando placa Instagram...');
          const generated = await generateInstagramPlate({
            title: item.title,
            category: item.category,
            imagePath: item.image,
            outputPath: platePath
          });
          if (generated && DRY_RUN) await fs.unlink(platePath).catch(() => {});
        }
      }

      if (imageUrl) {
        let creationId = record?.creationId;
        if (!creationId) {
          console.log('- Creando contenedor Instagram...');
          const igText = await generateSocialCopy({ ...item, platform: 'instagram' });
          const container = await createInstagramContainer({ imageUrl, caption: igText, dryRun: DRY_RUN });
          creationId = container.id;
          if (!DRY_RUN) {
             socialData.posts[key] = { ...record, slug: item.slug, platform: 'instagram', creationId, status: 'container-created' };
          }
        }

        console.log('- Publicando contenedor Instagram...');
        const result = await publishInstagramContainer({ creationId, dryRun: DRY_RUN });

        if (!DRY_RUN) {
          socialData.posts[key] = {
            slug: item.slug,
            platform: 'instagram',
            date: new Date().toISOString(),
            status: 'published',
            remoteId: result.id,
            attempts: (record?.attempts || 0) + 1,
            publishedAt: new Date().toISOString()
          };
          console.log('✓ Publicado en Instagram');
        }
        actionsTaken++;
      } else {
        console.log('! Instagram en espera: asset no disponible.');
        if (!DRY_RUN && !record) {
          socialData.posts[key] = { slug: item.slug, platform: 'instagram', date: new Date().toISOString(), status: 'pending-asset', attempts: 0 };
        }
      }
    } catch (error) {
      console.error(`✗ Error Instagram: ${error.message}`);
      if (!DRY_RUN) {
        const isAmbiguous = error instanceof MetaError && error.isAmbiguous;
        socialData.posts[key] = {
          ...socialData.posts[key],
          slug: item.slug,
          platform: 'instagram',
          date: new Date().toISOString(),
          status: isAmbiguous ? 'unknown' : 'failed',
          lastError: error.message,
          attempts: (record?.attempts || 0) + 1
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
