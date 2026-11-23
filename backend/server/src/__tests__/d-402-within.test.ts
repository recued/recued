/** D-402 slice G (§4.1) — an element named by the row it sits in (`within`): the step's grammar, the row
 *  each control of a read sits in, the row's own texts the compiler names it by, and a checkbox told
 *  apart from others of its name by what it sends. */
import { describe, expect, it } from 'vitest';
import { bridgeRunsCommand, parseBrowserActSteps } from '@recued/contracts';

import { rowTextsForRef, rowsShowing, selectorForRef } from '../bridges/html-selector.js';
import { outlinePage } from '../bridges/page-outline.js';

const INBOX = '<ul id="mails">'
  + '<li><span class="from">Ada</span> — <span class="subject">Lunch on Friday?</span> <button ref="e1">Delete</button></li>'
  + '<li><span class="from">Bob</span> — <span class="subject">Invoice 1043 for October</span> <button ref="e2">Delete</button></li>'
  + '<li><span class="from">Cy</span> — <span class="subject">Your parcel is on its way</span> <button ref="e3">Delete</button></li></ul>';

describe('D-402 slice G — within, in a step', () => {
  it('a click or typing named by its text takes the row it sits in, by one text or up to five', () => {
    const parsed = parseBrowserActSteps([{ do: 'click', text: 'Delete', role: 'button', within: { text: ['Bob', 'Invoice 1043'] } },
      { do: 'type', text: 'Quantity', within: { text: 'Brass lamp' }, value: '2' }], { page: 'bridge:work:3:D1' });
    expect(parsed).toMatchObject({ ok: true, steps: [
      { do: 'click', text: 'Delete', role: 'button', within: { text: ['Bob', 'Invoice 1043'] } },
      { do: 'type', text: 'Quantity', within: { text: ['Brass lamp'] }, value: '2' }] });
  });

  it('refuses it on another step, beside a ref or a selector, and with no text or too many', () => {
    const refused = (step: Record<string, unknown>) => {
      const parsed = parseBrowserActSteps([step], { page: 'bridge:work:3:D1' });
      return parsed.ok ? '' : parsed.error;
    };
    expect(refused({ do: 'press', text: 'Search', key: 'Enter', within: { text: ['Bob'] } })).toContain('a press step takes');
    expect(refused({ do: 'click', ref: 'e2', within: { text: ['Bob'] } })).toContain('name it by text (and role), not by ref or selector');
    expect(refused({ do: 'click', selector: '#delete', within: { text: ['Bob'] } })).toContain('not by ref or selector');
    expect(refused({ do: 'click', text: 'Delete', within: { text: [] } })).toContain('within.text is one text, or up to 5');
    expect(refused({ do: 'click', text: 'Delete', within: { text: ['a', 'b', 'c', 'd', 'e', 'f'] } })).toContain('up to 5');
    expect(refused({ do: 'click', text: 'Delete', within: 'Bob' })).toContain('within names the item the element sits in');
  });

  it('needs a Bridge that checks the row at the step (`row_checks`), for a click or typing only', () => {
    const profile = { supported_actions: ['click', 'fill', 'submit', 'describe', 'inspect'] };
    expect(bridgeRunsCommand(profile, 'click', { ref: 'e2', within: ['Bob'] })).toBe(false);
    expect(bridgeRunsCommand({ ...profile, row_checks: true }, 'click', { ref: 'e2', within: ['Bob'] })).toBe(true);
    expect(bridgeRunsCommand({ ...profile, row_checks: true }, 'fill', { ref: 'e2', within: ['Bob'], value: '2' })).toBe(true);
    expect(bridgeRunsCommand(profile, 'click', { ref: 'e2' })).toBe(true);
  });
});

describe('D-402 slice G — the row a control sits in, read on the server', () => {
  it('each control of a read carries what its row shows, as the Bridge finds the row', () => {
    const outline = outlinePage(`<body>${INBOX}<p><a ref="e9" href="/help">Help</a></p></body>`, { url: 'https://mail.example.com/inbox' });
    expect(outline.controls.find((control) => control.ref === 'e2')?.item).toBe('Bob — Invoice 1043 for October Delete');
    expect(outline.controls.find((control) => control.ref === 'e9')?.item).toBeUndefined();
  });

  it('the compiler names a row by its own texts beside the element, found alone in the read', () => {
    expect(rowTextsForRef(INBOX, 'e2')).toEqual(['Bob', 'Invoice 1043 for October']);
    expect(rowsShowing(INBOX, ['Bob', 'Invoice 1043 for October'], 'Delete')).toBe(1);
    expect(rowsShowing(INBOX, ['Delete'], 'Delete')).toBe(3);
    expect(rowTextsForRef('<p><button ref="e1">Go</button></p>', 'e1')).toBeUndefined();
  });

  it('a checkbox among others of its name, by what it sends (Bridge 0.0.13 keeps the value)', () => {
    const boxes = [1, 2, 3].map((n) => `<input type="checkbox" name="checkboxes[]" value="cb${String(n)}" ref="e${String(n)}"> Checkbox ${String(n)}`).join('');
    expect(selectorForRef(`<form>${boxes}</form>`, 'e2')).toBe('input[name="checkboxes[]"][value="cb2"]');
  });
});
