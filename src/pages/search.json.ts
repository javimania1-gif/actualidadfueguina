import { getCollection } from 'astro:content';

export async function GET() {
  const noticias = await getCollection('noticias');
  
  const searchIndex = noticias.map((nota) => ({
    title: nota.data.title,
    slug: nota.slug,
    category: nota.data.category,
    date: nota.data.date,
    image: nota.data.image,
    description: nota.data.description
  }));

  return new Response(JSON.stringify(searchIndex), {
    status: 200,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}
