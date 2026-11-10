import { describe, expect, it } from 'vitest';
import { chatMarkdown } from '../../src/markdown.ts';

describe('chat markdown', () => {
  it('renders headings, emphasis, lists and code', () => {
    const html = chatMarkdown('### Plan\n- **Positioning**: smart\n- `copy.md`');
    expect(html).toContain('<h3>Plan</h3>');
    expect(html).toContain('<strong>Positioning</strong>');
    expect(html).toContain('<code>copy.md</code>');
  });
  it('shows raw HTML as text, never as markup', () => {
    const html = chatMarkdown('hi <img src=x onerror="alert(1)"> <script>alert(2)</script>');
    expect(html).not.toMatch(/<img|<script/i);
    expect(html).toContain('&#60;img');
  });
  it('drops images to their alt text', () => {
    expect(chatMarkdown('![logo](http://evil.test/x.png)')).not.toContain('<img');
  });
  it('links only http(s) and mailto, opening in a new tab', () => {
    expect(chatMarkdown('[a](javascript:alert(1))')).not.toContain('<a');
    expect(chatMarkdown('[a](data:text/html,x)')).not.toContain('<a');
    const html = chatMarkdown('[docs](https://example.com)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
