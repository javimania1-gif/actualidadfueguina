
import fs from 'node:fs/promises';
import path from 'node:path';
import { DRAFTS_DIR, ensureDirs } from './lib/news-utils.mjs';

await ensureDirs();
const MAX_AGE_DAYS = Number(process.env.AF_DRAFT_MAX_AGE_DAYS || 10);
const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
let removed = 0;

for (const file of await fs.readdir(DRAFTS_DIR)) {
  if (!file.endsWith('.md')) continue;
  const full = path.join(DRAFTS_DIR, file);
  const stat = await fs.stat(full);
  if (stat.mtimeMs < cutoff) {
    await fs.unlink(full);
    removed += 1;
  }
}
console.log(`Borradores eliminados por antigüedad: ${removed}`);
