import { defineCollection, z } from 'astro:content';

const noticias = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string().max(180),
    date: z.coerce.date(),
    category: z.string(),
    tags: z.array(z.string()).default([]),
    image: z.string().optional(),
    imageAlt: z.string().optional(),
    author: z.string().default('Actualidad Fueguina'),
    featured: z.boolean().default(false),
    location: z.string().optional()
  })
});

export const collections = { noticias };
