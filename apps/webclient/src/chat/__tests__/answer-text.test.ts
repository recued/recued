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
  const node: FakeNode = {
    tagName,
    attributes: new Map(),
    children: [],
    textContent: text,
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

const paint = (text: string): FakeNode => {
  const host = makeNode('DIV');
  renderAnswerText(doc, host as unknown as HTMLElement, text);
  return host;
};

/** What a reader sees, and which parts are links. */
const shape = (host: FakeNode) => host.children.length === 0
  ? [{ text: host.textContent }]
  : host.children.map((child) => child.tagName === 'A'
    ? { link: child.textContent, href: child.getAttribute('href'), children: child.children.length }
    : { text: child.textContent });

const record = '#data/mail/record/work/mail%3Aseed%2F%28v2%29';

describe('Chat answer citations', () => {
  it('links a citation to the exact record address, with its label as text', () => {
    expect(shape(paint(`The client asked [for a revised offer](${record}).`))).toEqual([
      { text: 'The client asked ' },
      { link: 'for a revised offer', href: record, children: 0 },
      { text: '.' },
    ]);
  });

  it('links calendar and file records, and several citations in one answer', () => {
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

  it('leaves an answer without citations exactly as it was painted before', () => {
    const text = 'No citation here.\n\n[Draft] (not a link) and #data/mail/record/work/x';
    const host = paint(text);
    expect(host.children).toEqual([]);
    expect(host.textContent).toBe(text);
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
