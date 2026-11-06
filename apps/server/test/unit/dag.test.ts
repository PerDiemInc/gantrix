import { describe, expect, it } from 'vitest';
import { readySteps, type SchedulableStep, validatePlan } from '../../src/plan/dag.ts';
import type { PlannedStep } from '../../src/plan/schema.ts';

const step = (key: string, dependsOn: string[] = [], agent = 'writer'): PlannedStep => ({
  key,
  title: key,
  agent,
  instructions: 'do it',
  acceptance: 'it is done',
  dependsOn,
});
const ctx = { agentNames: new Set(['writer', 'editor']), doneKeys: new Set<string>() };

describe('validatePlan', () => {
  it('accepts a diamond', () => {
    const plan = { steps: [step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])] };
    expect(validatePlan(plan, ctx)).toEqual([]);
  });

  it('reports every problem in words the planner can act on', () => {
    const plan = { steps: [step('a'), step('a'), step('b', ['zz'], 'ghost'), step('c', ['c'])] };
    expect(validatePlan(plan, ctx)).toEqual([
      'Step key "a" is used more than once.',
      'Step "b" uses unknown agent "ghost". Available: writer, editor.',
      'Step "b" depends on unknown step "zz".',
      'Step "c" depends on itself.',
    ]);
  });

  it('finds cycles', () => {
    const plan = { steps: [step('a', ['c']), step('b', ['a']), step('c', ['b'])] };
    expect(validatePlan(plan, ctx)).toEqual([
      'Steps depend on each other in a cycle: a → c → b → a.',
    ]);
  });

  it('lets a replan build on finished steps but not reuse their keys', () => {
    const replan = { ...ctx, doneKeys: new Set(['research']) };
    expect(validatePlan({ steps: [step('write', ['research'])] }, replan)).toEqual([]);
    expect(validatePlan({ steps: [step('research')] }, replan)).toEqual([
      'Step key "research" belongs to a finished step; choose a new key.',
    ]);
  });
});

describe('readySteps', () => {
  const s = (
    key: string,
    status: SchedulableStep['status'],
    dependsOn: string[] = [],
    agentId: string | null = 'A',
  ): SchedulableStep => ({
    key,
    status,
    dependsOn,
    agentId,
  });

  it('starts pending steps whose dependencies all succeeded', () => {
    const steps = [
      s('a', 'succeeded'),
      s('b', 'pending', ['a']),
      s('c', 'pending', ['b']),
      s('d', 'pending'),
    ];
    expect(readySteps(steps, new Map([['A', 5]]))).toEqual(['b', 'd']);
  });

  it("respects each agent's limit, counting queued, running and judging but not approvals", () => {
    const steps = [
      s('busy', 'running'),
      s('waiting', 'awaiting_approval'),
      s('p1', 'pending'),
      s('p2', 'pending'),
      s('other', 'pending', [], 'B'),
    ];
    expect(
      readySteps(
        steps,
        new Map([
          ['A', 2],
          ['B', 1],
        ]),
      ),
    ).toEqual(['p1', 'other']);
  });

  it('never starts a step whose agent was deleted', () => {
    expect(readySteps([s('orphan', 'pending', [], null)], new Map())).toEqual([]);
  });
});
