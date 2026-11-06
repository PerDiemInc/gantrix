#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { createClient } from './client.ts';
import * as cmd from './commands.ts';
import { addTeam } from './team.ts';

// Settings come from the environment, falling back to the repo's .env (never overriding).
try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch {
  // no .env: rely on the environment
}
const baseUrl =
  process.env.GANTRIX_URL ??
  `http://${process.env.GANTRIX_HOST ?? '127.0.0.1'}:${process.env.GANTRIX_PORT ?? '4700'}`;
const token = process.env.GANTRIX_TOKEN ?? '';

const client = createClient(baseUrl, token);
const run =
  <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
  async (...args: A) => {
    try {
      if (!token) throw new Error('GANTRIX_TOKEN is not set (see the server .env).');
      await fn(...args);
    } catch (error) {
      console.error(cmd.explain(error));
      process.exitCode = 1;
    }
  };

const program = new Command('gantrix')
  .description('Agents with skills that work a plan like a Gantt chart until the goal is met.')
  .version('0.1.0');

const agents = program.command('agents').description('manage agents');
agents
  .command('list', { isDefault: true })
  .description('list agents')
  .action(run(() => cmd.listAgents(client)));
agents
  .command('add <name>')
  .description('add an agent')
  .option('-d, --description <text>', 'what the agent is good at (the planner reads this)')
  .option('-s, --skills <names>', 'comma-separated skill names')
  .option('-m, --model <model>', 'e.g. qwen3:8b or openai/<model> (default: GANTRIX_DEFAULT_MODEL)')
  .option('--base-url <url>', 'model server URL (default: OLLAMA_BASE_URL)')
  .option('--max-concurrency <n>', 'steps this agent may run at once', '1')
  .option('--prompt <text>', 'extra system prompt')
  .option('-c, --connection <name>', 'a saved model connection (see gantrix connections)')
  .action(run((name: string, o) => cmd.addAgent(client, name, o)));
agents
  .command('rm <name>')
  .description('remove an agent')
  .action(run((name: string) => cmd.removeAgent(client, name)));

const skills = program.command('skills').description('manage skills');
skills
  .command('list', { isDefault: true })
  .description('list installed skills')
  .action(run(() => cmd.listSkills(client)));
skills
  .command('add <folder>')
  .description('install a skill folder containing a SKILL.md')
  .action(run((folder: string) => cmd.addSkill(client, folder)));
skills
  .command('rm <name[@version]>')
  .description('remove an installed skill')
  .action(run((ref: string) => cmd.removeSkill(client, ref)));

const connections = program
  .command('connections')
  .description('model servers: Ollama, OpenAI, Anthropic or compatible, local or cloud');
connections
  .command('list', { isDefault: true })
  .description('list connections')
  .action(run(() => cmd.listConnections(client)));
connections
  .command('add <name>')
  .description('save a connection')
  .requiredOption('-p, --provider <provider>', 'ollama, openai, anthropic, http or claude-code')
  .option(
    '-u, --url <url>',
    'base URL (default: local Ollama, api.openai.com or api.anthropic.com); for claude-code, the claude binary',
  )
  .option(
    '-H, --header <header...>',
    'e.g. "Authorization: Bearer env:MY_KEY" (env:NAME reads the worker environment)',
  )
  .option('--api-key-env <name>', 'read the API key from this environment variable')
  .option('--method <method>', 'http: POST (default), PUT, PATCH or GET')
  .option('--content-type <type>', 'http: Content-Type (default application/json)')
  .option('--body <template>', 'http: body with {{prompt}}, {{system}}, {{model}}, "{{messages}}"')
  .option(
    '--reply-path <path>',
    'http: where the reply is, e.g. choices.0.message.content (default: auto)',
  )
  .action(run((name: string, o) => cmd.addConnection(client, name, o)));
connections
  .command('test <name> <model>')
  .description('send one short prompt through a connection')
  .action(run((name: string, model: string) => cmd.testConnection(client, name, model)));
connections
  .command('rm <name>')
  .description('remove a connection no agent uses')
  .action(run((name: string) => cmd.removeConnection(client, name)));

const team = program.command('team').description('the built-in executive agents');
team
  .command('add')
  .description(
    'install the CTO, CMO, CRO, CISO, CPO, designer and engineer agents and their skills',
  )
  .option('--only <roles>', 'comma-separated, e.g. cto,cpo')
  .option('-m, --model <model>', 'model for all of them (default: GANTRIX_DEFAULT_MODEL)')
  .action(run((o) => addTeam(client, o)));

program
  .command('run <goal...>')
  .description('start a task and follow it live')
  .option('--max-minutes <n>', 'time budget')
  .option('--max-tokens <n>', 'token budget')
  .option('--max-replans <n>', 'replan budget')
  .option('--ask', 'ask before shell, web, MCP and email tools (approvals on)')
  .option(
    '--approve-all',
    'run every tool call without asking (the default unless the server says otherwise)',
  )
  .option('--detach', "don't follow the task")
  .action(run((goal: string[], o) => cmd.runTask(client, goal.join(' '), o)));
program
  .command('tasks')
  .description('list recent tasks')
  .option('-n, --limit <n>', 'how many', '20')
  .action(run((o) => cmd.listTasks(client, o)));
program
  .command('show <task>')
  .description('show a task as a Gantt chart ("last" = most recent)')
  .option('-a, --all', 'include superseded steps from earlier plans')
  .action(run((ref: string, o) => cmd.showTask(client, ref, o)));
program
  .command('say <task> <words...>')
  .description('send a note to a running task: the whole team (replans) or one step with --to')
  .option('--to <step>', 'the step key, e.g. research_tea')
  .action(run((ref: string, words: string[], o) => cmd.say(client, ref, words, o)));
program
  .command('logs <task> [step]')
  .description("show each step's conversation: prompts, replies, tool calls and the judge")
  .option('--full', 'show system prompts, thinking and long text in full')
  .action(run((ref: string, step: string | undefined, o) => cmd.logs(client, ref, step, o)));
program
  .command('tail <task>')
  .description('follow a task live and answer approvals')
  .action(run((ref: string) => cmd.tail(client, ref)));
program
  .command('cancel <task>')
  .description('cancel a task')
  .action(run((ref: string) => cmd.cancel(client, ref)));
program
  .command('files <task> [path]')
  .description('list workspace files, or print one')
  .action(run((ref: string, path?: string) => cmd.files(client, ref, path)));

program
  .command('approvals')
  .description('list pending approvals')
  .action(run(() => cmd.listApprovals(client)));
program
  .command('answer <id> [words...]')
  .description("answer an agent's question (empty skips it)")
  .action(
    run((id: string, words: string[] = []) => cmd.answerQuestion(client, id, words.join(' '))),
  );
program
  .command('example <name>')
  .description('start an example project: website')
  .option('--detach', "don't follow the project")
  .action(run((name: string, o) => cmd.runExample(client, name, o)));
program
  .command('approve <id>')
  .description('approve a tool call')
  .action(run((id: string) => cmd.decide(client, id, true)));
program
  .command('deny <id>')
  .description('deny a tool call')
  .action(run((id: string) => cmd.decide(client, id, false)));

await program.parseAsync();
