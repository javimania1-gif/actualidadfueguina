import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { ROOT, NEWS_DIR, sleep } from './lib/news-utils.mjs';
import {
  loadSocialData, saveSocialData, generateSocialCopy,
  generateInstagramPlate, publishToFacebook,
  createInstagramContainer, publishInstagramContainer, MetaError
} from './lib/social-utils.mjs';
import {
  SOCIAL_STATUS,
  ACTIVE_SOCIAL_STATUSES,
  shouldExcludeFromReservation,
  statusForMetaError
} from './lib/social-state.mjs';

const RUN_RESERVE = process.argv.includes('--reserve');
const RUN_PREPARE = process.argv.includes('--prepare');
const RUN_PUBLISH = process.argv.includes('--publish');
// Si no se especifica ninguna opción, por defecto se ejecutan todas consecutivamente
const EXECUTE_ALL = !RUN_RESERVE && !RUN_PREPARE && !RUN_PUBLISH;

const ALLOW_LOCAL_SOCIAL_WRITE =
  process.env.GITHUB_ACTIONS === 'true' ||
  process.env.AF_WRITE_STATE === 'true' ||
  process.argv.includes('--write-state');
const DRY_RUN = process.argv.includes('--dry-run') || !ALLOW_LOCAL_SOCIAL_WRITE;
const MAX_FB_PER_RUN = Number(process.env.AF_MAX_FB_PER_RUN || 2);
const MAX_IG_PER_RUN = Number(process.env.AF_MAX_IG_PER_RUN || 2);
const SITE_URL = process.env.AF_SITE_URL || 'https://actualidadfueguina.com.ar';
// Antigüedad máxima para publicación en redes (120 horas / 5 días), en ms
const MAX_AGE_SOCIAL_MS = 120 * 60 * 60 * 1000;

async function main() {
  console.log(`\n=== INICIO PROCESO SOCIAL ${DRY_RUN ? '(DRY RUN)' : ''} ===`);

  // Identificador único de este intento de ejecución. Combina RUN_ID y RUN_ATTEMPT
  // para que un re-run del mismo workflow no reconozca como propia una reserva anterior.
  function buildRunId() {
    const id = process.env.GITHUB_RUN_ID;
    const attempt = process.env.GITHUB_RUN_ATTEMPT;
    if (id && attempt) return `${id}-${attempt}`;
    return `local-${Date.now()}`;
  }

  const socialData = await loadSocialData();
  const GLOBAL_RUN_ID = buildRunId();

  // FASE 1: RESERVA
  if (RUN_RESERVE || EXECUTE_ALL) {
    console.log('\n--- FASE 1: RESERVA ---');

    const now = new Date();

    // Contar reservas activas de Facebook e Instagram
    const activeFbReservations = Object.values(socialData.posts).filter(p => ACTIVE_SOCIAL_STATUSES.has(p.status) && p.platform === 'facebook');
    const activeIgReservations = Object.values(socialData.posts).filter(p => ACTIVE_SOCIAL_STATUSES.has(p.status) && p.platform === 'instagram');

    const fbSlotsAvailable = Math.max(0, MAX_FB_PER_RUN - activeFbReservations.length);
    const igSlotsAvailable = Math.max(0, MAX_IG_PER_RUN - activeIgReservations.length);

    console.log(`Slots disponibles: Facebook ${fbSlotsAvailable}/${MAX_FB_PER_RUN}, Instagram ${igSlotsAvailable}/${MAX_IG_PER_RUN}`);

    if (fbSlotsAvailable === 0 && igSlotsAvailable === 0) {
      console.log('Todos los slots de reserva están ocupados. Se salta la reserva.');
    } else {
      const files = (await fs.readdir(NEWS_DIR)).filter(f => f.endsWith('.md'));
      const candidates = [];

      for (const file of files) {
        const fullPath = path.join(NEWS_DIR, file);
        const content = await fs.readFile(fullPath, 'utf8');
        const { data, content: body } = matter(content);
        const slug = file.replace('.md', '');

        if (data.social?.enabled === false) continue;

        // Verificar antigüedad: no publicar noticias con más de 48h (excepto urgentes)
        const newsDate = data.date ? new Date(data.date) : new Date(0);
        const ageMs = now - newsDate;
        if (!data.social?.urgent && ageMs > MAX_AGE_SOCIAL_MS) continue;

        const fbKey = `${slug}|facebook`;
        const igKey = `${slug}|instagram`;

        const fbRecord = socialData.posts[fbKey];
        const igRecord = socialData.posts[igKey];

        const fbExcluded = shouldExcludeFromReservation(fbRecord);
        const igExcluded = shouldExcludeFromReservation(igRecord);

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
          date: newsDate,
          image: data.image,
          body,
          fbPublished: fbExcluded,
          igPublished: igExcluded || (data.importance < 5),
          fbRecord,
          igRecord
        });
      }

      // Ordenar: urgentes primero → fecha de noticia más reciente → importancia
      candidates.sort((a, b) => {
        if (a.urgent && !b.urgent) return -1;
        if (!a.urgent && b.urgent) return 1;
        const dateDiff = (b.date || new Date(0)) - (a.date || new Date(0));
        if (Math.abs(dateDiff) > 30 * 60 * 1000) return dateDiff; // diferencia > 30min: priorizar reciente
        return b.importance - a.importance;
      });

      console.log(`Candidatos disponibles: ${candidates.length}`);

      let fbReserved = 0;
      let igReserved = 0;

      for (const item of candidates) {
        if (fbReserved >= fbSlotsAvailable && igReserved >= igSlotsAvailable) break;

        let reservedSomething = false;

        if (!item.fbPublished && fbReserved < fbSlotsAvailable) {
          const key = `${item.slug}|facebook`;
          socialData.posts[key] = {
            slug: item.slug,
            platform: 'facebook',
            date: now.toISOString(),
            status: SOCIAL_STATUS.RESERVED,
            attempts: (item.fbRecord?.attempts || 0) + 1,
            runId: GLOBAL_RUN_ID
          };
          console.log(`- Reservado Facebook: "${item.title}" (runId: ${GLOBAL_RUN_ID})`);
          fbReserved++;
          reservedSomething = true;
        }

        if (!item.igPublished && igReserved < igSlotsAvailable) {
          const key = `${item.slug}|instagram`;
          socialData.posts[key] = {
            slug: item.slug,
            platform: 'instagram',
            date: now.toISOString(),
            status: SOCIAL_STATUS.RESERVED,
            attempts: (item.igRecord?.attempts || 0) + 1,
            creationId: item.igRecord?.creationId || null,
            runId: GLOBAL_RUN_ID
          };
          console.log(`- Reservado Instagram: "${item.title}" (runId: ${GLOBAL_RUN_ID})`);
          igReserved++;
          reservedSomething = true;
        }

        if (reservedSomething) {
          console.log(`  Reservando noticia: "${item.title}"`);
        }
      }

      console.log(`Reservas realizadas: FB ${fbReserved}, IG ${igReserved}`);

      if ((fbReserved > 0 || igReserved > 0) && !DRY_RUN) {
        await saveSocialData(socialData);
        console.log('✓ Reservas guardadas en disco.');
      }
    }
  }

  // FASE 2: PREPARACIÓN
  if (RUN_PREPARE || EXECUTE_ALL) {
    console.log('\n--- FASE 2: PREPARACIÓN ---');

    const now = new Date();
    const reservedPosts = [];
    let hasChanges = false;

    for (const record of Object.values(socialData.posts)) {
      if (record.status === SOCIAL_STATUS.RESERVED || record.status === SOCIAL_STATUS.PREPARING) {
        const reservedDate = new Date(record.date);
        const diffMs = now.getTime() - reservedDate.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);

        if (diffHours > 1) {
          console.warn(`! Reserva huerfana detectada para [${record.platform.toUpperCase()}] ${record.slug} (creada hace ${diffHours.toFixed(1)} horas). Marcando como '${SOCIAL_STATUS.NEEDS_RECONCILIATION}'.`);
          if (!DRY_RUN) {
            record.status = SOCIAL_STATUS.NEEDS_RECONCILIATION;
            record.lastError = 'Reserva huérfana no procesada por caída de ejecución anterior';
            hasChanges = true;
          }
        } else {
          // Validar que la reserva pertenezca a la ejecución actual para evitar colisiones entre runs paralelos o desfasados
          const isLocalRun = record.runId && record.runId.startsWith('local');
          const isCurrentRun = record.runId === GLOBAL_RUN_ID || (GLOBAL_RUN_ID.startsWith('local') && isLocalRun);
          
          if (!isCurrentRun) {
            console.warn(`! Reserva pertenece a otra ejecucion (runId: ${record.runId}, actual: ${GLOBAL_RUN_ID}). Marcando como '${SOCIAL_STATUS.NEEDS_RECONCILIATION}'.`);
            if (!DRY_RUN) {
              record.status = SOCIAL_STATUS.NEEDS_RECONCILIATION;
              record.lastError = 'Reserva pertenece a otra ejecución diferente';
              hasChanges = true;
            }
          } else {
            reservedPosts.push(record);
          }
        }
      }
    }

    if (hasChanges && !DRY_RUN) {
      await saveSocialData(socialData);
    }

    // RECOVERY: Procesar pending-asset de Instagram antes de reservas normales
    const pendingAssets = Object.values(socialData.posts).filter(
      p => p.platform === 'instagram' && p.status === SOCIAL_STATUS.PENDING_ASSET
    );
    if (pendingAssets.length > 0) {
      console.log(`\nRecuperando ${pendingAssets.length} post(s) de Instagram con pending-asset...`);
      for (const record of pendingAssets) {
        const key = `${record.slug}|instagram`;
        const plateFilename = `plate-${record.slug}.jpg`;
        const platePath = path.join(ROOT, 'public/uploads/social', plateFilename);

        let recoveredUrl = null;

        // Verificar si la imagen original ya está pública
        try {
          const fullPath = path.join(NEWS_DIR, `${record.slug}.md`);
          const content = await fs.readFile(fullPath, 'utf8');
          const { data } = matter(content);
          if (data.image && data.image.startsWith('/uploads/')) {
            const publicUrl = `${SITE_URL}${data.image}`;
            const check = await fetch(publicUrl, { method: 'HEAD' }).catch(() => ({ ok: false }));
            if (check.ok) {
              recoveredUrl = publicUrl;
              console.log(`✓ Imagen original disponible para recovery: ${publicUrl}`);
            }
          }
        } catch {}

        // Verificar si la placa social ya está pública
        if (!recoveredUrl) {
          const plateExists = await fs.access(platePath).then(() => true).catch(() => false);
          if (plateExists) {
            const publicUrl = `${SITE_URL}/uploads/social/${plateFilename}`;
            const check = await fetch(publicUrl, { method: 'HEAD' }).catch(() => ({ ok: false }));
            if (check.ok) {
              recoveredUrl = publicUrl;
              console.log(`✓ Placa disponible para recovery: ${publicUrl}`);
            }
          }
        }

        if (recoveredUrl && !DRY_RUN) {
          // Crear contenedor Instagram ahora que tenemos imagen
          try {
            const fullPath = path.join(NEWS_DIR, `${record.slug}.md`);
            const content = await fs.readFile(fullPath, 'utf8');
            const { data, content: body } = matter(content);
            const igText = await generateSocialCopy({
              slug: record.slug, title: data.title, description: data.description,
              category: data.category, location: data.location, tags: data.tags || [],
              image: data.image, body, platform: 'instagram'
            });
            const containerData = await createInstagramContainer({ text: igText, imageUrl: recoveredUrl, dryRun: DRY_RUN });
            socialData.posts[key] = {
              ...socialData.posts[key],
              status: SOCIAL_STATUS.PREPARED,
              creationId: containerData.id,
              preparedAt: new Date().toISOString()
            };
            await saveSocialData(socialData);
            console.log(`✓ Recovery completado: ${record.slug} → prepared (creationId: ${containerData.id})`);
          } catch (err) {
            console.error(`✗ Recovery fallido para ${record.slug}: ${err.message}`);
          }
        } else if (!recoveredUrl) {
          console.log(`! ${record.slug}: asset aún no disponible, se mantiene pending-asset.`);
        }
      }
    }

    console.log(`Reservas activas encontradas para preparar: ${reservedPosts.length}`);


    for (const record of reservedPosts) {
      const slug = record.slug;
      const platform = record.platform;
      const key = `${slug}|${platform}`;

      // Facebook no necesita preparación
      if (platform === 'facebook') {
        console.log(`[FACEBOOK] ${slug}: Se saltará la preparación (listo directo para publicar).`);
        if (!DRY_RUN) {
          socialData.posts[key] = {
            ...socialData.posts[key],
            status: SOCIAL_STATUS.PREPARED,
            preparedAt: new Date().toISOString()
          };
          await saveSocialData(socialData);
        }
        continue;
      }

      console.log(`\nPreparando [${platform.toUpperCase()}]: ${slug}`);

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
          socialData.posts[key].status = SOCIAL_STATUS.CANCELLED;
          socialData.posts[key].lastError = `No se encontró el archivo markdown: ${err.message}`;
          await saveSocialData(socialData);
        }
        continue;
      }

      try {
        const plateFilename = `plate-${slug}.jpg`;
        const platePath = path.join(ROOT, 'public/uploads/social', plateFilename);
        let imageUrl = null;

        // 1. Imagen HTTP directa -> Descargar localmente para evitar hotlinking
        if (item.image && item.image.startsWith('http')) {
          console.log(`- Imagen externa detectada; se usara placa local para evitar hotlinking: ${item.image}`);
          item.image = '';
        }
        if (false && item.image && item.image.startsWith('http')) {
          console.log(`- Descargando imagen externa: ${item.image}`);
          const localPath = await downloadImage(item.image, item.slug);
          if (localPath) {
            item.image = localPath; // Se transformó en relativa
          }
        }
        
        // 2. Imagen relativa /uploads/ -> construir URL absoluta y verificar disponibilidad
        if (item.image && item.image.startsWith('/uploads/')) {
          const publicUrl = `${SITE_URL}${item.image}`;
          console.log(`- Verificando imagen relativa como URL pública: ${publicUrl}`);
          const check = await fetch(publicUrl, { method: 'HEAD' }).catch(() => ({ ok: false }));
          if (check.ok) {
            imageUrl = publicUrl;
            console.log(`- Imagen pública disponible, se usará directamente.`);
          } else {
            console.log(`! Imagen relativa aún no disponible públicamente.`);
          }
        }
        // 3. Si hay placa ya generada, verificarla
        if (!imageUrl) {
          const plateExists = await fs.access(platePath).then(() => true).catch(() => false);
          if (plateExists) {
            const publicUrl = `${SITE_URL}/uploads/social/${plateFilename}`;
            console.log(`- Verificando disponibilidad de placa: ${publicUrl}`);
            const check = await fetch(publicUrl, { method: 'HEAD' }).catch(() => ({ ok: false }));
            if (check.ok) {
              imageUrl = publicUrl;
            } else {
              console.log('! Placa existente aún no disponible públicamente en Cloudflare.');
            }
          }
        }
        // 4. Generar nueva placa si no hay imagen disponible
        if (!imageUrl) {
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


        if (imageUrl) {
          console.log('- Generando copy Instagram...');
          const igText = await generateSocialCopy({ ...item, platform: 'instagram' });
          
          let creationId = record.creationId;
          if (!creationId) {
            console.log('- Creando contenedor en Instagram...');
            const containerData = await createInstagramContainer({ text: igText, imageUrl, dryRun: DRY_RUN });
            creationId = containerData.id;
          } else {
            console.log(`- Reutilizando contenedor existente de Instagram (creationId: ${creationId})`);
          }
          
          if (!DRY_RUN) {
            socialData.posts[key] = {
              ...socialData.posts[key],
              status: SOCIAL_STATUS.PREPARED,
              creationId: creationId,
              preparedAt: new Date().toISOString()
            };
            await saveSocialData(socialData);
            console.log(`✓ Contenedor Instagram preparado (creationId: ${creationId}) y guardado.`);
          } else {
            console.log(`[DRY-RUN] Contenedor Instagram preparado: ${creationId}`);
          }
        } else {
          console.log('! Saltando Instagram: esperando disponibilidad del asset.');
          if (!DRY_RUN) {
            socialData.posts[key].status = SOCIAL_STATUS.PENDING_ASSET;
            await saveSocialData(socialData);
          }
        }
      } catch (error) {
        console.error(`✗ Error al preparar Instagram: ${error.message}`);
        if (!DRY_RUN) {
          socialData.posts[key] = {
            ...socialData.posts[key],
            status: error instanceof MetaError ? statusForMetaError(error) : SOCIAL_STATUS.NEEDS_RECONCILIATION,
            lastError: error.message
          };
          await saveSocialData(socialData);
          console.log(`Estado Instagram actualizado a: ${socialData.posts[key].status}`);
        }
      }
      await sleep(1000);
    }
  }

  // FASE 3: PUBLICACIÓN
  if (RUN_PUBLISH || EXECUTE_ALL) {
    console.log('\n--- FASE 3: PUBLICACIÓN ---');

    // Procesar Facebook e Instagram usando el mismo runId del intento actual
    const currentRunId = GLOBAL_RUN_ID;
    const fbReserved = Object.values(socialData.posts).filter(p => {
      if (p.status !== SOCIAL_STATUS.PREPARED || p.platform !== 'facebook') return false;
      const isLocalRun = p.runId && p.runId.startsWith('local');
      return p.runId === currentRunId || (currentRunId.startsWith('local') && isLocalRun);
    });
    console.log(`Reservas de Facebook listas para publicar: ${fbReserved.length}`);

    for (const record of fbReserved) {
      const slug = record.slug;
      const key = `${slug}|facebook`;
      console.log(`\nPublicando [FACEBOOK]: ${slug}`);

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
          socialData.posts[key].status = SOCIAL_STATUS.CANCELLED;
          socialData.posts[key].lastError = `No se encontró el archivo markdown: ${err.message}`;
          await saveSocialData(socialData);
        }
        continue;
      }

      const newsUrl = `${SITE_URL}/noticias/${slug}/`;

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
          await saveSocialData(socialData);
          console.log('✓ Publicado en Facebook');
        } else {
          console.log('[DRY-RUN] Facebook: ' + fbText.slice(0, 60) + '...');
        }
      } catch (error) {
        console.error(`✗ Error Facebook: ${error.message}`);
        if (!DRY_RUN) {
          socialData.posts[key] = {
            ...socialData.posts[key],
            status: error instanceof MetaError ? statusForMetaError(error) : SOCIAL_STATUS.NEEDS_RECONCILIATION,
            lastError: error.message
          };
          await saveSocialData(socialData);
          console.log(`Estado Facebook actualizado a: ${socialData.posts[key].status}`);
        }
      }
      await sleep(1000);
    }

    // Procesar Instagram (lee los 'prepared' de Instagram del mismo runId)
    const igPrepared = Object.values(socialData.posts).filter(p => {
      if (p.status !== SOCIAL_STATUS.PREPARED || p.platform !== 'instagram') return false;
      const isLocalRun = p.runId && p.runId.startsWith('local');
      return p.runId === currentRunId || (currentRunId.startsWith('local') && isLocalRun);
    });
    console.log(`Reservas de Instagram listas para publicar: ${igPrepared.length}`);

    for (const record of igPrepared) {
      const slug = record.slug;
      const key = `${slug}|instagram`;
      console.log(`\nPublicando [INSTAGRAM]: ${slug}`);

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
        continue;
      }

      try {
        const creationId = record.creationId;
        if (!creationId) {
          throw new Error('No se encontró creationId en el post preparado');
        }

        console.log('- Publicando contenedor en Instagram...');
        const result = await publishInstagramContainer({ creationId, dryRun: DRY_RUN });

        if (!DRY_RUN) {
          socialData.posts[key] = {
            ...socialData.posts[key],
            status: 'published',
            remoteId: result.id,
            publishedAt: new Date().toISOString()
          };
          await saveSocialData(socialData);
          console.log('✓ Publicado en Instagram');
        } else {
          console.log(`[DRY-RUN] Instagram publicado con container: ${creationId}`);
        }
      } catch (error) {
        console.error(`✗ Error Instagram: ${error.message}`);
        if (!DRY_RUN) {
          socialData.posts[key] = {
            ...socialData.posts[key],
            status: error instanceof MetaError ? statusForMetaError(error) : SOCIAL_STATUS.NEEDS_RECONCILIATION,
            lastError: error.message
          };
          await saveSocialData(socialData);
          console.log(`Estado Instagram actualizado a: ${socialData.posts[key].status}`);
        }
      }
      await sleep(1000);
    }
  }

  if (DRY_RUN) {
    console.log('\n[DRY-RUN] No se guardaron cambios definitivos en el registro.');
  }

  console.log('\n=== FIN PROCESO SOCIAL ===');
}

main().catch(console.error);
