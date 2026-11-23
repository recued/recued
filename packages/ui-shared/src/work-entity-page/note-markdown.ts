import { Marked } from 'marked';
import { e } from '../template.js';

export interface NoteHeading { id: string; level: number; text: string }
export interface NoteMarkdown { html: string; headings: NoteHeading[] }

/** Note bodies are untrusted text. Keep Marked's escaped text/code rendering,
 * replace raw HTML with literal text, and allow only absolute web/email links.
 * Images remain their alt text so reading a note never fetches remote content.
 * A private parser prevents other Markdown consumers from changing this policy. */
export const renderNoteMarkdown = (body: string): NoteMarkdown => {
  const headings: NoteHeading[] = [];
  const occurrences = new Map<string, number>();
  let linkIndex = 0;
  const markdown = new Marked({
    gfm: true,
    renderer: {
      html({ text }) { return e(text); },
      image({ tokens, text }) { return tokens ? this.parser.parseInline(tokens) : e(text); },
      link({ href, title, tokens, text, autolink }) {
        const label = autolink ? e(text) : this.parser.parseInline(tokens);
        let url: URL;
        try { url = new URL(href); } catch { return label; }
        if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) return label;
        return `<a href="${e(url.href)}" target="_blank" rel="noopener noreferrer" data-note-note-link="${linkIndex}" data-note-focus="link-${linkIndex++}"${title ? ` title="${e(title)}"` : ''}>${label}</a>`;
      },
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens, this.parser.textRenderer);
        const slug = text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 80) || 'section';
        const occurrence = (occurrences.get(slug) ?? 0) + 1;
        occurrences.set(slug, occurrence);
        const id = `work-note-heading-${slug}-${occurrence}`;
        headings.push({ id, level: depth, text });
        return `<h${depth} id="${e(id)}" tabindex="-1" data-note-heading="${e(id)}" data-note-focus="${e(id)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
  });
  try { return { html: markdown.parse(body, { async: false }), headings }; }
  catch {
    // A parser failure must leave the original note readable and copyable.
    return { html: '<p role="status">This note could not be formatted. Plain text is shown.</p>'
      + `<div class="work-entity-note-plain">${e(body)}</div>`, headings: [] };
  }
};
