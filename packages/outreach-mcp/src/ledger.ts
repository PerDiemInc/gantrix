import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const normalize = (email: string) => email.trim().toLowerCase();

async function lines(file: string): Promise<string[]> {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  } catch {
    return [];
  }
}

async function append(file: string, line: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${line}\n`, { mode: 0o600 });
}

const csv = (v: string) => `"${v.replaceAll('"', '""')}"`;

export interface SentRow {
  at: string;
  to: string;
  subject: string;
}

/** The do-not-contact list and the send log, shared by every task on this machine. */
export class Ledger {
  readonly #doNotContactFile: string;
  readonly #sentLogFile: string;

  constructor(doNotContactFile: string, sentLogFile: string) {
    this.#doNotContactFile = doNotContactFile;
    this.#sentLogFile = sentLogFile;
  }

  async isBlocked(email: string): Promise<boolean> {
    const target = normalize(email);
    const domain = target.split('@')[1];
    // An entry of "@example.com" blocks the whole domain.
    return (await lines(this.#doNotContactFile)).some((l) => {
      const entry = normalize(l.split(',')[0] ?? '');
      return entry === target || (entry.startsWith('@') && entry.slice(1) === domain);
    });
  }

  async block(email: string, reason: string): Promise<void> {
    await append(this.#doNotContactFile, `${normalize(email)},${reason.replaceAll('\n', ' ')}`);
  }

  async sent(): Promise<SentRow[]> {
    return (await lines(this.#sentLogFile)).flatMap((l) => {
      const m = /^([^,]+),"((?:[^"]|"")*)","((?:[^"]|"")*)"$/.exec(l);
      return m?.[1] && m[2] !== undefined && m[3] !== undefined
        ? [{ at: m[1], to: m[2].replaceAll('""', '"'), subject: m[3].replaceAll('""', '"') }]
        : [];
    });
  }

  async sentToday(now = new Date()): Promise<number> {
    const day = now.toISOString().slice(0, 10);
    return (await this.sent()).filter((r) => r.at.startsWith(day)).length;
  }

  async previous(email: string): Promise<SentRow[]> {
    const target = normalize(email);
    return (await this.sent()).filter((r) => normalize(r.to) === target);
  }

  async record(to: string, subject: string, now = new Date()): Promise<void> {
    await append(this.#sentLogFile, `${now.toISOString()},${csv(normalize(to))},${csv(subject)}`);
  }
}
