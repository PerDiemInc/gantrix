import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { agentSkills, agents, skills } from '../../db/schema.ts';
import { HttpError, IdParams, notFound, parse } from '../http.ts';
import type { ApiDeps } from '../server.ts';

const AgentFields = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'name must be lowercase letters, digits and dashes'),
  description: z.string().max(500),
  systemPrompt: z.string().max(20_000),
  model: z.string().min(1).nullable(), // null → GANTRIX_DEFAULT_MODEL
  modelBaseUrl: z.url().nullable(), // null → OLLAMA_BASE_URL
  connectionId: z.uuid().nullable(), // null → the default; wins over modelBaseUrl
  maxConcurrency: z.number().int().min(1).max(16),
  skillIds: z.array(z.uuid()).max(32),
});
// Omitted fields get the database defaults.
const CreateAgent = AgentFields.partial().required({ name: true });
const UpdateAgent = AgentFields.partial();

export function agentRoutes(app: FastifyInstance, { db }: ApiDeps): void {
  async function withSkills(rows: (typeof agents.$inferSelect)[]) {
    const ids = rows.map((a) => a.id);
    const links = ids.length
      ? await db
          .select({
            agentId: agentSkills.agentId,
            id: skills.id,
            name: skills.name,
            version: skills.version,
          })
          .from(agentSkills)
          .innerJoin(skills, eq(skills.id, agentSkills.skillId))
          .where(inArray(agentSkills.agentId, ids))
      : [];
    return rows.map((a) => ({
      ...a,
      skills: links.filter((l) => l.agentId === a.id).map(({ agentId: _, ...s }) => s),
    }));
  }

  async function getAgent(id: string) {
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, id) });
    if (!agent) throw notFound('Agent');
    const [withLinks] = await withSkills([agent]);
    return withLinks;
  }

  app.get('/api/agents', async () =>
    withSkills(await db.select().from(agents).orderBy(asc(agents.name))),
  );

  app.get('/api/agents/:id', async (request) => getAgent(parse(IdParams, request.params).id));

  app.post('/api/agents', async (request, reply) => {
    const { skillIds, ...fields } = parse(CreateAgent, request.body);
    const id = await db.transaction(async (tx) => {
      const [row] = await tx.insert(agents).values(fields).returning({ id: agents.id });
      if (!row) throw new HttpError(500, 'Agent insert returned no row.');
      if (skillIds?.length) {
        await tx
          .insert(agentSkills)
          .values(skillIds.map((skillId) => ({ agentId: row.id, skillId })));
      }
      return row.id;
    });
    return reply.code(201).send(await getAgent(id));
  });

  app.patch('/api/agents/:id', async (request) => {
    const { id } = parse(IdParams, request.params);
    const { skillIds, ...fields } = parse(UpdateAgent, request.body);
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(agents)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(agents.id, id))
        .returning({ id: agents.id });
      if (!row) throw notFound('Agent');
      if (skillIds) {
        await tx.delete(agentSkills).where(eq(agentSkills.agentId, id));
        if (skillIds.length) {
          await tx
            .insert(agentSkills)
            .values(skillIds.map((skillId) => ({ agentId: id, skillId })));
        }
      }
    });
    return getAgent(id);
  });

  // Steps that used this agent keep their history; pending ones fail and trigger a replan.
  app.delete('/api/agents/:id', async (request, reply) => {
    const { id } = parse(IdParams, request.params);
    const [row] = await db.delete(agents).where(eq(agents.id, id)).returning({ id: agents.id });
    if (!row) throw notFound('Agent');
    return reply.code(204).send();
  });
}
