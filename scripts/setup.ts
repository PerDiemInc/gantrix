// Creates .env from .env.example with a fresh GANTRIX_TOKEN. Never overwrites an existing .env.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const env = new URL('.env', root);

// Gantrix keeps projects, logs and login tokens here: only you should read it.
mkdirSync(join(homedir(), '.gantrix'), { recursive: true, mode: 0o700 });
chmodSync(join(homedir(), '.gantrix'), 0o700);

if (existsSync(env)) {
  chmodSync(env, 0o600); // it holds the API token; an older .env may be readable by others
  console.log('.env already exists; leaving its contents as they are (made it private).');
} else {
  const example = readFileSync(new URL('.env.example', root), 'utf8');
  const token = randomBytes(32).toString('hex');
  writeFileSync(env, example.replace(/^GANTRIX_TOKEN=$/m, `GANTRIX_TOKEN=${token}`), {
    mode: 0o600,
  });
  console.log('Created .env with a new GANTRIX_TOKEN (you paste it into the dashboard once).');
}
