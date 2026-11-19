import { describe, expect, it } from 'vitest';
import { sourceLabel } from '../../src/pages/SkillsPage.tsx';

describe('where an installed skill came from', () => {
  const sha = 'a1b2c3d4'.repeat(5);

  it('shows the repository and folder with a short commit, dropping the pinned tree', () => {
    expect(
      sourceLabel({
        sourceUrl: `https://github.com/acme/skills/tree/${sha}/skills/pdf`,
        sourceRef: sha,
      }),
    ).toBe('github.com/acme/skills/skills/pdf @ a1b2c3d');
  });

  it('shows a direct link as it is, with no commit', () => {
    expect(sourceLabel({ sourceUrl: 'https://example.com/x/SKILL.md', sourceRef: null })).toBe(
      'example.com/x/SKILL.md',
    );
  });

  it('shows nothing for a skill installed from a folder on this machine', () => {
    expect(sourceLabel({ sourceUrl: null, sourceRef: null })).toBeNull();
  });
});
