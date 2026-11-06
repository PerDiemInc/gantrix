import type { ConversationMessage } from '@gantrix/shared';
import type { BaseMessage } from '@langchain/core/messages';

/** Long tool results are cut so one page never carries megabytes. */
export const MAX_MESSAGE_CHARS = 20_000;

const clip = (s: string) =>
  s.length > MAX_MESSAGE_CHARS
    ? `${s.slice(0, MAX_MESSAGE_CHARS)}\n… (${s.length - MAX_MESSAGE_CHARS} more characters)`
    : s;

function textOf(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (typeof part === 'object' && 'text' in part ? String(part.text) : ''))
    .join('');
}

const ROLES: Record<string, ConversationMessage['role']> = {
  system: 'system',
  human: 'user',
  ai: 'assistant',
  tool: 'tool',
};

/** LangGraph checkpoint messages → what the dashboard and CLI show. */
export function toConversation(messages: readonly BaseMessage[]): ConversationMessage[] {
  return messages.flatMap((m): ConversationMessage[] => {
    const role = ROLES[m.getType()];
    if (!role) return [];
    const out: ConversationMessage = { role, text: clip(textOf(m.content)) };
    const extra = m.additional_kwargs as { reasoning_content?: unknown } | undefined;
    if (typeof extra?.reasoning_content === 'string' && extra.reasoning_content.trim()) {
      out.thinking = clip(extra.reasoning_content.trim());
    }
    if (role === 'assistant') {
      const ai = m as BaseMessage & {
        tool_calls?: { id?: string; name: string; args: Record<string, unknown> }[];
        usage_metadata?: { total_tokens?: number };
      };
      if (ai.tool_calls?.length) {
        out.toolCalls = ai.tool_calls.map((c) => ({ id: c.id ?? '', name: c.name, args: c.args }));
      }
      if (ai.usage_metadata?.total_tokens) out.tokens = ai.usage_metadata.total_tokens;
    }
    if (role === 'tool') {
      const t = m as BaseMessage & { tool_call_id?: string; name?: string };
      if (t.name) out.toolName = t.name;
      if (t.tool_call_id) out.toolCallId = t.tool_call_id;
    }
    return [out];
  });
}
