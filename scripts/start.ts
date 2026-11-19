// `npm start`: brings up everything needed to run Gantrix with local (Ollama) agents.
// Creates .env if missing, starts Postgres + Valkey, applies migrations, checks Ollama and the
// default model, then runs the API, worker and dashboard together. Ctrl+C stops all three.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DEFAULT_MODEL } from '@gantrix/shared';
import pg from 'pg';

const root = new URL('../', import.meta.url).pathname;
const envFile = `${root}.env`;

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n"${cmd} ${args.join(' ')}" failed.`);
    process.exit(r.status ?? 1);
  }
}

if (!existsSync(envFile)) run('npm', ['run', 'setup']);
process.loadEnvFile(envFile);

console.log('\n→ Starting Postgres and Valkey (Docker)…');
run('npm', ['run', 'infra:up']);

console.log('\n→ Applying migrations…');
run('npm', ['run', 'db:migrate']);

// Local agents run on Ollama; warn (don't block) if it is missing or the model isn't pulled.
const ollama = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
// The default model is a setting saved in the database (Agents → Default model).
const saved = await (async () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await db.connect();
    const r = await db.query(
      "select value->>'model' as model, value->>'connectionId' as connection from app_settings where key = 'default_model'",
    );
    return {
      model: r.rows[0]?.model || DEFAULT_MODEL,
      onConnection: Boolean(r.rows[0]?.connection),
    };
  } catch {
    return { model: DEFAULT_MODEL, onConnection: false };
  } finally {
    await db.end().catch(() => {});
  }
})();
const model = saved.model;
try {
  const res = await fetch(`${ollama}/api/tags`, { signal: AbortSignal.timeout(3000) });
  const { models = [] } = (await res.json()) as { models?: { name: string }[] };
  const have = models.some((m) => m.name === model || m.name === `${model}:latest`);
  if (saved.onConnection)
    console.log('\n✔ Ollama is up. The default model runs on a saved connection.');
  else if (!have) console.warn(`\n⚠ Model "${model}" is not pulled. Run: ollama pull ${model}`);
  else console.log(`\n✔ Ollama is up and has ${model}.`);
} catch {
  console.warn(
    `\n⚠ Ollama is not reachable at ${ollama}. Start it with "ollama serve" (or open the app).`,
  );
}

const services = [
  { name: 'api', script: 'dev:api' },
  { name: 'worker', script: 'dev:worker' },
  { name: 'web', script: 'dev:web' },
];

const children: ChildProcess[] = [];
let stopping = false;

function stopAll(code = 0): void {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
}

for (const { name, script } of services) {
  const child = spawn('npm', ['run', script], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const prefix = `[${name}] `;
  const pipe = (stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) => {
    let buf = '';
    stream.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) out.write(`${prefix}${l}\n`);
    });
  };
  if (child.stdout) pipe(child.stdout, process.stdout);
  if (child.stderr) pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`\n${prefix}exited with code ${code}; stopping the rest.`);
      stopAll(code ?? 1);
    }
  });
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

console.log(
  '\n→ Dashboard: http://127.0.0.1:4701  (token: npm run token)  ·  API: http://127.0.0.1:4700\n',
);
