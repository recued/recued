/** Bounded answer formatting, existing Data record links, and asset/file
 * citations bound to this answer by the server. Code is always literal.
 * Unknown source handles and unsupported model URLs remain literal text.
 * No HTML is interpreted. */
import { chatSourceCitationsOf, type ChatSourceCitation } from '@recued/contracts';
import { sourceCitationHref } from './source-citations.js';
import { parseShellRoute, parseSourceRecordAddress } from '../shell/route.js';

export type AnswerTextSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'link'; readonly label: string; readonly href: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly children: readonly AnswerTextSegment[] };

export const ANSWER_CODE_BLOCK_ATTR = 'data-chat-answer-code-block';
export const ANSWER_CODE_COPY_ATTR = 'data-chat-answer-code-copy';
export const ANSWER_CODE_STATUS_ATTR = 'data-chat-answer-code-status';
export const ANSWER_CONTROL_ATTR = 'data-chat-answer-control';

/** A one-line label without brackets, then a fragment with no whitespace,
 *  brackets, parentheses, quotes or angle brackets. The server percent-encodes
 *  parentheses in `source_url` so the address cannot end a link early. */
const RECORD_LINK = /\[([^[\]\n]+)\]\((#[^\s()[\]<>"'`]+)\)/uy;
const OTHER_LINK_START = /\[[^[\]\n]+\]\(/uy;

const escaped = (text: string, at: number): boolean => {
  let slashes = 0;
  while (at > 0 && text[--at] === '\\') slashes++;
  return slashes % 2 === 1;
};
const tickEnd = (text: string, start: number): number => {
  let end = start;
  while (text[end] === '`') end++;
  return end;
};
const codeEnd = (text: string, start: number, length: number): number => {
  let next = text.indexOf('`', start);
  while (next >= 0) {
    const end = tickEnd(text, next);
    if (end - next === length) return next;
    next = text.indexOf('`', end);
  }
  return -1;
};

export const answerTextSegments = (text: string, sources: readonly ChatSourceCitation[] = []): AnswerTextSegment[] => {
  const verified = new Map(chatSourceCitationsOf(sources).map(source => [`#source/${source.id}`, sourceCitationHref(source)]));
  const read = (start: number, strong: boolean): { segments: AnswerTextSegment[]; end: number; closed: boolean } => {
    const segments: AnswerTextSegment[] = [];
    let plain = '';
    const flush = (): void => { if (plain) { segments.push({ kind: 'text', text: plain }); plain = ''; } };
    let i = start;
    while (i < text.length) {
      if (text[i] === '`' && !escaped(text, i)) {
        const after = tickEnd(text, i);
        const end = codeEnd(text, after, after - i);
        // An unfinished streamed span must not activate a link in its body.
        if (end < 0) { plain += text.slice(i); i = text.length; break; }
        flush(); segments.push({ kind: 'code', text: text.slice(after, end) });
        i = end + after - i; continue;
      }
      if (text.startsWith('**', i) && !escaped(text, i)) {
        if (strong) { flush(); return { segments, end: i + 2, closed: true }; }
        const child = read(i + 2, true);
        if (child.closed && child.segments.length) {
          flush(); segments.push({ kind: 'strong', children: child.segments }); i = child.end; continue;
        }
        plain += text.slice(i); i = text.length; break;
      }
      if (text[i] === '[' && !escaped(text, i)) {
        RECORD_LINK.lastIndex = i;
        const match = RECORD_LINK.exec(text);
        if (match) {
          const label = match[1] ?? '', href = match[2] ?? '';
          const target = verified.get(href);
          if (label.trim() && (target || parseSourceRecordAddress(parseShellRoute(href)) !== null)) {
            flush(); segments.push({ kind: 'link', label, href: target ?? href });
          } else plain += match[0];
          i += match[0].length; continue;
        }
        // Unsupported link syntax is one literal unit, including formatting
        // characters in a label or URL. Never reinterpret part of its target.
        OTHER_LINK_START.lastIndex = i;
        const other = OTHER_LINK_START.exec(text);
        if (other) {
          let end = i + other[0].length, depth = 1;
          while (end < text.length && text[end] !== '\n' && depth > 0) {
            if (text[end] === '(' && !escaped(text, end)) depth++;
            if (text[end] === ')' && !escaped(text, end)) depth--;
            end++;
          }
          plain += text.slice(i, end); i = end; continue;
        }
      }
      plain += text[i++];
    }
    flush(); return { segments, end: i, closed: !strong };
  };
  return read(0, false).segments;
};

interface AnswerList {
  kind: 'list'; ordered: boolean; start: number;
  items: Array<{ parts: Array<string | AnswerList>; ordinal?: number }>;
}
type AnswerBlock = AnswerList
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'code'; text: string; language: string; offset: number };
const fence = (line: string): RegExpMatchArray | null => line.match(/^[ \t]*(`{3,}|~{3,})([^\r\n]*)$/u);
const heading = (line: string): RegExpMatchArray | null => line.match(/^ {0,3}(#{1,6})[ \t]+(.+)$/u);
const listItem = (line: string) => {
  const match = line.match(/^( *)([-+*]|\d{1,9}[.)])[ \t]+(.*)$/u);
  if (!match) return undefined;
  const ordered = /^\d/u.test(match[2]!);
  return { indent: match[1]!.length, ordered, text: match[3]!, ordinal: ordered ? Number.parseInt(match[2]!, 10) : undefined };
};

const answerBlocks = (text: string): AnswerBlock[] => {
  let offset = 0;
  const lines = text.split('\n').map(raw => {
    const line = { text: raw.replace(/\r$/u, ''), offset }; offset += raw.length + 1; return line;
  });
  let i = 0;
  const readList = (depth: number): AnswerList => {
    const first = listItem(lines[i]!.text)!;
    const list: AnswerList = { kind: 'list', ordered: first.ordered, start: first.ordinal ?? 1, items: [] };
    while (i < lines.length) {
      const current = listItem(lines[i]!.text);
      if (!current || current.indent !== first.indent || current.ordered !== first.ordered) break;
      const item: AnswerList['items'][number] = { parts: [current.text], ordinal: current.ordinal };
      list.items.push(item); i++;
      const continueText = (line: string): void => {
        const last = item.parts.at(-1);
        if (typeof last === 'string') item.parts[item.parts.length - 1] = `${last}\n${line.trimStart()}`;
        else item.parts.push(line.trimStart());
      };
      while (i < lines.length && lines[i]!.text.trim()) {
        const line = lines[i]!.text, nested = listItem(line);
        if (fence(line) || heading(line)) break;
        if (nested) {
          if (nested.indent <= first.indent) break;
          if (depth < 8) item.parts.push(readList(depth + 1));
          else { continueText(line); i++; }
        } else if (line.length - line.trimStart().length > first.indent) {
          continueText(line); i++;
        } else break;
      }
    }
    return list;
  };
  const blocks: AnswerBlock[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.text.trim()) { i++; continue; }
    const open = fence(line.text);
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      const marker = open[1]!;
      const language = open[2]!.trim().split(/\s+/u)[0] ?? '';
      const start = lines[++i]?.offset ?? text.length;
      while (i < lines.length) {
        const close = lines[i]!.text.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/u)?.[1];
        if (close && close[0] === marker[0] && close.length >= marker.length) break;
        i++;
      }
      const end = lines[i]?.offset ?? text.length;
      blocks.push({ kind: 'code', text: text.slice(start, end), language: /^[\w.+#-]{1,32}$/u.test(language) ? language : '', offset: line.offset });
      if (i < lines.length) i++;
      continue;
    }
    const title = heading(line.text);
    if (title) { blocks.push({ kind: 'heading', level: Math.min(6, title[1]!.length + 2), text: title[2]! }); i++; continue; }
    if (listItem(line.text)) { blocks.push(readList(0)); continue; }
    const prose = [line.text]; i++;
    while (i < lines.length && lines[i]!.text.trim() && !fence(lines[i]!.text)
      && !heading(lines[i]!.text) && !listItem(lines[i]!.text)) prose.push(lines[i++]!.text);
    blocks.push({ kind: 'paragraph', text: prose.join('\n') });
  }
  return blocks;
};

export const ANSWER_TEXT_STYLES = `
[data-chat-answer-formatted="blocks"] { white-space:normal !important; }
[data-chat-answer-formatted="blocks"] > p { margin:.65em 0; white-space:pre-wrap; }
[data-chat-answer-formatted="blocks"] > :first-child { margin-top:0; }
[data-chat-answer-formatted="blocks"] > :last-child { margin-bottom:0; }
.chat-answer-heading { margin:.9em 0 .4em; font-size:1em; line-height:1.4; font-weight:650; }
h3.chat-answer-heading { font-size:1.1em; }
.chat-answer-list { margin:.6em 0; padding-inline-start:1.6em; }
.chat-answer-list li { margin:.25em 0; white-space:pre-wrap; }
.chat-answer-list .chat-answer-list { margin:.25em 0; }
.chat-answer-inline-code { font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace; font-size:.88em;
  padding:.1em .3em; border-radius:4px; background:var(--surface-sunk); overflow-wrap:anywhere; }
[${ANSWER_CODE_BLOCK_ATTR}] { min-width:0; max-width:100%; margin:.75em 0; border:1px solid var(--border);
  border-radius:8px; background:var(--surface-sunk); overflow:hidden; }
.chat-answer-code-head { display:flex; align-items:center; gap:8px; padding:4px 8px 4px 12px;
  color:var(--muted); font-size:12px; }
.chat-answer-code-head > :first-child { margin-inline-end:auto; }
[${ANSWER_CODE_COPY_ATTR}] { font:inherit; color:var(--fg); background:var(--surface); border:1px solid var(--border);
  border-radius:5px; padding:3px 9px; min-height:28px; cursor:pointer; }
[${ANSWER_CODE_COPY_ATTR}][aria-disabled="true"] { cursor:wait; opacity:.65; }
[${ANSWER_CODE_BLOCK_ATTR}] pre { margin:0; padding:8px 12px 12px; min-width:0; max-width:100%; overflow-x:auto;
  white-space:pre; overflow-wrap:normal; word-break:normal; font:13px/1.6 ui-monospace,'SF Mono',Menlo,Consolas,monospace; }
[${ANSWER_CODE_BLOCK_ATTR}] code { font:inherit; }
[${ANSWER_CODE_STATUS_ATTR}] { margin:0; padding:0 12px; font-size:12px; color:var(--muted); }
[${ANSWER_CODE_STATUS_ATTR}]:not(:empty) { padding-bottom:8px; }
[${ANSWER_CODE_STATUS_ATTR}][data-copy-quiet] { position:absolute; width:1px; height:1px; overflow:hidden;
  clip-path:inset(50%); padding:0; margin:-1px; white-space:nowrap; }
[${ANSWER_CODE_COPY_ATTR}]:focus-visible, [${ANSWER_CODE_BLOCK_ATTR}] pre:focus-visible {
  outline:2px solid var(--accent); outline-offset:-2px; }
@media (max-width:640px), (pointer:coarse) { [${ANSWER_CODE_COPY_ATTR}] { min-width:44px; min-height:44px; } }
`;

/** Render a small text-only subset. The route owns Copy through one delegated
 * controller; neither HTML nor arbitrary model-authored URLs become markup. */
export const renderAnswerText = (
  doc: Document,
  host: HTMLElement,
  text: string,
  sources: readonly ChatSourceCitation[] = [],
  scope = 'answer',
): void => {
  // Retain the cheap plain-text streaming path.
  if (!/[\[`~]|\*\*|\n[ \t]*\r?\n|^ *#{1,6}\s|^ *(?:[-+*]|\d{1,9}[.)])\s/mu.test(text)) {
    host.setAttribute('data-chat-answer-formatted', 'plain');
    host.textContent = text;
    return;
  }
  const blocks = answerBlocks(text);
  let linkIndex = 0;
  const inline = (parent: HTMLElement, segments: readonly AnswerTextSegment[]): void => {
    for (const segment of segments) {
      if (segment.kind === 'text') parent.appendChild(doc.createTextNode(segment.text));
      else if (segment.kind === 'strong') {
        const strong = doc.createElement('strong'); inline(strong, segment.children); parent.appendChild(strong);
      } else if (segment.kind === 'code') {
        const code = doc.createElement('code'); code.className = 'chat-answer-inline-code'; code.textContent = segment.text; parent.appendChild(code);
      } else {
        const link = doc.createElement('a'); link.setAttribute('href', segment.href); link.textContent = segment.label;
        link.setAttribute(ANSWER_CONTROL_ATTR, JSON.stringify([scope, 'link', linkIndex++, segment.href])); parent.appendChild(link);
      }
    }
  };
  const list = (block: AnswerList): HTMLElement => {
    const element = doc.createElement(block.ordered ? 'ol' : 'ul'); element.className = 'chat-answer-list';
    if (block.ordered) element.setAttribute('start', String(block.start));
    for (const item of block.items) {
      const li = doc.createElement('li');
      if (item.ordinal !== undefined) li.setAttribute('value', String(item.ordinal));
      for (const part of item.parts) {
        if (typeof part === 'string') inline(li, answerTextSegments(part, sources));
        else li.appendChild(list(part));
      }
      element.appendChild(li);
    }
    return element;
  };
  if (blocks.length === 1 && blocks[0]?.kind === 'paragraph') {
    host.textContent = '';
    host.setAttribute('data-chat-answer-formatted', 'inline');
    inline(host, answerTextSegments(text, sources)); return;
  }
  const existingCode = new Map(Array.from(host.querySelectorAll?.<HTMLElement>(`[${ANSWER_CODE_BLOCK_ATTR}]`) ?? [])
    .map(element => [element.getAttribute(ANSWER_CODE_BLOCK_ATTR)!, element]));
  const nodes: Node[] = [];
  host.setAttribute('data-chat-answer-formatted', 'blocks');
  for (const block of blocks) {
    if (nodes.length) nodes.push(doc.createTextNode('\n'));
    if (block.kind === 'list') { nodes.push(list(block)); continue; }
    if (block.kind === 'code') {
      const key = JSON.stringify([scope, block.offset]);
      const previous = existingCode.get(key);
      const previousCode = previous?.querySelector('code');
      if (previous && previousCode) {
        const prior = previousCode.textContent ?? '';
        if (prior !== block.text) {
          const first = previousCode.firstChild as Text | null;
          if (block.text.startsWith(prior) && first?.nodeType === 3 && previousCode.childNodes.length === 1) {
            first.appendData(block.text.slice(prior.length));
          } else previousCode.textContent = block.text;
        }
        const language = previous.querySelector('.chat-answer-code-head > span');
        if (language) language.textContent = block.language || 'Code';
        nodes.push(previous); continue;
      }
      const box = doc.createElement('div'); box.setAttribute(ANSWER_CODE_BLOCK_ATTR, key);
      const head = doc.createElement('div'); head.className = 'chat-answer-code-head';
      const language = doc.createElement('span'); language.textContent = block.language || 'Code'; head.appendChild(language);
      const copy = doc.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy';
      copy.setAttribute(ANSWER_CODE_COPY_ATTR, key); copy.setAttribute('aria-label', 'Copy code');
      copy.setAttribute(ANSWER_CONTROL_ATTR, JSON.stringify([scope, 'copy', block.offset])); head.appendChild(copy);
      const pre = doc.createElement('pre'); pre.setAttribute('tabindex', '0'); pre.setAttribute('aria-label', 'Code block');
      pre.setAttribute(ANSWER_CONTROL_ATTR, JSON.stringify([scope, 'code', block.offset]));
      const code = doc.createElement('code'); code.textContent = block.text; pre.appendChild(code);
      const status = doc.createElement('p'); status.setAttribute(ANSWER_CODE_STATUS_ATTR, ''); status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'off');
      box.appendChild(head); box.appendChild(pre); box.appendChild(status); nodes.push(box);
    } else {
      const element = doc.createElement(block.kind === 'heading' ? `h${block.level}` : 'p');
      if (block.kind === 'heading') element.className = 'chat-answer-heading';
      inline(element, answerTextSegments(block.text, sources)); nodes.push(element);
    }
  }
  if (typeof host.insertBefore === 'function' && host.childNodes !== undefined) {
    // Leave retained code nodes connected. Appending later prose must not
    // discard a code selection, scroll position or focused Copy control.
    const keep = new Set(nodes);
    for (const child of Array.from(host.childNodes)) if (!keep.has(child)) host.removeChild(child);
    let cursor = host.firstChild;
    for (const node of nodes) {
      if (cursor === node) cursor = cursor.nextSibling;
      else host.insertBefore(node, cursor);
    }
  } else {
    host.textContent = '';
    for (const node of nodes) host.appendChild(node);
  }
};
