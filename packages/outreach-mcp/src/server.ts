import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { type OutreachConfig, SETUP_HELP } from './config.ts';
import { Ledger } from './ledger.ts';

export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
}
export type SendFn = (email: OutgoingEmail) => Promise<{ messageId: string }>;

/** A cold sequence is at most three touches; after that, stop. */
export const MAX_TOUCHES = 3;
const MAX_BODY = 2_000;

const text = (t: string, isError = false) => ({
  content: [{ type: 'text' as const, text: t }],
  ...(isError ? { isError } : {}),
});

const addressOf = (from: string) => /<([^>]+)>/.exec(from)?.[1] ?? from.trim();

export function footer(unsubscribe: string, postalAddress: string): string {
  return `\n\n--\n${unsubscribe}\n${postalAddress}`;
}

export function createServer(cfg: OutreachConfig, send: SendFn, now = () => new Date()) {
  const server = new McpServer({ name: 'gantrix-outreach', version: '0.1.0' });
  const ledger = new Ledger(cfg.doNotContactFile, cfg.sentLogFile);

  server.registerTool(
    'check_contact',
    {
      description:
        'Before writing to someone, check whether they are on the do-not-contact list and when you last emailed them.',
      inputSchema: { email: z.email() },
    },
    async ({ email }) => {
      if (await ledger.isBlocked(email)) return text(`${email} is on the do-not-contact list.`);
      const previous = await ledger.previous(email);
      if (!previous.length) return text(`${email} has never been emailed from here.`);
      const list = previous.map((p) => `${p.at.slice(0, 10)} "${p.subject}"`).join('; ');
      return text(`${email} was emailed ${previous.length} time(s): ${list}.`);
    },
  );

  server.registerTool(
    'send_email',
    {
      description: `Send one plain-text email to one person from the configured address. A footer with the unsubscribe line and postal address is added for you. At most ${MAX_TOUCHES} emails per person; set follow_up when you have emailed them before.`,
      inputSchema: {
        to: z.email().describe('one recipient address'),
        subject: z.string().min(3).max(120),
        body: z.string().min(20).max(MAX_BODY).describe('plain text, without a footer'),
        follow_up: z.boolean().default(false),
      },
    },
    async ({ to, subject, body, follow_up }) => {
      const s = cfg.settings;
      if (!s) return text(`${cfg.problem}\n${SETUP_HELP}`, true);
      if (/^\s*(re|fwd?)\s*:/i.test(subject)) {
        return text('Don\'t start a subject with "Re:" or "Fwd:"; it misleads the reader.', true);
      }
      if (await ledger.isBlocked(to)) {
        return text(`Not sent: ${to} is on the do-not-contact list.`, true);
      }
      const previous = await ledger.previous(to);
      if (previous.length >= MAX_TOUCHES) {
        return text(`Not sent: ${to} already got ${previous.length} emails. Stop here.`, true);
      }
      if (previous.length && !follow_up) {
        return text(
          `Not sent: ${to} was already emailed on ${previous.at(-1)?.at.slice(0, 10)}. Set follow_up if this is the next touch.`,
          true,
        );
      }
      const today = await ledger.sentToday(now());
      if (today >= s.OUTREACH_DAILY_LIMIT) {
        return text(
          `Not sent: the daily limit of ${s.OUTREACH_DAILY_LIMIT} emails is reached. Try again tomorrow.`,
          true,
        );
      }
      const replyTo = addressOf(s.OUTREACH_FROM);
      const { messageId } = await send({
        from: s.OUTREACH_FROM,
        to,
        subject,
        text: body.trimEnd() + footer(s.OUTREACH_UNSUBSCRIBE, s.OUTREACH_POSTAL_ADDRESS),
        headers: {
          'List-Unsubscribe': `<mailto:${replyTo}?subject=unsubscribe>`,
        },
      });
      await ledger.record(to, subject, now());
      return text(
        `Sent to ${to} (${messageId}). ${today + 1}/${s.OUTREACH_DAILY_LIMIT} emails today.`,
      );
    },
  );

  server.registerTool(
    'add_do_not_contact',
    {
      description:
        'Add an address (or "@domain.com" for a whole company) to the do-not-contact list, for example when someone asks not to be emailed.',
      inputSchema: {
        email: z.string().regex(/^([^@\s]+)?@[^@\s]+\.[^@\s]+$/, 'an email or @domain'),
        reason: z.string().min(2).max(200),
      },
    },
    async ({ email, reason }) => {
      await ledger.block(email, reason);
      return text(`${email} won't be emailed again.`);
    },
  );

  return server;
}
