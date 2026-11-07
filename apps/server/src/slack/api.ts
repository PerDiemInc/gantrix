const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A minimal Slack Web API client: POST JSON, retry once on rate limits, throw on !ok. */
export class SlackApi {
  readonly #token: string;
  readonly #base: string;

  constructor(token: string, base = 'https://slack.com/api') {
    this.#token = token;
    this.#base = base.replace(/\/$/, '');
  }

  async call<T extends object = Record<string, unknown>>(
    method: string,
    body: Record<string, unknown> = {},
    retries = 2,
  ): Promise<T> {
    const res = await fetch(`${this.#base}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${this.#token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429 && retries > 0) {
      await sleep(Math.min(Number(res.headers.get('retry-after') ?? 1), 30) * 1000);
      return this.call(method, body, retries - 1);
    }
    const json = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as {
      ok: boolean;
      error?: string;
    } & T;
    if (!json.ok) throw new Error(`Slack ${method} failed: ${json.error ?? res.status}`);
    return json;
  }
}

/** Escapes text for Slack mrkdwn, so agent or user text can't make links or mentions. */
export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
