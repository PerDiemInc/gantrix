import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NotConnected } from './auth.ts';
import { LAYOUTS, type SlidesApi, slideRequests } from './slides.ts';

const text = (t: string, isError = false) => ({
  content: [{ type: 'text' as const, text: t }],
  ...(isError ? { isError } : {}),
});
const run = async (fn: () => Promise<string>) => {
  try {
    return text(await fn());
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true);
  }
};
const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour like #1F6FEB');

export function createServer(api: SlidesApi) {
  const server = new McpServer({ name: 'gantrix-slides', version: '0.1.0' });

  server.registerTool(
    'create_presentation',
    {
      description:
        "Create a new, empty Google Slides deck in the user's Drive. Returns its id and link.",
      inputSchema: { title: z.string().min(1).max(200) },
    },
    ({ title }) =>
      run(async () => {
        const p = await api.create(title);
        return `Created "${title}". presentation_id: ${p.id}\nLink: ${p.url}`;
      }),
  );

  server.registerTool(
    'add_slide',
    {
      description:
        'Add one slide. Layouts: TITLE (title + subtitle), SECTION_HEADER, TITLE_AND_BODY, TITLE_AND_TWO_COLUMNS (body = left, right = right), TITLE_ONLY, BIG_NUMBER (title = the number, body = what it means), BLANK. Put one idea per slide; separate bullet lines with \\n.',
      inputSchema: {
        presentation_id: z.string().min(5),
        layout: z.enum(LAYOUTS),
        title: z.string().max(300).optional(),
        body: z.string().max(3_000).optional(),
        right: z.string().max(3_000).optional(),
        bullets: z.boolean().default(false).describe('turn body lines into bullets'),
        notes: z.string().max(5_000).optional().describe('speaker notes'),
        background: HEX.optional(),
        text_color: HEX.optional(),
        index: z.number().int().min(0).optional().describe('0-based position; default: at the end'),
      },
    },
    (a) =>
      run(async () => {
        const { slideId, requests } = slideRequests({
          layout: a.layout,
          title: a.title,
          body: a.body,
          right: a.right,
          bullets: a.bullets,
          background: a.background,
          textColor: a.text_color,
          index: a.index,
        });
        await api.batch(a.presentation_id, requests);
        if (a.notes) {
          const deck = await api.get(a.presentation_id);
          const notesId = deck.slides?.find((s) => s.objectId === slideId)?.slideProperties
            ?.notesPage?.notesProperties?.speakerNotesObjectId;
          if (notesId) {
            await api.batch(a.presentation_id, [
              { insertText: { objectId: notesId, insertionIndex: 0, text: a.notes } },
            ]);
          }
        }
        return `Added a ${a.layout} slide (${slideId}).`;
      }),
  );

  server.registerTool(
    'list_slides',
    {
      description: 'List the slides of a deck with their text, to check the result.',
      inputSchema: { presentation_id: z.string().min(5) },
    },
    ({ presentation_id }) =>
      run(async () => {
        const deck = await api.get(presentation_id);
        const lines = (deck.slides ?? []).map((s, i) => {
          const words = (s.pageElements ?? [])
            .flatMap((e) => e.shape?.text?.textElements ?? [])
            .map((t) => t.textRun?.content ?? '')
            .join('')
            .replace(/\s+/g, ' ')
            .trim();
          return `${i + 1}. ${words.slice(0, 160) || '(no text)'}`;
        });
        return `"${deck.title ?? ''}" has ${lines.length} slides:\n${lines.join('\n')}`;
      }),
  );

  return server;
}

export { NotConnected };
