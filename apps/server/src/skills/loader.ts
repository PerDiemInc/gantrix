import { createHash } from 'node:crypto';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { McpServerConfig } from '@gantrix/shared';
import { type ParsedSkill, parseSkillFile } from './manifest.ts';
import { pathExists, walk } from './workspace.ts';

const SKIP = new Set(['.git', 'node_modules', '.DS_Store']);
const skipped = (root: string, path: string) =>
  relative(root, path)
    .split(sep)
    .some((part) => SKIP.has(part));

export async function checksumDir(dir: string): Promise<string> {
  const files = (await walk(dir, SKIP))
    .filter((e) => e.kind === 'file')
    .map((e) => e.path)
    .sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash
      .update(file)
      .update('\0')
      .update(await readFile(join(dir, file)))
      .update('\0');
  }
  return hash.digest('hex');
}

export interface InstalledSkill extends ParsedSkill {
  sourcePath: string;
  checksum: string;
}

/**
 * Copies a skill folder to <skillsDir>/<name>/<version>, so later edits to the original
 * don't change what runs. A version can be installed only once; bump it to change a skill.
 */
export async function installSkill(sourceDir: string, skillsDir: string): Promise<InstalledSkill> {
  const parsed = parseSkillFile(await readFile(join(sourceDir, 'SKILL.md'), 'utf8'));
  const links = (await walk(sourceDir, SKIP)).filter((e) => e.kind === 'link');
  if (links.length) {
    throw new Error(
      `Skill folders can't contain symlinks: ${links.map((e) => e.path).join(', ')}.`,
    );
  }
  const dest = join(skillsDir, parsed.name, parsed.version);
  if (await pathExists(dest)) {
    throw new Error(
      `Skill "${parsed.name}" ${parsed.version} is already installed; bump the version.`,
    );
  }
  await mkdir(dirname(dest), { recursive: true });
  await cp(sourceDir, dest, { recursive: true, filter: (src) => !skipped(sourceDir, src) });
  return { ...parsed, sourcePath: dest, checksum: await checksumDir(dest) };
}

/** Re-reads an installed skill, refusing if its files changed since it was registered. */
export async function loadVerifiedSkill(row: {
  name: string;
  sourcePath: string;
  checksum: string;
}): Promise<ParsedSkill> {
  if ((await checksumDir(row.sourcePath)) !== row.checksum) {
    throw new Error(`Skill "${row.name}" changed on disk since it was registered; re-register it.`);
  }
  return parseSkillFile(await readFile(join(row.sourcePath, 'SKILL.md'), 'utf8'));
}

export interface AgentToolkit {
  builtinTools: Set<string>;
  mcpServers: Record<string, McpServerConfig>;
  autoApprove: Set<string>;
  instructions: string;
}

/** Merges an agent's skills into one toolkit. */
export function combineSkills(skills: readonly ParsedSkill[]): AgentToolkit {
  const toolkit: AgentToolkit = {
    builtinTools: new Set(),
    mcpServers: {},
    autoApprove: new Set(),
    instructions: '',
  };
  const sections: string[] = [];
  for (const skill of skills) {
    for (const t of skill.manifest.tools) toolkit.builtinTools.add(t);
    for (const t of skill.manifest.autoApprove) toolkit.autoApprove.add(t);
    for (const [name, server] of Object.entries(skill.manifest.mcpServers)) {
      if (toolkit.mcpServers[name]) {
        throw new Error(`Two skills define an MCP server named "${name}"; rename one.`);
      }
      toolkit.mcpServers[name] = server;
    }
    if (skill.instructions) sections.push(`## Skill: ${skill.name}\n${skill.instructions}`);
  }
  toolkit.instructions = sections.join('\n\n');
  return toolkit;
}
