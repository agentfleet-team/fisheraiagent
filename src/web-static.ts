import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
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

export interface WebAssetOptions {
  // The build token the page stamps on its asset URLs (?v=<commit>); a
  // request that carries it asks for that exact build.
  assetVersion?: string;
  // The request carried ?v= — the URL names the build, so the response
  // may be cached long.
  versioned?: boolean;
}

// The page and every unversioned URL can drift a build behind after a
// deploy, so a cache must never reuse them without asking. `no-store`
// also survives Cloudflare's default browser TTL, which raises a smaller
// origin freshness — plain `no-cache` included — to its own max-age.
const CACHE_FRESH = 'no-cache, no-store';
// A versioned URL names its bytes exactly: it may be cached long. A year
// is far above Cloudflare's 4-hour browser TTL, which respects the
// higher of the two values.
const CACHE_VERSIONED = 'public, max-age=31536000, immutable';

// Stamp the page's own asset references with ?v=<version> so a deploy
// changes the URLs a browser fetches. Only same-origin paths that map to
// a served content type are stamped — links like /auth/login are not.
function versionAssetRefs(html: string, assetVersion: string): string {
  if (assetVersion === '') return html;
  const v = encodeURIComponent(assetVersion);
  return html.replace(/(src|href)="(\/[^"#?]+)"/g, (match, attr: string, path: string) =>
    CONTENT_TYPES[extname(path).toLowerCase()] !== undefined ? `${attr}="${path}?v=${v}"` : match,
  );
}

// Serves the static page from web/ for GET/HEAD requests outside /v1.
// Returns false when nothing matched so the caller can send its own 404.
export async function serveWebAsset(
  method: string,
  pathname: string,
  res: ServerResponse,
  options: WebAssetOptions = {},
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
  const ext = extname(file).toLowerCase();
  const type = CONTENT_TYPES[ext];
  if (!type) return false;
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) return false;
  const cacheControl = ext !== '.html' && options.versioned ? CACHE_VERSIONED : CACHE_FRESH;
  const headers = { 'content-type': type, 'cache-control': cacheControl };
  if (ext === '.html') {
    // The HTML references its assets by build, so it is rewritten per
    // request; its own length changes with the stamp.
    const html = await readFile(file, 'utf8')
      .then((text) => versionAssetRefs(text, options.assetVersion ?? ''))
      .catch(() => undefined);
    if (html === undefined) return false;
    res.writeHead(200, { ...headers, 'content-length': Buffer.byteLength(html) });
    res.end(method === 'HEAD' ? undefined : html);
    return true;
  }
  res.writeHead(200, { ...headers, 'content-length': info.size });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  // A stream that fails mid-send destroys the response; no error text ever
  // leaves this path — a miss fell through to the caller's fixed 404 above.
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
  return true;
}
