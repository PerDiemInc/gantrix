/**
 * Each agent's setup interview: what it asks about how you work, and the skill it writes from
 * your answers. Tokens are never an answer: they go into a connection, so they reach neither
 * the skill file nor a model.
 */

export interface SetupQuestion {
  id: string;
  /** 'github' asks for read access (a token or a saved connection) instead of text. */
  kind?: 'github';
  /** What the agent says. */
  ask: string;
  why?: string;
  /** How the answer is labelled in the skill. */
  heading: string;
  /** Answers to pick from; you can always type your own. */
  options?: readonly string[];
  multiline?: boolean;
  placeholder?: string;
  /** Only asked when the answer to question `id` mentions one of these (case ignored). */
  when?: { id: string; mentions: readonly string[] };
}

export interface Interview {
  role: string;
  /** The agent's first message. */
  intro: string;
  questions: readonly SetupQuestion[];
}

export type SetupAnswers = Record<string, string>;

export const MAX_SETUP_ANSWER_CHARS = 2_000;

const CODE_HOSTS = ['GitHub', 'GitLab', 'Bitbucket', 'Only on this computer', 'No code yet'];

const code = (ask = 'How do you save your code?'): SetupQuestion => ({
  id: 'code',
  ask,
  why: 'So I know where to read it.',
  heading: 'Where the code lives',
  options: CODE_HOSTS,
});

const githubAccess = (after: string, ask: string): SetupQuestion => ({
  id: 'github',
  kind: 'github',
  ask,
  why: 'I only read: I cannot push, comment or merge.',
  heading: 'GitHub access',
  when: { id: after, mentions: ['github'] },
});

const codeElsewhere: SetupQuestion = {
  id: 'code_location',
  ask: 'Where can I find it? A repository address or a folder is enough.',
  heading: 'Code location',
  placeholder: 'e.g. gitlab.com/acme/app or ~/projects/app',
  when: { id: 'code', mentions: ['gitlab', 'bitbucket', 'computer'] },
};

const codeQuestions = (ask?: string): SetupQuestion[] => [
  code(ask),
  githubAccess('code', 'Can I have read access to your GitHub? Give me a token for it.'),
  codeElsewhere,
];

const stack: SetupQuestion = {
  id: 'stack',
  ask: 'What is it built with?',
  heading: 'Tech stack',
  placeholder: 'e.g. TypeScript, React Native, Postgres on AWS',
};

const never: SetupQuestion = {
  id: 'never',
  ask: 'What should I never do?',
  heading: 'Never do',
  multiline: true,
  placeholder: 'e.g. never touch the production database',
};

const anything: SetupQuestion = {
  id: 'notes',
  ask: 'Anything else I should know?',
  heading: 'Other notes',
  multiline: true,
};

const product: SetupQuestion = {
  id: 'product',
  ask: 'What do you sell, and who buys it?',
  heading: 'Product and customer',
  multiline: true,
};

const hosting: SetupQuestion = {
  id: 'hosting',
  ask: 'Where does it run today, or where should it run?',
  heading: 'Hosting',
  options: ['AWS', 'Google Cloud', 'Vercel', 'Heroku', 'Supabase', 'Not decided'],
};

const environments: SetupQuestion = {
  id: 'environments',
  ask: 'Which environments do you have, and which changes need your approval first?',
  heading: 'Environments and approvals',
  multiline: true,
  placeholder: 'e.g. staging and production; ask before anything in production',
};

const interview = (role: string, about: string, questions: SetupQuestion[]): Interview => ({
  role,
  intro: `Before I start ${about}, tell me how you work. I'll turn your answers into my own skill. Skip anything you like.`,
  questions,
});

const INTERVIEWS: Record<string, Interview> = {
  cto: interview('cto', 'making technical decisions', [
    ...codeQuestions(),
    stack,
    {
      id: 'shipping',
      ask: 'How does a change reach production?',
      heading: 'How changes ship',
      options: ['Pull request with review', 'Push straight to main', 'Not shipping yet'],
    },
    never,
    anything,
  ]),
  engineer: interview('engineer', 'building', [
    ...codeQuestions(),
    stack,
    {
      id: 'tests',
      ask: 'Which commands test and check the code?',
      heading: 'Test and lint commands',
      placeholder: 'e.g. npm test && npm run lint',
    },
    {
      id: 'conventions',
      ask: 'Any coding conventions I should follow?',
      heading: 'Conventions',
      multiline: true,
    },
    never,
  ]),
  cpo: interview('cpo', 'planning', [
    product,
    {
      id: 'tracker',
      ask: 'Where do you track work?',
      heading: 'Work tracker',
      options: ['Linear', 'Jira', 'GitHub Issues', 'Notion', 'A spreadsheet', 'Nowhere yet'],
    },
    githubAccess('tracker', 'Can I have read access to your GitHub issues? Give me a token.'),
    {
      id: 'cadence',
      ask: 'How do you plan: how often, and who decides priorities?',
      heading: 'Planning',
      multiline: true,
    },
    anything,
  ]),
  cmo: interview('cmo', 'writing marketing', [
    product,
    { id: 'channels', ask: 'Which channels matter to you?', heading: 'Channels' },
    {
      id: 'voice',
      ask: 'How should we sound? Paste a line you like if you have one.',
      heading: 'Voice',
      multiline: true,
    },
    {
      id: 'claims',
      ask: 'Is there anything we must never claim?',
      heading: 'Never claim',
      multiline: true,
    },
    anything,
  ]),
  cro: interview('cro', 'finding customers', [
    product,
    {
      id: 'icp',
      ask: 'Describe your best customer: size, place, and what makes them buy.',
      heading: 'Ideal customer',
      multiline: true,
    },
    { id: 'crm', ask: 'Where do you keep leads and deals?', heading: 'CRM' },
    {
      id: 'outreach',
      ask: 'Who do emails come from, and what rules apply to outreach?',
      heading: 'Outreach rules',
      multiline: true,
    },
    anything,
  ]),
  ciso: interview('ciso', 'looking for security problems', [
    ...codeQuestions(),
    {
      id: 'scope',
      ask: 'Which systems of yours am I allowed to test?',
      why: 'I only test what you name here.',
      heading: 'Authorized scope',
      multiline: true,
    },
    {
      id: 'compliance',
      ask: 'Do any rules or audits apply to you?',
      heading: 'Compliance',
      placeholder: 'e.g. SOC 2, PCI, GDPR, none',
    },
    never,
  ]),
  designer: interview('designer', 'designing', [
    product,
    {
      id: 'brand',
      ask: 'What are your brand colors and fonts? A website address works too.',
      heading: 'Brand',
      multiline: true,
    },
    { id: 'tool', ask: 'Where do your designs live?', heading: 'Design tool' },
    { id: 'style', ask: 'What style do you like, and what do you dislike?', heading: 'Style' },
    anything,
  ]),
  devops: interview('devops', 'deploying', [
    ...codeQuestions(),
    hosting,
    environments,
    { id: 'ci', ask: 'What builds and deploys your code today?', heading: 'CI/CD' },
    never,
  ]),
  'aws-engineer': interview('aws-engineer', 'changing your AWS', [
    {
      id: 'region',
      ask: 'Which AWS region and CLI profile should I use?',
      why: 'Only the profile name: never paste access keys here.',
      heading: 'Region and profile',
      placeholder: 'e.g. us-east-1, profile "staging"',
    },
    {
      id: 'state',
      ask: 'Where is your Terraform state, if you have any?',
      heading: 'Terraform state',
    },
    environments,
    never,
  ]),
  'gcp-engineer': interview('gcp-engineer', 'changing your Google Cloud', [
    {
      id: 'project',
      ask: 'Which Google Cloud project and region should I use?',
      heading: 'Project and region',
    },
    {
      id: 'state',
      ask: 'Where is your Terraform state, if you have any?',
      heading: 'Terraform state',
    },
    environments,
    never,
  ]),
};

const GENERIC = interview('agent', 'working', [
  { id: 'goal', ask: 'What do you want my help with?', heading: 'What I help with' },
  {
    id: 'tools',
    ask: 'Which tools and services do you use for that work?',
    heading: 'Tools and services',
    multiline: true,
  },
  ...codeQuestions('If the work involves code, how do you save it?'),
  never,
  anything,
]);

/** Built-in skills that say which role an agent plays, whatever it is called. */
const SKILL_ROLES: Record<string, string> = {
  'exec-cto': 'cto',
  'exec-engineer': 'engineer',
  'exec-cpo': 'cpo',
  'exec-cmo': 'cmo',
  'exec-cro': 'cro',
  'exec-ciso': 'ciso',
  'exec-designer': 'designer',
  'exec-devops': 'devops',
  'devops-aws': 'aws-engineer',
  'devops-gcp': 'gcp-engineer',
};

export function interviewFor(agent: {
  name: string;
  skills: readonly { name: string }[];
}): Interview {
  const bySkill = agent.skills.map((s) => SKILL_ROLES[s.name]).find(Boolean);
  const role = bySkill ?? agent.name;
  return (Object.hasOwn(INTERVIEWS, role) ? INTERVIEWS[role] : undefined) ?? GENERIC;
}

/** The questions that apply, given the answers so far. */
export function askedQuestions(
  questions: readonly SetupQuestion[],
  answers: SetupAnswers,
): SetupQuestion[] {
  return questions.filter((q) => {
    if (!q.when) return true;
    const answer = (answers[q.when.id] ?? '').toLowerCase();
    return q.when.mentions.some((m) => answer.includes(m.toLowerCase()));
  });
}

const SECRETS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bxapp-[A-Za-z0-9-]{10,}/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[A-Za-z0-9_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // A password inside an address: postgres://user:password@host
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

/** True when text looks like it holds a password or token, which a skill must never do. */
export const looksSecret = (text: string): boolean => SECRETS.some((s) => s.test(text));

export const setupSkillName = (agentName: string): string => `setup-${agentName}`.slice(0, 64);

/** The SKILL.md an agent writes from the interview. Only asked, answered questions are in it. */
export function renderSetupSkill(o: {
  agentName: string;
  interview: Interview;
  answers: SetupAnswers;
  version: string;
}): string {
  const lines = askedQuestions(o.interview.questions, o.answers).flatMap((q) => {
    const answer = q.kind ? '' : (o.answers[q.id] ?? '').trim();
    // Indented, so an answer with its own headings or lists stays inside its bullet.
    return answer ? [`- **${q.heading}:** ${answer.replace(/\r?\n/g, '\n  ')}`] : [];
  });
  const description = `How the user works, as told to ${o.agentName} in its setup interview.`;
  return `---
name: ${setupSkillName(o.agentName)}
description: ${JSON.stringify(description)}
version: ${o.version}
---
The user told you this in your setup interview. Follow it over your defaults. What isn't
here is unknown: ask, or say what you assumed.

${lines.length ? lines.join('\n') : '- No details given.'}
`;
}
