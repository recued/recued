import { chatSourceCitationsOf, type ChatMessage } from '@recued/contracts';
import { ANSWER_CODE_BLOCK_ATTR, ANSWER_CODE_STATUS_ATTR, ANSWER_CONTROL_ATTR, renderAnswerText } from './answer-text.js';
import { buildAnswerSources } from './source-citations.js';

type Answer = Pick<ChatMessage, 'id' | 'content' | 'source_citations'>;
interface Target { message: Answer; sessionId?: string; version: string }
interface CopyState { version: string; phase: 'pending' | 'copied' | 'failed'; plain: boolean }
export const ANSWER_COPY_ATTR = 'data-chat-answer-copy';
const ACTIONS = 'data-chat-answer-actions';

/** A text representation of the trusted rendered answer. Keep code literal,
 * explicit list numbering and portable links when rich paste is unavailable. */
const readableText = (node: Node, indent = ''): string => {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1) return '';
  const element = node as HTMLElement;
  if (element.tagName === 'PRE') return element.textContent ?? '';
  if (element.tagName === 'BR') return '\n';
  if (element.tagName === 'A') {
    const label = element.textContent ?? '', href = element.getAttribute('href');
    return href && label !== href ? `${label} (${href})` : label;
  }
  if (element.tagName === 'OL' || element.tagName === 'UL') {
    let ordinal = Number(element.getAttribute('start') ?? 1);
    return Array.from(element.children).map(item => {
      if (item.hasAttribute('value')) ordinal = Number(item.getAttribute('value'));
      const marker = element.tagName === 'OL' ? `${ordinal++}.` : '-';
      const body = Array.from(item.childNodes).map(child => child.nodeType === 1
        && ['UL', 'OL'].includes((child as Element).tagName)
        ? `\n${readableText(child, `${indent}  `)}` : readableText(child)).join('');
      return `${indent}${marker} ${body}`;
    }).join('\n');
  }
  const children = Array.from(element.childNodes);
  const isBlock = (child: Node): boolean => child.nodeType === 1
    && ['DIV', 'SECTION', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'UL', 'OL'].includes((child as Element).tagName);
  if (!children.some(isBlock)) return children.map(child => readableText(child, indent)).join('');
  const blocks: string[] = []; let inline = '';
  const flush = () => { if (inline.trim()) blocks.push(inline.replace(/^\n+|\n+$/gu, '')); inline = ''; };
  for (const child of children) {
    if (isBlock(child)) {
      flush(); blocks.push(readableText(child, indent));
    } else inline += readableText(child, indent);
  }
  flush(); return blocks.join('\n\n');
};

/** Clipboard HTML is pasted outside Chat's stylesheet. Carry soft breaks as
 * markup, and preserve authored spacing without changing literal code. */
const preservePasteWhitespace = (element: HTMLElement, root: HTMLElement, blocks: boolean): void => {
  if (element.tagName === 'PRE' || element.tagName === 'CODE') return;
  if (element === root) element.style.whiteSpace = blocks ? 'normal' : 'pre-wrap';
  else if (element.tagName === 'P' || element.tagName === 'LI') element.style.whiteSpace = 'pre-wrap';
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 1) preservePasteWhitespace(child as HTMLElement, root, blocks);
    else if (child.nodeType === 3 && /[\r\n]/u.test(child.textContent ?? '')) {
      const value = child.textContent ?? '';
      if (element === root && blocks && !value.trim()) continue;
      const fragment = element.ownerDocument.createDocumentFragment();
      value.split(/\r\n?|\n/gu).forEach((line, index) => {
        if (index) fragment.appendChild(element.ownerDocument.createElement('br'));
        fragment.appendChild(element.ownerDocument.createTextNode(line));
      });
      element.replaceChild(fragment, child);
    }
  }
};

const clipboardContent = (doc: Document, target: Target): { text: string; html: string } => {
  const body = doc.createElement('div');
  renderAnswerText(doc, body, target.message.content, target.message.source_citations);
  const blocks = body.getAttribute('data-chat-answer-formatted') === 'blocks';
  for (const box of Array.from(body.querySelectorAll(`[${ANSWER_CODE_BLOCK_ATTR}]`))) {
    const pre = box.querySelector('pre'); if (pre) box.replaceWith(pre);
  }
  body.querySelectorAll(`[${ANSWER_CODE_STATUS_ATTR}]`).forEach(element => element.remove());
  const sources = buildAnswerSources(doc, { ...target.message, role: 'assistant' }, target.sessionId);
  if (sources) {
    // Include the displayed source scope and read time, without copying the
    // disclosure's controls or duplicating its labels.
    const details = sources.querySelector('details');
    const provenance = Array.from(details?.querySelectorAll('small') ?? []);
    sources.querySelectorAll('li').forEach((item, index) => {
      if (provenance[index]) item.appendChild(provenance[index]!.cloneNode(true));
    });
    details?.remove(); body.appendChild(sources);
  }
  let base: URL | undefined;
  try {
    const url = new URL(doc.defaultView?.location.href ?? '');
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      url.username = ''; url.password = ''; url.search = ''; url.hash = ''; base = url;
    }
  } catch { /* Relative source links still identify the original workspace. */ }
  for (const element of [body, ...Array.from(body.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      if (!(element.tagName === 'A' && attribute.name === 'href')
        && !(element.tagName === 'OL' && attribute.name === 'start')
        && !(element.tagName === 'LI' && attribute.name === 'value')) element.removeAttribute(attribute.name);
    }
    if (element.tagName === 'A' && base) element.setAttribute('href', new URL(element.getAttribute('href')!, base).href);
  }
  const text = readableText(body);
  preservePasteWhitespace(body, body, blocks);
  return { text, html: body.outerHTML };
};

/** Clipboard writes belong to one retained answer snapshot. A route repaint,
 * another conversation or a later clipboard reply cannot change that snapshot. */
export const createAnswerCopy = (doc: Document, root: HTMLElement) => {
  const targets = new WeakMap<HTMLButtonElement, Target>();
  const copies = new Map<string, CopyState>();
  let disposed = false;
  const paint = (button: HTMLButtonElement, target: Target, announce = false): void => {
    const state = copies.get(button.getAttribute(ANSWER_COPY_ATTR)!);
    const pending = state?.phase === 'pending', same = state?.version === target.version;
    const copied = state?.phase === 'copied' && same;
    button.textContent = pending ? 'Copying…' : copied ? 'Copied' : 'Copy answer';
    button.setAttribute('aria-disabled', String(pending)); button.setAttribute('aria-busy', String(pending));
    const status = button.parentElement?.querySelector<HTMLElement>('[role="status"]');
    if (!status) return;
    status.setAttribute('aria-live', announce ? 'polite' : 'off');
    status.textContent = !state || pending ? '' : !same ? 'The answer changed while copying. Copy again for the current text.'
      : state.phase === 'failed' ? 'Could not copy this answer. You can select and copy its text.'
      : state.plain ? 'Answer copied as text.' : 'Answer copied.';
    if (copied) status.setAttribute('data-copy-quiet', ''); else status.removeAttribute('data-copy-quiet');
  };
  const repaint = (announce?: string): void => {
    if (disposed) return;
    const visible = new Set<string>();
    for (const button of Array.from(root.querySelectorAll?.<HTMLButtonElement>(`[${ANSWER_COPY_ATTR}]`) ?? [])) {
      const target = targets.get(button); if (!target) continue;
      const key = button.getAttribute(ANSWER_COPY_ATTR)!; visible.add(key); paint(button, target, key === announce);
    }
    for (const [key, state] of copies) if (!visible.has(key) && state.phase !== 'pending') copies.delete(key);
  };
  const click = (event: Event): void => {
    const button = (event.target as Element | null)?.closest?.<HTMLButtonElement>(`[${ANSWER_COPY_ATTR}]`);
    if (!button || disposed || !root.contains(button)) return;
    const target = targets.get(button), key = button.getAttribute(ANSWER_COPY_ATTR)!;
    if (!target || copies.get(key)?.phase === 'pending') return;
    const operation: CopyState = { version: target.version, phase: 'pending', plain: false };
    copies.set(key, operation); repaint();
    void (async () => {
      try {
        const content = clipboardContent(doc, target), view = doc.defaultView, clipboard = view?.navigator.clipboard;
        const Item = view?.ClipboardItem;
        if (clipboard?.write && Item && (typeof Item.supports !== 'function' || Item.supports('text/html'))) {
          try {
            await clipboard.write([new Item({ 'text/html': new Blob([content.html], { type: 'text/html' }),
              'text/plain': new Blob([content.text], { type: 'text/plain' }) })]);
          } catch (error) {
            if (!(error instanceof Error) || !['NotSupportedError', 'DataError'].includes(error.name) || !clipboard.writeText) throw error;
            operation.plain = true; await clipboard.writeText(content.text);
          }
        } else {
          if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
          operation.plain = true; await clipboard.writeText(content.text);
        }
        if (disposed || copies.get(key) !== operation) return;
        operation.phase = 'copied'; repaint(key);
      } catch {
        if (disposed || copies.get(key) !== operation) return;
        operation.phase = 'failed'; repaint(key);
      }
    })();
  };
  root.addEventListener('click', click);
  return {
    append(row: HTMLElement, message: Answer, sessionId?: string): void {
      const key = JSON.stringify([sessionId ?? '', message.id]);
      const sources = chatSourceCitationsOf(message.source_citations);
      const snapshot = { id: message.id, content: message.content, source_citations: sources };
      const target = { message: snapshot, sessionId, version: JSON.stringify([snapshot.content, sources]) };
      const actions = doc.createElement('div'); actions.className = 'chat-answer-actions'; actions.setAttribute(ACTIONS, '');
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'chat-answer-copy';
      button.setAttribute(ANSWER_COPY_ATTR, key); button.setAttribute(ANSWER_CONTROL_ATTR, JSON.stringify([key, 'answer-copy']));
      button.setAttribute('aria-label', 'Copy answer'); button.title = 'Copy this answer and its source links';
      const status = doc.createElement('span'); status.setAttribute('role', 'status'); status.setAttribute('aria-atomic', 'true');
      actions.appendChild(button); actions.appendChild(status); row.appendChild(actions); targets.set(button, target); paint(button, target);
    },
    repaint,
    dispose(): void { disposed = true; copies.clear(); root.removeEventListener?.('click', click); },
  };
};

export const ANSWER_COPY_STYLES = `
.chat-answer-actions { display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; margin-top:8px; font-size:12px; color:var(--muted); }
.chat-answer-copy { font:inherit; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:6px; min-height:36px; padding:4px 10px; cursor:pointer; }
.chat-answer-copy:hover { border-color:var(--accent); }
.chat-answer-copy:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.chat-answer-copy[aria-disabled=true] { cursor:wait; opacity:.65; }
.chat-answer-actions [data-copy-quiet] { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
@media (max-width:640px), (pointer:coarse) { .chat-answer-copy { min-height:44px; } }
`;
