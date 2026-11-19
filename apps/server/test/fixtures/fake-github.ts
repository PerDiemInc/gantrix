import type { SkillFetch } from '../../src/skills/remote.ts';

export const SHA = 'a'.repeat(40);

export interface FakeRepo {
  /** path → file text. */
  files: Record<string, string>;
  /** path → git mode, e.g. "120000" for a symlink; default "100644". */
  modes?: Record<string, string>;
  /** Branches that exist, mapped to a commit; default { main: SHA }. */
  refs?: Record<string, string>;
  truncated?: boolean;
  /** Make every API call answer like this (e.g. 403 with a rate limit message). */
  fail?: { status: number; body: string };
}

/** The slice of GitHub the skill installer talks to, served from memory. */
export function fakeGithub(owner: string, repo: string, r: FakeRepo) {
  const calls: string[] = [];
  const refs = r.refs ?? { main: SHA };
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const raw = `https://raw.githubusercontent.com/${owner}/${repo}/`;
  const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
  const fetch: SkillFetch = async (url) => {
    calls.push(url);
    if (url.startsWith(raw)) {
      const path = decodeURIComponent(url.slice(raw.length + SHA.length + 1));
      const text = r.files[path];
      return text === undefined ? { status: 404, body: '' } : { status: 200, body: text };
    }
    if (!url.startsWith(base)) return { status: 404, body: 'not found' };
    if (r.fail) return r.fail;
    const rest = url.slice(base.length);
    if (rest === '') return ok({ default_branch: 'main' });
    if (rest.startsWith('/commits/')) {
      const ref = decodeURIComponent(rest.slice('/commits/'.length));
      const sha = refs[ref];
      return sha ? ok({ sha }) : { status: 404, body: '{"message":"No commit found"}' };
    }
    if (rest.startsWith('/git/trees/')) {
      return ok({
        sha: SHA,
        truncated: r.truncated ?? false,
        tree: Object.entries(r.files).map(([path, text]) => ({
          path,
          mode: r.modes?.[path] ?? '100644',
          type: r.modes?.[path] === '160000' ? 'commit' : 'blob',
          size: Buffer.byteLength(text),
        })),
      });
    }
    return { status: 404, body: '' };
  };
  return { fetch, calls };
}

export const skillMd = (name: string, extra = '', version = '1.0.0') =>
  `---\nname: ${name}\ndescription: Does ${name} things.\nversion: ${version}\n${extra}---\nBe careful with ${name}.\n`;
