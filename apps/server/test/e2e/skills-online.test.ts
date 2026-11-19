import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../../src/api/event-hub.ts';
import { buildServer } from '../../src/api/server.ts';
import { loadVerifiedSkill } from '../../src/skills/loader.ts';
import { fakeGithub, SHA, skillMd } from '../fixtures/fake-github.ts';
import { type Engine, startEngine } from './harness.ts';

let e: Engine;
let app: ReturnType<typeof buildServer>;
let hub: EventHub;
const token = 't'.repeat(32);
const auth = { authorization: `Bearer ${token}` };
const PDF = 'https://github.com/acme/skills/tree/main/skills/pdf';
let github = fakeGithub('acme', 'skills', { files: {} });

const repo = {
  files: {
    'skills/pdf/SKILL.md': skillMd('pdf', 'tools: [read_file, shell]\n'),
    'skills/pdf/scripts/run.py': 'print("hi")',
    'skills/xlsx/SKILL.md': skillMd('xlsx'),
  },
};

beforeAll(async () => {
  e = await startEngine();
  hub = new EventHub(e.db, e.config.DATABASE_URL);
  await hub.start();
  github = fakeGithub('acme', 'skills', repo);
  app = buildServer({ ...e.deps, hub, skillFetch: (url) => github.fetch(url) }, token, false);
});
afterAll(async () => {
  await app?.close();
  await hub?.close();
  await e?.close();
});
beforeEach(async () => {
  await e.reset();
  github = fakeGithub('acme', 'skills', repo);
});

const post = (url: string, payload: object) =>
  app.inject({ method: 'POST', url, headers: auth, payload });
const lookup = (url: string) => post('/api/skills/lookup', { url });
const skills = async () => (await app.inject({ url: '/api/skills', headers: auth })).json();

describe('installing a skill from the web', () => {
  it('shows what it would install first, then installs exactly that, pinned to the commit', async () => {
    const looked = await lookup(PDF);
    expect(looked.statusCode).toBe(200);
    const preview = looked.json();
    expect(preview).toMatchObject({
      kind: 'skill',
      name: 'pdf',
      commit: SHA,
      sourceUrl: `https://github.com/acme/skills/tree/${SHA}/skills/pdf`,
      files: [{ path: 'SKILL.md' }, { path: 'scripts/run.py' }],
    });
    expect(preview.warnings.some((w: { text: string }) => /shell commands/.test(w.text))).toBe(
      true,
    );
    // Looking is not installing.
    expect(await skills()).toEqual([]);

    const done = await post('/api/skills/install-online', {
      previewId: preview.id,
      checksum: preview.checksum,
    });
    expect(done.statusCode).toBe(201);
    expect(done.json()).toMatchObject({
      name: 'pdf',
      version: '1.0.0',
      sourceUrl: `https://github.com/acme/skills/tree/${SHA}/skills/pdf`,
      sourceRef: SHA,
      manifest: { tools: ['read_file', 'shell'] },
    });
    const [listed] = await skills();
    expect(listed.sourceRef).toBe(SHA);

    // The files are in the skills folder, checksummed and loadable, and the holding area is empty.
    expect(await readFile(join(listed.sourcePath, 'scripts/run.py'), 'utf8')).toBe('print("hi")');
    expect((await loadVerifiedSkill(listed)).name).toBe('pdf');
    expect(existsSync(join(e.config.GANTRIX_SKILLS_DIR, '.incoming', preview.id))).toBe(false);
  });

  it('can be answered once, and only for what was shown', async () => {
    const preview = (await lookup(PDF)).json();
    const ok = { previewId: preview.id, checksum: preview.checksum };
    expect((await post('/api/skills/install-online', ok)).statusCode).toBe(201);
    expect((await post('/api/skills/install-online', ok)).statusCode).toBe(404);
    expect(
      (await post('/api/skills/install-online', { previewId: 'nope', checksum: preview.checksum }))
        .statusCode,
    ).toBe(404);
    expect(
      (await post('/api/skills/install-online', { previewId: preview.id, checksum: 'abc' }))
        .statusCode,
    ).toBe(400);
  });

  it('refuses when the files changed between the review and the yes', async () => {
    const preview = (await lookup(PDF)).json();
    const held = join(e.config.GANTRIX_SKILLS_DIR, '.incoming', preview.id, 'SKILL.md');
    await writeFile(held, skillMd('pdf', 'tools: [read_file, shell, deploy_site]\n'));
    const res = await post('/api/skills/install-online', {
      previewId: preview.id,
      checksum: preview.checksum,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/changed/);
    expect(await skills()).toEqual([]);

    // A made-up checksum is no better.
    const second = (await lookup(PDF)).json();
    const wrong = await post('/api/skills/install-online', {
      previewId: second.id,
      checksum: '0'.repeat(64),
    });
    expect(wrong.statusCode).toBe(409);
  });

  it('will not install the same version twice, and says why', async () => {
    const first = (await lookup(PDF)).json();
    await post('/api/skills/install-online', { previewId: first.id, checksum: first.checksum });
    const again = (await lookup(PDF)).json();
    const res = await post('/api/skills/install-online', {
      previewId: again.id,
      checksum: again.checksum,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/already installed/);
    expect(await skills()).toHaveLength(1);
  });

  it('lists the skills in a repository so one can be picked', async () => {
    const res = await lookup('https://github.com/acme/skills');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      kind: 'choices',
      choices: [
        { name: 'pdf', url: 'https://github.com/acme/skills/tree/main/skills/pdf' },
        { name: 'xlsx', url: 'https://github.com/acme/skills/tree/main/skills/xlsx' },
      ],
    });
  });

  it('turns a bad link or a GitHub failure into a plain message', async () => {
    const bad = await lookup('https://example.com/skills.zip');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/GitHub link/);
    expect((await lookup('http://github.com/acme/skills')).json().error).toMatch(/https/);

    github = fakeGithub('acme', 'skills', {
      ...repo,
      fail: { status: 403, body: 'API rate limit exceeded' },
    });
    const limited = await lookup('https://github.com/acme/skills');
    expect(limited.statusCode).toBe(400);
    expect(limited.json().error).toMatch(/rate limit/);
    expect((await lookup('')).statusCode).toBe(400);
  });
});
