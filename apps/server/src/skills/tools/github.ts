import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { asToolResult, ToolError } from '../workspace.ts';

export const GITHUB_READ = 'github_read';
const TIMEOUT_MS = 20_000;
const MAX_CHARS = 50_000;

/** What an agent may read: named repositories, else one owner, else whatever the token sees. */
export interface GithubScope {
  org: string | null;
  /** "owner/name", lower case. */
  repos: string[];
}

export interface GithubAccess {
  baseUrl: string;
  /** The Authorization header, resolved. It stays here: the model never sees it. */
  authorization: string;
  scope: GithubScope;
}

const NAME = /^[\w.-]+$/;

/**
 * The connection's settings as a scope. Repositories are "owner/name", or just "name" inside the
 * organization. A repository that can't be placed is an error, never silently "everything".
 */
export function githubScope(settings: Record<string, string>): GithubScope {
  const org = settings.org?.trim() || null;
  if (org && !NAME.test(org)) throw new ToolError(`"${org}" isn't a GitHub owner name.`);
  const repos = (settings.repos ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const parts = r.includes('/') ? r.split('/') : [org ?? '', r];
      if (parts.length !== 2 || !parts.every((p) => NAME.test(p) && p !== '.' && p !== '..')) {
        throw new ToolError(`Write the repository "${r}" as owner/name.`);
      }
      return parts.join('/').toLowerCase();
    });
  return { org, repos };
}

export function describeScope({ org, repos }: GithubScope): string {
  if (repos.length) return `the repositories ${repos.join(', ')}`;
  return org ? `the repositories of ${org}` : 'every repository the token can see';
}

/** The full URL for an API path, if it is one this scope may read. */
export function githubUrl(baseUrl: string, path: string, scope: GithubScope): URL {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new ToolError('Give an API path like /repos/owner/name/pulls.');
  }
  const base = new URL(baseUrl.replace(/\/+$/, ''));
  // Parsing resolves "..", so the check below sees the path that is really requested.
  const url = new URL(`${base.href.replace(/\/+$/, '')}${path}`);
  const prefix = base.pathname.replace(/\/+$/, '');
  if (url.origin !== base.origin || !url.pathname.startsWith(`${prefix}/`)) {
    throw new ToolError('That path leaves the GitHub API.');
  }
  const local = url.pathname.slice(prefix.length);
  if (/%2f|%5c|%2e/i.test(local)) throw new ToolError('Encoded slashes and dots are not allowed.');
  const [, root, owner, name] = local.split('/');
  const outside = new ToolError(`You can only read ${describeScope(scope)}.`);
  if (root === 'repos') {
    if (!owner || !name || !NAME.test(owner) || !NAME.test(name)) throw outside;
    if (scope.repos.length) {
      if (!scope.repos.includes(`${owner}/${name}`.toLowerCase())) throw outside;
    } else if (scope.org && owner.toLowerCase() !== scope.org.toLowerCase()) throw outside;
    return url;
  }
  // Listings: only when no single repositories were named.
  if (scope.repos.length) throw outside;
  if ((root === 'orgs' || root === 'users') && name === 'repos' && owner) {
    if (scope.org && owner.toLowerCase() !== scope.org.toLowerCase()) throw outside;
    return url;
  }
  if (!scope.org && local === '/user/repos') return url;
  throw outside;
}

const ACCEPT = {
  json: 'application/vnd.github+json',
  raw: 'application/vnd.github.raw+json',
  diff: 'application/vnd.github.diff',
} as const;

export function githubReadTool(access: GithubAccess, fetcher: typeof fetch = fetch) {
  return tool(
    async ({ path, as }) =>
      asToolResult(async () => {
        const url = githubUrl(access.baseUrl, path, access.scope);
        const response = await fetcher(url, {
          method: 'GET',
          headers: {
            authorization: access.authorization,
            accept: ACCEPT[as ?? 'json'],
            'user-agent': 'gantrix',
          },
          // A redirect could lead outside the allowed repositories.
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (response.status >= 300 && response.status < 400) {
          throw new ToolError('GitHub redirected this (was the repository renamed?).');
        }
        const body = await response.text();
        if (!response.ok) {
          throw new ToolError(`GitHub answered ${response.status}: ${body.slice(0, 300)}`);
        }
        return body.length > MAX_CHARS
          ? `${body.slice(0, MAX_CHARS)}\n… cut at ${MAX_CHARS} characters; ask for less (per_page, a single file).`
          : body;
      }),
    {
      name: GITHUB_READ,
      description: `Read from the GitHub API (GET only). You can read ${describeScope(access.scope)}. Examples: /repos/owner/name, /repos/owner/name/contents/src (use as "raw" for a file's text), /repos/owner/name/pulls?state=open, /repos/owner/name/pulls/12 (use as "diff" for the changes), /repos/owner/name/commits?per_page=20.`,
      schema: z.object({
        path: z.string().min(2).max(1_000).describe('API path starting with /'),
        as: z.enum(['json', 'raw', 'diff']).optional().describe('reply format, default json'),
      }),
    },
  );
}
