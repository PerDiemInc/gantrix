import { createHash } from 'node:crypto';

interface Pull {
  number: number;
  title: string;
  html_url: string;
  head: { sha: string };
}

interface Comment {
  id: number;
  body: string | null;
  user: { login: string } | null;
}

export interface Discussion {
  key: string;
  fingerprint: string;
  title: string;
  url: string;
  comments: { author: string; body: string; path?: string }[];
}

export class GitHubDiscussions {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async *pages<T>(path: string): AsyncGenerator<T> {
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ per_page: '100', page: String(page) });
      if (path.endsWith('/pulls')) query.set('state', 'open');
      const response = await fetch(`https://api.github.com${path}?${query}`, {
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/vnd.github+json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
      yield* (await response.json()) as T[];
      if (!response.headers.get('link')?.includes('rel="next"')) return;
    }
  }

  async *scan(repo: string): AsyncGenerator<Discussion> {
    const base = `/repos/${repo}`;
    for await (const pull of this.pages<Pull>(`${base}/pulls`)) {
      const comments: Discussion['comments'] = [];
      const hash = createHash('sha256').update(pull.head.sha);
      const add = (comment: Comment, path?: string) => {
        if (!comment.body?.trim()) return;
        hash.update(JSON.stringify([path, comment.id, comment.body]));
        comments.push({
          author: comment.user?.login ?? 'unknown',
          body: comment.body,
          ...(path ? { path } : {}),
        });
      };
      for await (const comment of this.pages<Comment>(`${base}/issues/${pull.number}/comments`)) {
        add(comment);
      }
      for await (const comment of this.pages<Comment & { path: string }>(
        `${base}/pulls/${pull.number}/comments`,
      )) {
        add(comment, comment.path);
      }
      for await (const review of this.pages<Comment>(`${base}/pulls/${pull.number}/reviews`)) {
        add(review);
      }
      if (comments.length) {
        yield {
          key: `${repo.toLowerCase()}#${pull.number}`,
          fingerprint: hash.digest('hex'),
          title: pull.title,
          url: pull.html_url,
          comments,
        };
      }
    }
  }
}
