import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, writeArticleWithModel, makeNewsMarkdown, makeDraftMarkdown, sleep, generateWebPlate, normalizeImageAsset } from '../scripts/lib/news-utils.mjs';

const draftsToProcess = [
  '2026-07-11-tierra-del-fuego-inauguro-la-temporada-de-nieve-con-la-tradicional-bajada-de-ant-ccb00c.md',
  '2026-07-14-el-unico-objetivo-que-tenia-la-intervencion-era-recaudar-y-apropiarse-de-un-puer-aa2498.md',
  '2026-07-14-rio-grande-vuelve-a-alentar-a-la-seleccion-transmitiran-el-partido-entre-argenti-1afcc5.md'
];

async function run() {
  for (const filename of draftsToProcess) {
    const filePath = path.join(ROOT, 'src/content/borradores', filename);
    const content = await fs.readFile(filePath, 'utf8');
    
    // Parse frontmatter
    const urlMatch = content.match(/^sourceUrl:\s*["'](.*?)["']/m);
    const titleMatch = content.match(/^title:\s*["'](.*?)["']/m);
    const catMatch = content.match(/^category:\s*["'](.*?)["']/m);
    const imgMatch = content.match(/^originalImage:\s*["'](.*?)["']/m);
    
    const url = urlMatch ? urlMatch[1] : '';
    const title = titleMatch ? titleMatch[1] : '';
    const category = catMatch ? catMatch[1] : 'Provincia';
    const originalImage = imgMatch ? imgMatch[1] : '';
    
    const bodyContent = content.split('## Material fuente detectado')[1] || content;

    console.log(`Processing: ${title}`);
    
    const item = {
      title,
      url,
      description: bodyContent.slice(0, 300),
      content: bodyContent
    };
    
    try {
      const ai = await writeArticleWithModel({ item, source: { id: 'manual' }, existingTitles: new Set(), category });
      console.log(`AI Rewrote: ${ai.title}`);
      
      let finalImage = originalImage;
      if (originalImage.startsWith('http')) {
        const normalized = await normalizeImageAsset(originalImage, { seed: ai.slug, purpose: 'web' });
        if (normalized.ok) {
           finalImage = normalized.publicPath;
        } else {
           finalImage = await generateWebPlate({ slug: ai.slug, title: ai.title, category });
        }
      }
      
      const newMarkdown = makeNewsMarkdown({
        ...ai,
        image: finalImage,
        originalImage,
        imageAlt: ai.title,
        sourceName: 'Rescate',
        sourceUrl: url,
        detectedAt: new Date().toISOString()
      });
      
      const outPath = path.join(ROOT, 'src/content/noticias', `${ai.slug}.md`);
      await fs.writeFile(outPath, newMarkdown, 'utf8');
      console.log(`Saved to ${outPath}`);
      
      // Delete draft
      await fs.unlink(filePath).catch(() => {});
    } catch (e) {
      console.error(`Failed to process ${filename}:`, e);
    }
  }
}

run().catch(console.error);
