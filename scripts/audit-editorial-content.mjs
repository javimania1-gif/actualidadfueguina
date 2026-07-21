import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { NEWS_DIR } from './lib/news-utils.mjs';
import { PUBLICATION_CATEGORIES, TERRITORIES } from './lib/taxonomy.mjs';
import { normalizeText } from './lib/pipeline-utils.mjs';

function titleTokens(value = '') {
  return new Set(normalizeText(value).split(/\s+/).filter((word) => word.length >= 4));
}

function similarity(left, right) {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
}

const notes = [];
for (const file of await fs.readdir(NEWS_DIR)) {
  if (!file.endsWith('.md')) continue;
  const parsed = matter(await fs.readFile(path.join(NEWS_DIR, file), 'utf8'));
  notes.push({ file, body: parsed.content, ...parsed.data });
}

const critical = [];
const warnings = [];
for (const note of notes) {
  if (!PUBLICATION_CATEGORIES.includes(note.category)) critical.push({ file: note.file, issue: 'invalid-publication-category', value: note.category });
  if (!TERRITORIES.includes(note.territory)) critical.push({ file: note.file, issue: 'invalid-territory', value: note.territory });
  if (!note.scope || !note.classificationVersion) critical.push({ file: note.file, issue: 'missing-classification-metadata' });
  const visualText = normalizeText(`${note.imageAlt || ''} ${note.imageSourceUrl || ''}`);
  if (['national', 'international'].includes(note.scope)
    && /\b(melella|vuoto|martin perez|harrington|tierra del fuego)\b/.test(visualText)
    && !/\b(melella|vuoto|martin perez|harrington|tierra del fuego)\b/.test(normalizeText(`${note.title} ${note.description}`))) {
    critical.push({ file: note.file, issue: 'local-image-outside-tdf-scope' });
  }
  if ((note.classificationConfidence === 'low' || note.classificationConfidence === 'lowest') && note.featured) {
    warnings.push({ file: note.file, issue: 'low-confidence-featured' });
  }
}

for (let left = 0; left < notes.length; left++) {
  for (let right = left + 1; right < notes.length; right++) {
    if (/\bpronostico\b/.test(normalizeText(notes[left].title)) && /\bpronostico\b/.test(normalizeText(notes[right].title))) continue;
    const score = similarity(notes[left].title, notes[right].title);
    if (score >= 0.48) warnings.push({ issue: 'possible-duplicate-story', score: Number(score.toFixed(2)), files: [notes[left].file, notes[right].file] });
  }
}

console.log(JSON.stringify({ notes: notes.length, critical, warnings }, null, 2));
if (critical.length) process.exit(1);
