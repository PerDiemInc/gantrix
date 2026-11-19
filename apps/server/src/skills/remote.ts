import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type {
  SkillChoicesDto,
  SkillLookupDto,
  SkillPreviewDto,
  SkillReviewWarning,
} from '@gantrix/shared';
import { checksumDir } from './loader.ts';
import { type ParsedSkill, parseSkillFile } from './manifest.ts';
import { fetchPublic } from './tools/web.ts';

/** One GET of a public URL. The default refuses private and local addresses, at every redirect. */
export type SkillFetch = (url: string) => Promise<{ status: number; body: string }>;

export const defaultSkillFetch: SkillFetch = async (url) => {
  const res = await fetchPublic(url);
  return { status: res.status, body: res.body };
};

export const MAX_FILES = 100;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_CHOICES = 50;
const MAX_REF_SEGMENTS = 5;
const DOWNLOAD_CONCURRENCY = 4;
// Same as the installer, so the checksum of what was shown matches what is installed.
const SKIP = new Set(['.git', 'node_modules', '.DS_Store']);
const BINARY =
  /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|tar|7z|rar|woff2?|ttf|otf|eot|exe|dll|so|dylib|wasm|mp[34]|mov|avi|bin|class|jar)$/i;
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;

export class SkillSourceError extends Error {}

export type SkillSource =
  | { kind: 'github'; owner: string; repo: string; rest: string[]; blob: boolean }
  | { kind: 'file'; url: string };

/**
 * What a pasted link points at: a GitHub repository or a folder in one (`/tree/<ref>/<path>`),
 * a file in one (`/blob/<ref>/<path>/SKILL.md`, or its raw link), or a direct https link to a
 * SKILL.md anywhere. Nothing else: a skill is code an agent may run, so the places it can come
 * from are narrow.
 */
export function parseSkillSource(input: string): SkillSource {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new SkillSourceError('That is not a link. Paste a GitHub link, or a link to a SKILL.md.');
  }
  if (url.protocol !== 'https:') throw new SkillSourceError('The link must start with https://.');
  if (url.username || url.password) throw new SkillSourceError('The link can not hold a password.');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const host = url.hostname.toLowerCase();

  if (host === 'github.com' || host === 'www.github.com') {
    const [owner, rawRepo, kind, ...rest] = parts;
    const repo = rawRepo?.replace(/\.git$/, '');
    if (!owner || !repo || !SAFE_NAME.test(owner) || !SAFE_NAME.test(repo)) {
      throw new SkillSourceError('Link to a repository: https://github.com/owner/repo.');
    }
    if (!kind) return { kind: 'github', owner, repo, rest: [], blob: false };
    if ((kind === 'tree' || kind === 'blob') && rest.length) {
      return { kind: 'github', owner, repo, rest, blob: kind === 'blob' };
    }
    throw new SkillSourceError(
      'Link to the repository, a folder in it (…/tree/main/folder) or its SKILL.md.',
    );
  }
  if (host === 'raw.githubusercontent.com') {
    const [owner, repo, ...rest] = parts;
    if (!owner || !repo || rest.length < 2 || !SAFE_NAME.test(owner) || !SAFE_NAME.test(repo)) {
      throw new SkillSourceError('That GitHub raw link is incomplete.');
    }
    return { kind: 'github', owner, repo, rest, blob: true };
  }
  if (/\/SKILL\.md$/i.test(url.pathname)) return { kind: 'file', url: url.href };
  throw new SkillSourceError(
    'Use a GitHub link (a repository, or a folder in one) or a direct https link to a SKILL.md.',
  );
}

interface Resolved {
  owner: string;
  repo: string;
  ref: string;
  sha: string;
  /** The folder in the repository ("" = the root). */
  dir: string;
}

const api = (owner: string, repo: string, rest: string) =>
  `https://api.github.com/repos/${owner}/${repo}${rest}`;
const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

function githubFailure(status: number, body: string, what: string): SkillSourceError {
  if (status === 403 && /rate limit/i.test(body)) {
    return new SkillSourceError(
      "GitHub's rate limit for anonymous requests is used up (60 an hour). Try again later.",
    );
  }
  if (status === 404) {
    return new SkillSourceError(
      `Couldn't find ${what} on GitHub. Check the link, and that the repository is public.`,
    );
  }
  return new SkillSourceError(`GitHub answered ${status} for ${what}.`);
}

const json = <T>(body: string, what: string): T => {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new SkillSourceError(`GitHub sent something unexpected for ${what}.`);
  }
};

/** The branch or tag, the commit it points to, and the folder, from the part after /tree/. */
async function resolveGithub(
  f: SkillFetch,
  s: Extract<SkillSource, { kind: 'github' }>,
): Promise<Resolved> {
  const { owner, repo } = s;
  if (!s.rest.length) {
    const info = await f(api(owner, repo, ''));
    if (info.status !== 200) throw githubFailure(info.status, info.body, `${owner}/${repo}`);
    const branch = json<{ default_branch?: string }>(info.body, 'the repository').default_branch;
    if (!branch) throw new SkillSourceError('That repository has no default branch.');
    const c = await f(api(owner, repo, `/commits/${encodePath(branch)}`));
    if (c.status !== 200) throw githubFailure(c.status, c.body, `branch ${branch}`);
    return {
      owner,
      repo,
      ref: branch,
      sha: json<{ sha: string }>(c.body, 'the commit').sha,
      dir: '',
    };
  }
  // A branch name can contain slashes, so try the shortest reading first: "main", then "main/x".
  for (let k = 1; k <= Math.min(s.rest.length, MAX_REF_SEGMENTS); k++) {
    const ref = s.rest.slice(0, k).join('/');
    const c = await f(api(owner, repo, `/commits/${encodePath(ref)}`));
    if (c.status === 200) {
      let dir = s.rest.slice(k).join('/');
      if (s.blob) {
        // A file link: the skill is the folder that holds it, and the file must be SKILL.md.
        const name = dir.split('/').pop() ?? '';
        if (name.toLowerCase() !== 'skill.md') {
          throw new SkillSourceError('Link to a folder, or to the SKILL.md inside it.');
        }
        dir = dir.split('/').slice(0, -1).join('/');
      }
      return { owner, repo, ref, sha: json<{ sha: string }>(c.body, 'the commit').sha, dir };
    }
    if (c.status === 403) throw githubFailure(c.status, c.body, `ref ${ref}`);
    if (c.status !== 404 && c.status !== 422) throw githubFailure(c.status, c.body, `ref ${ref}`);
  }
  throw new SkillSourceError(
    "Couldn't find that branch or tag on GitHub. Check the link, and that the repository is public.",
  );
}

interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
}

async function loadTree(f: SkillFetch, r: Resolved): Promise<TreeEntry[]> {
  const res = await f(api(r.owner, r.repo, `/git/trees/${r.sha}?recursive=1`));
  if (res.status !== 200) throw githubFailure(res.status, res.body, 'the file list');
  const tree = json<{ tree?: TreeEntry[]; truncated?: boolean }>(res.body, 'the file list');
  if (tree.truncated) {
    throw new SkillSourceError(
      'That repository is too large to look through. Link to the skill folder itself.',
    );
  }
  return tree.tree ?? [];
}

const inDir = (path: string, dir: string) => !dir || path === dir || path.startsWith(`${dir}/`);

const safeSegments = (rel: string): boolean =>
  rel.split('/').every((p) => p && p !== '.' && p !== '..' && !/[\\\0]/.test(p));

export interface SkillFile {
  /** Relative to the skill folder. */
  path: string;
  size: number;
  /** Where to download it. */
  url: string;
}

/** The files of the skill in `dir`, checked against the limits, ready to download. */
export function planFiles(tree: readonly TreeEntry[], r: Resolved): SkillFile[] {
  const files: SkillFile[] = [];
  let total = 0;
  for (const e of tree) {
    if (!inDir(e.path, r.dir) || e.path === r.dir) continue;
    const rel = r.dir ? e.path.slice(r.dir.length + 1) : e.path;
    if (rel.split('/').some((p) => SKIP.has(p))) continue;
    if (e.type === 'tree') continue;
    if (e.type === 'commit') {
      throw new SkillSourceError(`It contains a Git submodule (${rel}), which can't be installed.`);
    }
    if (e.mode === '120000') {
      throw new SkillSourceError(`It contains a symlink (${rel}); skills can't contain symlinks.`);
    }
    if (!safeSegments(rel)) throw new SkillSourceError(`"${rel}" is not a safe file name.`);
    if (BINARY.test(rel)) {
      throw new SkillSourceError(
        `It contains a binary file (${rel}). Only text files can be installed from the web; download the folder and install it from there.`,
      );
    }
    const size = e.size ?? 0;
    if (size > MAX_FILE_BYTES) {
      throw new SkillSourceError(
        `${rel} is ${Math.round(size / 1024)} KB; the limit for one file is ${MAX_FILE_BYTES / 1024} KB.`,
      );
    }
    total += size;
    files.push({
      path: rel,
      size,
      url: `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${r.sha}/${encodePath(e.path)}`,
    });
    if (files.length > MAX_FILES) {
      throw new SkillSourceError(
        `It has more than ${MAX_FILES} files; that is too many for a skill.`,
      );
    }
  }
  if (total > MAX_TOTAL_BYTES) {
    throw new SkillSourceError(
      `Its files add up to ${(total / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_TOTAL_BYTES / 1024 / 1024} MB.`,
    );
  }
  return files;
}

/** Every folder under `dir` that holds a SKILL.md, for a link to a place with several skills. */
export function findSkillFolders(tree: readonly TreeEntry[], dir: string): string[] {
  return tree
    .filter((e) => e.type === 'blob' && /(^|\/)SKILL\.md$/.test(e.path) && inDir(e.path, dir))
    .map((e) => e.path.split('/').slice(0, -1).join('/'))
    .sort();
}

async function inPool<T>(items: readonly T[], n: number, run: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++] as T;
        await run(item);
      }
    }),
  );
}

async function download(f: SkillFetch, files: readonly SkillFile[], dest: string): Promise<void> {
  const root = resolve(dest) + sep;
  await inPool(files, DOWNLOAD_CONCURRENCY, async (file) => {
    const res = await f(file.url);
    if (res.status !== 200)
      throw new SkillSourceError(`Couldn't download ${file.path} (${res.status}).`);
    if (res.body.includes('\0')) {
      throw new SkillSourceError(
        `${file.path} is not a text file; it can't be installed from the web.`,
      );
    }
    if (Buffer.byteLength(res.body) > MAX_FILE_BYTES) {
      throw new SkillSourceError(`${file.path} is larger than ${MAX_FILE_BYTES / 1024} KB.`);
    }
    const target = resolve(dest, file.path);
    if (!target.startsWith(root))
      throw new SkillSourceError(`"${file.path}" is not a safe file name.`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, res.body);
  });
}

const SCRIPT = /\.(sh|bash|zsh|py|rb|js|mjs|cjs|ts|ps1|pl)$/i;

/** What a skill can do on this machine, in plain words, for the person deciding to install it. */
export function reviewSkill(
  skill: Pick<ParsedSkill, 'manifest'>,
  files: readonly { path: string }[],
): SkillReviewWarning[] {
  const out: SkillReviewWarning[] = [];
  const { tools, mcpServers, autoApprove } = skill.manifest;
  if (tools.includes('shell')) {
    out.push({
      level: 'caution',
      text: 'Can run shell commands on this machine, as you, without a sandbox. A project that asks first waits for your OK; a project that does not runs them straight away.',
    });
  }
  for (const [name, s] of Object.entries(mcpServers)) {
    out.push({
      level: 'caution',
      text: `Starts a program on this machine when an agent uses it: ${[s.command, ...s.args].join(' ')} (MCP server "${name}"${s.env ? `, with variables ${Object.keys(s.env).join(', ')}` : ''}).`,
    });
  }
  if (tools.includes('deploy_site')) {
    out.push({
      level: 'info',
      text: 'Can publish a folder as a website on the local preview server.',
    });
  }
  if (tools.includes('web_fetch')) {
    out.push({
      level: 'info',
      text: 'Can fetch public web pages, whose text can try to steer the agent.',
    });
  }
  if (autoApprove.length) {
    out.push({
      level: 'caution',
      text: `Wants these to run without asking: ${autoApprove.join(', ')}.`,
    });
  }
  const scripts = files.filter((f) => SCRIPT.test(f.path));
  if (scripts.length) {
    out.push({
      level: tools.includes('shell') || Object.keys(mcpServers).length ? 'caution' : 'info',
      text: `Includes ${scripts.length} script file${scripts.length === 1 ? '' : 's'} (${scripts
        .slice(0, 4)
        .map((s) => s.path)
        .join(', ')}${scripts.length > 4 ? ', …' : ''}) that an agent could run.`,
    });
  }
  if (!out.length) {
    out.push({
      level: 'info',
      text: 'It has no tools of its own: it only gives the agent instructions.',
    });
  }
  return out;
}

export interface Held {
  dir: string;
  preview: SkillPreviewDto;
  expires: number;
}

/**
 * Skills that were downloaded and shown, waiting for a yes. They live in a folder of their own
 * under the skills folder and are forgotten after a while; installing takes exactly what was
 * shown. Nothing here is ever run.
 */
export class PreviewStore {
  readonly root: string;
  readonly #held = new Map<string, Held>();
  readonly #ttlMs: number;
  readonly #max: number;

  constructor(skillsDir: string, ttlMs = 15 * 60_000, max = 8) {
    this.root = join(skillsDir, '.incoming');
    this.#ttlMs = ttlMs;
    this.#max = max;
  }

  /** Drops what is left from a previous run, and what has expired. */
  async sweep(now = Date.now()): Promise<void> {
    for (const [id, h] of this.#held) {
      if (h.expires <= now) await this.discard(id);
    }
  }

  async startFresh(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  async create(now = Date.now()): Promise<{ id: string; dir: string; expires: number }> {
    await this.sweep(now);
    while (this.#held.size >= this.#max) {
      const oldest = this.#held.keys().next().value;
      if (oldest === undefined) break;
      await this.discard(oldest);
    }
    const id = randomUUID();
    const dir = join(this.root, id);
    await mkdir(dir, { recursive: true });
    return { id, dir, expires: now + this.#ttlMs };
  }

  hold(id: string, held: Held): void {
    this.#held.set(id, held);
  }

  /** Hands over a held skill, once. The caller owns its folder from then on. */
  take(id: string, now = Date.now()): Held | undefined {
    const h = this.#held.get(id);
    if (!h || h.expires <= now) return undefined;
    this.#held.delete(id);
    return h;
  }

  async discard(id: string): Promise<void> {
    this.#held.delete(id);
    // Only ever a folder this store made: its name is a UUID, joined to its own root.
    if (/^[0-9a-f-]{36}$/.test(id)) await rm(join(this.root, id), { recursive: true, force: true });
  }

  get size(): number {
    return this.#held.size;
  }
}

const displayOf = (source: SkillSource, r?: Resolved) =>
  source.kind === 'file'
    ? source.url.replace(/^https:\/\//, '')
    : `github.com/${source.owner}/${source.repo}${r?.dir ? `/${r.dir}` : ''}`;

/**
 * Downloads what a link points at into the holding area and describes it, or, for a link to a
 * place with several skills, lists them. Installs nothing.
 */
export async function lookupSkill(
  store: PreviewStore,
  input: string,
  f: SkillFetch = defaultSkillFetch,
  now = Date.now(),
): Promise<SkillLookupDto> {
  const source = parseSkillSource(input);
  const { id, dir, expires } = await store.create(now);
  try {
    let sourceUrl: string;
    let commit: string | null = null;
    let shown: string;
    let files: { path: string; size: number }[];

    if (source.kind === 'file') {
      const res = await f(source.url);
      if (res.status !== 200) throw new SkillSourceError(`Couldn't download it (${res.status}).`);
      if (Buffer.byteLength(res.body) > MAX_FILE_BYTES) {
        throw new SkillSourceError(`It is larger than ${MAX_FILE_BYTES / 1024} KB.`);
      }
      await writeFile(join(dir, 'SKILL.md'), res.body);
      files = [{ path: 'SKILL.md', size: Buffer.byteLength(res.body) }];
      sourceUrl = source.url;
      shown = displayOf(source);
    } else {
      const resolved = await resolveGithub(f, source);
      const tree = await loadTree(f, resolved);
      const holders = findSkillFolders(tree, resolved.dir);
      if (!holders.length) {
        throw new SkillSourceError(
          `No SKILL.md found${resolved.dir ? ` in ${resolved.dir}` : ' in that repository'}.`,
        );
      }
      if (!holders.includes(resolved.dir)) {
        // Not a skill itself: a place that holds some. Let the person pick.
        await store.discard(id);
        const choices: SkillChoicesDto['choices'] = holders.slice(0, MAX_CHOICES).map((p) => ({
          name: p.split('/').pop() || resolved.repo,
          path: p,
          url: `https://github.com/${resolved.owner}/${resolved.repo}/tree/${resolved.ref}/${p}`,
        }));
        return { kind: 'choices', source: displayOf(source, resolved), choices };
      }
      const plan = planFiles(tree, resolved);
      await download(f, plan, dir);
      files = plan.map(({ path, size }) => ({ path, size }));
      commit = resolved.sha;
      sourceUrl = `https://github.com/${resolved.owner}/${resolved.repo}/tree/${resolved.sha}${resolved.dir ? `/${resolved.dir}` : ''}`;
      shown = displayOf(source, resolved);
    }

    let parsed: ParsedSkill;
    try {
      parsed = parseSkillFile(await readFile(join(dir, 'SKILL.md'), 'utf8'));
    } catch (error) {
      throw new SkillSourceError(
        `It isn't a valid skill: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const preview: SkillPreviewDto = {
      kind: 'skill',
      id,
      expiresAt: new Date(expires).toISOString(),
      source: shown,
      sourceUrl,
      commit,
      name: parsed.name,
      version: parsed.version,
      description: parsed.description,
      manifest: parsed.manifest,
      instructions: parsed.instructions,
      // SKILL.md first, since it is what matters; the rest in plain order.
      files: files.sort((a, b) =>
        a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path < b.path ? -1 : 1,
      ),
      totalBytes: files.reduce((n, x) => n + x.size, 0),
      warnings: reviewSkill(parsed, files),
      checksum: await checksumDir(dir),
    };
    store.hold(id, { dir, preview, expires });
    return preview;
  } catch (error) {
    await store.discard(id);
    throw error;
  }
}
