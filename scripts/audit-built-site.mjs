import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './lib/news-utils.mjs';

const dist = path.join(ROOT, 'dist');
const required = [
  'index.html', 'rss.xml', 'news-sitemap.xml', 'search.json',
  'categorias/actualidad/index.html', 'categorias/politica/index.html',
  'categorias/economia/index.html', 'categorias/sociedad/index.html',
  'categorias/policiales/index.html', 'categorias/deportes/index.html',
  'categorias/nacionales/index.html', 'categorias/mundo/index.html',
  'categorias/malvinas/index.html', 'categorias/antartida/index.html',
  'malvinas-antartica/index.html', 'privacidad/index.html', 'cookies/index.html',
  'terminos/index.html', 'politica-editorial/index.html', 'correcciones/index.html',
  'quienes-somos/index.html', 'contacto/index.html', 'anuncia/index.html'
];

const missing = [];
for (const relative of required) {
  try {
    await fs.access(path.join(dist, relative));
  } catch {
    missing.push(relative);
  }
}

const requiredContent = [
  ['index.html', 'data-commercial-promo'],
  ['index.html', 'wa.me/5492964621291'],
  ['contacto/index.html', '2964 621291'],
  ['anuncia/index.html', 'Buenas Vibras TDF SAS'],
  ['quienes-somos/index.html', 'Cómo trabajamos']
];
const missingContent = [];
for (const [relative, expected] of requiredContent) {
  try {
    const html = await fs.readFile(path.join(dist, relative), 'utf8');
    if (!html.includes(expected)) missingContent.push({ relative, expected });
  } catch {
    missingContent.push({ relative, expected });
  }
}

const htmlFiles = [];
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(absolute);
    else if (entry.name.endsWith('.html')) htmlFiles.push(absolute);
  }
}
await walk(dist);

const brokenInternalLinks = new Set();
for (const file of htmlFiles) {
  const html = await fs.readFile(file, 'utf8');
  for (const match of html.matchAll(/href="(\/[^"]*)"/g)) {
    const pathname = match[1].split(/[?#]/)[0];
    if (!pathname || pathname.startsWith('//')) continue;
    const target = pathname.endsWith('/') ? path.join(dist, pathname, 'index.html') : path.join(dist, pathname);
    try {
      await fs.access(target);
    } catch {
      brokenInternalLinks.add(pathname);
    }
  }
}

if (missing.length || missingContent.length || brokenInternalLinks.size) {
  console.error(JSON.stringify({ missing, missingContent, brokenInternalLinks: [...brokenInternalLinks].sort() }, null, 2));
  process.exit(1);
}
console.log(`Auditoría estática OK: ${htmlFiles.length} páginas HTML, ${required.length} rutas críticas.`);
