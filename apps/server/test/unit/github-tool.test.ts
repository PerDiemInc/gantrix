import { describe, expect, it } from 'vitest';
import {
  type GithubScope,
  githubReadTool,
  githubScope,
  githubUrl,
} from '../../src/skills/tools/github.ts';

const API = 'https://api.github.com';
const one: GithubScope = { org: null, repos: ['acme/app'] };
const org: GithubScope = { org: 'acme', repos: [] };
const any: GithubScope = { org: null, repos: [] };
const ok = (path: string, scope: GithubScope) => githubUrl(API, path, scope).href;

describe('github scope', () => {
  it('reads owner/name or names inside the organization', () => {
    expect(githubScope({ repos: 'Acme/App, other/lib' }).repos).toEqual(['acme/app', 'other/lib']);
    expect(githubScope({ org: 'acme', repos: 'app' }).repos).toEqual(['acme/app']);
    expect(githubScope({})).toEqual(any);
  });

  it('refuses a repository it cannot place instead of widening access', () => {
    expect(() => githubScope({ repos: 'app' })).toThrow('owner/name');
    expect(() => githubScope({ repos: 'a/b/c' })).toThrow('owner/name');
    expect(() => githubScope({ repos: 'acme/..' })).toThrow('owner/name');
  });
});

describe('github paths', () => {
  it('allows only the named repositories', () => {
    expect(ok('/repos/ACME/app/pulls?state=open', one)).toBe(
      `${API}/repos/ACME/app/pulls?state=open`,
    );
    expect(ok('/repos/acme/app/contents/my%20file.md', one)).toContain('my%20file.md');
    for (const path of [
      '/repos/acme/other',
      '/repos/acme/app/../other',
      '/repos/acme/app/%2e%2e/other',
      '/repos/acme/app%2F..%2Fother',
      '/orgs/acme/repos',
      '/user/repos',
      '/user',
      '//evil.example/repos/acme/app',
      'https://evil.example/repos/acme/app',
      '/repos/acme/app\\..\\other',
      '/search/code?q=secret',
    ]) {
      expect(() => ok(path, one), path).toThrow();
    }
  });

  it('keeps an organization scope inside that organization', () => {
    expect(ok('/repos/acme/anything', org)).toContain('/repos/acme/anything');
    expect(ok('/orgs/acme/repos', org)).toContain('/orgs/acme/repos');
    expect(() => ok('/repos/other/anything', org)).toThrow();
    expect(() => ok('/orgs/other/repos', org)).toThrow();
    expect(() => ok('/user/repos', org)).toThrow();
  });

  it('works under an Enterprise base path', () => {
    const base = 'https://ghe.example/api/v3';
    expect(githubUrl(base, '/repos/acme/app', one).href).toBe(`${base}/repos/acme/app`);
    expect(() => githubUrl(base, '/../../repos/acme/app', one)).toThrow();
  });
});

describe('github_read', () => {
  const access = { baseUrl: API, authorization: 'Bearer secret-token', scope: one };

  it('only sends GET with the token, and never returns it', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const tool = githubReadTool(access, async (url, init) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response('{"name":"app"}');
    });
    expect(await tool.invoke({ path: '/repos/acme/app' })).toBe('{"name":"app"}');
    expect(seen[0]?.init.method).toBe('GET');
    expect(seen[0]?.init.redirect).toBe('manual');
    expect(JSON.stringify(tool.description)).not.toContain('secret-token');
  });

  it('reports refusals, redirects and errors without calling outside the scope', async () => {
    let called = 0;
    const tool = githubReadTool(access, async () => {
      called++;
      return new Response(null, { status: 301 });
    });
    expect(await tool.invoke({ path: '/repos/acme/other' })).toMatch(/^Error: You can only read/);
    expect(called).toBe(0);
    expect(await tool.invoke({ path: '/repos/acme/app' })).toMatch(/redirected/);
  });
});
