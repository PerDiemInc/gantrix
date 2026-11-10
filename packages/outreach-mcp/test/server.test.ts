import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createServer, type OutgoingEmail } from '../src/server.ts';

const SETTINGS = `SMTP_URL=smtps://u:p@smtp.example.com:465
OUTREACH_FROM=Dana Lee <dana@example.com>
OUTREACH_POSTAL_ADDRESS=Example Inc, 1 Main St, Springfield, IL 62701
OUTREACH_DAILY_LIMIT=2
`;
const BODY = 'Saw your new location opened in Austin. Happy to share how others handle pickup.';

let dir: string;
let sent: OutgoingEmail[];
let client: Client;

async function connect(withSettings = true) {
  if (withSettings) await writeFile(join(dir, 'outreach.env'), SETTINGS);
  const cfg = loadConfig({ HOME: dir, OUTREACH_CONFIG: join(dir, 'outreach.env') });
  const server = createServer(cfg, async (email) => {
    sent.push(email);
    return { messageId: `<m${sent.length}@test>` };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
}

async function call(name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { text: r.content[0]?.text ?? '', isError: Boolean(r.isError) };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'outreach-'));
  sent = [];
});
afterEach(async () => {
  await client?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('send_email', () => {
  it('adds the unsubscribe line, postal address and List-Unsubscribe header', async () => {
    await connect();
    const r = await call('send_email', {
      to: 'Sam@Shop.com',
      subject: 'Pickup in Austin',
      body: BODY,
    });
    expect(r.isError).toBe(false);
    expect(sent[0]?.text).toContain('Reply "unsubscribe"');
    expect(sent[0]?.text).toContain('1 Main St, Springfield');
    expect(sent[0]?.headers['List-Unsubscribe']).toBe(
      '<mailto:dana@example.com?subject=unsubscribe>',
    );
    expect(await readFile(join(dir, '.gantrix/outreach/sent.csv'), 'utf8')).toContain(
      'sam@shop.com',
    );
  });

  it('explains the setup instead of sending when settings are missing', async () => {
    await connect(false);
    const r = await call('send_email', { to: 'sam@shop.com', subject: 'Hello there', body: BODY });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('~/.gantrix/outreach.env');
    expect(sent).toHaveLength(0);
  });

  it('never emails someone on the do-not-contact list, including whole domains', async () => {
    await connect();
    await call('add_do_not_contact', { email: '@shop.com', reason: 'asked to stop' });
    const r = await call('send_email', { to: 'sam@shop.com', subject: 'Hello there', body: BODY });
    expect(r.isError).toBe(true);
    expect(sent).toHaveLength(0);
    expect((await call('check_contact', { email: 'sam@shop.com' })).text).toContain(
      'do-not-contact',
    );
  });

  it('needs follow_up for a second email and stops after three', async () => {
    await connect();
    await writeFile(join(dir, 'outreach.env'), SETTINGS.replace('LIMIT=2', 'LIMIT=10'));
    await client.close();
    await connect(false);
    const args = { to: 'sam@shop.com', subject: 'Pickup in Austin', body: BODY };
    expect((await call('send_email', args)).isError).toBe(false);
    expect((await call('send_email', args)).text).toContain('follow_up');
    expect((await call('send_email', { ...args, follow_up: true })).isError).toBe(false);
    expect((await call('send_email', { ...args, follow_up: true })).isError).toBe(false);
    expect((await call('send_email', { ...args, follow_up: true })).text).toContain('Stop here');
    expect(sent).toHaveLength(3);
  });

  it('enforces the daily limit and rejects misleading subjects', async () => {
    await connect();
    expect(
      (await call('send_email', { to: 'sam@shop.com', subject: 'Re: our call', body: BODY }))
        .isError,
    ).toBe(true);
    await call('send_email', { to: 'a@one.com', subject: 'Hello there', body: BODY });
    await call('send_email', { to: 'b@two.com', subject: 'Hello there', body: BODY });
    const r = await call('send_email', { to: 'c@three.com', subject: 'Hello there', body: BODY });
    expect(r.text).toContain('daily limit of 2');
    expect(sent).toHaveLength(2);
  });

  it('refuses a subject with a line break, which used to hide the send from the log', async () => {
    await connect();
    const r = await call('send_email', { to: 'a@x.com', subject: 'Quick\nquestion', body: BODY });
    expect(r.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('refuses to send when the log has a line it cannot read', async () => {
    await connect();
    await mkdir(join(dir, '.gantrix', 'outreach'), { recursive: true });
    await writeFile(join(dir, '.gantrix', 'outreach', 'sent.csv'), 'not a row\n');
    const r = await call('send_email', { to: 'a@x.com', subject: 'Hello there', body: BODY });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain("Can't read a line of the send log");
    expect(sent).toHaveLength(0);
  });

  it('keeps the caps when many sends arrive at once', async () => {
    await connect(); // daily limit 2
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        call('send_email', { to: `p${i % 2}@x.com`, subject: 'Hello there', body: BODY }),
      ),
    );
    expect(sent).toHaveLength(2);
    expect(results.filter((r) => !r.isError)).toHaveLength(2);
  });

  it('blocks +tag addresses and subdomains of a blocked company', async () => {
    await connect();
    await call('add_do_not_contact', { email: 'boss@example.org', reason: 'asked' });
    await call('add_do_not_contact', { email: '@acme.com', reason: 'asked' });
    for (const to of ['boss+1@example.org', 'x@mail.acme.com']) {
      const r = await call('send_email', { to, subject: 'Hello there', body: BODY });
      expect(r.text).toContain('do-not-contact');
    }
    expect(sent).toHaveLength(0);
  });

  it('marks its tools read-only or not for clients', async () => {
    await connect();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName.check_contact?.readOnlyHint).toBe(true);
    expect(byName.send_email?.destructiveHint).toBe(true);
  });
});
