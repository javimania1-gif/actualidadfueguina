import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { ROOT, NEWS_DIR, sleep } from './lib/news-utils.mjs';
import {
  loadSocialData, saveSocialData, generateSocialCopy,
  generateInstagramPlate, publishToFacebook,
  createInstagramContainer, publishInstagramContainer, MetaError
} from './lib/social-utils.mjs';

const RUN_RESERVE = process.argv.includes('--reserve');
const RUN_PUBLISH = process.argv.includes('--publish');
// Si no se especifica ninguna opción, por defecto se ejecutan ambas consecutivamente
const EXECUTE_ALL = !RUN_RESERVE && !RUN_PUBLISH;

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_POSTS_PER_RUN = 1;
const SITE_URL = 'https://actualidadfueguina.com.ar';

async function main() {
  console.log(`\n=== INICIO PROCESO SOCIAL ${DRY_RUN ? '(DRY RUN)' : ''} ===`);

  const socialData = await loadSocialData();

  // FASE 1: RESERVA
  if (RUN_RESERVE || EXECUTE_ALL) {
    console.log('\n--- FASE 1: RESERVA ---');
    
    // Comprobar si ya existe alguna reserva activa en el registro
    const activeReservations = Object.values(socialData.posts).filter(p => p.status === 'publishing');
    
    if (activeReservations.length > 0) {
      console.log(`Ya existe una reserva activa para: ${activeReservations.map(r => r.slug).join(', ')}.`);
      console.log('Se salta la reserva de un nuevo candidato.');
    } else {
      const files = (await fs.readdir(NEWS_DIR)).filter(f => f.endsWith('.md'));
      const candidates = [];

      for (const file of files) {
        const fullPath = path.join(NEWS_DIR, file);
        const content = await fs.readFile(fullPath, 'utf8');
        const { data, content: body } = matter(content);
        const slug = file.replace('.md', '');

        if (data.social?.enabled === false) continue;

        const fbKey = `${slug}|facebook`;
        const igKey = `${slug}|instagram`;

        const fbRecord = socialData.posts[fbKey];
        const igRecord = socialData.posts[igKey];

        // Excluir si ya fue publicado, está en proceso de publicación, o requiere reconciliación
        const fbExcluded = fbRecord && ['published', 'publishing', 'unknown', 'needs-reconciliation'].includes(fbRecord.status);
        const igExcluded = igRecord && ['published', 'publishing', 'unknown', 'needs-reconciliation'].includes(igRecord.status);

        if (fbExcluded && igExcluded) continue;

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
          fbPublished: fbExcluded,
          igPublished: igExcluded || (data.importance < 5), // IG requiere importancia >= 5
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

      const toReserve = candidates.slice(0, MAX_POSTS_PER_RUN);
      console.log(`Candidatos disponibles: ${candidates.length}. Reservando: ${toReserve.length}`);

      for (const item of toReserve) {
        console.log(`Reservando noticia: "${item.title}"`);
        
        if (!item.fbPublished) {
          const key = `${item.slug}|facebook`;
          socialData.posts[key] = {
            slug: item.slug,
            platform: 'facebook',
            date: new Date().toISOString(),
            status: 'publishing',
            attempts: (item.fbRecord?.attempts || 0) + 1
          };
          console.log(`- Reservado Facebook para slug: ${item.slug}`);
        }
        
        if (!item.igPublished) {
          const key = `${item.slug}|instagram`;
          socialData.posts[key] = {
            slug: item.slug,
            platform: 'instagram',
            date: new Date().toISOString(),
            status: 'publishing',
            attempts: (item.igRecord?.attempts || 0) + 1,
            creationId: item.igRecord?.creationId || null
          };
          console.log(`- Reservado Instagram para slug: ${item.slug}`);
        }
      }

      if (toReserve.length > 0 && !DRY_RUN) {
        await saveSocialData(socialData);
        console.log('✓ Reservas guardadas en disco.');
      }
    }
  }

  // FASE 2: PUBLICACIÓN
  if (RUN_PUBLISH || EXECUTE_ALL) {
    console.log('\n--- FASE 2: PUBLICACIÓN ---');

    // Buscar posts en estado 'publishing'
    const reservedPosts = Object.values(socialData.posts).filter(p => p.status === 'publishing');
    console.log(`Reservas activas encontradas para publicar: ${reservedPosts.length}`);

    for (const record of reservedPosts) {
      const slug = record.slug;
      const platform = record.platform;
      const key = `${slug}|${platform}`;

      console.log(`\nProcesando publicación para [${platform.toUpperCase()}]: ${slug}`);

      // Leer archivo markdown de la noticia para obtener los textos frescos
      let item;
      try {
        const fullPath = path.join(NEWS_DIR, `${slug}.md`);
        const content = await fs.readFile(fullPath, 'utf8');
        const { data, content: body } = matter(content);
        item = {
          slug,
          title: data.title,
          description: data.description,
          category: data.category,
          location: data.location,
          tags: data.tags || [],
          image: data.image,
          body
        };
      } catch (err) {
        console.error(`✗ Error al leer archivo de la noticia para ${slug}: ${err.message}`);
        if (!DRY_RUN) {
          socialData.posts[key].status = 'failed';
          socialData.posts[key].lastError = `No se encontró el archivo markdown: ${err.message}`;
          await saveSocialData(socialData);
        }
        continue;
      }

      const newsUrl = `${SITE_URL}/noticias/${slug}/`;

      if (platform === 'facebook') {
        try {
          console.log('- Generando copy Facebook...');
          const fbText = await generateSocialCopy({ ...item, platform: 'facebook' });
          const result = await publishToFacebook({ text: fbText, link: newsUrl, dryRun: DRY_RUN });

          if (!DRY_RUN) {
            socialData.posts[key] = {
              ...socialData.posts[key],
              status: 'published',
              remoteId: result.id,
              publishedAt: new Date().toISOString()
            };
            console.log('✓ Publicado en Facebook');
          } else {
            console.log('[DRY-RUN] Facebook: ' + fbText.slice(0, 60) + '...');
          }
        } catch (error) {
          console.error(`✗ Error Facebook: ${error.message}`);
          if (!DRY_RUN) {
            const isAmbiguous = error instanceof MetaError ? error.isAmbiguous : true;
            socialData.posts[key] = {
              ...socialData.posts[key],
              status: isAmbiguous ? 'unknown' : 'failed',
              lastError: error.message
            };
            console.log(`Estado Facebook actualizado a: ${isAmbiguous ? 'unknown' : 'failed'}`);
          }
        }
        await sleep(1000);
      }

      if (platform === 'instagram') {
        try {
          const plateFilename = `plate-${slug}.jpg`;
          const platePath = path.join(ROOT, 'public/uploads/social', plateFilename);

          let imageUrl = null;

          if (item.image && item.image.startsWith('http')) {
            imageUrl = item.image;
          } else {
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
            
            let creationId = record.creationId;

            // FASE 2.1: Crear contenedor de Instagram si no existe
            if (!creationId) {
              console.log('- Creando contenedor en Instagram...');
              const containerData = await createInstagramContainer({ text: igText, imageUrl, dryRun: DRY_RUN });
              creationId = containerData.id;
              
              if (!DRY_RUN) {
                socialData.posts[key].creationId = creationId;
                await saveSocialData(socialData);
                console.log(`- Contenedor creado exitosamente (creationId: ${creationId}) y guardado.`);
              } else {
                console.log(`[DRY-RUN] Contenedor creado: ${creationId}`);
              }
            } else {
              console.log(`- Reutilizando contenedor existente de Instagram (creationId: ${creationId})`);
            }

            // FASE 2.2: Publicar el contenedor en Instagram
            console.log('- Publicando contenedor en Instagram...');
            const result = await publishInstagramContainer({ creationId, dryRun: DRY_RUN });

            if (!DRY_RUN) {
              socialData.posts[key] = {
                ...socialData.posts[key],
                status: 'published',
                remoteId: result.id,
                publishedAt: new Date().toISOString()
              };
              console.log('✓ Publicado en Instagram');
            } else {
              console.log('[DRY-RUN] Instagram publicado: ' + igText.slice(0, 60) + '...');
            }
          } else {
            console.log('! Saltando Instagram: esperando disponibilidad del asset.');
            if (!DRY_RUN) {
              // Si no está disponible el asset, lo dejamos en pending-asset para que vuelva a seleccionarse
              socialData.posts[key] = {
                ...socialData.posts[key],
                status: 'pending-asset'
              };
            }
          }
        } catch (error) {
          console.error(`✗ Error Instagram: ${error.message}`);
          if (!DRY_RUN) {
            const isAmbiguous = error instanceof MetaError ? error.isAmbiguous : true;
            socialData.posts[key] = {
              ...socialData.posts[key],
              status: isAmbiguous ? 'unknown' : 'failed',
              lastError: error.message
              // Conservamos el creationId en el registro si ya existía, por si era un error temporal
            };
            console.log(`Estado Instagram actualizado a: ${isAmbiguous ? 'unknown' : 'failed'}`);
          }
        }
        await sleep(1000);
      }

      // Guardar el estado de este post procesado de forma incremental
      if (!DRY_RUN) {
        await saveSocialData(socialData);
      }
    }
  }

  if (DRY_RUN) {
    console.log('\n[DRY-RUN] No se guardaron cambios definitivos en el registro.');
  }

  console.log('\n=== FIN PROCESO SOCIAL ===');
}

main().catch(console.error);
