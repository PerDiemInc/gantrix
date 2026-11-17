import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TEAM } from '@gantrix/shared';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Config } from './config.ts';
import type { Db } from './db/client.ts';
import { agentSkills, agents, skills } from './db/schema.ts';
import { installSkill } from './skills/loader.ts';

const SKILLS_SRC = fileURLToPath(new URL('../../../examples/skills/', import.meta.url));
const SEEDED_KEY = 'gantrix:default-team-seeded';

const versionOf = async (folder: string) =>
  /^version:\s*["']?([\d.]+)/m.exec(await readFile(`${folder}/SKILL.md`, 'utf8'))?.[1] ?? '0.0.0';

/**
 * A first run starts with the built-in team (CTO, designer, engineer…) instead of an empty
 * Agents page. It happens once: after that the agents are yours to edit or delete, and a
 * deleted agent doesn't come back. Returns how many agents it added.
 */
export async function seedDefaultTeam(
  db: Db,
  redis: Redis,
  config: Pick<Config, 'GANTRIX_SKILLS_DIR'>,
  skillsSrc = SKILLS_SRC,
): Promise<number> {
  if (await redis.get(SEEDED_KEY)) return 0;
  if ((await db.$count(agents)) > 0) {
    await redis.set(SEEDED_KEY, '1');
    return 0;
  }
  const skillIds = new Map<string, string>();
  let added = 0;
  for (const member of TEAM) {
    const ids: string[] = [];
    for (const name of member.skills) {
      let id = skillIds.get(name);
      if (!id) {
        try {
          const folder = `${skillsSrc}${name}`;
          const existing = await db.query.skills.findFirst({ where: eq(skills.name, name) });
          if (existing && existing.version === (await versionOf(folder))) {
            id = existing.id;
          } else {
            const installed = await installSkill(folder, config.GANTRIX_SKILLS_DIR);
            const [row] = await db
              .insert(skills)
              .values({
                name: installed.name,
                version: installed.version,
                description: installed.description,
                sourcePath: installed.sourcePath,
                checksum: installed.checksum,
                manifest: installed.manifest,
              })
              .returning({ id: skills.id });
            id = row?.id;
          }
        } catch (error) {
          // A skill that can't install shouldn't stop the agent from existing.
          console.error(
            `Starter skill ${name} not installed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (id) skillIds.set(name, id);
      }
      if (id) ids.push(id);
    }
    const [agent] = await db
      .insert(agents)
      .values({ name: member.name, description: member.description, avatar: member.avatar })
      .onConflictDoNothing()
      .returning({ id: agents.id });
    if (!agent) continue;
    added++;
    if (ids.length) {
      await db.insert(agentSkills).values(ids.map((skillId) => ({ agentId: agent.id, skillId })));
    }
  }
  await redis.set(SEEDED_KEY, '1');
  return added;
}
