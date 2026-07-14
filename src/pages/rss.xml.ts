import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { marked } from 'marked';
import { SITE } from '../data/site';

export async function GET(context) {
  const noticias = (await getCollection('noticias'))
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf())
    .slice(0, 50);

  return rss({
    title: SITE.name,
    description: SITE.description,
    site: context.site || SITE.url,
    items: noticias.map((nota) => {
      // Parse markdown body to HTML for full content
      const htmlContent = marked.parse(nota.body || '');
      
      // Resolve absolute image URL
      let imageUrl = '';
      if (nota.data.image) {
        if (nota.data.image.startsWith('http')) {
          imageUrl = nota.data.image;
        } else {
          imageUrl = `${SITE.url}${nota.data.image.startsWith('/') ? '' : '/'}${nota.data.image}`;
        }
      }

      // Build custom tags for Google News
      let customData = '';
      if (imageUrl) {
        customData += `<media:content url="${imageUrl}" medium="image" />`;
      }
      if (htmlContent) {
        customData += `<content:encoded><![CDATA[${htmlContent}]]></content:encoded>`;
      }
      
      // Add category tag
      if (nota.data.category) {
        customData += `<category><![CDATA[${nota.data.category}]]></category>`;
      }

      return {
        title: nota.data.title,
        pubDate: nota.data.date,
        description: nota.data.description,
        link: `/noticias/${nota.slug}/`,
        customData
      };
    }),
    xmlns: {
      media: 'http://search.yahoo.com/mrss/',
      content: 'http://purl.org/rss/1.0/modules/content/'
    }
  });
}
