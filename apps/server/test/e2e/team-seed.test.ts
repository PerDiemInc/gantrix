import { TEAM } from '@gantrix/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agents } from '../../src/db/schema.ts';
import { seedDefaultTeam } from '../../src/team-seed.ts';
import { type Engine, startEngine } from './harness.ts';

let e: Engine;
let redis: Redis;
beforeAll(async () => {
  e = await startEngine();
  redis = new Redis(process.env.GANTRIX_TEST_REDIS_URL ?? 'redis://127.0.0.1:16379/2');
});
afterAll(async () => {
  redis?.disconnect();
  await e?.close();
});
beforeEach(async () => {
  await e.reset();
  await redis.flushdb();
});

describe('starter team', () => {
  it('adds the built-in agents with their skills on a first run', async () => {
    expect(await seedDefaultTeam(e.db, redis, e.config)).toBe(TEAM.length);
    const list = await e.db.select().from(agents);
    expect(list.map((a) => a.name).sort()).toEqual(TEAM.map((m) => m.name).sort());
    const cto = list.find((a) => a.name === 'cto');
    expect(cto?.description).toContain('CTO');
    expect(cto?.avatar).toBe('preset:gant-glasses');
    const links = await e.db.execute('select count(*)::int as n from agent_skills');
    expect(Number((links.rows[0] as { n: number }).n)).toBeGreaterThanOrEqual(TEAM.length);
  });

  it('runs once: edits and deletions are not undone', async () => {
    await seedDefaultTeam(e.db, redis, e.config);
    await e.db.delete(agents);
    expect(await seedDefaultTeam(e.db, redis, e.config)).toBe(0);
    expect(await e.db.$count(agents)).toBe(0);
  });

  it("doesn't touch an installation that already has agents", async () => {
    await e.addAgent('mine');
    expect(await seedDefaultTeam(e.db, redis, e.config)).toBe(0);
    expect(await e.db.$count(agents)).toBe(1);
  });
});
