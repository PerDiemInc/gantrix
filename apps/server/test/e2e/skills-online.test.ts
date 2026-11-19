import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventHub } from '../../src/api/event-hub.ts';
import { buildServer } from '../../src/api/server.ts';
import { loadVerifiedSkill } from '../../src/skills/loader.ts';
import { fakeGithub, SHA, skillMd } from '../fixtures/fake-github.ts';
import { type Call, fakeWeb, json, site } from '../fixtures/fake-web.ts';
import { type Engine, startEngine } from './harness.ts';

let e: Engine;
let app: ReturnType<typeof buildServer>;
let hub: EventHub;
const token = 't'.repeat(32);
const auth = { authorization: `Bearer ${token}` };
const PDF = 'https://github.com/acme/skills/tree/main/skills/pdf';
let github = fakeGithub('acme', 'skills', { files: {} });
// Everything the server fetches goes through here: GitHub, skills.sh and GitHub's search.
let web = fakeWeb(github.fetch);

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
  web = fakeWeb(github.fetch);
  app = buildServer(
    { ...e.deps, hub, skillFetch: (url, headers) => web.fetch(url, headers) },
    token,
    false,
  );
});
afterAll(async () => {
  await app?.close();
  await hub?.close();
  await e?.close();
});
beforeEach(async () => {
  await e.reset();
  github = fakeGithub('acme', 'skills', repo);
  web = fakeWeb(github.fetch);
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
    web = fakeWeb(github.fetch);
    const limited = await lookup('https://github.com/acme/skills');
    expect(limited.statusCode).toBe(400);
    expect(limited.json().error).toMatch(/rate limit/);
    expect((await lookup('')).statusCode).toBe(400);
  });
});

describe('searching for skills online', () => {
  const search = (query: string) =>
    app.inject({ url: `/api/skills/search?${query}`, headers: auth });
  const onlineWorld = () => {
    web = fakeWeb(
      site({
        'https://skills.sh/api/search': () =>
          json({
            skills: [
              {
                id: 'acme/skills/xlsx',
                source: 'acme/skills',
                skillId: 'xlsx',
                name: 'xlsx',
                installs: 900,
              },
              {
                id: 'smithery.ai/xlsx',
                source: 'smithery.ai',
                skillId: 'xlsx',
                name: 'xlsx',
                installs: 5,
              },
            ],
          }),
        'https://api.github.com/search/code': () =>
          json({
            items: [
              {
                path: 'skills/pdf/SKILL.md',
                html_url: `https://github.com/acme/skills/blob/${SHA}/skills/pdf/SKILL.md`,
                repository: { full_name: 'acme/skills', description: 'Acme skills' },
              },
            ],
          }),
      }),
      github.fetch,
    );
  };
  const connect = (headers: Record<string, string>) =>
    post('/api/connections', { name: 'gh', provider: 'github', headers, settings: {} });
  const calls = (host: string): Call[] => web.calls.filter((c) => new URL(c.url).hostname === host);

  it('finds skills on skills.sh and says what it could not offer', async () => {
    onlineWorld();
    const res = await search('q=xlsx&sources=skills-sh');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      query: 'xlsx',
      githubConnection: null,
      hits: [
        {
          id: 'skills-sh:acme/skills/xlsx',
          url: 'https://skills.sh/acme/skills/xlsx',
          installs: 900,
        },
      ],
      notes: [{ source: 'skills-sh', level: 'info', text: expect.stringContaining('smithery.ai') }],
    });
  });

  it('reviews and installs a skill straight from a skills.sh link', async () => {
    onlineWorld();
    const hit = (await search('q=xlsx&sources=skills-sh')).json().hits[0];
    const preview = (await lookup(hit.url)).json();
    expect(preview).toMatchObject({
      kind: 'skill',
      name: 'xlsx',
      commit: SHA,
      source: 'github.com/acme/skills/skills/xlsx',
    });
    const done = await post('/api/skills/install-online', {
      previewId: preview.id,
      checksum: preview.checksum,
    });
    expect(done.statusCode).toBe(201);
    expect(done.json()).toMatchObject({
      name: 'xlsx',
      sourceUrl: `https://github.com/acme/skills/tree/${SHA}/skills/xlsx`,
    });
  });

  it('lists the featured collections, searchable by words', async () => {
    web = fakeWeb(
      fakeGithub('anthropics', 'skills', {
        files: {
          'skills/frontend-design/SKILL.md': skillMd('frontend-design'),
          'skills/pdf/SKILL.md': skillMd('pdf'),
        },
      }).fetch,
    );
    const res = await search('q=frontend&sources=featured');
    expect(res.json().hits).toMatchObject([
      { name: 'frontend-design', repo: 'anthropics/skills', source: 'featured' },
    ]);
    // The other collection could not be reached: said, not hidden.
    expect(res.json().notes[0]).toMatchObject({ source: 'featured', level: 'problem' });
  });

  it('searches inside repositories with the token of a GitHub connection, sent only to api.github.com', async () => {
    onlineWorld();
    const none = (await search('q=pdf&sources=github-code')).json();
    expect(none.hits).toEqual([]);
    expect(none.notes[0].text).toMatch(/GitHub connection/);
    expect(calls('api.github.com')).toHaveLength(0);

    expect((await connect({ Authorization: 'Bearer ghp_test_token' })).statusCode).toBe(201);
    const found = (await search('q=pdf&sources=github-code')).json();
    expect(found.githubConnection).toBe('gh');
    expect(found.hits).toMatchObject([
      { name: 'pdf', repo: 'acme/skills', path: 'skills/pdf', source: 'github-code' },
    ]);
    expect(calls('api.github.com')[0]?.headers?.authorization).toBe('Bearer ghp_test_token');

    // Looking a skill up uses it too, for GitHub's API, but raw files and skills.sh never see it.
    await lookup('https://skills.sh/acme/skills/xlsx');
    for (const c of calls('api.github.com'))
      expect(c.headers?.authorization, c.url).toBe('Bearer ghp_test_token');
    for (const host of ['raw.githubusercontent.com', 'skills.sh']) {
      for (const c of calls(host)) expect(c.headers?.authorization, c.url).toBeUndefined();
    }
  });

  it('works anonymously when the connection token cannot be read, and ignores unknown sources', async () => {
    onlineWorld();
    expect((await connect({ Authorization: 'Bearer env:GANTRIX_NO_SUCH_TOKEN' })).statusCode).toBe(
      201,
    );
    const res = await search('q=xlsx&sources=skills-sh,nonsense');
    expect(res.statusCode).toBe(200);
    expect(res.json().githubConnection).toBeNull();
    expect(res.json().hits).toHaveLength(1);
    expect((await search('q=xlsx&sources=nonsense')).json().hits).toEqual([]);
  });
});
