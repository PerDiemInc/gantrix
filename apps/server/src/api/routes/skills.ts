import { rm, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agentSkills, skills } from '../../db/schema.ts';
import { installSkill } from '../../skills/loader.ts';
import { HttpError, IdParams, notFound, parse } from '../http.ts';
import type { ApiDeps } from '../server.ts';

const InstallSkill = z.object({
  path: z.string().refine(isAbsolute, 'path must be an absolute path to a folder with a SKILL.md'),
});

export function skillRoutes(app: FastifyInstance, { db, config }: ApiDeps): void {
  app.get('/api/skills', async () => db.select().from(skills).orderBy(asc(skills.name)));

  /** Installs a skill folder from this machine: copies it into GANTRIX_SKILLS_DIR and records its checksum. */
  app.post('/api/skills', async (request, reply) => {
    const { path } = parse(InstallSkill, request.body);
    const info = await stat(path).catch(() => null);
    if (!info?.isDirectory()) throw new HttpError(400, `${path} is not a folder.`);
    const installed = await installSkill(path, config.GANTRIX_SKILLS_DIR).catch((error: Error) => {
      throw new HttpError(400, error.message);
    });
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
      .returning();
    return reply.code(201).send(row);
  });

  app.delete('/api/skills/:id', async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    const skill = await db.query.skills.findFirst({ where: eq(skills.id, id) });
    if (!skill) throw notFound('Skill');
    const inUse = await db.$count(agentSkills, eq(agentSkills.skillId, id));
    if (inUse)
      throw new HttpError(409, `Skill is used by ${inUse} agent(s); remove it from them first.`);
    await db.delete(skills).where(eq(skills.id, id));
    // Only ever delete inside the skills folder.
    const root = resolve(config.GANTRIX_SKILLS_DIR) + sep;
    if (resolve(skill.sourcePath).startsWith(root)) {
      await rm(skill.sourcePath, { recursive: true, force: true });
    }
    return reply.code(204).send();
  });
}
