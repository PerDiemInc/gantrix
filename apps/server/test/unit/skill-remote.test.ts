import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findSkillFolders,
  lookupSkill,
  MAX_FILE_BYTES,
  MAX_FILES,
  PreviewStore,
  parseSkillSource,
  planFiles,
  reviewSkill,
  SkillSourceError,
} from '../../src/skills/remote.ts';
import { fakeGithub, SHA, skillMd } from '../fixtures/fake-github.ts';

describe('where a skill may come from', () => {
  it('reads a repository, a folder, a SKILL.md and its raw link', () => {
    expect(parseSkillSource('https://github.com/acme/skills')).toEqual({
      kind: 'github',
      owner: 'acme',
      repo: 'skills',
      rest: [],
      blob: false,
    });
    expect(parseSkillSource('https://github.com/acme/skills.git')).toMatchObject({
      repo: 'skills',
    });
    expect(parseSkillSource('https://github.com/acme/skills/tree/main/skills/pdf')).toMatchObject({
      rest: ['main', 'skills', 'pdf'],
      blob: false,
    });
    expect(
      parseSkillSource('https://github.com/acme/skills/blob/main/skills/pdf/SKILL.md'),
    ).toMatchObject({ rest: ['main', 'skills', 'pdf', 'SKILL.md'], blob: true });
    expect(
      parseSkillSource('https://raw.githubusercontent.com/acme/skills/main/pdf/SKILL.md'),
    ).toMatchObject({ kind: 'github', rest: ['main', 'pdf', 'SKILL.md'], blob: true });
    expect(parseSkillSource('https://example.com/stuff/SKILL.md')).toEqual({
      kind: 'file',
      url: 'https://example.com/stuff/SKILL.md',
    });
  });

  it('reads a skills.sh link: the skill is found by name once the repository is listed', () => {
    expect(parseSkillSource('https://www.skills.sh/anthropics/skills/frontend-design')).toEqual({
      kind: 'github',
      owner: 'anthropics',
      repo: 'skills',
      rest: [],
      blob: false,
      pick: 'frontend-design',
    });
    expect(parseSkillSource('https://skills.sh/anthropics/skills')).toEqual({
      kind: 'github',
      owner: 'anthropics',
      repo: 'skills',
      rest: [],
      blob: false,
    });
    for (const bad of [
      'https://skills.sh/',
      'https://skills.sh/trending',
      'https://skills.sh/a/b/c/d',
      'https://skills.sh/a/b/c d',
    ]) {
      expect(() => parseSkillSource(bad), bad).toThrow(/skills\.sh link/);
    }
  });

  it('refuses everything else', () => {
    const bad: [string, RegExp][] = [
      ['not a link', /not a link/],
      ['http://github.com/acme/skills', /https/],
      ['https://user:pw@github.com/acme/skills', /password/],
      ['https://example.com/skills.zip', /GitHub link/],
      ['https://github.com/acme', /repository/],
      ['https://github.com/acme/skills/issues/4', /folder/],
      ['https://github.com/acme/ski lls', /repository/],
      ['https://gist.github.com/acme/abc', /GitHub link/],
    ];
    for (const [input, why] of bad) {
      expect(() => parseSkillSource(input), input).toThrow(why);
    }
  });
});

describe('what is in a skill folder', () => {
  const entry = (path: string, over: Record<string, unknown> = {}) => ({
    path,
    mode: '100644',
    type: 'blob' as const,
    size: 10,
    ...over,
  });
  const at = { owner: 'a', repo: 'b', ref: 'main', sha: SHA, dir: 'skills/pdf' };

  it('lists every folder with a SKILL.md under a place', () => {
    const tree = [
      entry('README.md'),
      entry('skills/pdf/SKILL.md'),
      entry('skills/xlsx/SKILL.md'),
      entry('skills/xlsx/ref/notes.md'),
      entry('other/skill.md'),
    ];
    expect(findSkillFolders(tree, '')).toEqual(['skills/pdf', 'skills/xlsx']);
    expect(findSkillFolders(tree, 'skills/pdf')).toEqual(['skills/pdf']);
    expect(findSkillFolders(tree, 'docs')).toEqual([]);
  });

  it('plans the files of one folder, relative to it, pinned to the commit', () => {
    const files = planFiles(
      [
        entry('skills/pdf/SKILL.md'),
        entry('skills/pdf/ref/a.md'),
        entry('skills/xlsx/SKILL.md'),
        entry('skills/pdf', { type: 'tree' }),
      ],
      at,
    );
    expect(files.map((f) => f.path)).toEqual(['SKILL.md', 'ref/a.md']);
    expect(files[0]?.url).toBe(`https://raw.githubusercontent.com/a/b/${SHA}/skills/pdf/SKILL.md`);
  });

  it('skips .git and node_modules, like the installer does', () => {
    expect(
      planFiles([entry('skills/pdf/SKILL.md'), entry('skills/pdf/node_modules/x/i.js')], at).map(
        (f) => f.path,
      ),
    ).toEqual(['SKILL.md']);
  });

  it('refuses symlinks, submodules, binaries, big files and too many files', () => {
    expect(() => planFiles([entry('skills/pdf/l', { mode: '120000' })], at)).toThrow(/symlink/);
    expect(() =>
      planFiles([entry('skills/pdf/m', { type: 'commit', mode: '160000' })], at),
    ).toThrow(/submodule/);
    expect(() => planFiles([entry('skills/pdf/logo.png')], at)).toThrow(/binary file/);
    expect(() => planFiles([entry('skills/pdf/big.md', { size: MAX_FILE_BYTES + 1 })], at)).toThrow(
      /limit for one file/,
    );
    expect(() =>
      planFiles(
        Array.from({ length: MAX_FILES + 1 }, (_, i) => entry(`skills/pdf/f${i}.md`)),
        at,
      ),
    ).toThrow(/too many/);
    expect(() =>
      planFiles(
        Array.from({ length: 6 }, (_, i) => entry(`skills/pdf/f${i}.md`, { size: 400_000 })),
        at,
      ),
    ).toThrow(/add up to/);
  });

  it('refuses names that could leave the folder', () => {
    expect(() => planFiles([entry('skills/pdf/../../etc/passwd')], at)).toThrow(
      /not a safe file name/,
    );
    expect(() => planFiles([entry('skills/pdf/a\\b.md')], at)).toThrow(/not a safe file name/);
  });
});

describe('looking a skill up', () => {
  let dir: string;
  let store: PreviewStore;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gantrix-remote-'));
    store = new PreviewStore(dir);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const repo = {
    files: {
      'README.md': '# skills',
      'skills/pdf/SKILL.md': skillMd('pdf', 'tools: [read_file, shell]\n'),
      'skills/pdf/scripts/run.py': 'print(1)',
      'skills/xlsx/SKILL.md': skillMd('xlsx'),
    },
  };

  it('describes a skill, pinned to the commit, and installs nothing', async () => {
    const gh = fakeGithub('acme', 'skills', repo);
    const r = await lookupSkill(
      store,
      'https://github.com/acme/skills/tree/main/skills/pdf',
      gh.fetch,
    );
    expect(r.kind).toBe('skill');
    if (r.kind !== 'skill') return;
    expect(r).toMatchObject({
      name: 'pdf',
      version: '1.0.0',
      commit: SHA,
      source: 'github.com/acme/skills/skills/pdf',
      sourceUrl: `https://github.com/acme/skills/tree/${SHA}/skills/pdf`,
      files: [
        { path: 'SKILL.md', size: expect.any(Number) },
        { path: 'scripts/run.py', size: 8 },
      ],
    });
    expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(r.manifest.tools).toEqual(['read_file', 'shell']);
    expect(r.instructions).toBe('Be careful with pdf.');
    expect(r.warnings.map((w) => w.level)).toContain('caution');
    expect(r.warnings.some((w) => /shell commands/.test(w.text))).toBe(true);
    expect(r.warnings.some((w) => /script file/.test(w.text))).toBe(true);
    expect(existsSync(join(store.root, r.id, 'SKILL.md'))).toBe(true);
    // Held for a yes, in a folder of its own: not in the skills folder proper.
    expect(existsSync(join(dir, 'pdf'))).toBe(false);
  });

  it('lists the skills in a repository so one can be picked', async () => {
    const gh = fakeGithub('acme', 'skills', repo);
    const r = await lookupSkill(store, 'https://github.com/acme/skills', gh.fetch);
    expect(r).toEqual({
      kind: 'choices',
      source: 'github.com/acme/skills',
      choices: [
        {
          name: 'pdf',
          path: 'skills/pdf',
          url: 'https://github.com/acme/skills/tree/main/skills/pdf',
        },
        {
          name: 'xlsx',
          path: 'skills/xlsx',
          url: 'https://github.com/acme/skills/tree/main/skills/xlsx',
        },
      ],
    });
    // Nothing was downloaded for a list: two API calls and no files.
    expect(gh.calls.filter((c) => c.includes('raw.githubusercontent')).length).toBe(0);
  });

  it('reads a branch name with a slash in it', async () => {
    const gh = fakeGithub('acme', 'skills', { ...repo, refs: { 'feature/x': SHA } });
    const r = await lookupSkill(
      store,
      'https://github.com/acme/skills/tree/feature/x/skills/xlsx',
      gh.fetch,
    );
    expect(r).toMatchObject({ kind: 'skill', name: 'xlsx', commit: SHA });
  });

  it('takes a direct link to a SKILL.md, and a blob link to one on GitHub', async () => {
    const direct = await lookupSkill(store, 'https://example.com/x/SKILL.md', async () => ({
      status: 200,
      body: skillMd('solo'),
    }));
    expect(direct).toMatchObject({
      kind: 'skill',
      name: 'solo',
      commit: null,
      sourceUrl: 'https://example.com/x/SKILL.md',
      files: [{ path: 'SKILL.md' }],
    });
    const gh = fakeGithub('acme', 'skills', repo);
    expect(
      await lookupSkill(
        store,
        'https://github.com/acme/skills/blob/main/skills/xlsx/SKILL.md',
        gh.fetch,
      ),
    ).toMatchObject({ kind: 'skill', name: 'xlsx' });
  });

  it('finds the folder for a skills.sh link by the skill name', async () => {
    const gh = fakeGithub('acme', 'skills', repo);
    const found = await lookupSkill(store, 'https://www.skills.sh/acme/skills/xlsx', gh.fetch);
    expect(found).toMatchObject({
      kind: 'skill',
      name: 'xlsx',
      source: 'github.com/acme/skills/skills/xlsx',
      sourceUrl: `https://github.com/acme/skills/tree/${SHA}/skills/xlsx`,
      commit: SHA,
    });
    // A skill with that name in several places: pick which.
    const twice = fakeGithub('acme', 'skills', {
      files: { ...repo.files, 'old/pdf/SKILL.md': skillMd('pdf', '', '0.1.0') },
    });
    const choices = await lookupSkill(store, 'https://skills.sh/acme/skills/pdf', twice.fetch);
    expect(choices).toMatchObject({
      kind: 'choices',
      choices: [{ path: 'old/pdf' }, { path: 'skills/pdf' }],
    });
    // A name that is not in the repository.
    await expect(
      lookupSkill(store, 'https://skills.sh/acme/skills/nope', gh.fetch),
    ).rejects.toThrow(/Couldn't find a skill called "nope" in acme\/skills/);
    // Just the repository, from skills.sh: the list.
    expect(await lookupSkill(store, 'https://skills.sh/acme/skills', gh.fetch)).toMatchObject({
      kind: 'choices',
    });
  });

  it('says what went wrong, in words, and leaves nothing held', async () => {
    const held = store.size;
    const gh = (r: object) => fakeGithub('acme', 'skills', { ...repo, ...r }).fetch;
    const fails: [string, object, RegExp][] = [
      ['https://github.com/acme/skills/tree/nope/skills/pdf', {}, /branch or tag/],
      ['https://github.com/acme/skills/tree/main/docs', {}, /No SKILL\.md found in docs/],
      ['https://github.com/acme/skills', { fail: { status: 404, body: '' } }, /public/],
      [
        'https://github.com/acme/skills',
        { fail: { status: 403, body: 'API rate limit exceeded' } },
        /rate limit/,
      ],
      ['https://github.com/acme/skills', { truncated: true }, /too large/],
      [
        'https://github.com/acme/skills/tree/main/skills/pdf',
        { files: { 'skills/pdf/SKILL.md': 'no frontmatter here' } },
        /isn't a valid skill/,
      ],
      [
        'https://github.com/acme/skills/tree/main/skills/pdf',
        { files: { 'skills/pdf/SKILL.md': skillMd('pdf'), 'skills/pdf/notes.txt': 'x\0y' } },
        /not a text file/,
      ],
    ];
    for (const [url, over, why] of fails) {
      await expect(lookupSkill(store, url, gh(over)), url).rejects.toThrow(why);
    }
    await expect(
      lookupSkill(store, 'https://github.com/acme/skills/tree/main/skills/pdf', async () => ({
        status: 500,
        body: '',
      })),
    ).rejects.toBeInstanceOf(SkillSourceError);
    expect(store.size).toBe(held);
  });
});

describe('the holding area', () => {
  it('hands a skill over once, forgets it after its time, and caps how many it holds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gantrix-hold-'));
    try {
      const store = new PreviewStore(dir, 1_000, 2);
      const held = (id: string, expires: number) => ({
        dir: join(store.root, id),
        expires,
        preview: {} as never,
      });
      const a = await store.create(0);
      store.hold(a.id, held(a.id, 1_000));
      expect(store.take(a.id, 500)).toBeDefined();
      expect(store.take(a.id, 500)).toBeUndefined(); // once

      const b = await store.create(0);
      store.hold(b.id, held(b.id, 1_000));
      expect(store.take(b.id, 1_500)).toBeUndefined(); // too late
      await store.sweep(1_500);
      expect(existsSync(join(store.root, b.id))).toBe(false);

      const c = await store.create(2_000);
      store.hold(c.id, held(c.id, 9_000));
      const d = await store.create(2_000);
      store.hold(d.id, held(d.id, 9_000));
      const e = await store.create(2_000); // a third one pushes the oldest out
      store.hold(e.id, held(e.id, 9_000));
      expect(store.size).toBe(2);
      expect(existsSync(join(store.root, c.id))).toBe(false);

      await store.startFresh();
      expect(existsSync(store.root)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('what a skill can do, in words', () => {
  const skill = (m: object) =>
    ({ manifest: { tools: [], mcpServers: {}, autoApprove: [], ...m } }) as never;

  it('says so when it is only instructions', () => {
    expect(reviewSkill(skill({}), [])).toEqual([
      { level: 'info', text: 'It has no tools of its own: it only gives the agent instructions.' },
    ]);
  });

  it('spells out shell, the programs it starts, and what it wants to run unasked', () => {
    const w = reviewSkill(
      skill({
        tools: ['shell', 'web_fetch'],
        mcpServers: { search: { command: 'npx', args: ['-y', 'some-mcp'], env: { KEY: 'x' } } },
        autoApprove: ['web_fetch'],
      }),
      [{ path: 'setup.sh' }],
    );
    const text = w.map((x) => x.text).join('\n');
    expect(text).toContain('Can run shell commands');
    expect(text).toContain('npx -y some-mcp');
    expect(text).toContain('with variables KEY');
    expect(text).toContain('run without asking: web_fetch');
    expect(text).toContain('1 script file (setup.sh)');
    expect(w.filter((x) => x.level === 'caution').length).toBeGreaterThanOrEqual(4);
  });
});
