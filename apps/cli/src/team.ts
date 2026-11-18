import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type AgentDto, type SkillDto, TEAM } from '@gantrix/shared';
import type { Client } from './client.ts';
import { paint } from './format.ts';

const SKILLS_DIR = fileURLToPath(new URL('../../../examples/skills/', import.meta.url));

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
  // The designer also makes images when the local image server command is installed
  // (npm run media:link); without it the skill would fail to start, so leave it out.
  const hasMedia = (() => {
    try {
      execFileSync('which', ['gantrix-media-mcp'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  const members = TEAM.filter((m) => !wanted || wanted.includes(m.name)).map((m) =>
    m.name === 'designer' && hasMedia ? { ...m, skills: [...m.skills, 'media-images'] } : m,
  );
  const dir = o.skillsDir ?? SKILLS_DIR;
  const [skills, agents] = await Promise.all([
    client.get<SkillDto[]>('/api/skills'),
    client.get<AgentDto[]>('/api/agents'),
  ]);

  for (const m of members) {
    const ids: string[] = [];
    const labels: string[] = [];
    for (const name of m.skills) {
      const folder = `${dir}${dir.endsWith('/') ? '' : '/'}${name}`;
      const version = await skillVersion(folder);
      let skill = skills.find((s) => s.name === name && s.version === version);
      if (!skill) {
        skill = await client.post<SkillDto>('/api/skills', { path: folder });
        skills.push(skill);
      }
      ids.push(skill.id);
      labels.push(`${name} ${version}`);
    }

    const existing = agents.find((a) => a.name === m.name);
    if (existing) {
      // Move a team agent to the newest team skills, but only if its skills are still ours.
      const ours = existing.skills.every((s) => (m.skills as readonly string[]).includes(s.name));
      const current = existing.skills
        .map((s) => s.id)
        .sort()
        .join();
      if (ours && current !== [...ids].sort().join()) {
        await client.patch<AgentDto>(`/api/agents/${existing.id}`, { skillIds: ids });
        console.log(`${paint('green', '↑')} ${m.name} now uses ${labels.join(', ')}`);
      } else {
        console.log(`${paint('gray', '·')} ${m.name} already exists; left as is.`);
      }
      continue;
    }
    await client.post<AgentDto>('/api/agents', {
      name: m.name,
      description: m.description,
      skillIds: ids,
      avatar: m.avatar,
      ...(o.model ? { model: o.model } : {}),
    });
    console.log(`${paint('green', '✔')} ${paint('bold', m.name)} with ${labels.join(', ')}`);
  }
  if (members.some((m) => m.name === 'cro')) {
    console.log(
      paint(
        'gray',
        'The CRO sends email only after you set up ~/.gantrix/outreach.env and run `npm run outreach:link`; see the README.',
      ),
    );
  }
  if (members.some((m) => m.name === 'designer')) {
    console.log(
      paint(
        'gray',
        'The designer builds Google Slides decks after `npm run slides:link` and `npm run slides:auth`; see the README.',
      ),
    );
  }
}
