import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface ChatRequest {
  model: string;
  messages: { role: string; content: string; tool_calls?: unknown[] }[];
  tools?: { function: { name: string } }[];
  format?: { properties?: Record<string, unknown> };
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** What the fake model says. Tests replace any of these to script a scenario. */
export interface Script {
  /** Planner: return { steps: [...] }. `prompt` is the planner's user message. */
  plan: (prompt: string) => unknown;
  /** Step judge (prompt starts with "Step:") and goal judge (starts with "Goal:"). */
  judge: (prompt: string) => { passed: boolean; reason: string };
  /** Worker turn: a tool call, or the final reply. `tools` = tool names this agent has. */
  worker: (turn: { title: string; toolResults: string[]; tools: string[] }) => ToolCall | string;
}

export const defaultScript = (): Script => ({
  plan: () => ({ steps: [] }),
  judge: () => ({ passed: true, reason: 'Looks complete.' }),
  worker: ({ title, toolResults }) =>
    toolResults.length
      ? `Wrote ${title}.md with the result.`
      : { name: 'write_file', args: { path: `${title}.md`, content: `# ${title}\nDone.` } },
});

/**
 * A stand-in for Ollama's /api/chat, so the engine runs through the real ChatOllama client
 * without a model. Every reply costs 15 tokens (10 prompt + 5 completion).
 */
export async function startFakeOllama() {
  const script: Script = defaultScript();
  const calls = { plan: 0, judge: 0, worker: 0 };
  /** Request headers of every /api/chat call, oldest first. */
  const headers: Record<string, string | string[] | undefined>[] = [];
  /** Every /api/chat request body, oldest first. */
  const bodies: ChatRequest[] = [];

  const server: Server = createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'fake' }, { name: 'fake-big' }] }));
      return;
    }
    if (req.url !== '/api/chat') {
      res.writeHead(404).end();
      return;
    }
    headers.push(req.headers);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const request = JSON.parse(body) as ChatRequest;
      bodies.push(request);
      const last = request.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      const props = request.format?.properties ?? {};
      let content = '';
      let toolCalls: unknown[] | undefined;
      if ('steps' in props) {
        calls.plan++;
        content = JSON.stringify(script.plan(last));
      } else if ('passed' in props) {
        calls.judge++;
        content = JSON.stringify(script.judge(last));
      } else {
        calls.worker++;
        const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
        const title = /Your step: (.+)/.exec(system)?.[1]?.trim() ?? 'step';
        const toolResults = request.messages.filter((m) => m.role === 'tool').map((m) => m.content);
        const tools = (request.tools ?? []).map((t) => t.function.name);
        const reply = script.worker({ title, toolResults, tools });
        if (typeof reply === 'string') content = reply;
        else toolCalls = [{ function: { name: reply.name, arguments: reply.args } }];
      }
      const message = {
        role: 'assistant',
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      };
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(
        `${JSON.stringify({
          model: request.model,
          created_at: new Date().toISOString(),
          message,
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 10,
          eval_count: 5,
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    script,
    calls,
    headers,
    bodies,
    reset() {
      Object.assign(script, defaultScript());
      calls.plan = calls.judge = calls.worker = 0;
      headers.length = 0;
      bodies.length = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
