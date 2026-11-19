import { rm, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { SKILL_SEARCH_SOURCES, type SkillSearchSource } from '@gantrix/shared';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agentSkills, connections, skills } from '../../db/schema.ts';
import { resolveHeaders } from '../../models/connections.ts';
import { checksumDir, installSkill } from '../../skills/loader.ts';
import {
  defaultSkillFetch,
  lookupSkill,
  PreviewStore,
  SkillSourceError,
  withGithubAuth,
} from '../../skills/remote.ts';
import { SkillSearcher } from '../../skills/search.ts';
import { HttpError, IdParams, notFound, parse } from '../http.ts';
import type { ApiDeps } from '../server.ts';

const InstallSkill = z.object({
  path: z.string().refine(isAbsolute, 'path must be an absolute path to a folder with a SKILL.md'),
});

const LookupSkill = z.object({ url: z.string().trim().min(1).max(2_000) });
const SearchQuery = z.object({
  q: z.string().trim().max(200).default(''),
  // Comma separated; default is every source.
  sources: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? s
            .split(',')
            .map((x) => x.trim())
            .filter((x): x is SkillSearchSource =>
              (SKILL_SEARCH_SOURCES as readonly string[]).includes(x),
            )
        : [...SKILL_SEARCH_SOURCES],
    ),
});
const InstallOnline = z.object({
  previewId: z.string().min(1).max(64),
  // The checksum of what was shown, so the answer is for exactly those files.
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
});

export function skillRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { db, config } = deps;
  const store = new PreviewStore(config.GANTRIX_SKILLS_DIR);
  const searcher = new SkillSearcher();

  /**
   * The token of a saved GitHub connection (the first by name), for GitHub's search and its
   * higher rate limit. Only ever sent to api.github.com. None, or one that can't be read,
   * means searching anonymously.
   */
  async function githubAuth(): Promise<{
    authorization: string | null;
    connection: string | null;
  }> {
    const [c] = await db
      .select()
      .from(connections)
      .where(eq(connections.provider, 'github'))
      .orderBy(asc(connections.name))
      .limit(1);
    if (!c) return { authorization: null, connection: null };
    try {
      const authorization = resolveHeaders(c.headers).Authorization ?? null;
      return { authorization, connection: authorization ? c.name : null };
    } catch {
      return { authorization: null, connection: null };
    }
  }
  const fetcher = async () => {
    const auth = await githubAuth();
    return {
      ...auth,
      fetch: withGithubAuth(deps.skillFetch ?? defaultSkillFetch, auth.authorization),
    };
  };
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
      return await lookupSkill(store, url, (await fetcher()).fetch);
    } catch (error) {
      if (error instanceof SkillSourceError) throw new HttpError(400, error.message);
      request.log.warn({ err: error }, 'skill lookup failed');
      throw new HttpError(
        502,
        `Couldn't fetch that: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`,
      );
    }
  });

  /**
   * Searches for skills online: skills.sh, GitHub repositories tagged as holding skills, inside
   * GitHub repositories (needs a GitHub connection) and featured collections. Finds only;
   * reviewing and installing go through /lookup and /install-online.
   */
  app.get('/api/skills/search', async (request) => {
    const { q, sources } = parse(SearchQuery, request.query);
    const { fetch, authorization, connection } = await fetcher();
    return searcher.search(fetch, { q, sources, githubToken: Boolean(authorization), connection });
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
