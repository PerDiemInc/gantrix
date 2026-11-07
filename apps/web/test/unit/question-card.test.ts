import { describe, expect, it } from 'vitest';
import { fileFor } from '../../src/components/QuestionCard.tsx';

describe('question preview workspace resolution', () => {
  const files = [
    '.isolated-steps',
    'steps/author/',
    'steps/reviewer/',
    'steps/author/design/style-a.html',
    'steps/reviewer/design/style-a.html',
    'steps/reviewer/inputs/author/design/style-a.html',
    'design/style-a.html',
  ];
  it('resolves a full relative path in the asking step workspace', () => {
    expect(fileFor('design/style-a.html', files, 'author')).toBe(
      'steps/author/design/style-a.html',
    );
    expect(fileFor('./design/style-a.html', files, 'reviewer')).toBe(
      'steps/reviewer/design/style-a.html',
    );
    expect(fileFor('inputs/author/design/style-a.html', files, 'reviewer')).toBe(
      'steps/reviewer/inputs/author/design/style-a.html',
    );
  });
  it('never picks another step or a legacy root file for an isolated question', () => {
    expect(fileFor('style-a.html', files, 'missing')).toBeUndefined();
    expect(fileFor('design/style-a.html', files)).toBeUndefined();
    expect(fileFor('../author/design/style-a.html', files, 'reviewer')).toBeUndefined();
  });
  it('only resolves unambiguous basename shortcuts within the workspace', () => {
    expect(fileFor('style-a', files, 'author')).toBe('steps/author/design/style-a.html');
    expect(fileFor('style-a.html', files, 'reviewer')).toBeUndefined();
  });
  it('supports legacy project files but rejects non-preview files', () => {
    expect(fileFor('style-a', ['design/style-a.html'], 'old-step')).toBe('design/style-a.html');
    expect(fileFor('notes', ['notes.txt'], 'old-step')).toBeUndefined();
  });
  it('detects an empty isolated step directory even without a marker in a limited listing', () => {
    expect(fileFor('style-a', ['steps/new/', 'design/style-a.html'], 'new')).toBeUndefined();
  });
});
