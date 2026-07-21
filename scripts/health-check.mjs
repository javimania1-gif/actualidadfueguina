
const targets = [
  process.env.AF_SITE_URL || 'https://actualidadfueguina.com.ar/',
  'https://actualidadfueguina.javimania1.workers.dev/'
];

let base = '';
for (const url of targets) {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    const html = await response.text();
    if (response.ok && /Actualidad Fueguina/i.test(html)) {
      base = response.url;
      console.log(`OK portada: ${response.status} ${response.url}`);
      break;
    }
    console.warn(`Portada no válida en ${url}: ${response.status}`);
  } catch (error) {
    console.warn(`Error en ${url}: ${error.message}`);
  }
}

if (!base) {
  console.error('ERROR: ninguna portada respondió correctamente.');
  process.exit(1);
}

const origin = new URL(base).origin;
const checks = [
  '/rss.xml', '/news-sitemap.xml', '/search.json',
  '/categorias/actualidad/', '/categorias/politica/', '/categorias/economia/', '/categorias/sociedad/',
  '/categorias/policiales/', '/categorias/deportes/', '/categorias/nacionales/', '/categorias/mundo/',
  '/categorias/malvinas/', '/categorias/antartida/', '/malvinas-antartica/',
  '/privacidad/', '/cookies/', '/terminos/', '/politica-editorial/', '/correcciones/'
];
let failures = 0;

for (const pathname of checks) {
  try {
    const response = await fetch(new URL(pathname, origin), { redirect: 'follow' });
    if (!response.ok) {
      console.error(`FALLA ${response.status}: ${pathname}`);
      failures += 1;
    } else {
      console.log(`OK ${response.status}: ${pathname}`);
    }
  } catch (error) {
    console.error(`FALLA ${pathname}: ${error.message}`);
    failures += 1;
  }
}

if (failures > 0) process.exit(1);
console.log('Salud del sitio: OK');
