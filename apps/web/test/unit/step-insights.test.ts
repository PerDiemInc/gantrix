import type { AgentDto, StepDto } from '@gantrix/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Gantt } from '../../src/components/Gantt.tsx';
import { dependenciesOf, ownerOf, StepInsights } from '../../src/components/StepInsights.tsx';

const step = (overrides: Partial<StepDto> = {}): StepDto => ({
  id: 'write-1',
  taskId: 'project',
  planVersion: 1,
  key: 'write',
  title: 'Write report',
  instructions: 'Write a report',
  acceptance: 'Contains sources',
  agentId: 'author',
  dependsOn: [],
  parentStepId: null,
  status: 'pending',
  attempt: 1,
  output: null,
  judgeReason: null,
  error: null,
  tokensUsed: 1234,
  createdAt: '2026-01-01T00:00:00Z',
  queuedAt: null,
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

describe('step execution insights', () => {
  it('resolves dependencies without taking a later replan for a historical step', () => {
    const old = step({ id: 'old', key: 'research', status: 'succeeded' });
    const later = step({ id: 'later', key: 'research', planVersion: 2, status: 'pending' });
    expect(dependenciesOf(step({ dependsOn: ['research', 'missing'] }), [later, old])).toEqual([
      { key: 'research', dependency: old },
      { key: 'missing', dependency: undefined },
    ]);
  });

  it('shows a deleted agent (agentId null) apart from agents that are still loading', () => {
    expect(ownerOf(step({ agentId: null }), new Map())).toBe('Deleted agent');
    expect(ownerOf(step(), new Map())).toBe('…');
  });

  it('renders token usage, dependency status and judge feedback as text', () => {
    const agents = new Map([['author', { name: 'Researcher' } as AgentDto]]);
    const html = renderToStaticMarkup(
      createElement(StepInsights, {
        step: step({ dependsOn: ['research'], judgeReason: '<script>missing sources</script>' }),
        steps: [step({ key: 'research', status: 'succeeded' })],
        agents,
      }),
    );
    expect(html).toContain('Researcher');
    expect(html).toContain('1,234');
    expect(html).toContain('research');
    expect(html).toContain('not a dollar estimate');
    expect(html).toContain('&lt;script&gt;missing sources&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('shows pending judgment and no dependencies explicitly', () => {
    const html = renderToStaticMarkup(
      createElement(StepInsights, {
        step: step({ status: 'judging' }),
        steps: [],
        agents: new Map(),
      }),
    );
    expect(html).toContain('Evaluation in progress.');
    expect(html).toContain('No prerequisite tasks.');
  });
  it('exposes Gantt ownership, usage and judge feedback without relying on color', () => {
    const html = renderToStaticMarkup(
      createElement(Gantt, {
        steps: [step({ judgeReason: 'Accepted: sources checked' })],
        agents: new Map([['author', { name: 'Researcher' } as AgentDto]]),
        finishedAt: '2026-01-01T00:01:00Z',
        selected: null,
        onSelect: () => {},
      }),
    );
    expect(html).toContain('Researcher');
    expect(html).toContain('1,234 tokens');
    expect(html).toContain('Judge: Accepted: sources checked');
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-label="Write report');
  });
});
