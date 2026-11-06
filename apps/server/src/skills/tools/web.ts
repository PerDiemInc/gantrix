import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { asToolResult, ToolError } from '../workspace.ts';

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 50_000;
const MAX_REDIRECTS = 5;

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

// BlockList also checks IPv4-mapped IPv6 (e.g. ::ffff:7f00:1) against the IPv4 ranges.
const isBlocked = (address: string): boolean =>
  blocked.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');

// Checks the address before each request. A DNS answer that changes between this check and
// the request can slip through; web_fetch needs approval unless a skill allows it.
async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError('Only http and https URLs are allowed.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isBlocked)) {
    throw new ToolError(`${url.hostname} is a private or local address; refusing to fetch it.`);
  }
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel();
  return Buffer.concat(chunks).subarray(0, MAX_BYTES).toString('utf8');
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function webFetchTool() {
  return tool(
    ({ url }) =>
      asToolResult(async () => {
        let current = new URL(url);
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          await assertPublic(current);
          const response = await fetch(current, {
            redirect: 'manual',
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { 'user-agent': 'Gantrix/0.1 (+https://github.com/PerDiemInc/gantrix)' },
          });
          const location = response.headers.get('location');
          if (response.status >= 300 && response.status < 400 && location) {
            current = new URL(location, current);
            continue;
          }
          const type = response.headers.get('content-type') ?? '';
          if (!/^(text\/|application\/(json|xml|xhtml))/.test(type)) {
            throw new ToolError(`Unsupported content type "${type || 'unknown'}".`);
          }
          const body = await readCapped(response);
          const text = type.includes('html') ? htmlToText(body) : body;
          const clipped =
            text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[truncated]` : text;
          return `HTTP ${response.status} ${current.href}\n\n${clipped}`;
        }
        throw new ToolError(`More than ${MAX_REDIRECTS} redirects.`);
      }),
    {
      name: 'web_fetch',
      description: 'Fetch a public web page or text resource over http(s) and return its text.',
      schema: z.object({ url: z.string().describe('absolute http or https URL') }),
    },
  );
}
