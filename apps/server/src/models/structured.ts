import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessageLike } from '@langchain/core/messages';
import { z } from 'zod';
import { structuredMethod } from './provider.ts';

type Raw = { content?: unknown; usage_metadata?: unknown };

/** Models that could not give structured output, so the next call goes straight to JSON text. */
const textOnly = new WeakSet<object>();

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((c) => (typeof c === 'string' ? c : ((c as { text?: string }).text ?? '')))
          .join('')
      : '';

/** The JSON object in a model's reply: after any <think> block, inside a code fence or bare. */
export function extractJson(text: string): unknown {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(clean)?.[1];
  for (const candidate of [fenced, clean]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // Try the first {...} below.
    }
  }
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
  throw new Error('The reply had no JSON in it.');
}

/**
 * A model that answers as a schema. Models with real structured output use it. Some (Inkling 2
 * Mini on Ollama: "structured output is unavailable") cannot, so they are asked for JSON in the
 * prompt and the reply is checked against the same schema.
 */
export function structured<S extends z.ZodType>(
  model: BaseChatModel,
  schema: S,
  name: string,
  options: { includeRaw?: boolean } = {},
) {
  const native = model.withStructuredOutput(schema, {
    name,
    includeRaw: true,
    ...structuredMethod(model),
  });
  const asText = async (messages: BaseMessageLike[], config?: { signal?: AbortSignal }) => {
    const shape = JSON.stringify(z.toJSONSchema(schema));
    const note = `Reply with only one JSON object that matches this JSON Schema, with no other text:\n${shape}`;
    const withNote: BaseMessageLike[] = [...messages, { role: 'user', content: note }];
    const raw = (await model.invoke(withNote, config)) as unknown as Raw;
    return { raw, parsed: schema.parse(extractJson(textOf(raw.content))) as z.infer<S> };
  };
  return {
    async invoke(
      messages: BaseMessageLike[],
      config?: { signal?: AbortSignal },
    ): Promise<{ raw: Raw; parsed: z.infer<S> }> {
      if (!textOnly.has(model)) {
        try {
          const r = (await native.invoke(messages, config)) as unknown as {
            raw: Raw;
            parsed?: z.infer<S> | null;
          };
          if (r.parsed) return { raw: r.raw, parsed: r.parsed };
          // No tool call, but the answer may be JSON text.
          const fromText = schema.safeParse(safe(() => extractJson(textOf(r.raw.content))));
          if (fromText.success) return { raw: r.raw, parsed: fromText.data };
          textOnly.add(model);
        } catch (error) {
          if (!/structured output is unavailable/i.test(String((error as Error)?.message)))
            throw error;
          textOnly.add(model);
        }
      }
      return asText(messages, config);
    },
    includeRaw: options.includeRaw ?? true,
  };
}

function safe<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}
