import { describe, expect, it } from 'vitest';
import { askedQuestions, interviewFor, looksSecret, renderSetupSkill } from '../src/agent-setup.ts';
import { TEAM } from '../src/team.ts';

const cto = interviewFor({ name: 'cto', skills: [{ name: 'exec-cto' }] });
const ids = (answers: Record<string, string>) =>
  askedQuestions(cto.questions, answers).map((q) => q.id);

describe('setup interview', () => {
  it('has its own questions for every starter agent', () => {
    for (const member of TEAM) {
      const skills = member.skills.map((name) => ({ name }));
      expect(interviewFor({ name: member.name, skills }).role, member.name).toBe(member.name);
    }
  });

  it('finds the role by skill after a rename, and falls back to general questions', () => {
    expect(interviewFor({ name: 'boss', skills: [{ name: 'exec-cto' }] }).role).toBe('cto');
    expect(interviewFor({ name: 'writer', skills: [] }).role).toBe('agent');
    expect(interviewFor({ name: 'constructor', skills: [] }).role).toBe('agent');
  });

  it('asks the CTO how code is saved first, then for GitHub access only on GitHub', () => {
    expect(cto.questions[0]?.ask).toBe('How do you save your code?');
    expect(ids({})).not.toContain('github');
    expect(ids({ code: 'GitHub' })).toContain('github');
    expect(ids({ code: 'we use github enterprise' })).toContain('github');
    expect(ids({ code: 'GitHub' })).not.toContain('code_location');
    expect(ids({ code: 'GitLab' })).toContain('code_location');
    expect(ids({ code: 'GitLab' })).not.toContain('github');
  });

  it('writes only the answered questions that apply into the skill', () => {
    const markdown = renderSetupSkill({
      agentName: 'cto',
      interview: cto,
      answers: { code: 'GitHub', code_location: 'stale', never: 'no force push\n# ever' },
      version: '1.0.0',
    });
    expect(markdown).toContain('name: setup-cto');
    expect(markdown).toContain('- **Where the code lives:** GitHub');
    expect(markdown).toContain('- **Never do:** no force push\n  # ever');
    expect(markdown).not.toContain('stale');
    expect(markdown).not.toContain('Tech stack');
  });

  it('spots tokens and passwords, not ordinary text', () => {
    for (const secret of [
      `ghp_${'a'.repeat(36)}`,
      `github_pat_${'a'.repeat(40)}`,
      'AKIAABCDEFGHIJKLMNOP',
      'postgres://admin:hunter2@db.internal/app',
    ]) {
      expect(looksSecret(`use ${secret} please`), secret).toBe(true);
    }
    expect(looksSecret('GitHub, github.com/acme/app, pull requests with review')).toBe(false);
  });
});
