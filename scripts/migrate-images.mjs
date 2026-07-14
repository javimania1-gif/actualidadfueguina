import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import {
  ROOT,
  NEWS_DIR,
  normalizeImageAsset,
  generateWebPlate
} from './lib/news-utils.mjs';
import { isOfficialDomain } from './lib/source-policy.mjs';

const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config/sources.json'), 'utf8'));
const officialDomains = config.officialDomains || [];
const DRY_RUN = process.argv.includes('--dry-run');

async function exists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

function slugFromFile(file) {
  return file.replace(/\.md$/, '');
}

async function makePlate({ slug, title, category }) {
  const filename = `plate-${slug}.jpg`;
  const fullPath = path.join(ROOT, 'public/uploads/auto', filename);
  await generateWebPlate({
    title: title || 'Actualidad Fueguina',
    category: category || 'Actualidad',
    outputPath: fullPath
  });
  return `/uploads/auto/${filename}`;
}

async function chooseLocalImage({ slug, data }) {
  let image = String(data.image || '').trim();
  
  if (!image) {
    const originalImage = String(data.originalImage || '').trim();
    if (originalImage.startsWith('http')) {
      image = originalImage;
    } else {
      return {
        image: await makePlate({ slug, title: data.title, category: data.category }),
        reason: 'missing-image'
      };
    }
  }

  if (image.startsWith('/')) {
    const localPath = path.join(ROOT, 'public', image);
    if (await exists(localPath)) return { image, reason: 'already-local' };
    return {
      image: await makePlate({ slug, title: data.title, category: data.category }),
      reason: 'missing-local-file'
    };
  }

  if (image.startsWith('http')) {
    const normalized = await normalizeImageAsset(image, {
      seed: slug,
      purpose: 'web'
    });
    if (normalized.ok) {
      return { image: normalized.publicPath, reason: 'external-image-normalized' };
    }
    
    return {
      image: await makePlate({ slug, title: data.title, category: data.category }),
      reason: 'external-image-normalization-failed'
    };
  }

  return {
    image: await makePlate({ slug, title: data.title, category: data.category }),
    reason: 'unsupported-image-reference'
  };
}

const changed = [];
const files = (await fs.readdir(NEWS_DIR)).filter((file) => file.endsWith('.md')).sort();

for (const file of files) {
  const fullPath = path.join(NEWS_DIR, file);
  const original = await fs.readFile(fullPath, 'utf8');
  const parsed = matter(original);
  const slug = slugFromFile(file);
  const result = await chooseLocalImage({ slug, data: parsed.data });

  if (result.image === String(parsed.data.image || '').trim()) continue;

  let next = original;
  if (/^image:\s.*$/m.test(next)) {
    next = next.replace(/^image:\s.*$/m, `image: ${JSON.stringify(result.image)}`);
  } else {
    next = next.replace(/^tags:\s.*$/m, `$&\nimage: ${JSON.stringify(result.image)}`);
  }

  if (!/^imageAlt:\s.*$/m.test(next)) {
    next = next.replace(/^image:\s.*$/m, `$&\nimageAlt: ${JSON.stringify(parsed.data.imageAlt || parsed.data.title || 'Actualidad Fueguina')}`);
  }

  changed.push({ file, image: result.image, reason: result.reason });
  if (!DRY_RUN) await fs.writeFile(fullPath, next, 'utf8');
}

console.log(JSON.stringify({
  dryRun: DRY_RUN,
  changed
}, null, 2));
