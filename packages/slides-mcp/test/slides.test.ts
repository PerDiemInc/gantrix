import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttp, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accessToken, loadGoogleConfig } from '../src/auth.ts';
import { createServer } from '../src/server.ts';
import { hexToRgb, SlidesApi, slideRequests } from '../src/slides.ts';

/** Just enough of Google's token endpoint and Slides API to check what we send. */
async function fakeGoogle() {
  const batches: { id: string; requests: Record<string, Record<string, unknown>>[] }[] = [];
  const slides: string[] = ['p0'];
  const auth: string[] = [];
  const server: Server = createHttp((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      auth.push(String(req.headers.authorization ?? ''));
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.url === '/token') return json(200, { access_token: 'fresh-token', expires_in: 3600 });
      if (req.method === 'POST' && req.url === '/v1/presentations') {
        return json(200, { presentationId: 'deck1', slides: [{ objectId: 'p0' }] });
      }
      const m = /^\/v1\/presentations\/(\w+)(:batchUpdate)?$/.exec(req.url ?? '');
      if (m?.[2]) {
        const { requests } = JSON.parse(body);
        batches.push({ id: m[1] ?? '', requests });
        for (const r of requests) {
          if (r.createSlide) slides.push(r.createSlide.objectId);
          if (r.deleteObject) slides.splice(slides.indexOf(r.deleteObject.objectId), 1);
        }
        return json(200, {});
      }
      if (m) {
        return json(200, {
          title: 'Q4 plan',
          slides: slides.map((id) => ({
            objectId: id,
            pageElements: [
              { shape: { text: { textElements: [{ textRun: { content: `text of ${id}` } }] } } },
            ],
            slideProperties: {
              notesPage: { notesProperties: { speakerNotesObjectId: `${id}_notes` } },
            },
          })),
        });
      }
      json(404, { error: { message: 'not found' } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    batches,
    slides,
    auth,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let dir: string;
let google: Awaited<ReturnType<typeof fakeGoogle>>;
let client: Client;

async function connect(withToken = true) {
  const env = {
    GANTRIX_GOOGLE_DIR: dir,
    GOOGLE_TOKEN_URL: `${google.url}/token`,
    GOOGLE_SLIDES_API: google.url,
  };
  const cfg = loadGoogleConfig(env);
  await mkdir(dir, { recursive: true });
  await writeFile(
    cfg.clientFile,
    JSON.stringify({ installed: { client_id: 'cid', client_secret: 'sec' } }),
  );
  if (withToken) await writeFile(cfg.tokenFile, JSON.stringify({ refresh_token: 'refresh-1' }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1' });
  await Promise.all([
    createServer(new SlidesApi(google.url, () => accessToken(cfg))).connect(a),
    client.connect(b),
  ]);
  return cfg;
}
async function call(name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { text: r.content[0]?.text ?? '', isError: Boolean(r.isError) };
}

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'slides-')), 'google');
  google = await fakeGoogle();
});
afterEach(async () => {
  await client?.close();
  await google.close();
  await rm(join(dir, '..'), { recursive: true, force: true });
});

describe('slides-mcp', () => {
  it('refreshes the token, creates an empty deck and keeps the token file private', async () => {
    const cfg = await connect();
    const r = await call('create_presentation', { title: 'Q4 plan' });
    expect(r.text).toContain('https://docs.google.com/presentation/d/deck1/edit');
    expect(google.auth.filter((a) => a === 'Bearer fresh-token').length).toBeGreaterThan(0);
    expect(google.slides).toEqual([]); // the default first slide is removed
    const saved = JSON.parse(await readFile(cfg.tokenFile, 'utf8'));
    expect(saved).toMatchObject({ refresh_token: 'refresh-1', access_token: 'fresh-token' });
    expect((await stat(cfg.tokenFile)).mode & 0o777).toBe(0o600);
  });

  it('adds a slide with layout placeholders, bullets, colours and speaker notes', async () => {
    await connect();
    const r = await call('add_slide', {
      presentation_id: 'deck1',
      layout: 'TITLE_AND_BODY',
      title: 'Why now',
      body: 'Faster\nCheaper',
      bullets: true,
      background: '#0B1F3A',
      text_color: '#FFFFFF',
      notes: 'Pause here.',
    });
    expect(r.isError).toBe(false);
    const [first, notes] = google.batches;
    const kinds = first?.requests.map((q) => Object.keys(q)[0]);
    expect(kinds).toEqual([
      'createSlide',
      'insertText',
      'updateTextStyle',
      'insertText',
      'createParagraphBullets',
      'updateTextStyle',
      'updatePageProperties',
    ]);
    const mappings = (
      first!.requests[0]!.createSlide as {
        placeholderIdMappings: { layoutPlaceholder: { type: string } }[];
      }
    ).placeholderIdMappings.map((p) => p.layoutPlaceholder.type);
    expect(mappings).toEqual(['TITLE', 'BODY']);
    expect(notes?.requests[0]).toMatchObject({ insertText: { text: 'Pause here.' } });
    expect((await call('list_slides', { presentation_id: 'deck1' })).text).toContain(
      'has 2 slides',
    );
  });

  it('explains the one-time setup when Google is not connected', async () => {
    await connect(false);
    const r = await call('create_presentation', { title: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('npm run slides:auth');
  });
});

describe('slideRequests', () => {
  it('only maps the placeholders it fills, and converts colours', () => {
    const { requests } = slideRequests({ layout: 'TITLE', title: 'Gantrix' });
    expect(
      (requests[0]!.createSlide as { placeholderIdMappings: unknown[] }).placeholderIdMappings,
    ).toHaveLength(1);
    expect(hexToRgb('#FF8000')).toEqual({ red: 1, green: 128 / 255, blue: 0 });
    expect(() => hexToRgb('red')).toThrow();
  });
});
