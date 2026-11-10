import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
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
  ['64:ff9b::', 96], // NAT64: reaches IPv4 addresses
  ['2002::', 16], // 6to4: embeds an IPv4 address
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

// BlockList also checks IPv4-mapped IPv6 (e.g. ::ffff:7f00:1) against the IPv4 ranges.
const isBlocked = (address: string): boolean =>
  blocked.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');

// Literal IP hosts never go through DNS, so they're checked here.
function assertAllowedUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError('Only http and https URLs are allowed.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlocked(host)) {
    throw new ToolError(`${url.hostname} is a private or local address; refusing to fetch it.`);
  }
}

/**
 * The DNS lookup the socket itself uses. Checking here, not before the request, means the
 * address that's checked is the address that's connected to: a name that answers with a public
 * address first and 127.0.0.1 the second time can't slip through.
 */
const publicLookup = ((
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void,
) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((a) => isBlocked(a.address))) {
      return callback(
        new ToolError(`${hostname} is a private or local address; refusing to fetch it.`),
        '',
      );
    }
    if (options.all) return callback(null, list);
    const [first] = list;
    callback(null, first?.address ?? '', first?.family);
  });
}) as unknown as typeof dnsLookup;

interface Fetched {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
}

function get(url: URL): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        lookup: publicLookup,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'user-agent': 'Gantrix/0.1 (+https://github.com/PerDiemInc/gantrix)',
          'accept-encoding': 'identity',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        const done = () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).subarray(0, MAX_BYTES).toString('utf8'),
          });
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          total += chunk.byteLength;
          if (total >= MAX_BYTES) {
            res.destroy();
            done();
          }
        });
        res.on('end', done);
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
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
          assertAllowedUrl(current);
          const response = await get(current);
          const location = response.headers.location;
          if (response.status >= 300 && response.status < 400 && location) {
            current = new URL(location, current); // each hop is checked again
            continue;
          }
          const type = response.headers['content-type'] ?? '';
          if (!/^(text\/|application\/(json|xml|xhtml))/.test(type)) {
            throw new ToolError(`Unsupported content type "${type || 'unknown'}".`);
          }
          const body = response.body;
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
