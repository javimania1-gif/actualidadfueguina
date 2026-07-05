import { getCollection } from 'astro:content';
import { SITE } from '../data/site';

export async function GET() {
  const noticias = (await getCollection('noticias'))
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf())
    .slice(0, 50);

  const items = noticias.map((nota) => `
    <item>
      <title><![CDATA[${nota.data.title}]]></title>
      <description><![CDATA[${nota.data.description}]]></description>
      <link>${SITE.url}/noticias/${nota.slug}/</link>
      <guid>${SITE.url}/noticias/${nota.slug}/</guid>
      <pubDate>${nota.data.date.toUTCString()}</pubDate>
      <category><![CDATA[${nota.data.category}]]></category>
    </item>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0">
    <channel>
      <title>${SITE.name}</title>
      <description>${SITE.description}</description>
      <link>${SITE.url}</link>
      <language>es-AR</language>
      ${items}
    </channel>
  </rss>`;

  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
