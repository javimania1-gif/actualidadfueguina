import { defineCollection, z } from 'astro:content';

const noticias = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string().max(180),
    date: z.coerce.date(),
    sourcePublishedAt: z.coerce.date().optional(),
    category: z.string(),
    topic: z.string().default('Actualidad'),
    territory: z.string().default('Provincia'),
    scope: z.enum(['local', 'provincial', 'national', 'international', 'unknown']).default('provincial'),
    secondaryTerritories: z.array(z.string()).default([]),
    classificationConfidence: z.enum(['high', 'medium', 'low', 'lowest']).default('low'),
    classificationReason: z.string().default('legacy'),
    classificationVersion: z.number().int().default(1),
    storyId: z.string().optional(),
    storyVersion: z.number().int().positive().default(1),
    tags: z.array(z.string()).default([]),
    image: z.string().optional(),
    imageAlt: z.string().optional(),
    imageStrategy: z.string().optional(),
    imageSourceUrl: z.string().url().optional(),
    imageCredit: z.string().optional(),
    imageLicense: z.string().optional(),
    author: z.string().default('Actualidad Fueguina'),
    featured: z.boolean().default(false),
    location: z.string().optional(),
    sourceName: z.string().optional(),
    sourceUrl: z.string().url().optional(),
    automated: z.boolean().default(false),
    dailyDigest: z.boolean().default(false),
    importance: z.number().min(1).max(10).default(5),
    social: z.object({
      enabled: z.boolean().default(true),
      urgent: z.boolean().default(false)
    }).default({ enabled: true, urgent: false })
  })
});

const borradores = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string().max(180),
    date: z.coerce.date(),
    category: z.string(),
    topic: z.string().optional(),
    territory: z.string().optional(),
    scope: z.enum(['local', 'provincial', 'national', 'international', 'unknown']).optional(),
    location: z.string().optional(),
    sourceName: z.string(),
    sourceUrl: z.string().url(),
    originalImage: z.string().optional(),
    status: z.enum(['draft', 'review', 'approved']).default('draft'),
    detectedAt: z.coerce.date(),
    mode: z.string().optional()
  })
});

export const collections = { noticias, borradores };
