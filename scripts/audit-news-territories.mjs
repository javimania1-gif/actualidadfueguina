import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { resolvePublicationTerritory } from './lib/territory-resolver.mjs';

const NEWS_DIR = path.join(process.cwd(), 'src/content/noticias');

async function main() {
  const args = process.argv.slice(2);
  const isApply = args.includes('--apply');
  const dryRun = !isApply;
  
  const sinceDaysArg = args.find(a => a.startsWith('--since-days='));
  const sinceDays = sinceDaysArg ? parseInt(sinceDaysArg.split('=')[1], 10) : 7;
  
  const maxArg = args.find(a => a.startsWith('--max='));
  const max = maxArg ? parseInt(maxArg.split('=')[1], 10) : 1000;

  console.log(`Auditoría de Territorios${isApply ? ' [APPLY MODE]' : ' [DRY RUN]'}`);
  console.log(`Días: ${sinceDays}, Máximo: ${max}\n`);

  let files;
  try {
    files = await fs.readdir(NEWS_DIR);
  } catch (err) {
    console.error(`Error leyendo ${NEWS_DIR}:`, err);
    return;
  }

  const markdownFiles = files.filter(f => f.endsWith('.md')).reverse();
  const thresholdTime = Date.now() - (sinceDays * 24 * 60 * 60 * 1000);

  let processed = 0;
  let corrected = 0;
  const changedFiles = [];

  for (const file of markdownFiles) {
    if (processed >= max) break;
    
    // Check by filename date heuristically first to avoid parsing all files
    const match = file.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
        const fileTime = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`).getTime();
        if (fileTime < thresholdTime) continue;
    }

    const filePath = path.join(NEWS_DIR, file);
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      continue;
    }

    const { data: frontmatter, content: body } = matter(content);
    if (!frontmatter || !frontmatter.title) continue;

    processed++;

    const currentCat = frontmatter.category || '';
    const currentLoc = frontmatter.location || '';
    
    const territoryResult = resolvePublicationTerritory({
        title: frontmatter.title,
        description: frontmatter.description || '',
        body: body,
        verifiedFacts: {}, // we don't have this available from Markdown easily, but text is usually enough
        agendaTerritory: '',
        source: {
             defaultCategory: currentCat, // use existing as fallback
             location: currentLoc
        },
        sourceUrl: ''
    });

    const newCat = territoryResult.category;
    const newLoc = territoryResult.location;

    // Only apply if it changed AND confidence is high or medium
    if ((newCat !== currentCat || newLoc !== currentLoc) && ['high', 'medium'].includes(territoryResult.confidence)) {
        
        // Let's protect Ushuaia 24 etc changing location
        if (currentCat === newCat && currentLoc === newLoc) continue;

        console.log(`\n📄 Archivo: ${file}`);
        console.log(`   Título: ${frontmatter.title}`);
        console.log(`   Categoría actual: ${currentCat} -> Propuesta: ${newCat}`);
        console.log(`   Location actual: ${currentLoc} -> Propuesta: ${newLoc}`);
        console.log(`   Confianza: ${territoryResult.confidence}`);
        console.log(`   Razón: ${territoryResult.reason}`);

        if (isApply) {
            frontmatter.category = newCat;
            frontmatter.location = newLoc;
            
            // Build new content preserving everything exactly except category/location
            const newContent = matter.stringify(body, frontmatter);
            await fs.writeFile(filePath, newContent, 'utf8');
            corrected++;
            changedFiles.push(file);
        } else {
            corrected++;
        }
    }
  }

  console.log(`\n=== RESULTADOS ===`);
  console.log(`Procesadas: ${processed}`);
  console.log(`A corregir/Corregidas: ${corrected}`);
  if (isApply) {
      console.log(`Archivos modificados:`);
      changedFiles.forEach(f => console.log(`  - ${f}`));
  }
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
