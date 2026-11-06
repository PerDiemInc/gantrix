import { randomBytes } from 'node:crypto';

export const LAYOUTS = [
  'TITLE',
  'SECTION_HEADER',
  'TITLE_AND_BODY',
  'TITLE_AND_TWO_COLUMNS',
  'TITLE_ONLY',
  'BIG_NUMBER',
  'BLANK',
] as const;
export type Layout = (typeof LAYOUTS)[number];

/** Which placeholders each Google predefined layout has, in the order we fill them. */
const PLACEHOLDERS: Record<
  Layout,
  { type: string; index: number; field: 'title' | 'body' | 'right' }[]
> = {
  TITLE: [
    { type: 'CENTERED_TITLE', index: 0, field: 'title' },
    { type: 'SUBTITLE', index: 0, field: 'body' },
  ],
  SECTION_HEADER: [{ type: 'TITLE', index: 0, field: 'title' }],
  TITLE_AND_BODY: [
    { type: 'TITLE', index: 0, field: 'title' },
    { type: 'BODY', index: 0, field: 'body' },
  ],
  TITLE_AND_TWO_COLUMNS: [
    { type: 'TITLE', index: 0, field: 'title' },
    { type: 'BODY', index: 0, field: 'body' },
    { type: 'BODY', index: 1, field: 'right' },
  ],
  TITLE_ONLY: [{ type: 'TITLE', index: 0, field: 'title' }],
  BIG_NUMBER: [
    { type: 'TITLE', index: 0, field: 'title' },
    { type: 'BODY', index: 0, field: 'body' },
  ],
  BLANK: [],
};

export interface SlideInput {
  layout: Layout;
  title?: string | undefined;
  body?: string | undefined;
  right?: string | undefined;
  /** Lines of body text become bullets. */
  bullets?: boolean | undefined;
  background?: string | undefined;
  textColor?: string | undefined;
  /** 0-based; omitted = at the end. */
  index?: number | undefined;
}

const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString('hex')}`;

export function hexToRgb(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) throw new Error(`"${hex}" isn't a colour like #1F6FEB.`);
  const n = Number.parseInt(m[1], 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

/** The batchUpdate requests that create one slide and fill it. */
export function slideRequests(s: SlideInput, slideId = newId('slide')) {
  const slots = PLACEHOLDERS[s.layout].filter((p) => s[p.field]);
  const ids = slots.map((p) => ({ ...p, objectId: newId(p.field) }));
  const requests: Record<string, unknown>[] = [
    {
      createSlide: {
        objectId: slideId,
        ...(s.index === undefined ? {} : { insertionIndex: s.index }),
        slideLayoutReference: { predefinedLayout: s.layout },
        placeholderIdMappings: ids.map((p) => ({
          layoutPlaceholder: { type: p.type, index: p.index },
          objectId: p.objectId,
        })),
      },
    },
  ];
  for (const p of ids) {
    const text = s[p.field] ?? '';
    requests.push({ insertText: { objectId: p.objectId, insertionIndex: 0, text } });
    if (p.field !== 'title' && s.bullets && s.layout !== 'TITLE' && s.layout !== 'BIG_NUMBER') {
      requests.push({
        createParagraphBullets: {
          objectId: p.objectId,
          textRange: { type: 'ALL' },
          bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
        },
      });
    }
    if (s.textColor) {
      requests.push({
        updateTextStyle: {
          objectId: p.objectId,
          textRange: { type: 'ALL' },
          style: { foregroundColor: { opaqueColor: { rgbColor: hexToRgb(s.textColor) } } },
          fields: 'foregroundColor',
        },
      });
    }
  }
  if (s.background) {
    requests.push({
      updatePageProperties: {
        objectId: slideId,
        pageProperties: {
          pageBackgroundFill: { solidFill: { color: { rgbColor: hexToRgb(s.background) } } },
        },
        fields: 'pageBackgroundFill.solidFill.color',
      },
    });
  }
  return { slideId, requests };
}

export class SlidesApi {
  readonly #base: string;
  readonly #token: () => Promise<string>;

  constructor(base: string, token: () => Promise<string>) {
    this.#base = base.replace(/\/+$/, '');
    this.#token = token;
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.#base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.#token()}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
    if (!res.ok)
      throw new Error(`Google Slides: ${json.error?.message ?? `${res.status} ${res.statusText}`}`);
    return json;
  }

  async create(title: string) {
    const p = await this.#call<{ presentationId: string; slides?: { objectId: string }[] }>(
      'POST',
      '/v1/presentations',
      { title },
    );
    // A new deck starts with one empty title slide; remove it so slides come only from add_slide.
    const first = p.slides?.[0]?.objectId;
    if (first) await this.batch(p.presentationId, [{ deleteObject: { objectId: first } }]);
    return {
      id: p.presentationId,
      url: `https://docs.google.com/presentation/d/${p.presentationId}/edit`,
    };
  }

  batch(id: string, requests: unknown[]) {
    return this.#call('POST', `/v1/presentations/${encodeURIComponent(id)}:batchUpdate`, {
      requests,
    });
  }

  get(id: string) {
    return this.#call<{
      title?: string;
      slides?: {
        objectId: string;
        pageElements?: {
          shape?: { text?: { textElements?: { textRun?: { content?: string } }[] } };
        }[];
        slideProperties?: { notesPage?: { notesProperties?: { speakerNotesObjectId?: string } } };
      }[];
    }>('GET', `/v1/presentations/${encodeURIComponent(id)}`);
  }
}
