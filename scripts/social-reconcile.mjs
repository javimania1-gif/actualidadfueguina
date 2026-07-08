import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './lib/news-utils.mjs';

const SOCIAL_DATA_PATH = path.join(ROOT, 'data/social-posts.json');
const META_GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || 'v25.0';
const APPLY = process.argv.includes('--apply');
const DELETE = process.argv.includes('--delete');
const keyArg = process.argv.find((arg) => arg.startsWith('--key='));
const remoteArg = process.argv.find((arg) => arg.startsWith('--remote-id='));
const key = keyArg?.slice('--key='.length);
const remoteIdArg = remoteArg?.slice('--remote-id='.length);

const accessToken = process.env.META_PAGE_ACCESS_TOKEN;

if (!key && !remoteIdArg) {
  console.error('Uso: node scripts/social-reconcile.mjs --key=slug|facebook [--delete --apply]');
  console.error('  o: node scripts/social-reconcile.mjs --remote-id=PAGE_POST_ID');
  process.exit(2);
}

const socialData = JSON.parse(await fs.readFile(SOCIAL_DATA_PATH, 'utf8'));
const record = key ? socialData.posts?.[key] : null;
const remoteId = remoteIdArg || record?.remoteId;

if (!remoteId) {
  console.error(JSON.stringify({ ok: false, reason: 'missing-remote-id', key }, null, 2));
  process.exit(1);
}

if (!accessToken) {
  console.error(JSON.stringify({
    ok: false,
    reason: 'missing-meta-token',
    key,
    remoteId,
    destructiveActionTaken: false
  }, null, 2));
  process.exit(1);
}

async function graph(pathname, options = {}) {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${pathname}`);
  url.searchParams.set('access_token', accessToken);
  for (const [name, value] of Object.entries(options.query || {})) {
    url.searchParams.set(name, value);
  }
  const response = await fetch(url, {
    method: options.method || 'GET'
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(JSON.stringify({ status: response.status, body }));
  }
  return body;
}

const status = await graph(remoteId, {
  query: {
    fields: 'id,message,permalink_url,created_time,is_hidden,status_type'
  }
});

let deleteResult = null;
if (DELETE) {
  if (!APPLY) {
    deleteResult = { dryRun: true, message: 'Se requiere --apply para eliminar remotamente.' };
  } else {
    deleteResult = await graph(remoteId, { method: 'DELETE' });
    if (record) {
      record.status = 'cancelled';
      record.cancelledAt = new Date().toISOString();
      record.cancelReason = 'Post remoto eliminado mediante social-reconcile.';
      await fs.writeFile(SOCIAL_DATA_PATH, JSON.stringify(socialData, null, 2) + '\n', 'utf8');
    }
  }
}

console.log(JSON.stringify({
  ok: true,
  key,
  remoteId,
  remote: status,
  deleteResult,
  destructiveActionTaken: Boolean(DELETE && APPLY)
}, null, 2));
