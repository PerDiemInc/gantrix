import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AgentDto, SkillDto } from '@gantrix/shared';
import type { Client } from './client.ts';
import { paint } from './format.ts';

const SKILLS_DIR = fileURLToPath(new URL('../../../examples/skills/', import.meta.url));

/** The built-in executive team. The planner reads each description to decide who does what. */
export const TEAM = [
  {
    name: 'cto',
    skill: 'exec-cto',
    description:
      'CTO: technology and engineering. Architecture decisions, code reviews, build plans and estimates, technical risks. Can run shell commands with approval.',
  },
  {
    name: 'cmo',
    skill: 'exec-cmo',
    description:
      'CMO: marketing. Positioning, messaging, campaign plans, launch posts, landing-page copy, SEO briefs and competitor comparisons.',
  },
  {
    name: 'cro',
    skill: 'exec-cro',
    description:
      'CRO: sales and revenue. Ideal-customer profiles, lead lists from public sources, personal cold email and SMS drafts, sends one-to-one email with approval.',
  },
  {
    name: 'ciso',
    skill: 'exec-ciso',
    description:
      "CISO: security. Threat models, code and dependency audits, config checks and authorized testing of the user's own systems, with a fix plan.",
  },
  {
    name: 'cpo',
    skill: 'exec-cpo',
    description:
      'CPO and project manager: product specs (PRDs), priorities, roadmaps, milestone timelines with owners and dates, risks and status updates. Keeps the team aligned.',
  },
] as const;

export type Role = (typeof TEAM)[number]['name'];

async function skillVersion(folder: string): Promise<string> {
  const text = await readFile(`${folder}/SKILL.md`, 'utf8');
  return /^version:\s*["']?([\d.]+)/m.exec(text)?.[1] ?? '0.0.0';
}

export async function addTeam(
  client: Client,
  o: { only?: string; model?: string; skillsDir?: string },
): Promise<void> {
  const wanted = o.only?.split(',').map((s) => s.trim().toLowerCase());
  const unknown = wanted?.filter((w) => !TEAM.some((m) => m.name === w));
  if (unknown?.length) {
    throw new Error(
      `Unknown role(s): ${unknown.join(', ')}. Choose from ${TEAM.map((m) => m.name).join(', ')}.`,
    );
  }
  const members = TEAM.filter((m) => !wanted || wanted.includes(m.name));
  const dir = o.skillsDir ?? SKILLS_DIR;
  const [skills, agents] = await Promise.all([
    client.get<SkillDto[]>('/api/skills'),
    client.get<AgentDto[]>('/api/agents'),
  ]);

  for (const m of members) {
    const folder = `${dir}${dir.endsWith('/') ? '' : '/'}${m.skill}`;
    const version = await skillVersion(folder);
    let skill = skills.find((s) => s.name === m.skill && s.version === version);
    if (!skill) skill = await client.post<SkillDto>('/api/skills', { path: folder });

    if (agents.some((a) => a.name === m.name)) {
      console.log(`${paint('gray', '·')} ${m.name} already exists; left as is.`);
      continue;
    }
    await client.post<AgentDto>('/api/agents', {
      name: m.name,
      description: m.description,
      skillIds: [skill.id],
      ...(o.model ? { model: o.model } : {}),
    });
    console.log(`${paint('green', '✔')} ${paint('bold', m.name)} with ${m.skill} ${version}`);
  }
  if (members.some((m) => m.name === 'cro')) {
    console.log(
      paint(
        'gray',
        'The CRO sends email only after you set up ~/.gantrix/outreach.env and run `npm run outreach:link`; see the README.',
      ),
    );
  }
}
