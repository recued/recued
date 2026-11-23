/** D-402 (2026-11-21, task P) — an element named by the card it sits in (`within.card`): the step's grammar,
 *  the Bridge it needs (`card_rows`), the cards each control of a read sits in, and the card the compiler
 *  names it by, when no list item, table row, article or row by its role holds it. */
import { describe, expect, it } from 'vitest';
import { bridgeRunsCommand, parseBrowserActSteps } from '@recued/contracts';

import { cardsForRef, rowsShowing } from '../bridges/html-selector.js';
import { cardKindOf, isOfCardKind, outlinePage, parseInspectHtml } from '../bridges/page-outline.js';

/** P's notes, as the Bridge reads them: each note a card in a column, its buttons in its footer by its date. */
const card = (title: string, description: string, refs: [string, string]) => '<div class="col-md-6"><div data-testid="note-card" class="card">'
  + `<div class="card-header" data-testid="note-card-title">${title}</div>`
  + `<div class="card-body"><p data-testid="note-card-description">${description}</p></div>`
  + `<div class="card-footer"><div class="d-flex"><button data-testid="note-view" ref="${refs[0]}">View</button>`
  + `<button data-testid="note-edit" ref="${refs[1]}">Edit</button></div><p>21-11-2026</p></div></div></div>`;
const NOTES = `<main><h1>MyNotes</h1><div class="row">${card('Bench stock review', 'Count the adapters in stock.', ['e24', 'e25'])}`
  + `${card('Grocery list', 'Milk, eggs.', ['e28', 'e29'])}</div><p><a ref="e9" href="/help">Help</a></p></main>`;
const KIND = 'div[data-testid="note-card"]';

describe('within.card, in a step and on the Bridge', () => {
  it('a click or typing named by its text takes the card it sits in, by a tag with its test id or classes', () => {
    const parsed = parseBrowserActSteps([{ do: 'click', text: 'Edit', role: 'button', within: { text: ['Bench stock review'], card: KIND } },
      { do: 'type', text: 'Quantity', within: { text: 'Brass lamp', card: 'li.result.item' }, value: '2' }], { page: 'bridge:work:3:D1' });
    expect(parsed).toMatchObject({ ok: true, steps: [
      { do: 'click', within: { text: ['Bench stock review'], card: KIND } },
      { do: 'type', within: { text: ['Brass lamp'], card: 'li.result.item' } }] });
  });

  it('refuses a card named any other way: the Bridge matches it with closest()', () => {
    const refused = (card: unknown) => {
      const parsed = parseBrowserActSteps([{ do: 'click', text: 'Edit', within: { text: ['Bench stock review'], card } }], { page: 'bridge:work:3:D1' });
      return parsed.ok ? '' : parsed.error;
    };
    for (const card of ['div', '.card', 'div > p', 'div[data-id="x"]', 'div.a.b.c.d', 'div:has(p)', 'div[data-testid="x"], a', 3]) {
      expect(refused(card), String(card)).toContain('within.card names the kind of card the item is');
    }
  });

  it('needs a Bridge that checks the card at the step (`card_rows`): one that checks rows alone finds no row there', () => {
    const profile = { supported_actions: ['click', 'fill', 'submit', 'describe', 'inspect'], row_checks: true };
    expect(bridgeRunsCommand(profile, 'click', { ref: 'e25', within: ['Bench stock review'], within_card: KIND })).toBe(false);
    expect(bridgeRunsCommand({ ...profile, card_rows: true }, 'click', { ref: 'e25', within: ['Bench stock review'], within_card: KIND })).toBe(true);
    // A row as before needs no more.
    expect(bridgeRunsCommand(profile, 'click', { ref: 'e2', within: ['Bob'] })).toBe(true);
  });
});

describe('the cards a control sits in, read on the server', () => {
  it('a card\'s kind is its tag with its test id, else with its readable classes; it matches as closest() does', () => {
    const [main] = parseInspectHtml(NOTES).children.filter((node) => node.kind === 'element') as Array<Parameters<typeof cardKindOf>[0]>;
    const all = (function walk(el: Parameters<typeof cardKindOf>[0]): Array<Parameters<typeof cardKindOf>[0]> {
      return [el, ...el.children.flatMap((child) => child.kind === 'element' ? walk(child) : [])];
    })(main!);
    expect(new Set(all.map(cardKindOf).filter(Boolean))).toEqual(new Set([KIND, 'div.row', 'div.col-md-6', 'div[data-testid="note-card-title"]',
      'div.card-body', 'p[data-testid="note-card-description"]', 'div.card-footer', 'div.d-flex', 'button[data-testid="note-view"]',
      'button[data-testid="note-edit"]']));
    expect(all.filter((el) => isOfCardKind(el, KIND))).toHaveLength(2);
    // Classes as a subset, as a selector reads them: the note cards carry `card` too.
    expect(all.filter((el) => isOfCardKind(el, 'div.card'))).toHaveLength(2);
    expect(all.filter((el) => isOfCardKind(el, 'div.card.missing'))).toHaveLength(0);
    expect(all.filter((el) => el.tag === 'div' && isOfCardKind(el, 'div.col-md-6'))).toHaveLength(2);
  });

  it('each control no row holds carries what the nearest card of each kind above it shows', () => {
    const outline = outlinePage(`<body>${NOTES}</body>`, { url: 'https://practice.expandtesting.com/notes/app' });
    const edit = outline.controls.find((control) => control.ref === 'e25');
    expect(edit?.item).toBeUndefined();
    expect(edit?.cards?.[KIND]).toContain('Bench stock review');
    expect(edit?.cards?.[KIND]).not.toContain('Grocery list');
    expect(edit?.cards?.['div.card-footer']).toBe('View Edit 21-11-2026');
    expect(outline.controls.find((control) => control.ref === 'e29')?.cards?.[KIND]).toContain('Grocery list');
    // One of a kind the page shows once is no card; a link in no card has none.
    expect(edit?.cards?.['div.row']).toBeUndefined();
    expect(outline.controls.find((control) => control.ref === 'e9')?.cards).toBeUndefined();
  });

  it('the compiler reads each card above the element, nearest first, with its texts beside its controls', () => {
    expect(cardsForRef(NOTES, 'e25')).toEqual([
      { card: 'div.card-footer', texts: ['21-11-2026'] },
      { card: KIND, texts: ['Bench stock review', 'Count the adapters in stock.', '21-11-2026'] },
      { card: 'div.col-md-6', texts: ['Bench stock review', 'Count the adapters in stock.', '21-11-2026'] },
    ]);
    // The date both footers show picks out no one card; the title does.
    expect(rowsShowing(NOTES, ['21-11-2026'], 'Edit', 'div.card-footer')).toBe(2);
    expect(rowsShowing(NOTES, ['Bench stock review'], 'Edit', KIND)).toBe(1);
    // In a row, the row is the item, as before.
    expect(cardsForRef('<ul><li class="x">Bob <button ref="e1">Delete</button></li><li class="x">Ada <button ref="e2">Delete</button></li></ul>', 'e1'))
      .toBeUndefined();
  });
});
