/** D-345 slice B — a web page's HTML as readable text, for Read a web address.
 *
 *  What a person reads, in the shape the Browser Toolkit's Read the text of a web page gives a tab:
 *  the title, headings as `#` lines, paragraphs, list items as `- ` lines, table rows as cells
 *  between `|`, links as `[text](address)` made whole against the page. Scripts, styles, forms'
 *  hidden parts and navigation are left out; a page with a `<main>` (or one `<article>`) is read from
 *  there. Not a full HTML parser: a tag-by-tag pass, bounded by the fetch's byte cap. */
import { stripHtmlText } from '@recued/transforms';

/** Elements whose content is never text a person reads. */
const DROPPED = ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'head', 'nav', 'select', 'button'];

/** Elements that start and end a line of their own. */
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'form', 'fieldset', 'table',
  'thead', 'tbody', 'tfoot', 'ul', 'ol', 'dl', 'dt', 'dd', 'pre', 'blockquote', 'figure', 'figcaption', 'details', 'summary',
  'address', 'hr', 'br', 'tr', 'caption', 'label', 'legend', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li']);

/** The part of the page that is its content: its `<main>`, else its one `<article>`, else its `<body>`. */
const contentOf = (html: string): string => {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(html);
  if (main) return main[1]!;
  const articles = html.match(/<article\b[^>]*>[\s\S]*?<\/article\s*>/gi) ?? [];
  if (articles.length === 1) return articles[0]!;
  return /<body\b[^>]*>([\s\S]*)$/i.exec(html)?.[1] ?? html;
};

/** A text run's characters as a person reads them: entities decoded, spaces collapsed, keeping a
 *  space at either end where the run had one, so words either side of a tag stay apart. */
const run = (raw: string): string => {
  const text = stripHtmlText(raw);
  if (text === '') return /\s/.test(raw) ? ' ' : '';
  return `${/^\s/.test(raw) ? ' ' : ''}${text}${/\s$/.test(raw) ? ' ' : ''}`;
};

/** Stand-ins for a preformatted block's spaces and line ends while the text around it is tidied. */
const PRE_SPACE = '\uE000';
const PRE_LINE = '\uE001';

/** Preformatted text as it stands, its entities decoded: `stripHtmlText` would fold its spacing. Its
 *  spaces and line ends ride as stand-ins through the tidying of the rest. */
const preformatted = (raw: string): string => raw.replace(/&(lt|gt|amp|quot|#39|apos|nbsp);/g, (_m, name: string) =>
  ({ lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'", apos: "'", nbsp: ' ' })[name] ?? '')
  .replace(/\r?\n/g, PRE_LINE).replace(/[ \t]/g, PRE_SPACE);

const attribute = (attributes: string, name: string): string | undefined => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attributes);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : stripHtmlText(value);
};

/** The page's title, and its content as readable text. */
export const readableText = (html: string, pageUrl: string): { title: string; text: string } => {
  const title = stripHtmlText(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? '');
  let body = contentOf(html).replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of DROPPED) {
    body = body.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ')
      .replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ');
  }
  const out: string[] = [];
  /** The link being read: its address, and where its text starts in `out`. */
  let link: { href: string; at: number } | undefined;
  let pre = 0;
  let cellsInRow = 0;
  const token = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>|([^<]+)|(<)/g;
  for (let m = token.exec(body); m !== null; m = token.exec(body)) {
    const [, closing, rawName, attributes, text, stray] = m;
    if (text !== undefined || stray !== undefined) {
      out.push(pre > 0 ? preformatted(text ?? '<') : run(text ?? '<'));
      continue;
    }
    const name = rawName!.toLowerCase();
    if (name === 'pre') pre += closing ? -1 : 1;
    if (name === 'a') {
      if (!closing) {
        const href = attribute(attributes!, 'href');
        let address: string | undefined;
        try {
          address = href !== undefined && !href.startsWith('#') ? new URL(href, pageUrl).href : undefined;
        } catch {
          address = undefined;
        }
        link = address !== undefined && /^https?:/.test(address) ? { href: address, at: out.length } : undefined;
      } else if (link !== undefined) {
        const inner = out.splice(link.at).join('').replace(/\s+/g, ' ').trim();
        out.push(inner === '' ? '' : ` [${inner}](${link.href}) `);
        link = undefined;
      }
      continue;
    }
    if (name === 'img' && !closing) {
      const alt = attribute(attributes!, 'alt');
      if (alt) out.push(` [image: ${alt}] `);
      continue;
    }
    if ((name === 'td' || name === 'th') && !closing) {
      out.push(cellsInRow > 0 ? ' | ' : '');
      cellsInRow += 1;
      continue;
    }
    if (name === 'tr') cellsInRow = 0;
    if (!BLOCK.has(name)) continue;
    out.push('\n');
    if (closing) {
      if (/^h[1-6]$/.test(name) || name === 'p') out.push('\n');
      continue;
    }
    if (/^h[1-6]$/.test(name)) out.push(`\n${'#'.repeat(Number(name[1]))} `);
    else if (name === 'li') out.push('- ');
    else if (name === 'hr') out.push('---\n');
  }
  const text = out.join('')
    .split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^(#{1,6}|-) *$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replaceAll(PRE_SPACE, ' ').replaceAll(PRE_LINE, '\n');
  return { title, text };
};
