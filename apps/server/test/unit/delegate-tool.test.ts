import { describe, expect, it } from 'vitest';
import { delegateTool } from '../../src/skills/tools/delegate.ts';

describe('delegation workspace instructions', () => {
  const agents = [{ name: 'writer', description: 'Writes reports' }];
  it('names isolated parent input paths and explains returned child paths', () => {
    const tool = delegateTool(agents, 'parent-step');
    expect(tool.description).toContain('separate workspace');
    expect(tool.description).toContain('inputs/parent-step/');
    expect(tool.description).toContain('inputs/<child-step-id>/');
    expect(tool.description).not.toContain('same workspace');
  });
  it('retains shared-workspace guidance for legacy projects', () => {
    expect(delegateTool(agents).description).toContain('same workspace');
    expect(delegateTool(agents).description).not.toContain('inputs/');
  });
});
