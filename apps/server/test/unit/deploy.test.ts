import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSitePath } from '../../src/preview.ts';
import { deploySiteTool } from '../../src/skills/tools/deploy.ts';

let root: string;
let workspace: string;
let sites: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'deploy-'));
  workspace = join(root, 'ws');
  sites = join(root, 'sites');
  await mkdir(join(workspace, 'site'), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('deploy_site', () => {
  it('copies a site folder to the sites dir and returns its preview URL', async () => {
    await writeFile(join(workspace, 'site', 'index.html'), '<h1>Hi</h1>');
    const deploy = deploySiteTool(workspace, {
      sitesDir: sites,
      previewUrl: 'http://127.0.0.1:4702',
    });
    expect(await deploy.invoke({ folder: 'site', name: 'bakery' })).toBe(
      'Deployed site/ to http://127.0.0.1:4702/bakery/',
    );
    expect(await readFile(join(sites, 'bakery', 'index.html'), 'utf8')).toBe('<h1>Hi</h1>');
  });

  it('refuses a folder without index.html or outside the workspace', async () => {
    const deploy = deploySiteTool(workspace, { sitesDir: sites, previewUrl: 'http://x' });
    expect(await deploy.invoke({ folder: 'site', name: 'empty' })).toMatch(/no index\.html/);
    expect(await deploy.invoke({ folder: '../', name: 'escape' })).toMatch(/^Error/);
  });
});

describe('preview server paths', () => {
  it('serves files inside the sites dir only', async () => {
    await mkdir(join(sites, 'a'), { recursive: true });
    await writeFile(join(sites, 'a', 'index.html'), 'x');
    await writeFile(join(root, 'secret.txt'), 's');
    await symlink(join(root, 'secret.txt'), join(sites, 'a', 'link.txt'));
    expect(await resolveSitePath(sites, '/a/')).toBe(
      await import('node:fs/promises').then((f) => f.realpath(join(sites, 'a', 'index.html'))),
    );
    expect(await resolveSitePath(sites, '/../secret.txt')).toBeNull();
    expect(await resolveSitePath(sites, '/a/%2e%2e/%2e%2e/secret.txt')).toBeNull();
    expect(await resolveSitePath(sites, '/a/link.txt')).toBeNull();
  });
});
