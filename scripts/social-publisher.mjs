
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
const RESERVE_ONLY = process.argv.includes('--reserve');
const PUBLISH_ONLY = process.argv.includes('--publish');
const SITE_URL = 'https://actualidadfueguina.com.ar';

async function main() {
  const mode = RESERVE_ONLY ? 'RESERVE' : (PUBLISH_ONLY ? 'PUBLISH' : 'FULL');
  console.log(`\n=== SOCIAL PUBLISHER [Mode: ${mode}${DRY_RUN ? ', DRY RUN' : ''}] ===`);

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
    hour: 'numeric', hour12: false
  }).format(new Date())).getHours();
  const isNight = hourTDF >= 20 || hourTDF < 6;

  const rank = (item) => {
    let score = item.importance;
    if (item.urgent) score += 100;
    if (isNight && item.dailyDigest) score += 50;
    return score;
  };

  const isExcluded = (status) => ['published', 'unknown', 'needs-reconciliation', 'publishing'].includes(status);

  // --- FASE 1: RESERVA ---
  if (!PUBLISH_ONLY) {
    console.log('--- Phase: Selection & Reservation ---');
    const fbCandidates = newsItems
      .filter(item => !isExcluded(socialData.posts[item.fbKey]?.status))
      .sort((a, b) => rank(b) - rank(a));

    const igCandidates = newsItems
      .filter(item => item.importance >= 5 && !isExcluded(socialData.posts[item.igKey]?.status))
      .sort((a, b) => rank(b) - rank(a));

    console.log(`Candidates FB: ${fbCandidates.length}, IG: ${igCandidates.length}`);

    if (fbCandidates.length > 0) {
      const item = fbCandidates[0];
      if (!socialData.posts[item.fbKey]) {
        console.log(`[FB] Reserving: ${item.title}`);
        socialData.posts[item.fbKey] = { slug: item.slug, platform: 'facebook', status: 'publishing', date: new Date().toISOString(), attempts: 0 };
      }
    }

    if (igCandidates.length > 0) {
      const item = igCandidates[0];
      if (!socialData.posts[item.igKey]) {
        console.log(`[IG] Reserving: ${item.title}`);
        socialData.posts[item.igKey] = { slug: item.slug, platform: 'instagram', status: 'publishing', date: new Date().toISOString(), attempts: 0 };
      }
    }

    if (!DRY_RUN && !PUBLISH_ONLY) {
       await saveSocialData(socialData);
    }
  }

  // --- FASE 2: PUBLICACIÓN ---
  if (!RESERVE_ONLY) {
    console.log('\n--- Phase: Publication ---');
    const reservedItems = Object.values(socialData.posts).filter(p => p.status === 'publishing' || p.status === 'container-created' || p.status === 'pending-asset');
    console.log(`Items to process: ${reservedItems.length}`);

    for (const record of reservedItems) {
      const item = newsItems.find(n => n.slug === record.slug);
      if (!item) continue;
      const key = `${record.slug}|${record.platform}`;
      const newsUrl = `${SITE_URL}/noticias/${item.slug}/`;

      if (record.platform === 'facebook') {
        console.log(`\n[FACEBOOK] Publishing: ${item.title}`);
        try {
          const fbText = await generateSocialCopy({ ...item, platform: 'facebook' });
          const result = await publishToFacebook({ text: fbText, link: newsUrl, dryRun: DRY_RUN });
          if (!DRY_RUN) {
            socialData.posts[key] = { ...record, status: 'published', remoteId: result.id, attempts: (record.attempts || 0) + 1, publishedAt: new Date().toISOString() };
            console.log('✓ FB Published');
          }
        } catch (error) {
          console.error(`✗ FB Error: ${error.message}`);
          if (!DRY_RUN) {
            const isAmbiguous = error instanceof MetaError && error.isAmbiguous;
            socialData.posts[key] = { ...record, status: isAmbiguous ? 'unknown' : 'failed', lastError: error.message, attempts: (record.attempts || 0) + 1 };
          }
        }
      }

      if (record.platform === 'instagram') {
        console.log(`\n[INSTAGRAM] Processing: ${item.title}`);
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
              console.log(`- Checking asset: ${publicUrl}`);
              const check = await fetch(publicUrl, { method: 'HEAD' }).catch(() => ({ ok: false }));
              if (check.ok) imageUrl = publicUrl;
              else console.log('! Asset not public yet.');
            } else {
              console.log('- Generating plate...');
              const generated = await generateInstagramPlate({ title: item.title, category: item.category, imagePath: item.image, outputPath: platePath });
              if (generated) {
                console.log('! Plate generated. Waiting for deploy.');
                if (DRY_RUN) await fs.unlink(platePath).catch(() => {});
                else socialData.posts[key] = { ...record, status: 'pending-asset' };
              }
            }
          }

          if (imageUrl) {
            let creationId = record.creationId;
            if (!creationId) {
              console.log('- Creating IG container...');
              const igText = await generateSocialCopy({ ...item, platform: 'instagram' });
              const container = await createInstagramContainer({ imageUrl, caption: igText, dryRun: DRY_RUN });
              creationId = container.id;
              if (!DRY_RUN) {
                socialData.posts[key] = { ...record, creationId, status: 'container-created' };
                // Guardar creación del contenedor de inmediato para no perderlo
                await saveSocialData(socialData);
              }
            }

            console.log('- Publishing IG container...');
            const result = await publishInstagramContainer({ creationId, dryRun: DRY_RUN });
            if (!DRY_RUN) {
              socialData.posts[key] = { ...record, status: 'published', remoteId: result.id, attempts: (record.attempts || 0) + 1, publishedAt: new Date().toISOString() };
              console.log('✓ IG Published');
            }
          }
        } catch (error) {
          console.error(`✗ IG Error: ${error.message}`);
          if (!DRY_RUN) {
            const isAmbiguous = error instanceof MetaError && error.isAmbiguous;
            socialData.posts[key] = { ...record, status: isAmbiguous ? 'unknown' : 'failed', lastError: error.message, attempts: (record.attempts || 0) + 1 };
          }
        }
      }
      await sleep(1000);
    }
  }

  if (!DRY_RUN) {
    await saveSocialData(socialData);
  }
  console.log('\n=== SOCIAL PROCESS FINISHED ===');
}

main().catch(console.error);
