import fs from 'node:fs/promises';
import path from 'node:path';
import { inferAgendaTopic } from './lib/editorial-agenda.mjs';

const dirs = [
  path.join(process.cwd(), 'src/content/noticias'),
  path.join(process.cwd(), 'src/content/borradores')
];

async function migrate() {
  console.log('Migrando categorías...');
  for (const dir of dirs) {
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const filePath = path.join(dir, file);
        let content = await fs.readFile(filePath, 'utf-8');
        
        // Extraer título
        const titleMatch = content.match(/^title:\s*['"](.*?)['"]$/m);
        const title = titleMatch ? titleMatch[1] : '';
        
        // Extraer categoría antigua
        const oldCatMatch = content.match(/^category:\s*['"](.*?)['"]$/m);
        const oldCat = oldCatMatch ? oldCatMatch[1] : '';

        // Si ya es una de las nuevas temáticas o Mundo/Nacionales, tal vez la dejamos o forzamos re-cálculo
        // Mejor re-calcular todas para estar seguros.
        
        let newTopic = inferAgendaTopic({ title, category: oldCat, facts: {} });
        newTopic = newTopic.charAt(0).toUpperCase() + newTopic.slice(1);
        if (newTopic === 'Agenda') newTopic = 'Actualidad';
        if (newTopic === 'Servicios') newTopic = 'Actualidad';
        
        // Si era explícitamente Mundo o Nacionales, lo mantenemos si la nueva no es policiales o deportes
        if (oldCat === 'Mundo' || oldCat === 'Nacionales') {
           if (newTopic !== 'Deportes' && newTopic !== 'Policiales') {
             newTopic = oldCat;
           }
        }
        
        // Si era Tolhuin, Ushuaia, Rio Grande, Provincia, Antartida, Malvinas, etc. => se cambia al tema.
        if (['Tolhuin', 'Ushuaia', 'Rio Grande', 'Río Grande', 'Provincia', 'Malvinas', 'Antartida', 'Antártida'].includes(oldCat)) {
           // Queda el newTopic (Política, Policiales, etc.)
        } else if (oldCat === 'unknown') {
           newTopic = 'Actualidad';
        }

        content = content.replace(/^category:\s*['"].*?['"]$/m, `category: "${newTopic}"`);
        
        await fs.writeFile(filePath, content, 'utf-8');
        console.log(`Migrado: ${file} | ${oldCat} -> ${newTopic}`);
      }
    } catch (e) {
      console.log(`No se pudo procesar el directorio ${dir}`, e.message);
    }
  }
  console.log('Migración completa.');
}

migrate();
