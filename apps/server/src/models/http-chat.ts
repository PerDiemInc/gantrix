import type { HttpRequestConfig } from '@gantrix/shared';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import {
  BaseChatModel,
  type BaseChatModelParams,
  type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { callHttp, parseToolCalls, type TemplateVars } from './http-request.ts';

export interface HttpChatOptions extends BaseChatModelParams {
  url: string;
  request: HttpRequestConfig;
  /** Already resolved (env: values filled in). */
  headers: Record<string, string>;
  model: string;
  tools?: { name: string; description: string; parameters: unknown }[];
}

const textOf = (m: BaseMessage) =>
  typeof m.content === 'string'
    ? m.content
    : m.content.map((p) => (typeof p === 'object' && 'text' in p ? String(p.text) : '')).join('');

/** How to call tools when the server only speaks text. */
export function toolInstructions(tools: NonNullable<HttpChatOptions['tools']>): string {
  if (!tools.length) return '';
  const list = tools
    .map(
      (t) =>
        `- ${t.name}: ${t.description}\n  arguments (JSON Schema): ${JSON.stringify(t.parameters)}`,
    )
    .join('\n');
  return `\n\n## Tools\nYou can use these tools:\n${list}\n\nTo use one, reply with ONLY a block like this and nothing else:\n\`\`\`tool\n{"tool": "write_file", "args": {"path": "notes.md", "content": "..."}}\n\`\`\`\nYou will get the result in the next message. When the work is done, reply in plain text without a tool block.`;
}

/** The conversation for the templates, with tool calls and results written as text. */
export function templateVars(
  messages: readonly BaseMessage[],
  model: string,
  tools: NonNullable<HttpChatOptions['tools']>,
): TemplateVars {
  const system =
    messages
      .filter((m) => m.getType() === 'system')
      .map(textOf)
      .join('\n\n') + toolInstructions(tools);
  const chat: TemplateVars['messages'] = [];
  if (system) chat.push({ role: 'system', content: system });
  for (const m of messages) {
    const type = m.getType();
    if (type === 'human') chat.push({ role: 'user', content: textOf(m) });
    if (type === 'ai') {
      const calls = (m as AIMessage).tool_calls ?? [];
      const content = calls.length
        ? calls
            .map((c) => `\`\`\`tool\n${JSON.stringify({ tool: c.name, args: c.args })}\n\`\`\``)
            .join('\n')
        : textOf(m);
      chat.push({ role: 'assistant', content });
    }
    if (type === 'tool') {
      const name = (m as { name?: string }).name ?? 'tool';
      chat.push({ role: 'user', content: `Result of ${name}:\n${textOf(m)}` });
    }
  }
  const rest = chat.filter((c) => c.role !== 'system');
  const prompt =
    rest.length === 1
      ? (rest[0]?.content ?? '')
      : rest.map((c) => `## ${c.role === 'user' ? 'User' : 'You'}\n${c.content}`).join('\n\n');
  // Servers that take one prompt get the system text in front of it.
  return {
    system,
    model,
    messages: chat,
    prompt: system && rest.length ? `${system}\n\n${prompt}` : prompt,
  };
}

/** Any HTTP model server, described by a request template (the "http" connection). */
export class HttpChatModel extends BaseChatModel {
  readonly #o: HttpChatOptions;

  constructor(o: HttpChatOptions) {
    super(o);
    this.#o = o;
  }

  _llmType() {
    return 'http';
  }

  override bindTools(tools: BindToolsInput[]) {
    return new HttpChatModel({
      ...this.#o,
      tools: tools.map((t) => {
        const f = convertToOpenAITool(t as Parameters<typeof convertToOpenAITool>[0]).function;
        return { name: f.name, description: f.description ?? '', parameters: f.parameters };
      }),
    });
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    _run?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const tools = this.#o.tools ?? [];
    const vars = templateVars(messages, this.#o.model, tools);
    const result = await callHttp(
      this.#o.url,
      this.#o.request,
      this.#o.headers,
      vars,
      options.signal,
    );
    const calls = parseToolCalls(
      result.reply,
      tools.map((t) => t.name),
    );
    const message = calls.length
      ? new AIMessage({
          content: '',
          tool_calls: calls.map((c, i) => ({
            id: `call_${Date.now()}_${i}`,
            name: c.name,
            args: c.args,
          })),
        })
      : new AIMessage(result.reply);
    return { generations: [{ text: result.reply, message }] };
  }
}
