import type { HttpRequestConfig } from '@gantrix/shared';

/** What the templates can use. */
export interface TemplateVars {
  prompt: string;
  system: string;
  model: string;
  /** OpenAI-style chat messages. */
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
}

const PLACEHOLDER = /\{\{\s*(prompt|system|model|messages)\s*\}\}/g;
const text = (vars: TemplateVars, name: string) =>
  name === 'messages' ? JSON.stringify(vars.messages) : String(vars[name as keyof TemplateVars]);

/** A URL with placeholders; values are URL-encoded. */
export function renderUrl(template: string, vars: TemplateVars): string {
  const url = template.replace(PLACEHOLDER, (_, name: string) =>
    encodeURIComponent(text(vars, name)),
  );
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The server URL must start with http:// or https://.');
  }
  return parsed.toString();
}

/**
 * The request body for the content type:
 * - JSON: a placeholder that is a whole string value ("{{messages}}") becomes that JSON value,
 *   so messages stay an array; inside a longer string it is JSON-escaped.
 * - form-urlencoded: values are URL-encoded.
 * - anything else: values are inserted as they are.
 */
export function renderBody(template: string, contentType: string, vars: TemplateVars): string {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'application/json' || type.endsWith('+json')) {
    const whole = template.replace(
      /"\{\{\s*(prompt|system|model|messages)\s*\}\}"/g,
      (_, name: string) =>
        name === 'messages' ? JSON.stringify(vars.messages) : JSON.stringify(text(vars, name)),
    );
    const body = whole.replace(PLACEHOLDER, (_, name: string) =>
      JSON.stringify(text(vars, name)).slice(1, -1),
    );
    try {
      JSON.parse(body);
    } catch {
      throw new Error(
        'The body template is not valid JSON once filled in. Put placeholders inside quotes, e.g. {"prompt": "{{prompt}}"}.',
      );
    }
    return body;
  }
  if (type === 'application/x-www-form-urlencoded') {
    return template.replace(PLACEHOLDER, (_, name: string) => encodeURIComponent(text(vars, name)));
  }
  return template.replace(PLACEHOLDER, (_, name: string) => text(vars, name));
}

/** "choices.0.message.content" → that value, or undefined. */
export function getPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split('.').filter(Boolean)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// Common reply shapes, tried in order when no path is set.
const AUTO_PATHS = [
  'choices.0.message.content',
  'choices.0.text',
  'content.0.text',
  'message.content',
  'output.0.content.0.text',
  'output_text',
  'response',
  'output',
  'text',
  'result',
  'answer',
  'reply',
  'data.text',
  'data.output',
];

/** The reply text in a response body, and which path it came from. */
export function extractReply(
  body: string,
  replyPath: string,
): { reply: string; path: string | null } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { reply: body, path: null }; // not JSON: the whole body is the reply
  }
  if (typeof json === 'string') return { reply: json, path: null };
  if (replyPath) {
    const found = getPath(json, replyPath);
    if (found === undefined) {
      throw new Error(
        `The response has nothing at "${replyPath}". Paths it has: ${listPaths(json).join(', ') || 'none'}.`,
      );
    }
    return { reply: typeof found === 'string' ? found : JSON.stringify(found), path: replyPath };
  }
  for (const path of AUTO_PATHS) {
    const found = getPath(json, path);
    if (typeof found === 'string') return { reply: found, path };
  }
  return { reply: body, path: null };
}

/** Text paths in a JSON value, to help pick a reply path. */
export function listPaths(value: unknown, prefix = '', out: string[] = [], depth = 0): string[] {
  if (out.length >= 25 || depth > 6) return out;
  if (typeof value === 'string') out.push(prefix || '(root)');
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value).slice(0, 20)) {
      listPaths(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
  }
  return out;
}

export interface TextToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Tool calls written as text: a fenced ```tool block, or a bare JSON object, holding
 * {"tool": "name", "args": {...}}. Several blocks mean several calls.
 */
export function parseToolCalls(reply: string, toolNames: readonly string[]): TextToolCall[] {
  const blocks = [...reply.matchAll(/```(?:tool|json)?\s*\n?([\s\S]*?)```/g)].map(
    (m) => m[1] ?? '',
  );
  const trimmed = reply.trim();
  if (!blocks.length && trimmed.startsWith('{') && trimmed.endsWith('}')) blocks.push(trimmed);
  const calls: TextToolCall[] = [];
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      const o = item as { tool?: unknown; name?: unknown; args?: unknown; arguments?: unknown };
      const name = typeof o.tool === 'string' ? o.tool : typeof o.name === 'string' ? o.name : '';
      const args = (o.args ?? o.arguments ?? {}) as Record<string, unknown>;
      if (name && toolNames.includes(name) && args && typeof args === 'object') {
        calls.push({ name, args });
      }
    }
  }
  return calls;
}

export interface HttpCallResult {
  status: number;
  /** Clipped for display. */
  raw: string;
  reply: string;
  path: string | null;
  request: { method: string; url: string; headers: Record<string, string>; body: string | null };
}

/** One call to the server. Header values in the returned request are hidden. */
export async function callHttp(
  url: string,
  config: HttpRequestConfig,
  headers: Record<string, string>,
  vars: TemplateVars,
  signal?: AbortSignal,
): Promise<HttpCallResult> {
  const target = renderUrl(url, vars);
  const body =
    config.method === 'GET' ? null : renderBody(config.bodyTemplate, config.contentType, vars);
  const sent: Record<string, string> = {
    ...(body === null ? {} : { 'content-type': config.contentType }),
    ...headers,
  };
  const res = await fetch(target, {
    method: config.method,
    headers: sent,
    ...(body === null ? {} : { body }),
    signal: signal ?? AbortSignal.timeout(120_000),
  });
  const raw = await res.text();
  const request = {
    method: config.method,
    url: target,
    headers: Object.fromEntries(
      Object.entries(sent).map(([k, v]) => [k, k.toLowerCase() === 'content-type' ? v : 'hidden']),
    ),
    body,
  };
  if (!res.ok) {
    const error = new Error(
      `The server answered ${res.status} ${res.statusText}: ${raw.slice(0, 300)}`,
    );
    Object.assign(error, {
      result: { status: res.status, raw: raw.slice(0, 4_000), reply: '', path: null, request },
    });
    throw error;
  }
  const { reply, path } = extractReply(raw, config.replyPath);
  return { status: res.status, raw: raw.slice(0, 4_000), reply, path, request };
}
