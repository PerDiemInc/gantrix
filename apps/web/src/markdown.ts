import { Marked } from 'marked';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Markdown for chat bubbles. Agent replies are model output, which can carry text from any web
 * page an agent fetched, and the bubbles render in the dashboard's own origin (where the API
 * token lives), unlike file previews, which are sandboxed. So raw HTML is shown as text,
 * images are dropped to their alt text, and only http(s) and mailto links become links.
 */
const chat = new Marked({ gfm: true, breaks: true, async: false });
chat.use({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    image({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (!/^(https?:|mailto:)/i.test(href)) return inner;
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(href)}"${t} target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
  },
});

export const chatMarkdown = (text: string): string => chat.parse(text) as string;
