import { describe, expect, it } from 'vitest';
import { previewKind, resolveRelative } from '../../src/components/FilePreview.tsx';

describe('file previews', () => {
  it('picks a preview by extension', () => {
    expect(previewKind('product/prd.md')).toBe('markdown');
    expect(previewKind('design/print/card.HTML')).toBe('html');
    expect(previewKind('art/hero.png')).toBe('image');
    expect(previewKind('data.csv')).toBe('text');
  });

  it('resolves links next to the file and refuses ones that leave the workspace', () => {
    expect(resolveRelative('design/mockups/home.html', '../tokens.css')).toBe('design/tokens.css');
    expect(resolveRelative('design/mockups/home.html', './img/a.png?v=2')).toBe(
      'design/mockups/img/a.png',
    );
    expect(resolveRelative('notes.md', '../../etc/passwd')).toBeNull();
    expect(resolveRelative('a.html', 'https://example.com/x.css')).toBeNull();
    expect(resolveRelative('a.html', '/abs.css')).toBeNull();
    expect(resolveRelative('a.html', 'data:image/png;base64,AA')).toBeNull();
  });
});
