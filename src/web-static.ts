import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../web/', import.meta.url)));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Serves the static page from web/ for GET/HEAD requests outside /v1.
// Returns false when nothing matched so the caller can send its own 404.
export async function serveWebAsset(
  method: string,
  pathname: string,
  res: ServerResponse,
): Promise<boolean> {
  if (method !== 'GET' && method !== 'HEAD') return false;
  let rel: string;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    return false;
  }
  if (rel.includes('\0')) return false;
  const file = normalize(join(ROOT, rel));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return false;
  const type = CONTENT_TYPES[extname(file).toLowerCase()];
  if (!type) return false;
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return false;
  res.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    'cache-control': 'no-cache',
  });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file).pipe(res);
  return true;
}
