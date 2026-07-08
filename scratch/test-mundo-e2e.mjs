import fs from 'fs/promises';
import { readSource, materialize } from '../scripts/lib/news-utils.mjs';

const config = JSON.parse(await fs.readFile('./config/sources.json', 'utf8'));
const mundoSources = config.sources.filter(s => s.forceCategory === 'Mundo');

for (const source of mundoSources) {
  console.log(`\n=== Probando fuente: ${source.name} ===`);
  try {
    const items = await readSource(source);
    console.log(`- RSS respondido correctamente. Items encontrados: ${items.length}`);
    const toTest = items.slice(0, 3);
    for (const item of toTest) {
      console.log(`\n  -> Extrayendo URL original: ${item.link}`);
      try {
        const article = await materialize(item);
        console.log(`  -> URL resuelta: ${article.finalUrl}`);
        console.log(`  -> Título extraído: ${article.title || item.title}`);
        console.log(`  -> Cuerpo extraído (${(article.text || '').length} caracteres)`);
      } catch (err) {
        console.log(`  -> Error extrayendo: ${err.message}`);
      }
    }
  } catch (err) {
    console.log(`- Error leyendo RSS: ${err.message}`);
  }
}
