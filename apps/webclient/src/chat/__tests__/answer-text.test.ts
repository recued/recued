import type { ChatSourceCitation } from '@recued/contracts';
import { describe, expect, it } from 'vitest';
import { answerTextSegments, renderAnswerText } from '../answer-text.js';

/** Enough DOM to tell elements from text: tags, attributes, children. */
interface FakeNode {
  tagName: string;
  attributes: Map<string, string>;
  children: FakeNode[];
  textContent: string;
  readonly firstChild: FakeNode | null;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeNode): FakeNode;
  removeChild(child: FakeNode): FakeNode;
}

const makeNode = (tagName: string, text = ''): FakeNode => {
  let ownText = text;
  const node: FakeNode = {
    tagName,
    attributes: new Map(),
    children: [],
    get textContent() { return ownText + node.children.map(child => child.textContent).join(''); },
    set textContent(value: string) { ownText = value; node.children = []; },
    get firstChild() { return node.children[0] ?? null; },
    setAttribute: (name, value) => { node.attributes.set(name, value); },
    getAttribute: (name) => node.attributes.get(name) ?? null,
    appendChild: (child) => { node.children.push(child); return child; },
    removeChild: (child) => { node.children.splice(node.children.indexOf(child), 1); return child; },
  };
  return node;
};

const doc = {
  createElement: (tag: string) => makeNode(tag.toUpperCase()),
  createTextNode: (text: string) => makeNode('#text', text),
} as unknown as Document;

const paint = (text: string, sources: readonly ChatSourceCitation[] = []): FakeNode => {
  const host = makeNode('DIV');
  renderAnswerText(doc, host as unknown as HTMLElement, text, sources);
  return host;
};

/** What a reader sees, and which parts are links. */
const shape = (host: FakeNode): Array<{ text: string } | { link: string; href: string | null; children: number }> => {
  if (host.tagName === 'A') return [{ link: host.textContent, href: host.getAttribute('href'), children: host.children.length }];
  return host.children.length === 0 ? [{ text: host.textContent }] : host.children.flatMap(shape);
};
const descendants = (host: FakeNode, tag: string): FakeNode[] =>
  host.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...descendants(child, tag)]);

const record = '#data/mail/record/work/mail%3Aseed%2F%28v2%29';

describe('Chat answer citations', () => {
  it('links a citation to the exact record address, with its label as text', () => {
    expect(shape(paint(`The client asked [for a revised offer](${record}).`))).toEqual([
      { text: 'The client asked ' },
      { link: 'for a revised offer', href: record, children: 0 },
      { text: '.' },
    ]);
  });

  it('preserves calendar and file record links', () => {
    const calendar = '#data/calendar/record/work/event-1';
    const file = '#data/files/record/received/file-9';
    expect(answerTextSegments(`[Meeting](${calendar}) and [offer](${file})`)).toEqual([
      { kind: 'link', label: 'Meeting', href: calendar },
      { kind: 'text', text: ' and ' },
      { kind: 'link', label: 'offer', href: file },
    ]);
  });

  it.each([
    ['a script URL', '[open](javascript:alert(1))'],
    ['an external URL', '[offer](https://example.com/offer)'],
    ['a protocol-relative URL', '[offer](//example.com/offer)'],
    ['another in-app route', '[settings](#settings/ai-models)'],
    ['a record address missing its record', '[mail](#data/mail/record/work)'],
    ['an unknown Data tab', '[contact](#data/contact/record/work/c-1)'],
    ['an unclosed target', `[mail](${record}`],
    ['an empty label', `[ ](${record})`],
    ['nested brackets', `[see [1]](${record})`],
    ['an escaped bracket', `\\[mail](${record})`],
    ['a target with a space', '[mail](#data/mail/record/work/a b)'],
    ['a target with quotes', '[mail](#data/mail/record/work/a"onclick="x)'],
  ])('keeps %s as literal text', (_case, text) => {
    expect(answerTextSegments(text).every((segment) => segment.kind === 'text')).toBe(true);
    expect(shape(paint(text))).toEqual([{ text }]);
  });

  it('shows markup inside a label as text, never as elements', () => {
    const label = '<img src=x onerror=alert(1)>';
    const host = paint(`[${label}](${record})`);
    expect(shape(host)).toEqual([{ link: label, href: record, children: 0 }]);
  });

  it('keeps unsupported syntax literal inside separate prose paragraphs', () => {
    const text = 'No citation here.\n\n[Draft] (not a link) and #data/mail/record/work/x';
    const host = paint(text);
    expect(descendants(host, 'P').map(node => node.textContent)).toEqual(text.split('\n\n'));
    expect(descendants(host, 'A')).toEqual([]);
  });

  it('replaces what a previous paint left', () => {
    const host = paint(`[first](${record})`);
    renderAnswerText(doc, host as unknown as HTMLElement, `[second](${record}) and more`);
    expect(shape(host)).toEqual([
      { link: 'second', href: record, children: 0 },
      { text: ' and more' },
    ]);
  });
});

it('renders headings and bold as text-only emphasis beside a safe citation', () => {
  const host = paint(`## Current work\n**Private preparation** and [source](${record}).`);
  expect(descendants(host, 'H4').map(node => node.textContent)).toEqual(['Current work']);
  expect(descendants(host, 'STRONG').map(node => node.textContent)).toEqual(['Private preparation']);
  expect(descendants(host, 'A')[0]?.getAttribute('href')).toBe(record);
});

it('never executes HTML inside emphasis and leaves code notation literal', () => {
  const emphasis = paint('**<img src=x onerror=alert(1)>**');
  expect(descendants(emphasis, 'STRONG')[0]?.textContent).toBe('<img src=x onerror=alert(1)>');
  expect(descendants(emphasis, 'IMG')).toHaveLength(0);
  const code = '```md\n## Heading\n**bold**\n```';
  expect(descendants(paint(code), 'CODE').map(node => node.textContent)).toEqual(['## Heading\n**bold**\n']);
  expect(paint('\\**literal**').children.map(n => n.tagName)).not.toContain('STRONG');
});

it('formats prose around inline code without interpreting its contents', () => {
  const host = paint(`## Current work\n\n**Run** \`npm test\` then [check](${record}).`);
  expect(descendants(host, 'H4')).toHaveLength(1);
  expect(descendants(host, 'STRONG').map(node => node.textContent)).toEqual(['Run']);
  expect(descendants(host, 'CODE').map(node => node.textContent)).toEqual(['npm test']);
  expect(descendants(host, 'A')[0]?.getAttribute('href')).toBe(record);
  const literal = `[example](${record}) **raw** <img src=x onerror=alert(1)>`;
  const code = paint(`Before \`\`${literal} with a \` tick\`\` **after**.`);
  expect(descendants(code, 'CODE')[0]?.textContent).toBe(`${literal} with a \` tick`);
  expect(descendants(code, 'A')).toHaveLength(0);
  expect(descendants(code, 'IMG')).toHaveLength(0);
  expect(descendants(code, 'STRONG').map(node => node.textContent)).toEqual(['after']);
});

it('keeps fenced code literal with exact newlines and a matching-length closing fence', () => {
  const raw = `[source](${record})\r\n\`\`\`\r\n**raw** <script>no()</script>\r\n`;
  const host = paint(`\`\`\`\`md\r\n${raw}\`\`\`\`\r\n\n**Outside**`);
  expect(descendants(host, 'PRE')).toHaveLength(1);
  expect(descendants(host, 'CODE')[0]?.textContent).toBe(raw);
  expect(descendants(host, 'A')).toHaveLength(0);
  expect(descendants(host, 'SCRIPT')).toHaveLength(0);
  expect(descendants(host, 'STRONG').map(node => node.textContent)).toEqual(['Outside']);
});

it('keeps a streamed fence literal before closure and formats the following prose when it closes', () => {
  const host = makeNode('DIV');
  const prefix = `## Answer\n\n~~~text\n[source](${record})\n**raw**`;
  renderAnswerText(doc, host as unknown as HTMLElement, prefix);
  expect(descendants(host, 'CODE')[0]?.textContent).toBe(`[source](${record})\n**raw**`);
  expect(descendants(host, 'A')).toHaveLength(0);
  renderAnswerText(doc, host as unknown as HTMLElement, `${prefix}\n~~~\n\n**Ready** [source](${record})`);
  expect(descendants(host, 'CODE')[0]?.textContent).toBe(`[source](${record})\n**raw**\n`);
  expect(descendants(host, 'STRONG').map(node => node.textContent)).toEqual(['Ready']);
  expect(descendants(host, 'A')).toHaveLength(1);
  renderAnswerText(doc, host as unknown as HTMLElement, 'Replaced with ordinary text.');
  expect(descendants(host, 'PRE')).toHaveLength(0);
  expect(host.textContent).toBe('Replaced with ordinary text.');
});

it('does not activate a source in an unfinished inline code span', () => {
  const host = paint(`**Before** \`[source](${record}) **still literal**`);
  expect(descendants(host, 'A')).toHaveLength(0);
  expect(descendants(host, 'STRONG').map(node => node.textContent)).toEqual(['Before']);
  expect(host.textContent).toContain(`\`[source](${record}) **still literal**`);
});

it('keeps unsupported links literal even when their labels and targets contain code or emphasis', () => {
  const text = '[**offer** `raw`](https://example.com/(v2)/**path**)';
  const host = paint(text);
  expect(host.textContent).toBe(text);
  expect(descendants(host, 'A')).toHaveLength(0);
  expect(descendants(host, 'STRONG')).toHaveLength(0);
  expect(descendants(host, 'CODE')).toHaveLength(0);
});

it('renders ordered and nested unordered lists while preserving explicit item numbers', () => {
  const host = paint('4. **First**\n6. Next\n\n- Parent\n  - Child with `value`\n- [ ] Still a text task');
  expect(descendants(host, 'OL')[0]?.getAttribute('start')).toBe('4');
  expect(descendants(host, 'LI').slice(0, 2).map(node => node.getAttribute('value'))).toEqual(['4', '6']);
  expect(descendants(host, 'UL')).toHaveLength(2);
  expect(descendants(host, 'LI').some(node => node.textContent === '[ ] Still a text task')).toBe(true);
  expect(descendants(host, 'CODE')[0]?.textContent).toBe('value');
  expect(descendants(host, 'INPUT')).toHaveLength(0);
});

it('keeps continuation text in its original position between nested lists', () => {
  const parts = ['Parent', 'Child', 'Parent afterward', 'Another child', 'Finish parent'];
  const host = paint('- Parent\n  - Child\n  Parent afterward\n  - Another child\n  Finish parent');
  const positions = parts.map(part => host.textContent.indexOf(part));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(descendants(host, 'UL')).toHaveLength(3);
});

const source: ChatSourceCitation = { kind: 'asset', id: `src_${'a'.repeat(24)}`, asset_id: 'asset:a/with(parenthesis)',
  label: 'Saved hose', read_at: 1000, read_version: 'b'.repeat(64) };
const documentSource: ChatSourceCitation = { kind: 'file', id: `src_${'c'.repeat(24)}`, file_ref: `file:${'1'.repeat(32)}`,
  collection_slug: 'received', label: 'Note.txt', read_at: 1001, read_version: 'd'.repeat(64) };

it('builds asset and file links only from this answer’s typed source catalog', () => {
  expect(answerTextSegments(`[hose](#source/${source.id}) and [note](#source/${documentSource.id})`, [source, documentSource])).toEqual([
    { kind: 'link', label: 'hose', href: '#yours/asset/asset%3Aa%2Fwith(parenthesis)' },
    { kind: 'text', text: ' and ' },
    { kind: 'link', label: 'note', href: '#data/files/record/received/file%3A11111111111111111111111111111111' },
  ]);
  for (const prose of [`[unknown](#source/src_${'e'.repeat(24)})`, '[guessed](#yours/asset/asset%3Aa)',
    `[unsupported](#source/${source.id}/extra)`]) {
    expect(answerTextSegments(prose, [source]).every(s => s.kind === 'text')).toBe(true);
  }
  expect(answerTextSegments(`[uncited](#source/${source.id})`)).toEqual([{ kind: 'text', text: `[uncited](#source/${source.id})` }]);
});

it('never treats a catalog label or extra href as HTML or a destination', () => {
  const label = '<img src=x onerror=alert(1)>';
  const host = paint(`[${label}](#source/${source.id})`, [{ ...source, href: 'javascript:alert(1)' } as ChatSourceCitation]);
  expect(shape(host)).toEqual([{ link: label, href: '#yours/asset/asset%3Aa%2Fwith(parenthesis)', children: 0 }]);
});
