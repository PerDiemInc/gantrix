import { describe, expect, it } from 'vitest';
import { asideSummary, groupAsides } from '../../src/components/Meeting.tsx';
import { ago, duration } from '../../src/format.ts';

const line = (id: number, aside = false, tool?: string) => ({
  id,
  at: '2026-11-10T10:00:00Z',
  speaker: 'agent' as const,
  name: 'cpo',
  text: tool ? `${tool} {}` : 'hi',
  ...(aside ? { aside } : {}),
  ...(tool ? { tool } : {}),
});

describe('folding tool calls in the chat', () => {
  it('folds a run of asides into one item and keeps other lines apart', () => {
    const items = groupAsides([
      line(1),
      line(2, true, 'read_file'),
      line(3, true, 'read_file'),
      line(4),
      line(5, true, 'list_files'),
    ]);
    expect(items.map((i) => (i.kind === 'line' ? 'line' : i.lines.length))).toEqual([
      'line',
      2,
      'line',
      1,
    ]);
  });
  it('summarises the tools, most used first, and notes read', () => {
    const lines = [
      line(1, true, 'list_files'),
      line(2, true, 'read_file'),
      line(3, true, 'read_file'),
      line(4, true),
    ];
    expect(asideSummary(lines)).toBe('3 tool calls · read_file ×2, list_files · 1 note read');
  });
});

describe('times', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const before = (ms: number) => new Date(now - ms).toISOString();
  it('says when with one unit', () => {
    expect(ago(before(20_000), now)).toBe('just now');
    expect(ago(before(12 * 60_000), now)).toBe('12m ago');
    expect(ago(before(5 * 3_600_000), now)).toBe('5h ago');
    expect(ago(before(94 * 3_600_000 + 56 * 60_000), now)).toBe('3d ago');
  });
  it('shows long runs in days and hours', () => {
    expect(duration(45 * 3_600_000 + 53 * 60_000)).toBe('1d 21h');
    expect(duration(11 * 60_000 + 41_000)).toBe('11m 41s');
  });
});
