import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { ROOT, NEWS_DIR, yamlString } from './lib/news-utils.mjs';
import { selectImageForNews, logImageSelection } from './lib/image-plan.mjs';

const TARGETS = [
  {
    file: '2026-07-08-melella-reforma-constitucional-tierra-del-fuego.md',
    verifiedFacts: {
      people: ['Gustavo Melella'],
      places: ['Tierra del Fuego'],
      organizations: ['Gobierno de Tierra del Fuego'],
      eventType: 'legal-policy'
    }
  },
  {
    file: '2026-07-08-discord-ia-baneos-masivos.md',
    verifiedFacts: {
      organizations: ['Discord'],
      eventType: 'technology'
    }
  },
  {
    file: '2026-07-08-errata-argentina-egipto.md',
    verifiedFacts: {
      teams: ['Argentina', 'Egipto'],
      organizations: ['Selección Argentina'],
      eventType: 'sports-result'
    }
  },
  {
    file: '2026-07-07-competencias-deportivas-casa-deporte-tolhuin.md',
    verifiedFacts: {
      places: ['Casa del Deporte de Tolhuin', 'Tolhuin'],
      organizations: ['Municipio de Tolhuin'],
      eventType: 'agenda'
    }
  },
  {
    file: '2026-07-06-parque-termal-tolhuin-capacitacion-temporada-invierno.md',
    verifiedFacts: {
      places: ['Parque Termal Tolhuin', 'Termas de Tolhuin', 'Tolhuin'],
      organizations: ['Municipio de Tolhuin'],
      eventType: 'agenda'
    }
  }
];

function upsertFrontmatterLine(content, key, value) {
  const line = `${key}: ${yamlString(value || '')}`;
  const pattern = new RegExp(`^${key}:.*$`, 'm');
  if (pattern.test(content)) return content.replace(pattern, line);
  return content.replace(/^imageAlt:.*$/m, (match) => `${match}\n${line}`);
}

function updateImageFrontmatter(raw, { image, imageAlt, meta }) {
  let next = raw;
  next = upsertFrontmatterLine(next, 'image', image);
  next = upsertFrontmatterLine(next, 'imageAlt', imageAlt);
  next = upsertFrontmatterLine(next, 'imageStrategy', meta.strategy);
  next = upsertFrontmatterLine(next, 'imageSourceUrl', meta.sourceUrl);
  next = upsertFrontmatterLine(next, 'imageCredit', meta.credit);
  next = upsertFrontmatterLine(next, 'imageLicense', meta.license);
  return next;
}

for (const target of TARGETS) {
  const fullPath = path.join(NEWS_DIR, target.file);
  const raw = await fs.readFile(fullPath, 'utf8');
  const parsed = matter(raw);
  const selection = await selectImageForNews({
    article: {
      title: parsed.data.title,
      description: parsed.data.description,
      image: ''
    },
    ai: {
      title: parsed.data.title,
      description: parsed.data.description,
      category: parsed.data.category,
      location: parsed.data.location,
      tags: parsed.data.tags || [],
      imageAlt: parsed.data.imageAlt
    },
    verification: { verifiedFacts: target.verifiedFacts },
    sourceArticle: {
      title: parsed.data.title,
      description: parsed.data.description
    }
  });

  logImageSelection(selection);
  if (!selection.image || selection.meta?.strategy === 'fallback-plate') {
    console.log(`SIN CAMBIO ${target.file}: no se consiguio imagen representativa.`);
    continue;
  }

  const next = updateImageFrontmatter(raw, {
    image: selection.image,
    imageAlt: selection.imageAlt || parsed.data.imageAlt || parsed.data.title,
    meta: selection.meta
  });
  await fs.writeFile(fullPath, next, 'utf8');
  console.log(`MIGRADA ${target.file}: ${selection.image}`);
}
