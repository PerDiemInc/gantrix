import { rm, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agentSkills, skills } from '../../db/schema.ts';
import { checksumDir, installSkill } from '../../skills/loader.ts';
import {
  defaultSkillFetch,
  lookupSkill,
  PreviewStore,
  SkillSourceError,
} from '../../skills/remote.ts';
import { HttpError, IdParams, notFound, parse } from '../http.ts';
import type { ApiDeps } from '../server.ts';

const InstallSkill = z.object({
  path: z.string().refine(isAbsolute, 'path must be an absolute path to a folder with a SKILL.md'),
});

const LookupSkill = z.object({ url: z.string().trim().min(1).max(2_000) });
const InstallOnline = z.object({
  previewId: z.string().min(1).max(64),
  // The checksum of what was shown, so the answer is for exactly those files.
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
});

export function skillRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { db, config } = deps;
  const store = new PreviewStore(config.GANTRIX_SKILLS_DIR);
  // What a previous run left in the holding area is not something anyone was shown.
  app.addHook('onReady', () => store.startFresh());

  app.get('/api/skills', async () => db.select().from(skills).orderBy(asc(skills.name)));

  /**
   * Downloads a skill from a link into a holding area and describes it, so a person can decide.
   * Nothing is installed or run. A link to a place with several skills lists them instead.
   */
  app.post('/api/skills/lookup', async (request) => {
    const { url } = parse(LookupSkill, request.body);
    try {
      return await lookupSkill(store, url, deps.skillFetch ?? defaultSkillFetch);
    } catch (error) {
      if (error instanceof SkillSourceError) throw new HttpError(400, error.message);
      request.log.warn({ err: error }, 'skill lookup failed');
      throw new HttpError(
        502,
        `Couldn't fetch that: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`,
      );
    }
  });

  /** Installs exactly what /lookup showed, once the person said yes. */
  app.post('/api/skills/install-online', async (request, reply) => {
    const { previewId, checksum } = parse(InstallOnline, request.body);
    await store.sweep();
    const held = store.take(previewId);
    if (!held) {
      throw new HttpError(404, 'That review has expired. Look the skill up again.');
    }
    try {
      if (checksum !== held.preview.checksum || (await checksumDir(held.dir)) !== checksum) {
        throw new HttpError(409, 'The files changed since you reviewed them. Look it up again.');
      }
      const installed = await installSkill(held.dir, config.GANTRIX_SKILLS_DIR).catch(
        (error: Error) => {
          throw new HttpError(400, error.message);
        },
      );
      const [row] = await db
        .insert(skills)
        .values({
          name: installed.name,
          version: installed.version,
          description: installed.description,
          sourcePath: installed.sourcePath,
          checksum: installed.checksum,
          manifest: installed.manifest,
          sourceUrl: held.preview.sourceUrl,
          sourceRef: held.preview.commit,
        })
        .returning();
      return reply.code(201).send(row);
    } finally {
      await rm(held.dir, { recursive: true, force: true });
    }
  });

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
