import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { ROOT } from './lib/news-utils.mjs';
import { resolvePublicationTerritory } from './lib/territory-resolver.mjs';
import {
  CLASSIFICATION_VERSION,
  canonicalTerritory,
  categoryForPublication,
  inferCanonicalTopic
} from './lib/taxonomy.mjs';

const apply = process.argv.includes('--apply');
const dirs = [path.join(ROOT, 'src/content/noticias')];
if (process.argv.includes('--include-drafts')) dirs.push(path.join(ROOT, 'src/content/borradores'));
const managedFields = [
  'topic',
  'territory',
  'scope',
  'secondaryTerritories',
  'classificationConfidence',
  'classificationReason',
  'classificationVersion'
];

function yaml(value) {
  return JSON.stringify(value);
}

function updateFrontmatter(content, values) {
  let next = content;
  for (const field of managedFields) {
    next = next.replace(new RegExp(`^${field}:.*\\r?\\n`, 'm'), '');
  }
  next = next.replace(/^category:.*$/m, `category: ${yaml(values.category)}`);
  next = next.replace(/^location:.*$/m, `location: ${yaml(values.location)}`);
  const block = [
    `topic: ${yaml(values.topic)}`,
    `territory: ${yaml(values.territory)}`,
    `scope: ${yaml(values.scope)}`,
    `secondaryTerritories: ${yaml(values.secondaryTerritories)}`,
    `classificationConfidence: ${yaml(values.classificationConfidence)}`,
    `classificationReason: ${yaml(values.classificationReason)}`,
    `classificationVersion: ${CLASSIFICATION_VERSION}`
  ].join('\n');
  return next.replace(/^(category:.*)$/m, `$1\n${block}`);
}

const summary = {
  mode: apply ? 'apply' : 'dry-run',
  scanned: 0,
  changed: 0,
  topics: {},
  territories: {},
  lowConfidence: [],
  examples: []
};

for (const dir of dirs) {
  for (const file of await fs.readdir(dir).catch(() => [])) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(dir, file);
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = matter(content);
    const oldCategory = parsed.data.category || '';
    const hasCurrentClassification = Number(parsed.data.classificationVersion) >= CLASSIFICATION_VERSION;
    const oldTerritory = hasCurrentClassification
      ? (parsed.data.classificationConfidence === 'high' ? canonicalTerritory(parsed.data.territory) : '')
      : (canonicalTerritory(parsed.data.territory) || canonicalTerritory(oldCategory));
    const resolution = resolvePublicationTerritory({
      title: parsed.data.title || '',
      description: parsed.data.description || '',
      body: parsed.content,
      source: {
        territory: oldTerritory,
        location: parsed.data.location || '',
        defaultCategory: oldTerritory
      },
      sourceUrl: parsed.data.sourceUrl || ''
    });
    const topic = inferCanonicalTopic({
      title: parsed.data.title || '',
      description: parsed.data.description || '',
      body: parsed.content,
      current: oldCategory
    });
    const values = {
      topic,
      category: categoryForPublication(topic, resolution.scope),
      territory: resolution.primaryTerritory,
      scope: resolution.scope,
      secondaryTerritories: resolution.secondaryTerritories,
      classificationConfidence: resolution.confidence,
      classificationReason: resolution.reason,
      location: resolution.location || parsed.data.location || 'Tierra del Fuego AIAS'
    };
    const next = updateFrontmatter(content, values);
    summary.scanned++;
    summary.topics[topic] = (summary.topics[topic] || 0) + 1;
    summary.territories[values.territory] = (summary.territories[values.territory] || 0) + 1;
    if (['low', 'lowest'].includes(values.classificationConfidence)) summary.lowConfidence.push(file);
    if (next !== content) {
      summary.changed++;
      if (summary.examples.length < 20) {
        summary.examples.push({ file, from: oldCategory, category: values.category, topic, territory: values.territory, reason: values.classificationReason });
      }
      if (apply) await fs.writeFile(filePath, next, 'utf8');
    }
  }
}

console.log(JSON.stringify(summary, null, 2));
