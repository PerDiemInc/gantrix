import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { hostnameOf } from './api/auth.ts';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** The file a URL path maps to, inside the sites folder only (no .., no symlinks out). */
export async function resolveSitePath(root: string, urlPath: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const base = await realpath(root).catch(() => null);
  if (!base) return null;
  let target = resolve(base, `.${decoded}`);
  if (target !== base && !target.startsWith(base + sep)) return null;
  const info = await stat(target).catch(() => null);
  if (info?.isDirectory()) target = join(target, 'index.html');
  const real = await realpath(target).catch(() => null);
  if (!real || (real !== base && !real.startsWith(base + sep))) return null;
  return real;
}

/**
 * Serves sites published with deploy_site, on their own port: a site runs on a different
 * origin from the dashboard, so its scripts can't read the dashboard's token.
 */
export function createPreviewServer(
  sitesDir: string,
  o: { checkHost: boolean } = { checkHost: true },
): Server {
  return createServer(async (req, res) => {
    // A page that rebinds its own domain to 127.0.0.1 sends that domain as Host.
    if (o.checkHost && !LOOPBACK.has(hostnameOf(req.headers.host ?? '').toLowerCase())) {
      res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Unexpected Host');
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const url = req.url ?? '/';
    if (url === '/' || url === '') {
      const names = await readdir(sitesDir, { withFileTypes: true }).catch(() => []);
      const sites = names.filter((d) => d.isDirectory()).map((d) => d.name);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Gantrix sites</title><style>body{font:16px/1.6 system-ui;margin:40px}</style><h1>Sites deployed by your agents</h1>${
          sites.length
            ? `<ul>${sites.map((s) => `<li><a href="/${encodeURIComponent(s)}/">${escapeHtml(s)}</a></li>`).join('')}</ul>`
            : '<p>None yet. An agent with the deploy_site tool publishes here.</p>'
        }`,
      );
      return;
    }
    // "/name" → "/name/" so relative links inside the site work.
    const first = url.split('?')[0] ?? '';
    if (/^\/[a-z0-9][a-z0-9-]*$/i.test(first)) {
      // a site name only: "/\\evil.com" isn't one
      res.writeHead(301, { Location: `${first}/` }).end();
      return;
    }
    const file = await resolveSitePath(sitesDir, url);
    const body = file ? await readFile(file).catch(() => null) : null;
    if (!file || !body) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}
