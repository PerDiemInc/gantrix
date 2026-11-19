import {
  SKILL_SEARCH_SOURCES,
  type SkillHitDto,
  type SkillSearchDto,
  type SkillSearchNote,
  type SkillSearchSource,
} from '@gantrix/shared';
import { parse as parseYaml } from 'yaml';
import { type SkillFetch, SkillSourceError } from './remote.ts';

const SKILLS_SH = 'https://skills.sh/api/search';
const MAX_PER_SOURCE = 30;
const MAX_QUERY = 100;
const FEATURED_TTL_MS = 10 * 60_000;
const FEATURED_DESCRIPTIONS = 4;

const LABEL: Record<SkillSearchSource, string> = {
  'skills-sh': 'skills.sh',
  featured: 'Featured',
  github: 'GitHub',
  'github-code': 'GitHub code',
};

/**
 * Collections worth browsing, each a GitHub repository (and folder) that holds skills. They are
 * listed from the repository itself, so they are as current as it is. Anything installed from
 * them is still shown to you first.
 */
export const FEATURED: { label: string; repo: string; dir: string }[] = [
  { label: 'Anthropic skills', repo: 'anthropics/skills', dir: 'skills' },
  { label: 'Gantrix examples', repo: 'PerDiemInc/gantrix', dir: 'examples/skills' },
];

const REPO = /^[\w.-]+\/[\w.-]+$/;
const api = (path: string) => `https://api.github.com${path}`;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Why GitHub said no, in words a person can act on. */
function githubNote(status: number, body: string, what: string): string {
  if (status === 403 || status === 429) {
    return /rate limit|abuse|secondary/i.test(body) || status === 429
      ? `GitHub's search limit is used up for now (${what}). Wait a minute and try again; a GitHub connection raises it.`
      : `GitHub refused ${what}. The token may not be allowed to search.`;
  }
  if (status === 401) return `GitHub rejected the token in your GitHub connection (${what}).`;
  if (status === 422) return `GitHub could not run that search (${what}). Try different words.`;
  return `GitHub answered ${status} for ${what}.`;
}

interface Found {
  hits: SkillHitDto[];
  notes: SkillSearchNote[];
}

/** skills.sh: a directory of skills with install counts. Its search is not a documented API. */
async function searchSkillsSh(f: SkillFetch, q: string): Promise<Found> {
  const source = 'skills-sh';
  if (q.length < 2) {
    return {
      hits: [],
      notes: [{ source, level: 'info', text: 'Type at least 2 characters to search skills.sh.' }],
    };
  }
  const res = await f(`${SKILLS_SH}?q=${encodeURIComponent(q)}`);
  const data = res.status === 200 ? (parseJson(res.body) as { skills?: unknown[] } | null) : null;
  if (!data || !Array.isArray(data.skills)) {
    return {
      hits: [],
      notes: [
        {
          source,
          level: 'problem',
          text: `skills.sh did not answer the search (${res.status || 'no reply'}). It may be down, or have changed.`,
        },
      ],
    };
  }
  const hits: SkillHitDto[] = [];
  const elsewhere = new Set<string>();
  for (const raw of data.skills) {
    const s = raw as Record<string, unknown>;
    const repo = str(s.source);
    const skill = str(s.skillId) || str(s.name);
    if (!skill) continue;
    // Some entries come from other registries (a domain, not owner/repo): there is no GitHub
    // folder to install from.
    if (!REPO.test(repo)) {
      if (repo) elsewhere.add(repo);
      continue;
    }
    hits.push({
      id: `skills-sh:${repo}/${skill}`,
      source,
      sourceLabel: LABEL[source],
      kind: 'skill',
      name: skill,
      description: repo,
      repo,
      path: null,
      url: `https://skills.sh/${repo}/${skill}`,
      installs: num(s.installs),
      stars: null,
    });
  }
  hits.sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0));
  const notes: SkillSearchNote[] = [];
  if (elsewhere.size) {
    notes.push({
      source,
      level: 'info',
      text: `${elsewhere.size === 1 ? '1 result comes' : `Results from ${elsewhere.size} sources come`} from outside GitHub (${[...elsewhere].slice(0, 3).join(', ')}${elsewhere.size > 3 ? ', …' : ''}), so ${elsewhere.size === 1 ? 'it' : 'they'} can't be installed here.`,
    });
  }
  return { hits: hits.slice(0, MAX_PER_SOURCE), notes };
}

/** GitHub repositories tagged as holding skills, matching the words. Works without a token. */
async function searchGithubRepos(f: SkillFetch, q: string): Promise<Found> {
  const source = 'github';
  const queries = [
    `${q} topic:agent-skills`,
    `${q} topic:claude-skills`,
    ...(q ? [`${q} SKILL.md in:readme`] : []),
  ].map((x) => x.trim());
  const answers = await Promise.all(
    queries.map((query) =>
      f(
        api(
          `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=15`,
        ),
      ),
    ),
  );
  const hits = new Map<string, SkillHitDto>();
  const notes: SkillSearchNote[] = [];
  for (const res of answers) {
    if (res.status !== 200) {
      const text = githubNote(res.status, res.body, 'a repository search');
      if (!notes.some((n) => n.text === text)) notes.push({ source, level: 'problem', text });
      continue;
    }
    const items =
      (parseJson(res.body) as { items?: Record<string, unknown>[] } | null)?.items ?? [];
    for (const r of items) {
      const full = str(r.full_name);
      if (!REPO.test(full) || hits.has(full)) continue;
      hits.set(full, {
        id: `github:${full}`,
        source,
        sourceLabel: LABEL[source],
        kind: 'repo',
        name: str(r.name) || full,
        description: str(r.description) || full,
        repo: full,
        path: null,
        url: str(r.html_url) || `https://github.com/${full}`,
        installs: null,
        stars: num(r.stargazers_count),
      });
    }
  }
  return {
    hits: [...hits.values()]
      .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0))
      .slice(0, MAX_PER_SOURCE),
    notes,
  };
}

/** SKILL.md files on GitHub whose text matches. GitHub only allows this with a token. */
async function searchGithubCode(f: SkillFetch, q: string, hasToken: boolean): Promise<Found> {
  const source = 'github-code';
  if (!hasToken) {
    return {
      hits: [],
      notes: [
        {
          source,
          level: 'info',
          text: 'Searching inside GitHub repositories needs a GitHub connection (GitHub only allows it with a token). Add one on the Connections page.',
        },
      ],
    };
  }
  if (!q) {
    return {
      hits: [],
      notes: [{ source, level: 'info', text: 'Type something to search inside repositories.' }],
    };
  }
  const res = await f(
    api(`/search/code?q=${encodeURIComponent(`${q} filename:SKILL.md`)}&per_page=20`),
  );
  if (res.status !== 200) {
    return {
      hits: [],
      notes: [
        {
          source,
          level: 'problem',
          text:
            res.status === 403 || res.status === 422
              ? `GitHub refused the code search. It needs a token that is allowed to search code (a classic token works). ${githubNote(res.status, res.body, 'the code search')}`
              : githubNote(res.status, res.body, 'the code search'),
        },
      ],
    };
  }
  const items = (parseJson(res.body) as { items?: Record<string, unknown>[] } | null)?.items ?? [];
  const hits: SkillHitDto[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const repo = str((it.repository as Record<string, unknown> | undefined)?.full_name);
    const path = str(it.path);
    const link = str(it.html_url);
    if (!REPO.test(repo) || !/(^|\/)SKILL\.md$/.test(path) || !link) continue;
    const dir = path.split('/').slice(0, -1).join('/');
    const key = `${repo}/${dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      id: `github-code:${key}`,
      source,
      sourceLabel: LABEL[source],
      kind: 'skill',
      name: dir.split('/').pop() || repo.split('/')[1] || repo,
      description: str((it.repository as Record<string, unknown>).description) || repo,
      repo,
      path: dir || null,
      url: link,
      installs: null,
      stars: null,
    });
  }
  return { hits, notes: [] };
}

/** The `name` and `description` of a SKILL.md, tolerant of anything else in it. */
export function readFrontmatter(text: string): { name: string; description: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { name: '', description: '' };
  try {
    const fm = (parseYaml(m[1] ?? '') ?? {}) as Record<string, unknown>;
    return { name: str(fm.name), description: str(fm.description).replace(/\s+/g, ' ').trim() };
  } catch {
    return { name: '', description: '' };
  }
}

interface Collection {
  at: number;
  items: {
    name: string;
    description: string;
    repo: string;
    path: string;
    url: string;
    label: string;
  }[];
  problem?: string;
}

/**
 * Searches skills online across several sources at once. Each source is separate: one that fails
 * (a rate limit, no token) leaves a note and the others still answer.
 */
export class SkillSearcher {
  readonly #cache = new Map<string, Collection>();

  /** A featured collection, listed from its repository and remembered for a few minutes. */
  async #collection(f: SkillFetch, c: (typeof FEATURED)[number], now: number): Promise<Collection> {
    const cached = this.#cache.get(c.repo);
    if (cached && now - cached.at < FEATURED_TTL_MS) return cached;
    const fail = (problem: string): Collection => ({ at: now, items: [], problem });
    const repo = await f(api(`/repos/${c.repo}`));
    if (repo.status !== 200) return fail(githubNote(repo.status, repo.body, c.repo));
    const branch = str((parseJson(repo.body) as Record<string, unknown> | null)?.default_branch);
    const commit = await f(api(`/repos/${c.repo}/commits/${encodeURIComponent(branch)}`));
    const sha = str((parseJson(commit.body) as Record<string, unknown> | null)?.sha);
    if (commit.status !== 200 || !sha) return fail(githubNote(commit.status, commit.body, c.repo));
    const tree = await f(api(`/repos/${c.repo}/git/trees/${sha}?recursive=1`));
    const entries =
      (parseJson(tree.body) as { tree?: { path: string; type: string }[] } | null)?.tree ?? [];
    if (tree.status !== 200) return fail(githubNote(tree.status, tree.body, c.repo));
    const dirs = entries
      .filter((e) => e.type === 'blob' && /(^|\/)SKILL\.md$/.test(e.path))
      .map((e) => e.path.split('/').slice(0, -1).join('/'))
      .filter((d) => d === c.dir || d.startsWith(`${c.dir}/`))
      .sort();
    const items: Collection['items'] = [];
    // raw.githubusercontent.com is not the rate-limited API, so reading each SKILL.md for its
    // description is cheap; a few at a time.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(FEATURED_DESCRIPTIONS, dirs.length) }, async () => {
        while (next < dirs.length) {
          const dir = dirs[next++] as string;
          const raw = await f(
            `https://raw.githubusercontent.com/${c.repo}/${sha}/${dir}/SKILL.md`,
          ).catch(() => ({ status: 0, body: '' }));
          const fm = raw.status === 200 ? readFrontmatter(raw.body) : { name: '', description: '' };
          items.push({
            name: dir.split('/').pop() || fm.name,
            description: fm.description,
            repo: c.repo,
            path: dir,
            url: `https://github.com/${c.repo}/tree/${sha}/${dir}`,
            label: c.label,
          });
        }
      }),
    );
    items.sort((a, b) => (a.name < b.name ? -1 : 1));
    const made: Collection = { at: now, items };
    this.#cache.set(c.repo, made);
    return made;
  }

  async #featured(f: SkillFetch, q: string, now: number): Promise<Found> {
    const source = 'featured';
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const lists = await Promise.all(FEATURED.map((c) => this.#collection(f, c, now)));
    const hits: SkillHitDto[] = [];
    const notes: SkillSearchNote[] = [];
    lists.forEach((list, i) => {
      if (list.problem) {
        notes.push({ source, level: 'problem', text: `${FEATURED[i]?.label}: ${list.problem}` });
      }
      for (const it of list.items) {
        const hay = `${it.name} ${it.description}`.toLowerCase();
        if (words.every((w) => hay.includes(w))) {
          hits.push({
            id: `featured:${it.repo}/${it.path}`,
            source,
            sourceLabel: it.label,
            kind: 'skill',
            name: it.name,
            description: it.description || it.repo,
            repo: it.repo,
            path: it.path,
            url: it.url,
            installs: null,
            stars: null,
          });
        }
      }
    });
    return { hits, notes };
  }

  async search(
    f: SkillFetch,
    input: {
      q: string;
      sources: readonly SkillSearchSource[];
      githubToken: boolean;
      connection: string | null;
    },
    now = Date.now(),
  ): Promise<SkillSearchDto> {
    const q = input.q.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);
    const wanted = SKILL_SEARCH_SOURCES.filter((s) => input.sources.includes(s));
    const run: Record<SkillSearchSource, () => Promise<Found>> = {
      'skills-sh': () => searchSkillsSh(f, q),
      featured: () => this.#featured(f, q, now),
      github: () => searchGithubRepos(f, q),
      'github-code': () => searchGithubCode(f, q, input.githubToken),
    };
    const done = await Promise.allSettled(wanted.map((s) => run[s]()));
    const hits: SkillHitDto[] = [];
    const notes: SkillSearchNote[] = [];
    done.forEach((r, i) => {
      const source = wanted[i] as SkillSearchSource;
      if (r.status === 'fulfilled') {
        hits.push(...r.value.hits);
        notes.push(...r.value.notes);
      } else {
        const why =
          r.reason instanceof SkillSourceError || r.reason instanceof Error
            ? r.reason.message.slice(0, 160)
            : 'unknown error';
        notes.push({
          source,
          level: 'problem',
          text: `${LABEL[source]} could not be searched: ${why}`,
        });
      }
    });
    return { query: q, hits, notes, githubConnection: input.connection };
  }
}
