#!/usr/bin/env node
// Stands in for `codex exec` in tests: records how it was called, writes a file, and prints
// the JSON events Codex prints. FAKE_CODEX_FAIL makes the turn fail.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 0.0.0-test');
  process.exit(0);
}
const prompt = readFileSync(0, 'utf8');
if (process.env.FAKE_CODEX_LOG) {
  appendFileSync(
    process.env.FAKE_CODEX_LOG,
    `${JSON.stringify({ args, prompt, cwd: process.cwd(), hasToken: 'GANTRIX_TOKEN' in process.env, hasSlack: 'SLACK_BOT_TOKEN' in process.env })}\n`,
  );
}
const say = (e) => console.log(JSON.stringify(e));
say({ type: 'thread.started', thread_id: 't1' });
say({ type: 'turn.started' });
if (process.env.FAKE_CODEX_FAIL) {
  say({ type: 'turn.failed', error: { message: 'usage limit reached' } });
  process.exit(1);
}
writeFileSync('codex-notes.md', '# Notes from Codex\n');
say({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'Starting.' } });
say({ type: 'item.completed', item: { id: 'b', type: 'command_execution', command: 'ls' } });
say({
  type: 'item.completed',
  item: { id: 'c', type: 'agent_message', text: 'Wrote codex-notes.md.' },
});
say({
  type: 'turn.completed',
  usage: { input_tokens: 1100, cached_input_tokens: 1000, output_tokens: 20 },
});
