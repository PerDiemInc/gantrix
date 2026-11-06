// Creates .env from .env.example with a fresh GANTRIX_TOKEN. Never overwrites an existing .env.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const env = new URL('.env', root);

if (existsSync(env)) {
  console.log('.env already exists; leaving it as is.');
} else {
  const example = readFileSync(new URL('.env.example', root), 'utf8');
  const token = randomBytes(32).toString('hex');
  writeFileSync(env, example.replace(/^GANTRIX_TOKEN=$/m, `GANTRIX_TOKEN=${token}`), {
    mode: 0o600,
  });
  console.log('Created .env with a new GANTRIX_TOKEN (you paste it into the dashboard once).');
}
