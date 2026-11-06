import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { templateVars, toolInstructions } from '../../src/models/http-chat.ts';
import {
  extractReply,
  listPaths,
  parseToolCalls,
  renderBody,
  renderUrl,
  type TemplateVars,
} from '../../src/models/http-request.ts';

const vars: TemplateVars = {
  prompt: 'Say "hi"\nnow',
  system: 'Be brief.',
  model: 'm-1',
  messages: [{ role: 'user', content: 'Say "hi"' }],
};

describe('renderBody', () => {
  it('escapes JSON strings and keeps {{messages}} an array', () => {
    const body = renderBody(
      '{"model": "{{model}}", "input": {"text": "{{prompt}}"}, "messages": "{{messages}}", "note": "for {{model}}"}',
      'application/json',
      vars,
    );
    expect(JSON.parse(body)).toEqual({
      model: 'm-1',
      input: { text: 'Say "hi"\nnow' },
      messages: [{ role: 'user', content: 'Say "hi"' }],
      note: 'for m-1',
    });
  });

  it('says how to fix a template that is not JSON', () => {
    expect(() => renderBody('{prompt: {{prompt}}}', 'application/json', vars)).toThrow(
      /inside quotes/,
    );
  });

  it('URL-encodes form bodies and leaves text as it is', () => {
    expect(renderBody('q={{prompt}}&m={{model}}', 'application/x-www-form-urlencoded', vars)).toBe(
      'q=Say%20%22hi%22%0Anow&m=m-1',
    );
    expect(renderBody('{{prompt}}', 'text/plain', vars)).toBe('Say "hi"\nnow');
  });
});

describe('renderUrl', () => {
  it('fills placeholders in the path and query, URL-encoded', () => {
    expect(renderUrl('https://x.dev/v1/{{model}}/run?q={{prompt}}', vars)).toBe(
      'https://x.dev/v1/m-1/run?q=Say%20%22hi%22%0Anow',
    );
  });
  it('refuses other protocols', () => {
    expect(() => renderUrl('file:///etc/{{model}}', vars)).toThrow(/http/);
  });
});

describe('extractReply', () => {
  it('follows a reply path, including array indexes', () => {
    const body = JSON.stringify({ data: { outputs: [{ text: 'OK' }] } });
    expect(extractReply(body, 'data.outputs.0.text')).toEqual({
      reply: 'OK',
      path: 'data.outputs.0.text',
    });
  });
  it('lists the paths it has when the path is wrong', () => {
    expect(() => extractReply('{"a": {"b": "x"}}', 'a.c')).toThrow(/a\.b/);
  });
  it('detects OpenAI, Anthropic and simple shapes, else returns the body', () => {
    expect(extractReply('{"choices":[{"message":{"content":"o"}}]}', '').reply).toBe('o');
    expect(extractReply('{"content":[{"type":"text","text":"a"}]}', '').reply).toBe('a');
    expect(extractReply('{"response":"r"}', '').reply).toBe('r');
    expect(extractReply('plain text', '').reply).toBe('plain text');
    expect(extractReply('{"x": 1}', '')).toEqual({ reply: '{"x": 1}', path: null });
  });
  it('lists text paths in a response', () => {
    expect(listPaths({ a: 'x', b: [{ c: 'y' }], n: 1 })).toEqual(['a', 'b.0.c']);
  });
});

describe('text tool protocol', () => {
  it('reads tool calls from a fenced block or bare JSON, ignoring unknown tools', () => {
    const tools = ['write_file', 'read_file'];
    expect(
      parseToolCalls(
        'Sure:\n```tool\n{"tool": "write_file", "args": {"path": "a.md", "content": "x"}}\n```',
        tools,
      ),
    ).toEqual([{ name: 'write_file', args: { path: 'a.md', content: 'x' } }]);
    expect(parseToolCalls('{"name": "read_file", "arguments": {"path": "a.md"}}', tools)).toEqual([
      { name: 'read_file', args: { path: 'a.md' } },
    ]);
    expect(parseToolCalls('```tool\n{"tool": "rm_rf", "args": {}}\n```', tools)).toEqual([]);
    expect(parseToolCalls('All done, I wrote a.md.', tools)).toEqual([]);
  });

  it('writes the conversation, tool calls and results as text for the server', () => {
    const tools = [
      { name: 'write_file', description: 'Write a file', parameters: { type: 'object' } },
    ];
    const v = templateVars(
      [
        new SystemMessage('You are a writer.'),
        new HumanMessage('Write a.md'),
        new AIMessage({
          content: '',
          tool_calls: [{ id: '1', name: 'write_file', args: { path: 'a.md' } }],
        }),
        new ToolMessage({ tool_call_id: '1', name: 'write_file', content: 'Wrote 3 bytes.' }),
      ],
      'm',
      tools,
    );
    expect(v.system).toContain('You are a writer.');
    expect(v.system).toContain(toolInstructions(tools).trim().split('\n')[0]);
    expect(v.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(v.messages[2]?.content).toContain('"tool":"write_file"');
    expect(v.messages[3]?.content).toBe('Result of write_file:\nWrote 3 bytes.');
    expect(v.prompt).toContain('## User\nWrite a.md');
  });
});
