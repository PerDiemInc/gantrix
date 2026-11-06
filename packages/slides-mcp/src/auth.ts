import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Only the files this app creates: Gantrix can't see the rest of your Drive. */
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';

export interface GoogleConfig {
  clientFile: string;
  tokenFile: string;
  authUrl: string;
  tokenUrl: string;
  slidesApi: string;
}

export function loadGoogleConfig(env: NodeJS.ProcessEnv = process.env): GoogleConfig {
  const dir = env.GANTRIX_GOOGLE_DIR ?? join(env.HOME ?? homedir(), '.gantrix', 'google');
  return {
    clientFile: join(dir, 'oauth-client.json'),
    tokenFile: join(dir, 'token.json'),
    authUrl: env.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
    slidesApi: env.GOOGLE_SLIDES_API ?? 'https://slides.googleapis.com',
  };
}

interface Client {
  client_id: string;
  client_secret: string;
}
interface Token {
  refresh_token: string;
  access_token?: string;
  expires_at?: number;
}

export const SETUP_HELP = `Google Slides isn't connected yet. Once:
1. In Google Cloud Console, enable the Google Slides API, then create an OAuth client of type
   "Desktop app" and download its JSON.
2. Save it as ~/.gantrix/google/oauth-client.json (the file Google gives you works as is).
3. Run: npm run slides:auth   (opens a Google sign-in; Gantrix only gets the decks it creates)
Until then, write the deck as an outline file instead.`;

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Google's download nests the fields under "installed"; a flat file works too. */
async function readClient(cfg: GoogleConfig): Promise<Client | null> {
  const raw = await readJson<Client & { installed?: Client; web?: Client }>(cfg.clientFile);
  const c = raw?.installed ?? raw?.web ?? raw;
  return c?.client_id && c.client_secret
    ? { client_id: c.client_id, client_secret: c.client_secret }
    : null;
}

async function saveToken(cfg: GoogleConfig, token: Token): Promise<void> {
  await mkdir(dirname(cfg.tokenFile), { recursive: true, mode: 0o700 });
  await writeFile(cfg.tokenFile, JSON.stringify(token, null, 2), { mode: 0o600 });
  await chmod(cfg.tokenFile, 0o600);
}

async function postForm(url: string, form: Record<string, string>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok)
    throw new Error(
      `Google sign-in failed: ${String(body.error_description ?? body.error ?? res.status)}`,
    );
  return body as { access_token: string; expires_in: number; refresh_token?: string };
}

export class NotConnected extends Error {}

/** A valid access token, refreshed when it's about to expire. */
export async function accessToken(cfg: GoogleConfig): Promise<string> {
  const [client, token] = await Promise.all([readClient(cfg), readJson<Token>(cfg.tokenFile)]);
  if (!client || !token?.refresh_token) throw new NotConnected(SETUP_HELP);
  if (token.access_token && (token.expires_at ?? 0) > Date.now() + 60_000)
    return token.access_token;
  const r = await postForm(cfg.tokenUrl, {
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
    client_id: client.client_id,
    client_secret: client.client_secret,
  });
  await saveToken(cfg, {
    refresh_token: r.refresh_token ?? token.refresh_token,
    access_token: r.access_token,
    expires_at: Date.now() + r.expires_in * 1000,
  });
  return r.access_token;
}

/**
 * The one-time sign-in: a loopback redirect on 127.0.0.1 with PKCE, as Google recommends for
 * desktop apps. Prints the URL to open; saves the refresh token with mode 600.
 */
export async function signIn(cfg: GoogleConfig, log = console.log): Promise<void> {
  const client = await readClient(cfg);
  if (!client) throw new Error(`No OAuth client at ${cfg.clientFile}.\n\n${SETUP_HELP}`);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');

  const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') return void res.writeHead(404).end();
      const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        ok ? 'Gantrix is connected to Google Slides. You can close this tab.' : 'Sign-in failed.',
      );
      server.close();
      const port = (server.address() as { port: number } | null)?.port;
      if (ok)
        resolve({
          code: url.searchParams.get('code') ?? '',
          redirect: `http://127.0.0.1:${port}/callback`,
        });
      else reject(new Error(url.searchParams.get('error') ?? 'Sign-in was cancelled.'));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      const auth = new URL(cfg.authUrl);
      auth.search = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: `http://127.0.0.1:${port}/callback`,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      log(`Open this link to connect Google Slides (only decks Gantrix creates):\n\n${auth}\n`);
    });
    setTimeout(() => {
      server.close();
      reject(new Error('Timed out after 5 minutes waiting for the Google sign-in.'));
    }, 5 * 60_000).unref();
  });

  const r = await postForm(cfg.tokenUrl, {
    grant_type: 'authorization_code',
    code: code.code,
    redirect_uri: code.redirect,
    client_id: client.client_id,
    client_secret: client.client_secret,
    code_verifier: verifier,
  });
  if (!r.refresh_token) throw new Error('Google returned no refresh token; run the sign-in again.');
  await saveToken(cfg, {
    refresh_token: r.refresh_token,
    access_token: r.access_token,
    expires_at: Date.now() + r.expires_in * 1000,
  });
  log(`Connected. Token saved to ${cfg.tokenFile} (only you can read it).`);
}
