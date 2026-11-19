import { describe, expect, it } from 'vitest';
import {
  type AgentWork,
  describeWork,
  isStatusQuestion,
  statusReply,
} from '../../src/slack/agent-work.ts';

const item = (over: Partial<AgentWork['active'][number]> = {}) => ({
  project: 'Bakery launch',
  title: 'Build the site',
  status: 'running' as const,
  attempt: 1,
  minutes: 12,
  note: '',
  ...over,
});
const none: AgentWork = { active: [], waiting: [], recent: [] };

describe('what an agent knows about its own work', () => {
  it('says plainly when there is nothing', () => {
    expect(describeWork(none)).toContain('no tasks in any running project');
    expect(statusReply('writer', none)).toBe(
      '*writer*: nothing on my plate right now, and nothing finished in the last day.',
    );
  });

  it('lists running tasks with their project, age and attempt, then what waits on people', () => {
    const work: AgentWork = {
      active: [
        item({ attempt: 2 }),
        item({ title: 'Write copy', status: 'pending', minutes: null }),
      ],
      waiting: [
        { project: 'Bakery launch', title: 'Build the site', what: 'approve running shell' },
      ],
      recent: [item({ title: 'Brief', status: 'succeeded', note: 'brief.md written' })],
    };
    const facts = describeWork(work);
    expect(facts).toContain(
      '"Build the site" in project "Bakery launch": running (12 min), attempt 2',
    );
    expect(facts).toContain('"Write copy" in project "Bakery launch": pending');
    expect(facts).toContain('needs someone to approve running shell');
    expect(facts).toContain('"Brief" in "Bakery launch": succeeded. Result: brief.md written');

    const slack = statusReply('writer', work);
    expect(slack).toContain('*writer* is on 1 task:');
    expect(slack).toContain('• *Build the site* (Bakery launch): running (12 min), attempt 2');
    expect(slack).toContain('• Needs a person on *Build the site*: approve running shell');
    expect(slack).toContain('• Up next: *Write copy* (Bakery launch)');
    expect(slack).toContain('• Done: *Brief* (Bakery launch) — brief.md written');
  });

  it('shows hours for long tasks, and failures with the reason', () => {
    const work: AgentWork = {
      ...none,
      active: [item({ minutes: 200 })],
      recent: [item({ status: 'failed', note: 'terraform apply timed out' })],
    };
    expect(describeWork(work)).toContain('(3 h)');
    expect(describeWork(work)).toContain('failed. Why: terraform apply timed out');
    expect(statusReply('ops', work)).toContain('• Failed: *Build the site*');
  });

  it("doesn't let a task title break Slack's formatting", () => {
    const slack = statusReply('writer', { ...none, active: [item({ title: 'Fix <b>&</b>' })] });
    expect(slack).toContain('Fix &lt;b&gt;&amp;&lt;/b&gt;');
  });

  it('recognises a question about where things stand', () => {
    for (const q of [
      "what's your status?",
      'how is it going',
      'any progress?',
      'What are you working on',
      'anything blocked?',
      'give me a summary',
    ]) {
      expect(isStatusQuestion(q), q).toBe(true);
    }
    for (const q of ['write me a poem', 'draft the launch email', 'hi']) {
      expect(isStatusQuestion(q), q).toBe(false);
    }
  });
});
