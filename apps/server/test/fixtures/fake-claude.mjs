#!/usr/bin/env node
// Stands in for `claude -p` in tests: records how it was called, writes a file like Claude
// Code's Write tool would, and prints a result in Claude Code's JSON format.
import { appendFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    `${JSON.stringify({ args, cwd: process.cwd(), hasToken: 'GANTRIX_TOKEN' in process.env })}\n`,
  );
}
writeFileSync('claude-notes.md', '# Notes from Claude Code\n');
console.log(
  JSON.stringify([
    { type: 'system', subtype: 'init', cwd: process.cwd() },
    {
      type: 'result',
      is_error: false,
      result: 'Wrote claude-notes.md.',
      num_turns: 2,
      total_cost_usd: 0.01,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
    },
  ]),
);
