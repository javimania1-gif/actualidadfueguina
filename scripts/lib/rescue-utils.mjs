import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { ROOT } from './news-utils.mjs';
import { canonicalizeNewsUrl, MAX_RETRY_ATTEMPTS } from './pipeline-utils.mjs';

export const RESCUE_QUEUE_PATH = path.join(ROOT, 'data/news-rescue-queue.json');

const RESCUABLE_STATUSES = new Set([
  'draft', 'model-error', 'extract-error', 'temporary-error', 'failed-retryable',
  'budget-deferred', 'publication-deferred', 'rescue-pending'
]);

export function selectRescueBackfillCandidates({
  records = [],
  publishedUrls = new Set(),
  now = Date.now(),
  sinceHours = 72,
  max = 10,
  reason = '',
  sourceId = ''
} = {}) {
  const cutoff = now - Math.max(1, Number(sinceHours) || 72) * 60 * 60 * 1000;
  const selected = [];
  const seenUrls = new Set();

  for (const record of records) {
    const status = record.status || 'draft';
    if (!RESCUABLE_STATUSES.has(status)) continue;
    if ((Number(record.attempts) || 0) >= MAX_RETRY_ATTEMPTS) continue;
    if (reason && record.reason !== reason) continue;
    if (sourceId && record.sourceId !== sourceId) continue;
    const sourceUrl = canonicalizeNewsUrl(record.sourceUrl || '');
    if (!sourceUrl || publishedUrls.has(sourceUrl) || seenUrls.has(sourceUrl)) continue;
    const publishedAt = new Date(record.publishedAt || 0).getTime();
    const detectedAt = new Date(record.detectedAt || record.seenAt || 0).getTime();
    const freshnessReference = Number.isFinite(publishedAt) && publishedAt > 0 ? publishedAt : detectedAt;
    if (!Number.isFinite(freshnessReference) || freshnessReference < cutoff || freshnessReference > now + 6 * 60 * 60 * 1000) continue;
    seenUrls.add(sourceUrl);
    selected.push({ ...record, sourceUrl });
    if (selected.length >= Math.max(1, Number(max) || 10)) break;
  }
  return selected;
}

export function selectRunnableRescueItems(queue = {}, { now = Date.now(), max = 4 } = {}) {
  return (queue.items || [])
    .filter((item) => ['rescue-pending', 'failed-retryable', 'budget-deferred', 'publication-deferred'].includes(item.status))
    .filter((item) => {
      const next = new Date(item.nextRetryAt || 0).getTime();
      return !item.nextRetryAt || !Number.isFinite(next) || next <= now;
    })
    .filter((item) => (Number(item.attempts) || 0) < MAX_RETRY_ATTEMPTS)
    .slice(0, Math.max(0, Number(max) || 0));
}

export async function loadRescueQueue() {
  try {
    return JSON.parse(await fs.readFile(RESCUE_QUEUE_PATH, 'utf8'));
  } catch {
    return { version: 1, updatedAt: null, items: [] };
  }
}

export async function saveRescueQueue(queue) {
  queue.version = 1;
  queue.updatedAt = new Date().toISOString();
  queue.items = (queue.items || []).slice(-250);
  await fs.writeFile(RESCUE_QUEUE_PATH, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
}

export async function loadDraftBackfillRecords({ seen = { items: {} }, draftsDir } = {}) {
  const dir = draftsDir || path.join(ROOT, 'src/content/borradores');
  const seenByFile = new Map();
  for (const record of Object.values(seen.items || {})) {
    if (!record?.file) continue;
    const key = String(record.file).replace(/\\/g, '/').toLowerCase();
    const previous = seenByFile.get(key);
    if (!previous || String(record.seenAt || '') > String(previous.seenAt || '')) seenByFile.set(key, record);
  }

  const records = [];
  for (const file of await fs.readdir(dir).catch(() => [])) {
    if (!file.endsWith('.md')) continue;
    const absolute = path.join(dir, file);
    const parsed = matter(await fs.readFile(absolute, 'utf8'));
    const relative = path.relative(ROOT, absolute).replace(/\\/g, '/');
    const state = seenByFile.get(relative.toLowerCase()) || {};
    records.push({
      id: canonicalizeNewsUrl(parsed.data.sourceUrl || '') || relative,
      title: parsed.data.title || '',
      sourceUrl: parsed.data.sourceUrl || '',
      sourceId: state.source || '',
      category: parsed.data.category || '',
      location: parsed.data.location || '',
      publishedAt: parsed.data.date || '',
      detectedAt: parsed.data.detectedAt || state.seenAt || '',
      seenAt: state.seenAt || '',
      status: state.status || 'draft',
      reason: state.draftReason || state.failureReason || '',
      attempts: state.attempts || 0,
      draftFile: relative
    });
  }
  return records;
}
