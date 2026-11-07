import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { budgetBreach, canReplan, canRetry, resolveBudget } from '../../src/budget.ts';
import { loadConfig } from '../../src/config.ts';
import { combineSkills, installSkill, loadVerifiedSkill } from '../../src/skills/loader.ts';
import { parseSkillFile } from '../../src/skills/manifest.ts';
import { requiresApproval } from '../../src/skills/policy.ts';
import { builtinTools } from '../../src/skills/tools/index.ts';
import { resolveInWorkspace } from '../../src/skills/workspace.ts';

const SKILL = `---
name: notes
description: Writes notes.
version: 1.2.0
tools: [read_file, write_file]
license: MIT
mcp-servers:
  search: { command: npx, args: [-y, some-mcp], env: { REGION: us } }
auto-approve: [web_fetch]
---
Keep notes short.
`;

describe('SKILL.md', () => {
  it('parses Gantrix keys and ignores unknown ones', () => {
    const skill = parseSkillFile(SKILL);
    expect(skill).toMatchObject({
      name: 'notes',
      version: '1.2.0',
      instructions: 'Keep notes short.',
    });
    expect(skill.manifest).toEqual({
      tools: ['read_file', 'write_file'],
      mcpServers: { search: { command: 'npx', args: ['-y', 'some-mcp'], env: { REGION: 'us' } } },
      autoApprove: ['web_fetch'],
    });
  });

  it('accepts a plain Claude skill (name and description only)', () => {
    const skill = parseSkillFile('---\nname: claude-style\ndescription: x\n---\nBody');
    expect(skill.manifest).toEqual({ tools: [], mcpServers: {}, autoApprove: [] });
    expect(skill.version).toBe('0.0.0');
  });

  it('reads an optional per-server tool timeout and rejects bad values', () => {
    const md = (t: string) =>
      `---\nname: x\ndescription: y\nmcp-servers:\n  media: { command: c, timeout-seconds: ${t} }\n---\n`;
    expect(parseSkillFile(md('1800')).manifest.mcpServers.media?.timeoutSeconds).toBe(1800);
    expect(
      parseSkillFile('---\nname: x\ndescription: y\nmcp-servers:\n  media: { command: c }\n---\n')
        .manifest.mcpServers.media,
    ).not.toHaveProperty('timeoutSeconds');
    for (const bad of ['0', '7201', '2.5', '"soon"'])
      expect(() => parseSkillFile(md(bad))).toThrow();
  });

  it('rejects unknown tools, bad names and underscores in MCP server names', () => {
    expect(() => parseSkillFile('---\nname: x\ndescription: y\ntools: [rm_rf]\n---\n')).toThrow(
      /Unknown built-in tools: rm_rf/,
    );
    expect(() => parseSkillFile('---\nname: Bad Name\ndescription: y\n---\n')).toThrow(/lowercase/);
    expect(() =>
      parseSkillFile('---\nname: x\ndescription: y\nmcp-servers:\n  a_b: { command: c }\n---\n'),
    ).toThrow();
    expect(() => parseSkillFile('no frontmatter')).toThrow(/frontmatter/);
  });
});

describe('installing skills', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'gantrix-skill-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'SKILL.md'), SKILL);
  });

  it('copies, checksums, refuses a reinstall and detects tampering', async () => {
    const installed = await installSkill(join(root, 'src'), join(root, 'skills'));
    expect(installed.sourcePath).toBe(join(root, 'skills', 'notes', '1.2.0'));
    await expect(installSkill(join(root, 'src'), join(root, 'skills'))).rejects.toThrow(
      /bump the version/,
    );
    await expect(loadVerifiedSkill(installed)).resolves.toMatchObject({ name: 'notes' });
    await writeFile(join(installed.sourcePath, 'extra.sh'), 'echo pwned');
    await expect(loadVerifiedSkill(installed)).rejects.toThrow(/changed on disk/);
  });

  it('refuses folders with symlinks', async () => {
    const dir = join(root, 'linked');
    await mkdir(dir);
    await writeFile(join(dir, 'SKILL.md'), SKILL.replace('1.2.0', '9.9.9'));
    await symlink('/etc', join(dir, 'escape'));
    await expect(installSkill(dir, join(root, 'skills'))).rejects.toThrow(/symlinks/);
  });

  it('merges skills and rejects two MCP servers with the same name', () => {
    const a = parseSkillFile(SKILL);
    expect(combineSkills([a]).builtinTools).toEqual(new Set(['read_file', 'write_file']));
    expect(() => combineSkills([a, a])).toThrow(/MCP server named "search"/);
  });
});

describe('approval policy', () => {
  it('auto-approves file tools, always asks for shell and publishing, and lets skills waive the rest', () => {
    const allowed = new Set(['shell', 'web_fetch', 'deploy_site', 'media_list_media_models']);
    expect(requiresApproval('deploy_site', allowed)).toBe(true);
    expect(requiresApproval('media_list_media_models', allowed)).toBe(false);
    expect(requiresApproval('email_send', allowed)).toBe(true);
    expect(requiresApproval('read_file', new Set())).toBe(false);
    expect(requiresApproval('shell', allowed)).toBe(true);
    expect(requiresApproval('web_fetch', allowed)).toBe(false);
    expect(requiresApproval('web_fetch', new Set())).toBe(true);
    expect(requiresApproval('search_query', new Set())).toBe(true);
  });
});

describe('workspace tools', () => {
  let ws: string;
  let outside: string;
  const tools = () =>
    Object.fromEntries(
      builtinTools(new Set(['read_file', 'write_file', 'list_files', 'web_fetch']), ws).map((t) => [
        t.name,
        t,
      ]),
    );
  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'gantrix-ws-'));
    ws = join(base, 'ws');
    outside = join(base, 'outside');
    await mkdir(ws);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(ws, 'link'));
  });

  it('reads and writes inside the workspace', async () => {
    const t = tools();
    expect(await t.write_file?.invoke({ path: 'a/b.txt', content: 'hello' })).toMatch(
      /Wrote 5 bytes/,
    );
    expect(await t.read_file?.invoke({ path: 'a/b.txt' })).toBe('hello');
    expect(await readFile(join(ws, 'a', 'b.txt'), 'utf8')).toBe('hello');
  });

  it('refuses every way out: .., absolute paths and symlinks', async () => {
    const t = tools();
    for (const path of ['../outside/secret.txt', join(outside, 'secret.txt'), 'link/secret.txt']) {
      expect(await t.read_file?.invoke({ path })).toMatch(/outside the task workspace/);
    }
    expect(await t.write_file?.invoke({ path: 'link/new.txt', content: 'x' })).toMatch(/outside/);
    await expect(resolveInWorkspace(ws, '../x')).rejects.toThrow(/outside/);
  });

  it("lists symlinks without listing what's behind them", async () => {
    const listing = String(await tools().list_files?.invoke({}));
    expect(listing).toContain('link@');
    expect(listing).not.toContain('secret.txt');
  });

  it('web_fetch refuses local and private addresses and non-http schemes', async () => {
    const t = tools();
    for (const url of [
      'http://127.0.0.1:4700/',
      'http://10.1.2.3/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://169.254.169.254/latest',
    ]) {
      expect(await t.web_fetch?.invoke({ url })).toMatch(/private or local address/);
    }
    expect(await t.web_fetch?.invoke({ url: 'file:///etc/passwd' })).toMatch(/Only http and https/);
  });
});

describe('budgets', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgres://x@localhost/x',
    REDIS_URL: 'redis://localhost',
  });
  const budget = resolveBudget({ maxTokens: 1000, maxMinutes: 10 }, config);

  it('merges overrides over the defaults', () => {
    expect(budget).toEqual({ maxStepAttempts: 3, maxReplans: 5, maxTokens: 1000, maxMinutes: 10 });
  });

  it('stops on tokens or time, and limits replans and attempts', () => {
    const now = new Date('2026-01-01T00:20:00Z');
    expect(budgetBreach({ tokensUsed: 999, replans: 0, startedAt: null }, budget, now)).toBeNull();
    expect(
      budgetBreach({ tokensUsed: 1000, replans: 0, startedAt: null }, budget, now)?.limit,
    ).toBe('tokens');
    expect(
      budgetBreach(
        { tokensUsed: 0, replans: 0, startedAt: new Date('2026-01-01T00:05:00Z') },
        budget,
        now,
      )?.limit,
    ).toBe('time');
    expect(canReplan({ tokensUsed: 0, replans: 5, startedAt: null }, budget)).toBe(false);
    expect(canRetry({ attempt: 2 }, budget)).toBe(true);
    expect(canRetry({ attempt: 3 }, budget)).toBe(false);
  });
});
