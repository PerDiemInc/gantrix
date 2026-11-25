import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import {
  type AgentDto,
  type AgentSetupDto,
  type AgentSetupResultDto,
  askedQuestions,
  type GithubAccessInput,
  interviewFor,
  looksSecret,
  renderSetupSkill,
  type SetupAnswers,
  type SetupQuestion,
} from '@gantrix/shared';
import type { Client } from './client.ts';
import { paint } from './format.ts';

type Ask = (prompt: string) => Promise<string>;

/** A prompt for typing, and one that shows nothing for tokens. */
function terminal() {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: stdin, output, terminal: true });
  const ask: Ask = async (prompt) => (await rl.question(prompt)).trim();
  const secret: Ask = async (prompt) => {
    const answer = rl.question(prompt);
    muted = true;
    try {
      return (await answer).trim();
    } finally {
      muted = false;
      stdout.write('\n');
    }
  };
  return { ask, secret, close: () => rl.close() };
}

async function askText(ask: Ask, q: SetupQuestion, previous: string): Promise<string> {
  for (const [i, o] of (q.options ?? []).entries()) console.log(`  ${i + 1}. ${o}`);
  if (previous) console.log(paint('gray', `  now: ${previous}  (Enter keeps it, - clears it)`));
  for (;;) {
    const typed = await ask('> ');
    if (typed === '-') return '';
    if (!typed) return previous;
    const picked = q.options?.[Number(typed) - 1];
    const answer = picked ?? typed;
    if (!looksSecret(answer)) return answer;
    console.log(
      paint('yellow', "That looks like a password or token. Leave it out: it isn't stored here."),
    );
  }
}

async function askGithub(
  ask: Ask,
  secret: Ask,
  state: AgentSetupDto,
): Promise<GithubAccessInput | undefined> {
  const current = state.githubConnections.find((c) => c.id === state.githubConnectionId);
  if (current) console.log(paint('gray', `  now: ${current.name}  (Enter keeps it)`));
  console.log('  t. Paste a token (fine-grained, read-only)');
  console.log('  e. Read the token from a variable in .env');
  for (const [i, c] of state.githubConnections.entries()) {
    console.log(`  ${i + 1}. Use the saved connection ${c.name}`);
  }
  console.log(current ? '  n. Remove my GitHub access' : '  Enter: not now');
  for (;;) {
    const choice = (await ask('> ')).toLowerCase();
    if (!choice) return undefined;
    if (choice === 'n') return { mode: 'none' };
    const saved = state.githubConnections[Number(choice) - 1];
    if (saved) return { mode: 'connection', connectionId: saved.id };
    if (choice !== 't' && choice !== 'e') continue;
    const token =
      choice === 't'
        ? await secret('Token (hidden): ')
        : `env:${await ask('Variable name, e.g. GITHUB_TOKEN: ')}`;
    if (!token || token === 'env:') continue;
    const repos = await ask('Repositories I may read, owner/name, comma-separated (optional): ');
    const org = repos ? '' : await ask('Or a whole organization or user (optional): ');
    return { mode: 'token', token, ...(repos ? { repos } : {}), ...(org ? { org } : {}) };
  }
}

export async function setupAgent(client: Client, name: string): Promise<void> {
  const agent = (await client.get<AgentDto[]>('/api/agents')).find((a) => a.name === name);
  if (!agent) throw new Error(`No agent named "${name}".`);
  if (!stdin.isTTY) throw new Error('Run the setup interview in a terminal.');
  const state = await client.get<AgentSetupDto>(`/api/agents/${agent.id}/setup`);
  const interview = interviewFor({
    name: agent.name,
    skills: agent.skills.filter((s) => s.id !== state.setup?.skillId),
  });
  const answers: SetupAnswers = { ...state.setup?.answers };
  let github: GithubAccessInput | undefined;
  const { ask, secret, close } = terminal();
  try {
    console.log(`\n${paint('bold', agent.name)}: ${interview.intro}`);
    const done = new Set<string>();
    for (;;) {
      const q = askedQuestions(interview.questions, answers).find((x) => !done.has(x.id));
      if (!q) break;
      done.add(q.id);
      console.log(`\n${paint('bold', agent.name)}: ${q.ask}`);
      if (q.why) console.log(paint('gray', `  ${q.why}`));
      if (q.kind === 'github') github = await askGithub(ask, secret, state);
      else answers[q.id] = await askText(ask, q, answers[q.id] ?? '');
    }
    // Answers to questions that no longer apply (the code moved) aren't sent.
    const asked = new Set(askedQuestions(interview.questions, answers).map((q) => q.id));
    const kept = Object.fromEntries(
      Object.entries(answers).filter(([id, a]) => asked.has(id) && a),
    );
    console.log(
      `\n${paint('bold', 'The skill:')}\n\n${renderSetupSkill({ agentName: agent.name, interview, answers: kept, version: '(next)' })}`,
    );
    if (/^n/i.test(await ask('Save it? [Y/n] '))) return console.log('Not saved.');
    const saved = await client.post<AgentSetupResultDto>(`/api/agents/${agent.id}/setup`, {
      answers: kept,
      ...(github ? { github } : {}),
    });
    console.log(`Saved ${paint('bold', saved.skill.name)} ${saved.skill.version}.`);
    if (saved.github) console.log(`${saved.github.reply} (connection ${saved.github.connection})`);
    if (saved.github?.warning) console.log(paint('yellow', saved.github.warning));
  } finally {
    close();
  }
}
