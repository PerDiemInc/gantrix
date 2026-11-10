import { appendFile, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const normalize = (email: string) => email.trim().toLowerCase();
/** "Boss+news@Example.com" → "boss@example.com": a +tag reaches the same person. */
const person = (email: string) => normalize(email).replace(/\+[^@]*@/, '@');
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ');

/** The send log has a line this code can't read: refuse to send rather than guess the counts. */
export class LedgerError extends Error {}

const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 60_000;

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
    const target = person(email);
    const domain = target.split('@')[1] ?? '';
    // "@example.com" blocks the company and its subdomains (mail.example.com too).
    return (await lines(this.#doNotContactFile)).some((l) => {
      const entry = normalize(l.split(',')[0] ?? '');
      if (entry.startsWith('@')) {
        const d = entry.slice(1);
        return domain === d || domain.endsWith(`.${d}`);
      }
      return person(entry) === target;
    });
  }

  /**
   * Runs one send at a time: the checks, the send and the log entry, under a lock file shared
   * by every outreach server on this machine. Parallel calls would otherwise all pass the caps.
   */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(() => this.#withLockFile(work));
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  #queue: Promise<void> = Promise.resolve();

  async #withLockFile<T>(work: () => Promise<T>): Promise<T> {
    const lock = `${this.#sentLogFile}.lock`;
    await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await (await open(lock, 'wx', 0o600)).close();
        break;
      } catch {
        const info = await stat(lock).catch(() => null);
        if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) await rm(lock, { force: true });
        else if (Date.now() > until) throw new LedgerError('Another send is still running.');
        else await new Promise((r) => setTimeout(r, 100));
      }
    }
    try {
      return await work();
    } finally {
      await rm(lock, { force: true });
    }
  }

  async block(email: string, reason: string): Promise<void> {
    await append(this.#doNotContactFile, `${normalize(email)},${oneLine(reason)}`);
  }

  async sent(): Promise<SentRow[]> {
    return (await lines(this.#sentLogFile)).map((l) => {
      const m = /^([^,]+),"((?:[^"]|"")*)","((?:[^"]|"")*)"$/.exec(l);
      if (!m?.[1] || m[2] === undefined || m[3] === undefined) {
        // Skipping it would forget a send and loosen the caps.
        throw new LedgerError(
          `Can't read a line of the send log (${this.#sentLogFile}); fix or remove it before sending more email: ${l.slice(0, 80)}`,
        );
      }
      return { at: m[1], to: m[2].replaceAll('""', '"'), subject: m[3].replaceAll('""', '"') };
    });
  }

  async sentToday(now = new Date()): Promise<number> {
    const day = now.toISOString().slice(0, 10);
    return (await this.sent()).filter((r) => r.at.startsWith(day)).length;
  }

  async previous(email: string): Promise<SentRow[]> {
    const target = person(email);
    return (await this.sent()).filter((r) => person(r.to) === target);
  }

  async record(to: string, subject: string, now = new Date()): Promise<void> {
    await append(
      this.#sentLogFile,
      `${now.toISOString()},${csv(normalize(to))},${csv(oneLine(subject))}`,
    );
  }
}
