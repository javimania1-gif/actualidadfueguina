
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import {
  ROOT, NEWS_DIR, slugify, datePrefix, callModel, makeNewsMarkdown, ensureDirs
} from './lib/news-utils.mjs';

await ensureDirs();

const todayAR = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Argentina/Ushuaia',
  year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

const files = (await fs.readdir(NEWS_DIR)).filter((f) => f.endsWith('.md'));
const notes = [];

for (const file of files) {
  const full = path.join(NEWS_DIR, file);
  const parsed = matter(await fs.readFile(full, 'utf8'));
  const d = new Date(parsed.data.date);
  const dateAR = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Ushuaia',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
  if (dateAR === todayAR && !parsed.data.dailyDigest) {
    notes.push({
      title: parsed.data.title,
      description: parsed.data.description,
      category: parsed.data.category,
      location: parsed.data.location
    });
  }
}

if (notes.length < 3) {
  console.log(`No se crea resumen: solo hay ${notes.length} notas del día.`);
  process.exit(0);
}

const syntheticSource = notes.map((n, i) =>
  `${i + 1}. ${n.title}\n${n.description}\nCategoría: ${n.category}; ubicación: ${n.location || ''}`
).join('\n\n');

const ai = await callModel({
  sourceName: 'Producción propia de Actualidad Fueguina',
  sourceUrl: 'https://actualidadfueguina.com.ar/',
  sourceTitle: `Resumen del día ${todayAR}`,
  sourceDescription: 'Síntesis de las noticias publicadas por Actualidad Fueguina durante la jornada.',
  sourceText: `Prepará un panorama diario que conecte y jerarquice estas noticias sin agregar hechos nuevos:\n\n${syntheticSource}`,
  defaultCategory: 'Provincia',
  defaultLocation: 'Tierra del Fuego AIAS'
});

ai.title = ai.title || `Tierra del Fuego hoy: las claves de la jornada`;
ai.tags = [...new Set(['Resumen del día', 'Tierra del Fuego', ...(ai.tags || [])])].slice(0, 6);

const filename = `${datePrefix()}-${slugify(ai.title)}.md`;
const target = path.join(NEWS_DIR, filename);
let markdown = makeNewsMarkdown({
  ai,
  date: new Date(),
  image: '',
  sourceName: 'Actualidad Fueguina',
  sourceUrl: 'https://actualidadfueguina.com.ar/',
  featured: false
});
markdown = markdown.replace('automated: true', 'automated: true\ndailyDigest: true');
await fs.writeFile(target, markdown, 'utf8');
console.log(`Resumen diario publicado: ${ai.title}`);
