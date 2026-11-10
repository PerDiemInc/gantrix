import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer, get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPreviewServer } from '../../src/preview.ts';
import { alwaysAsks, requiresApproval } from '../../src/skills/policy.ts';
import { webFetchTool } from '../../src/skills/tools/web.ts';
import { resolveInWorkspace } from '../../src/skills/workspace.ts';

const dirs: string[] = [];
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'gx-sec-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('workspace paths', () => {
  it("won't write through a broken symlink to a file outside the workspace", async () => {
    const ws = await temp();
    const outside = await temp();
    await symlink(join(outside, 'evil.plist'), join(ws, 'x')); // the target doesn't exist yet
    await expect(resolveInWorkspace(ws, 'x')).rejects.toThrow(/broken symlink/);
    await expect(resolveInWorkspace(ws, 'notes/new.md')).resolves.toContain(ws.split('/').pop());
  });
});

describe('approvals', () => {
  it('always asks before an outreach email, whatever a skill says', () => {
    expect(alwaysAsks('outreach_send_email')).toBe(true);
    expect(alwaysAsks('outreach_check_contact')).toBe(false);
    expect(requiresApproval('deploy_site', new Set(['deploy_site']))).toBe(true);
  });
});

describe('the preview server', () => {
  it('refuses a rebound Host and only redirects plain site names', async () => {
    const sites = await temp();
    const server = createPreviewServer(sites);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const get = (path: string, host = `127.0.0.1:${port}`) =>
      new Promise<{ status: number; location?: string }>((resolve, reject) => {
        const req = httpGet({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
          res.resume();
          resolve({
            status: res.statusCode ?? 0,
            ...(res.headers.location ? { location: res.headers.location } : {}),
          });
        });
        req.on('error', reject);
      });
    try {
      expect((await get('/', 'evil.example:4702')).status).toBe(421);
      expect(await get('/bakery')).toEqual({ status: 301, location: '/bakery/' });
      expect((await get('/%5Cevil.com')).status).toBe(404);
      expect((await get('/\\evil.com')).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('web_fetch', () => {
  it('refuses names that resolve to this machine', async () => {
    const server = createServer((_req, res) => res.end('secret'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      for (const url of [`http://localhost:${port}/`, `http://127.0.0.1:${port}/`]) {
        const out = String(await webFetchTool().invoke({ url }));
        expect(out, url).toContain('private or local address');
        expect(out).not.toContain('secret');
      }
    } finally {
      server.close();
    }
  });
});
