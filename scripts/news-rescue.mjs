import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, loadSeen } from './lib/news-utils.mjs';
import { canonicalizeNewsUrl } from './lib/pipeline-utils.mjs';
import {
  loadDraftBackfillRecords,
  loadRescueQueue,
  saveRescueQueue,
  selectRescueBackfillCandidates
} from './lib/rescue-utils.mjs';

function option(name, fallback = '') {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback;
}

const apply = process.argv.includes('--apply');
const sinceHours = Number(option('since-hours', '72'));
const max = Number(option('max', '10'));
const reason = option('reason');
const sourceId = option('source');
const seen = await loadSeen();
const records = await loadDraftBackfillRecords({ seen });
const publishedUrls = new Set();

for (const file of await fs.readdir(path.join(ROOT, 'src/content/noticias')).catch(() => [])) {
  if (!file.endsWith('.md')) continue;
  const content = await fs.readFile(path.join(ROOT, 'src/content/noticias', file), 'utf8');
  const sourceUrl = content.match(/^sourceUrl:\s*['"](.*?)['"]$/m)?.[1] || '';
  if (sourceUrl) publishedUrls.add(canonicalizeNewsUrl(sourceUrl));
}

const candidates = selectRescueBackfillCandidates({
  records,
  publishedUrls,
  sinceHours,
  max,
  reason,
  sourceId
});

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  filters: { sinceHours, max, reason: reason || null, sourceId: sourceId || null },
  candidates: candidates.map(({ title, sourceUrl, sourceId: source, category, publishedAt, status, reason: why, draftFile }) => ({
    title, sourceUrl, source, category, publishedAt, status, reason: why, draftFile
  }))
}, null, 2));

if (apply && candidates.length) {
  const queue = await loadRescueQueue();
  const existing = new Set((queue.items || []).map((item) => canonicalizeNewsUrl(item.sourceUrl)));
  for (const candidate of candidates) {
    if (existing.has(candidate.sourceUrl)) continue;
    queue.items.push({
      id: candidate.id,
      status: 'rescue-pending',
      sourceId: candidate.sourceId,
      category: candidate.category,
      location: candidate.location,
      sourceUrl: candidate.sourceUrl,
      title: candidate.title,
      publishedAt: candidate.publishedAt,
      draftFile: candidate.draftFile,
      queuedAt: new Date().toISOString(),
      attempts: 0
    });
    existing.add(candidate.sourceUrl);
  }
  await saveRescueQueue(queue);
}
