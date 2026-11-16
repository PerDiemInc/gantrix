import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubDiscussions } from '../../src/integrations/github.ts';
import { commentBatches } from '../../src/integrations/pr-bridge.ts';

afterEach(() => vi.unstubAllGlobals());

describe('GitHub PR discussions', () => {
  it('reads all three comment sources and follows pagination', async () => {
    const comment = (id: number, body: string) => ({ id, body, user: { login: 'reviewer' } });
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      const path = url.pathname;
      const page = url.searchParams.get('page');
      if (path.endsWith('/pulls')) {
        expect(url.searchParams.get('state')).toBe('open');
        return Response.json([
          {
            number: 7,
            title: 'Test PR',
            html_url: 'https://github.com/a/b/pull/7',
            head: { sha: 'abc' },
          },
        ]);
      }
      if (path.endsWith('/issues/7/comments')) {
        return page === '1'
          ? Response.json([comment(1, 'Conversation')], {
              headers: { Link: '<https://api.github.com/example?page=2>; rel="next"' },
            })
          : Response.json([comment(2, 'Second page')]);
      }
      if (path.endsWith('/pulls/7/comments')) {
        return Response.json([{ ...comment(1, 'Inline reply'), path: 'src/index.ts' }]);
      }
      return Response.json([comment(1, 'Review body')]);
    });
    vi.stubGlobal('fetch', fetch);
    const github = new GitHubDiscussions('test-token');
    const [discussion] = await Array.fromAsync(github.scan('a/b'));
    expect(discussion?.comments.map(({ body }) => body)).toEqual([
      'Conversation',
      'Second page',
      'Inline reply',
      'Review body',
    ]);
    expect(discussion?.comments[2]?.path).toBe('src/index.ts');
    expect(fetch).toHaveBeenCalledTimes(5);
    const [repeated] = await Array.fromAsync(github.scan('a/b'));
    expect(repeated?.fingerprint).toBe(discussion?.fingerprint);
  });

  it('includes every part of long comments and preserves their order', () => {
    const body = 'x'.repeat(19_000);
    const batches = [
      ...commentBatches([
        { author: 'reviewer', body },
        { author: 'author', body: 'Reply' },
      ]),
    ];
    expect(batches.length).toBeGreaterThan(1);
    expect(
      batches
        .flat()
        .map((comment) => comment.body)
        .join(''),
    ).toBe(`${body}Reply`);
  });
});
