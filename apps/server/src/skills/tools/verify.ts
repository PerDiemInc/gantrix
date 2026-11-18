import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { asToolResult } from '../workspace.ts';
import { fetchPublic, htmlToText } from './web.ts';

export const VERIFY_URL = 'verify_url';

/** What one fetch of a deployed URL found. `ok` = it answered with a 2xx status. */
export interface SiteCheck {
  url: string;
  status: number;
  ok: boolean;
  title: string;
  /** The start of the page's text, or why the fetch failed. */
  detail: string;
}

export type CheckUrl = (url: string) => Promise<SiteCheck>;

const DETAIL_CHARS = 600;

/** Fetches a public URL and says whether a site answers there. Never throws. */
export const checkUrl: CheckUrl = async (url) => {
  try {
    const res = await fetchPublic(url);
    const html = res.type.includes('html');
    const title = html ? (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(res.body)?.[1] ?? '').trim() : '';
    const text = html ? htmlToText(res.body) : res.body;
    return {
      url: res.url,
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      title: title.slice(0, 200),
      detail: text.slice(0, DETAIL_CHARS),
    };
  } catch (error) {
    return {
      url,
      status: 0,
      ok: false,
      title: '',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};

export const describeCheck = (c: SiteCheck): string =>
  c.status
    ? `HTTP ${c.status} ${c.url}${c.title ? `\nTitle: ${c.title}` : ''}\n${c.detail}`
    : `No answer from ${c.url}: ${c.detail}`;

/**
 * Checks that a deployed site answers at its public URL. The engine records each check, and
 * on projects with the live check on it fetches the same URLs again before the goal is judged.
 */
export function verifyUrlTool(check: CheckUrl, onChecked: (c: SiteCheck) => Promise<void>) {
  return tool(
    ({ url }) =>
      asToolResult(async () => {
        const result = await check(url);
        await onChecked(result);
        return `${result.ok ? 'LIVE' : 'NOT LIVE'}: ${describeCheck(result)}`;
      }),
    {
      name: VERIFY_URL,
      description:
        'Check that a deployed website answers at its public URL (not localhost). Returns the HTTP status, the page title and the start of its text. Use it after every deploy; a new CloudFront or DNS name can take a few minutes, so check again if it is not live yet.',
      schema: z.object({ url: z.string().describe('the public http or https URL of the site') }),
    },
  );
}
