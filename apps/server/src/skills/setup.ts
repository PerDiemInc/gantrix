import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  askedQuestions,
  type GithubAccessInput,
  interviewFor,
  looksSecret,
  renderSetupSkill,
  type SetupAnswers,
  setupSkillName,
} from '@gantrix/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { agentSkills, agents, connections, skills } from '../db/schema.ts';
import { effectiveUrl, resolveHeaders, SERVICE_URLS } from '../models/connections.ts';
import { installSkill } from './loader.ts';
import { describeScope, type GithubAccess, githubReadTool, githubScope } from './tools/github.ts';
import { pathExists } from './workspace.ts';

type Agent = typeof agents.$inferSelect;
type Connection = typeof connections.$inferSelect;

/** Something in the answers the user can fix. */
export class SetupError extends Error {
  override name = 'SetupError';
}

/** The tool and the note an agent gets from its GitHub connection. Throws if unusable. */
export function githubAccessOf(c: Connection): GithubAccess {
  const { Authorization: authorization } = resolveHeaders(c.headers);
  if (!authorization) throw new SetupError(`Connection "${c.name}" has no token.`);
  return {
    baseUrl: effectiveUrl(c, ''),
    authorization,
    scope: githubScope(c.settings),
  };
}

/**
 * What a step gets for its agent's GitHub connection. A broken connection doesn't fail the
 * step: the agent is told, and can say so.
 */
export async function githubForStep(
  db: Db,
  agent: Pick<Agent, 'githubConnectionId'>,
  /** Claude Code and Codex use their own tools, not Gantrix's. */
  localCli: boolean,
  fetcher?: typeof fetch,
) {
  if (!agent.githubConnectionId) return null;
  if (localCli) {
    return {
      tools: [],
      note: "## GitHub\nGantrix's GitHub access isn't available in this run. Use your own tools if they can reach GitHub, or say what you need.",
    };
  }
  const c = await db.query.connections.findFirst({
    where: eq(connections.id, agent.githubConnectionId),
  });
  if (c?.provider !== 'github') return null;
  try {
    const access = githubAccessOf(c);
    return {
      tools: [githubReadTool(access, fetcher)],
      note: `## GitHub\nUse github_read to read ${describeScope(access.scope)}. It is read-only: you can't push, comment or merge. Gantrix holds the token; never ask for it.`,
    };
  } catch (error) {
    return {
      tools: [],
      note: `## GitHub\nYour GitHub access is broken: ${error instanceof Error ? error.message : String(error)} Say so in your reply if you needed it.`,
    };
  }
}

/** Signs in with the token and opens each named repository, so a wrong one shows up now. */
export async function checkGithub(access: GithubAccess, fetcher: typeof fetch = fetch) {
  const get = async (path: string) => {
    try {
      return await fetcher(`${access.baseUrl.replace(/\/+$/, '')}${path}`, {
        headers: {
          authorization: access.authorization,
          accept: 'application/vnd.github+json',
          'user-agent': 'gantrix',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new SetupError("Couldn't reach GitHub. Check your network and try again.");
    }
  };
  const me = await get('/user');
  if (!me.ok) {
    throw new SetupError(`GitHub rejected the token (${me.status}). Check it and try again.`);
  }
  const { login } = (await me.json()) as { login?: string };
  const { org, repos } = access.scope;
  if (repos.length > 20) throw new SetupError('Name at most 20 repositories.');
  for (const repo of repos) {
    const found = await get(`/repos/${repo}`);
    if (!found.ok) throw new SetupError(`The token can't see ${repo} (${found.status}).`);
  }
  if (org && !repos.length) {
    const found = await get(`/users/${org}`);
    if (!found.ok) throw new SetupError(`GitHub has no ${org} the token can see.`);
  }
  // Only classic tokens report scopes; "repo" there also allows writing.
  const scopes = (me.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim());
  return {
    reply: `Signed in as ${login ?? 'unknown'}. The agent can read ${describeScope(access.scope)}.`,
    warning: scopes.includes('repo')
      ? 'This classic token can also write. Gantrix only reads with it, but a fine-grained read-only token is safer.'
      : null,
  };
}

function checkAnswers(agent: { name: string; skills: { name: string }[] }, answers: SetupAnswers) {
  const interview = interviewFor(agent);
  const known = new Set(interview.questions.filter((q) => !q.kind).map((q) => q.id));
  const unknown = Object.keys(answers).filter((id) => !known.has(id));
  if (unknown.length) throw new SetupError(`Unknown questions: ${unknown.join(', ')}.`);
  const kept: SetupAnswers = {};
  for (const q of askedQuestions(interview.questions, answers)) {
    const answer = answers[q.id]?.trim();
    if (!answer) continue;
    if (looksSecret(answer)) {
      throw new SetupError(
        `The answer to "${q.ask}" looks like it holds a password or token. Take it out: answers go into the skill, which the model reads.`,
      );
    }
    kept[q.id] = answer;
  }
  return { interview, answers: kept };
}

const bump = (version: string) => {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
};

/**
 * Writes the agent's skill from the interview, attaches it in place of the previous one, and
 * saves the GitHub access that was given. All or nothing.
 */
export async function saveAgentSetup(
  deps: { db: Db; skillsDir: string; githubFetch?: typeof fetch },
  agentId: string,
  input: { answers: SetupAnswers; github?: GithubAccessInput | undefined },
) {
  const { db, skillsDir } = deps;
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent) return null;
  const linked = await db
    .select({ id: skills.id, name: skills.name })
    .from(agentSkills)
    .innerJoin(skills, eq(skills.id, agentSkills.skillId))
    .where(eq(agentSkills.agentId, agentId));
  const previousId = agent.setup?.skillId;
  const { interview, answers } = checkAnswers(
    { name: agent.name, skills: linked.filter((s) => s.id !== previousId) },
    input.answers,
  );
  if (!Object.keys(answers).length && !input.github) {
    throw new SetupError('Answer at least one question.');
  }

  // Check access before writing anything.
  const github = input.github;
  const all = await db.select().from(connections);
  let checked: Awaited<ReturnType<typeof checkGithub>> | null = null;
  let chosen: Connection | undefined;
  let draft: { headers: Record<string, string>; settings: Record<string, string> } | undefined;
  if (github?.mode === 'connection') {
    chosen = all.find((c) => c.id === github.connectionId && c.provider === 'github');
    if (!chosen) throw new SetupError('That is not a GitHub connection.');
    checked = await checkGithub(githubAccessOf(chosen), deps.githubFetch);
  } else if (github?.mode === 'token') {
    const token = github.token.trim().replace(/^bearer\s+/i, '');
    if (!/^(env:[A-Za-z_]\w*|\S+)$/.test(token)) {
      throw new SetupError('The token is one word, or env:NAME.');
    }
    const settings = Object.fromEntries(
      Object.entries({ org: github.org?.trim(), repos: github.repos?.trim() }).filter(
        (e): e is [string, string] => Boolean(e[1]),
      ),
    );
    draft = { headers: { Authorization: `Bearer ${token}` }, settings };
    let access: GithubAccess;
    try {
      const { Authorization } = resolveHeaders(draft.headers);
      access = {
        baseUrl: SERVICE_URLS.github,
        authorization: Authorization ?? '',
        scope: githubScope(settings),
      };
    } catch (error) {
      throw new SetupError((error as Error).message);
    }
    checked = await checkGithub(access, deps.githubFetch);
  }

  // The next version of this agent's own skill that isn't taken, in the database or on disk.
  const name = setupSkillName(agent.name);
  const versions = (await db.select().from(skills).where(eq(skills.name, name))).map(
    (s) => s.version,
  );
  let version = '1.0.0';
  while (versions.includes(version) || (await pathExists(join(skillsDir, name, version)))) {
    version = bump(version);
  }
  const markdown = renderSetupSkill({ agentName: agent.name, interview, answers, version });
  const source = await mkdtemp(join(tmpdir(), 'gantrix-setup-'));
  let installed: Awaited<ReturnType<typeof installSkill>>;
  try {
    await writeFile(join(source, 'SKILL.md'), markdown);
    installed = await installSkill(source, skillsDir);
  } finally {
    await rm(source, { recursive: true, force: true });
  }

  let stale: string | null = null;
  let connectionName: string | null = chosen?.name ?? null;
  try {
    await db.transaction(async (tx) => {
      let connectionId = agent.githubConnectionId;
      if (github?.mode === 'none') connectionId = null;
      if (chosen) connectionId = chosen.id;
      if (draft) {
        const base = `github-${agent.name}`.slice(0, 60);
        // Replace the token only on this agent's own connection, never on one others use.
        const own = all.find((c) => c.name === base && c.id === agent.githubConnectionId);
        const shared = own
          ? (await tx.$count(agents, eq(agents.githubConnectionId, own.id))) > 1
          : false;
        if (own && !shared) {
          await tx
            .update(connections)
            .set({ ...draft, updatedAt: new Date() })
            .where(eq(connections.id, own.id));
          connectionId = own.id;
          connectionName = own.name;
        } else {
          let free = base;
          for (let n = 2; all.some((c) => c.name === free); n++) free = `${base}-${n}`;
          const [row] = await tx
            .insert(connections)
            .values({ name: free, provider: 'github', ...draft })
            .returning({ id: connections.id });
          connectionId = row?.id ?? null;
          connectionName = free;
        }
      }
      const [skill] = await tx
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
      if (!skill) throw new Error('Skill insert returned no row.');
      if (previousId) {
        await tx
          .delete(agentSkills)
          .where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, previousId)));
        // Remove the replaced version, unless you also gave it to another agent.
        if (!(await tx.$count(agentSkills, eq(agentSkills.skillId, previousId)))) {
          const [old] = await tx.delete(skills).where(eq(skills.id, previousId)).returning();
          stale = old?.sourcePath ?? null;
        }
      }
      await tx.insert(agentSkills).values({ agentId, skillId: skill.id });
      const now = new Date();
      await tx
        .update(agents)
        .set({
          githubConnectionId: connectionId,
          setup: { answers, skillId: skill.id, updatedAt: now.toISOString() },
          updatedAt: now,
        })
        .where(eq(agents.id, agentId));
    });
  } catch (error) {
    await rm(installed.sourcePath, { recursive: true, force: true });
    throw error;
  }
  const old = stale as string | null;
  // Only ever delete inside the skills folder.
  if (old && resolve(old).startsWith(resolve(skillsDir) + sep)) {
    await rm(old, { recursive: true, force: true });
  }
  return {
    skill: { name: installed.name, version: installed.version, markdown },
    github: checked ? { connection: connectionName ?? '', ...checked } : null,
  };
}
