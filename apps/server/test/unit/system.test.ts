import { describe, expect, it } from 'vitest';
import { parseBytes, parseContainers, parseVmStat } from '../../src/system.ts';

describe('system sampling', () => {
  it('reads byte sizes the way docker prints them', () => {
    expect(parseBytes('17.59MiB')).toBe(Math.round(17.59 * 1024 ** 2));
    expect(parseBytes(' 23.43GiB')).toBe(Math.round(23.43 * 1024 ** 3));
    expect(parseBytes('512kB')).toBe(512_000);
    expect(parseBytes('0B')).toBe(0);
    expect(parseBytes('--')).toBe(0);
  });

  it('joins docker stats with docker ps, biggest memory first', () => {
    const stats = [
      '{"ID":"aaa","Name":"gateway","CPUPerc":"0.50%","MemUsage":"17.59MiB / 23.43GiB","MemPerc":"0.07%","PIDs":"2"}',
      '{"ID":"bbb","Name":"postgres","CPUPerc":"150.25%","MemUsage":"1.5GiB / 23.43GiB","MemPerc":"6.40%","PIDs":"30"}',
      '',
    ].join('\n');
    const ps = [
      '{"ID":"aaa","Names":"gateway","Image":"agentim-gateway","Status":"Up 26 hours (healthy)","Project":"agentim"}',
      '{"ID":"bbb","Names":"postgres","Image":"postgres:16","Status":"Up 2 days","Project":""}',
    ].join('\n');
    const [first, second] = parseContainers(stats, ps);
    expect(first).toMatchObject({
      name: 'postgres',
      image: 'postgres:16',
      project: null,
      cpuPercent: 150.25,
      memUsedBytes: 1.5 * 1024 ** 3,
      pids: 30,
    });
    expect(second).toMatchObject({
      name: 'gateway',
      project: 'agentim',
      status: 'Up 26 hours (healthy)',
      memPercent: 0.07,
    });
  });

  it('counts free and reclaimable pages from vm_stat as available', () => {
    const out = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                               1000.',
      'Pages active:                             9000.',
      'Pages inactive:                           2000.',
      'Pages speculative:                         500.',
      'Pages purgeable:                           100.',
    ].join('\n');
    expect(parseVmStat(out)).toBe((1000 + 2000 + 500 + 100) * 16384);
    expect(parseVmStat('nonsense')).toBeNull();
  });
});
