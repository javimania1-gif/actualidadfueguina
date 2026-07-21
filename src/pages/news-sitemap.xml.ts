import { getCollection } from 'astro:content';
import { SITE } from '../data/site';

function xml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export async function GET() {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const noticias = (await getCollection('noticias'))
    .filter((nota) => nota.data.date.valueOf() >= cutoff)
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
  const urls = noticias.map((nota) => `
  <url>
    <loc>${xml(`${SITE.url}/noticias/${nota.slug}/`)}</loc>
    <news:news>
      <news:publication>
        <news:name>${xml(SITE.name)}</news:name>
        <news:language>es</news:language>
      </news:publication>
      <news:publication_date>${nota.data.date.toISOString()}</news:publication_date>
      <news:title>${xml(nota.data.title)}</news:title>
    </news:news>
  </url>`).join('');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">${urls}
</urlset>\n`, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
