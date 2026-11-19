import { describe, expect, it } from 'vitest';
import { withGithubAuth } from '../../src/skills/remote.ts';
import { FEATURED, readFrontmatter, SkillSearcher } from '../../src/skills/search.ts';
import { fakeGithub, skillMd } from '../fixtures/fake-github.ts';
import { fakeWeb, json, site } from '../fixtures/fake-web.ts';

const ALL = ['skills-sh', 'featured', 'github', 'github-code'] as const;
const run = (
  web: ReturnType<typeof fakeWeb>,
  q: string,
  sources: readonly (typeof ALL)[number][] = ALL,
  githubToken = false,
  searcher = new SkillSearcher(),
) => searcher.search(web.fetch, { q, sources, githubToken, connection: githubToken ? 'gh' : null });

const skillsSh = (skills: unknown[], status = 200) =>
  site({ 'https://skills.sh/api/search': () => json({ skills }, status) });

describe('searching skills.sh', () => {
  const entries = [
    { id: 'a/small/pdf', source: 'a/small', skillId: 'pdf', name: 'pdf', installs: 10 },
    {
      id: 'anthropics/skills/pdf',
      source: 'anthropics/skills',
      skillId: 'pdf',
      name: 'pdf',
      installs: 233_000,
    },
    { id: 'smithery.ai/pdf', source: 'smithery.ai', skillId: 'pdf', name: 'pdf', installs: 6_000 },
    { id: 'x/y/', source: 'x/y', skillId: '', name: '', installs: 1 },
  ];

  it('lists skills by installs, each as a skills.sh link to review', async () => {
    const web = fakeWeb(skillsSh(entries));
    const r = await run(web, ' pdf ', ['skills-sh']);
    expect(r.query).toBe('pdf');
    expect(r.hits.map((h) => h.id)).toEqual([
      'skills-sh:anthropics/skills/pdf',
      'skills-sh:a/small/pdf',
    ]);
    expect(r.hits[0]).toMatchObject({
      kind: 'skill',
      source: 'skills-sh',
      sourceLabel: 'skills.sh',
      repo: 'anthropics/skills',
      installs: 233_000,
      url: 'https://skills.sh/anthropics/skills/pdf',
    });
    expect(web.calls[0]?.url).toBe('https://skills.sh/api/search?q=pdf');
  });

  it("says which results can't be installed, because they are not on GitHub", async () => {
    const r = await run(fakeWeb(skillsSh(entries)), 'pdf', ['skills-sh']);
    expect(r.notes).toEqual([
      { source: 'skills-sh', level: 'info', text: expect.stringContaining('smithery.ai') },
    ]);
  });

  it('words the note for one outside source and for several', async () => {
    const two = [
      ...entries,
      {
        id: 'modelscope.cn/pdf',
        source: 'modelscope.cn',
        skillId: 'pdf',
        name: 'pdf',
        installs: 3,
      },
    ];
    expect((await run(fakeWeb(skillsSh(entries)), 'pdf', ['skills-sh'])).notes[0]?.text).toBe(
      "1 result comes from outside GitHub (smithery.ai), so it can't be installed here.",
    );
    expect((await run(fakeWeb(skillsSh(two)), 'pdf', ['skills-sh'])).notes[0]?.text).toBe(
      "Results from 2 sources come from outside GitHub (smithery.ai, modelscope.cn), so they can't be installed here.",
    );
  });

  it('asks for two characters before searching, and does not call out', async () => {
    const web = fakeWeb(skillsSh(entries));
    const r = await run(web, 'p', ['skills-sh']);
    expect(r.hits).toEqual([]);
    expect(r.notes[0]?.text).toMatch(/at least 2 characters/);
    expect(web.calls).toHaveLength(0);
  });

  it('says so when skills.sh is down, without hiding the other sources', async () => {
    const down = site({ 'https://skills.sh/': () => ({ status: 503, body: '' }) });
    const gh = fakeGithub('o', 'r', { files: {} });
    const r = await run(fakeWeb(down, gh.fetch), 'pdf', ['skills-sh']);
    expect(r.hits).toEqual([]);
    expect(r.notes).toEqual([
      { source: 'skills-sh', level: 'problem', text: expect.stringContaining('503') },
    ]);
    expect((await run(fakeWeb(skillsSh([], 200)), 'pdf', ['skills-sh'])).notes).toEqual([]);
  });
});

describe('searching GitHub repositories', () => {
  const repoSearch = (items: Record<string, unknown[]>, fail?: { status: number; body: string }) =>
    site({
      'https://api.github.com/search/repositories': (url) => {
        if (fail) return fail;
        const q = decodeURIComponent(new URL(url).searchParams.get('q') ?? '');
        const key = [...Object.keys(items)].find((k) => q.includes(k));
        return json({ items: key ? items[key] : [] });
      },
    });
  const repo = (full: string, stars: number, description = '') => ({
    full_name: full,
    name: full.split('/')[1],
    html_url: `https://github.com/${full}`,
    description,
    stargazers_count: stars,
  });

  it('asks for repositories tagged as holding skills, and merges and ranks the answers', async () => {
    const web = fakeWeb(
      repoSearch({
        'topic:agent-skills': [repo('a/one', 50, 'First'), repo('b/two', 500)],
        'topic:claude-skills': [repo('b/two', 500), repo('c/three', 5000, 'Third')],
        'in:readme': [repo('d/four', 5)],
      }),
    );
    const r = await run(web, 'design', ['github']);
    expect(r.hits.map((h) => h.repo)).toEqual(['c/three', 'b/two', 'a/one', 'd/four']);
    expect(r.hits[0]).toMatchObject({
      kind: 'repo',
      stars: 5000,
      url: 'https://github.com/c/three',
      description: 'Third',
    });
    const urls = web.calls.map((c) => decodeURIComponent(c.url));
    expect(urls.some((u) => u.includes('design topic:agent-skills'))).toBe(true);
    expect(urls.some((u) => u.includes('design topic:claude-skills'))).toBe(true);
    expect(urls.some((u) => u.includes('design SKILL.md in:readme'))).toBe(true);
  });

  it('browses the tagged repositories when nothing is typed', async () => {
    const web = fakeWeb(repoSearch({ 'topic:agent-skills': [repo('a/one', 9)] }));
    const r = await run(web, '', ['github']);
    expect(r.hits).toHaveLength(1);
    expect(web.calls.length).toBe(2); // no keyword query without keywords
  });

  it('turns a rate limit into a note that says what to do', async () => {
    const r = await run(
      fakeWeb(repoSearch({}, { status: 403, body: 'API rate limit exceeded' })),
      'x',
      ['github'],
    );
    expect(r.hits).toEqual([]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatchObject({
      level: 'problem',
      text: expect.stringContaining('GitHub connection raises it'),
    });
  });
});

describe('searching inside GitHub repositories', () => {
  const code = (status: number, items: unknown[] = []) =>
    site({
      'https://api.github.com/search/code': () =>
        status === 200 ? json({ items }) : { status, body: '' },
    });
  const item = (full: string, path: string) => ({
    path,
    html_url: `https://github.com/${full}/blob/${'b'.repeat(40)}/${path}`,
    repository: { full_name: full, description: `${full} repo` },
  });

  it('needs a GitHub connection, and says so instead of failing', async () => {
    const web = fakeWeb(code(200));
    const r = await run(web, 'pdf', ['github-code'], false);
    expect(r.hits).toEqual([]);
    expect(r.notes[0]).toMatchObject({
      level: 'info',
      text: expect.stringContaining('GitHub connection'),
    });
    expect(web.calls).toHaveLength(0);
  });

  it('finds SKILL.md files, one hit per skill folder, linking the file for review', async () => {
    const web = fakeWeb(
      code(200, [
        item('acme/skills', 'skills/pdf/SKILL.md'),
        item('acme/skills', 'skills/pdf/SKILL.md'),
        item('acme/skills', 'skills/pdf/notes.md'),
        item('solo/skill', 'SKILL.md'),
      ]),
    );
    const r = await run(web, 'pdf', ['github-code'], true);
    expect(r.hits).toEqual([
      expect.objectContaining({
        name: 'pdf',
        repo: 'acme/skills',
        path: 'skills/pdf',
        kind: 'skill',
        description: 'acme/skills repo',
      }),
      expect.objectContaining({ name: 'skill', repo: 'solo/skill', path: null }),
    ]);
    expect(r.hits[0]?.url).toContain('/blob/');
    expect(r.githubConnection).toBe('gh');
    expect(decodeURIComponent(web.calls[0]?.url ?? '')).toContain('pdf filename:SKILL.md');
  });

  it('explains a refusal as a token problem, and asks for words to search', async () => {
    for (const status of [403, 422]) {
      const r = await run(fakeWeb(code(status)), 'pdf', ['github-code'], true);
      expect(r.notes[0]?.text).toMatch(/token that is allowed to search code/);
    }
    expect((await run(fakeWeb(code(200)), '', ['github-code'], true)).notes[0]?.text).toMatch(
      /Type something/,
    );
    expect((await run(fakeWeb(code(401)), 'pdf', ['github-code'], true)).notes[0]?.text).toMatch(
      /rejected the token/,
    );
  });
});

describe('featured collections', () => {
  const anthropic = fakeGithub('anthropics', 'skills', {
    files: {
      'README.md': '# x',
      'skills/frontend-design/SKILL.md': skillMd('frontend-design'),
      'skills/pdf/SKILL.md': skillMd('pdf'),
      'spec/SKILL.md': skillMd('not-a-skill-here'),
    },
  });
  const gantrix = fakeGithub('PerDiemInc', 'gantrix', {
    files: { 'examples/skills/exec-cto/SKILL.md': skillMd('exec-cto') },
  });

  it('lists the skills in each collection, with their descriptions, and nothing outside its folder', async () => {
    const r = await run(fakeWeb(anthropic.fetch, gantrix.fetch), '', ['featured']);
    expect(r.hits.map((h) => `${h.repo}:${h.name}`)).toEqual([
      'anthropics/skills:frontend-design',
      'anthropics/skills:pdf',
      'PerDiemInc/gantrix:exec-cto',
    ]);
    expect(r.hits[0]).toMatchObject({
      kind: 'skill',
      path: 'skills/frontend-design',
      description: 'Does frontend-design things.',
      url: `https://github.com/anthropics/skills/tree/${'a'.repeat(40)}/skills/frontend-design`,
      sourceLabel: 'Anthropic skills',
    });
  });

  it('filters by the words typed, in the name or the description', async () => {
    const web = fakeWeb(anthropic.fetch, gantrix.fetch);
    expect((await run(web, 'frontend', ['featured'])).hits.map((h) => h.name)).toEqual([
      'frontend-design',
    ]);
    expect((await run(web, 'things pdf', ['featured'])).hits.map((h) => h.name)).toEqual(['pdf']);
    expect((await run(web, 'zzz', ['featured'])).hits).toEqual([]);
  });

  it('remembers a collection for a few minutes instead of asking GitHub every time', async () => {
    const web = fakeWeb(anthropic.fetch, gantrix.fetch);
    const searcher = new SkillSearcher();
    await run(web, '', ['featured'], false, searcher);
    const first = web.calls.length;
    await run(web, 'pdf', ['featured'], false, searcher);
    expect(web.calls.length).toBe(first);
    // After the time is up it asks again.
    await searcher.search(
      web.fetch,
      { q: '', sources: ['featured'], githubToken: false, connection: null },
      Date.now() + 11 * 60_000,
    );
    expect(web.calls.length).toBeGreaterThan(first);
  });

  it('says which collection failed and still lists the other', async () => {
    const r = await run(fakeWeb(gantrix.fetch), '', ['featured']);
    expect(r.hits.map((h) => h.name)).toEqual(['exec-cto']);
    expect(r.notes).toEqual([
      {
        source: 'featured',
        level: 'problem',
        text: expect.stringContaining(FEATURED[0]?.label ?? ''),
      },
    ]);
  });
});

describe('searching several sources at once', () => {
  it('keeps what worked when one source fails outright', async () => {
    const web = fakeWeb(
      skillsSh([{ id: 'a/b/pdf', source: 'a/b', skillId: 'pdf', name: 'pdf', installs: 1 }]),
      site({
        'https://api.github.com/search/repositories': () => {
          throw new Error('socket hang up');
        },
      }),
    );
    const r = await run(web, 'pdf', ['skills-sh', 'github']);
    expect(r.hits.map((h) => h.source)).toEqual(['skills-sh']);
    expect(r.notes).toEqual([
      { source: 'github', level: 'problem', text: expect.stringContaining('socket hang up') },
    ]);
  });

  it('searches only the sources asked for, and caps a long query', async () => {
    const web = fakeWeb(skillsSh([]));
    await run(web, 'x'.repeat(500), ['skills-sh']);
    expect(web.calls).toHaveLength(1);
    expect(decodeURIComponent(web.calls[0]?.url ?? '').length).toBeLessThan(200);
  });
});

describe('where the GitHub token goes', () => {
  it('signs requests to api.github.com and no other host', async () => {
    const seen: [string, string | undefined][] = [];
    const f = withGithubAuth(async (url, headers) => {
      seen.push([url, headers?.authorization]);
      return { status: 200, body: '' };
    }, 'Bearer secret');
    await f('https://api.github.com/repos/a/b');
    await f('https://raw.githubusercontent.com/a/b/c/SKILL.md');
    await f('https://skills.sh/api/search?q=x');
    expect(seen).toEqual([
      ['https://api.github.com/repos/a/b', 'Bearer secret'],
      ['https://raw.githubusercontent.com/a/b/c/SKILL.md', undefined],
      ['https://skills.sh/api/search?q=x', undefined],
    ]);
  });

  it('changes nothing without a token', () => {
    const f = async () => ({ status: 200, body: '' });
    expect(withGithubAuth(f, null)).toBe(f);
  });
});

describe('reading a SKILL.md for a listing', () => {
  it('takes the name and a one-line description, and survives anything else', () => {
    expect(
      readFrontmatter('---\nname: pdf\ndescription: >\n  Reads and\n  fills PDFs.\n---\nbody'),
    ).toEqual({
      name: 'pdf',
      description: 'Reads and fills PDFs.',
    });
    for (const bad of ['no frontmatter', '---\n: : bad yaml [\n---\n', '']) {
      expect(readFrontmatter(bad)).toEqual({ name: '', description: '' });
    }
  });
});
