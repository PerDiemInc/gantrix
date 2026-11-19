import type { SkillFetch } from '../../src/skills/remote.ts';

export interface Call {
  url: string;
  headers: Record<string, string> | undefined;
}

/**
 * Several fake sites behind one fetch: the first that doesn't answer 404 wins. Records every
 * request with its headers, so a test can see where a token went.
 */
export function fakeWeb(...sites: SkillFetch[]) {
  const calls: Call[] = [];
  const fetch: SkillFetch = async (url, headers) => {
    calls.push({ url, headers });
    let last = { status: 404, body: '' };
    for (const site of sites) {
      last = await site(url, headers);
      if (last.status !== 404) return last;
    }
    return last;
  };
  return { fetch, calls };
}

export const json = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });

/** A site answering the given URL prefixes; anything else is a 404. */
export function site(
  routes: Record<string, (url: string) => { status: number; body: string }>,
): SkillFetch {
  return async (url) => {
    for (const [prefix, answer] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return answer(url);
    }
    return { status: 404, body: '' };
  };
}
