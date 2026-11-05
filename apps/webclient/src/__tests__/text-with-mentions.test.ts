/** D-338 §11 — a notice's text with the names it links: each name, in order, a link to where
 *  its record opens; the rest text; never parsed as markup. */
import { describe, expect, it } from 'vitest';
import { safeMentions, setTextWithMentions } from '../shell/text-with-mentions.js';
import { situationRefHref } from '../data/situation-ref-href.js';

/** A node with the DOM's own semantics where they matter: setting `textContent` clears children. */
class FakeNode {
  children: FakeNode[] = []; attrs: Record<string, string> = {}; private value: string;
  constructor(readonly tag: string, text = '') { this.value = text; }
  get textContent(): string { return this.value; }
  set textContent(value: string) { this.value = value; this.children = []; }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; }
  appendChild(child: FakeNode): FakeNode { this.children.push(child); return child; }
}
const fakeDocument = { createElement: (tag: string) => new FakeNode(tag), createTextNode: (text: string) => new FakeNode('#text', text) };
const target = () => new FakeNode('p');
const shown = (element: FakeNode): string => element.textContent + element.children.map(child => child.textContent).join('');
const mention = (text: string, id: string) => ({ text, ref: { collection: 'contact', id } });

describe('D-338 setTextWithMentions', () => {
  it('links each name in order, and keeps everything else as text', () => {
    const element = target();
    setTextWithMentions(fakeDocument as never, element as never, 'Birthdays: Ann Lee and Bo Ng\nAll day · Reminder in Yours',
      [mention('Ann Lee', 'c-ann'), mention('Bo Ng', 'c-bo')], situationRefHref);
    expect(element.children.map(child => [child.tag, child.textContent, child.attrs.href ?? null])).toEqual([
      ['#text', 'Birthdays: ', null], ['a', 'Ann Lee', '#data/contact/c-ann'], ['#text', ' and ', null], ['a', 'Bo Ng', '#data/contact/c-bo'],
      ['#text', '\nAll day · Reminder in Yours', null]]);
    expect(shown(element)).toBe('Birthdays: Ann Lee and Bo Ng\nAll day · Reminder in Yours');
  });

  it('passes over a name the text does not hold, and sets plain text when none is held', () => {
    const element = target();
    setTextWithMentions(fakeDocument as never, element as never, 'Birthday: Ann Lee', [mention('Zed Q', 'c-zed'), mention('Ann Lee', 'c-ann')], situationRefHref);
    expect(element.children.filter(child => child.tag === 'a').map(child => child.textContent)).toEqual(['Ann Lee']);
    const plain = target();
    setTextWithMentions(fakeDocument as never, plain as never, 'Birthday: Ann Lee', [mention('Zed Q', 'c-zed')], situationRefHref);
    expect(plain.children).toEqual([]);
    expect(plain.textContent).toBe('Birthday: Ann Lee');
  });

  it('never reads a name as markup', () => {
    const element = target();
    setTextWithMentions(fakeDocument as never, element as never, 'Birthday: <b>Ann</b>', [mention('<b>Ann</b>', 'c-ann')], situationRefHref);
    expect(element.children.find(child => child.tag === 'a')?.textContent).toBe('<b>Ann</b>');
  });

  it('keeps only well-formed mentions', () => {
    expect(safeMentions(undefined)).toBeUndefined();
    expect(safeMentions('Ann')).toBeUndefined();
    expect(safeMentions([{ text: 'Ann', ref: { collection: 'contact', id: 'c-ann' } }, { text: 'Bo', ref: { collection: 'Bad Kind', id: 'c' } },
      { text: 42, ref: { collection: 'contact', id: 'c' } }, { text: 'Cy', ref: { collection: 'contact', id: '' } }]))
      .toEqual([{ text: 'Ann', ref: { collection: 'contact', id: 'c-ann' } }]);
  });
});
