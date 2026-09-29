/** D-315 §4.5 — the type editor: a kind of email the owner makes, then grows. */

import { describe, expect, it, vi } from 'vitest';

import type { MailFactTypeSpec } from '@recued/contracts';

import { createMailFactTypeEditor, mailFactTypeIdOf, specFromTypeForm } from '../mail-fact-type-editor.js';

const FIELD = 'data-recued-mail-facts-field';
const FOCUS = 'data-recued-mail-facts-focus';
const ACTION = 'data-recued-data-action';

const el = (attrs: Record<string, string>, value = '', checked = false) =>
  ({ getAttribute: (name: string) => attrs[name] ?? null, value, checked }) as unknown as HTMLElement;

const wine: MailFactTypeSpec = {
  id: 'custom_wine_club_box',
  name: 'Wine club box',
  description: 'A box from the wine club.',
  variables: [
    { name: 'club', kind: 'text', required: true },
    { name: 'colour', kind: 'enum', required: false, values: ['red', 'white'] },
  ],
  states: ['shipped'],
  notices: [],
  identity: [['club']],
};

describe('a kind of email’s id', () => {
  it('is custom_ and its name in lower-case words, at most 40', () => {
    expect(mailFactTypeIdOf('Wine Club Box!')).toBe('custom_wine_club_box');
    expect(mailFactTypeIdOf('Café crème')).toBe('custom_cafe_creme');
    expect(mailFactTypeIdOf('  ')).toBe('custom_kind');
    expect(mailFactTypeIdOf('x'.repeat(60))).toBe(`custom_${'x'.repeat(40)}`);
  });
});

describe('the form as a type', () => {
  it('writes names as they are saved, drops empty rows, and one way to tell things apart', () => {
    const row = { values: '', description: '', locked: false };
    expect(specFromTypeForm({
      original: null,
      name: ' Wine club box ',
      description: '',
      variables: [
        { ...row, name: 'Box-ID', kind: 'id', required: true, identity: true },
        { ...row, name: 'colour', kind: 'enum', required: false, values: 'Red, white, , red', description: 'Its colour', identity: false },
        { ...row, name: ' ', kind: 'text', required: false, identity: true },
        // An attachment cannot tell one thing from another.
        { ...row, name: 'label', kind: 'file', required: false, identity: true },
      ],
      states: 'Shipped, out for delivery',
      notices: 'Price change!',
      dataFields: [{ path: 'Bottles', kind: 'list', description: '' }, { path: ' . ', kind: 'text', description: '' }, { path: 'Order. Gift note', kind: 'text', description: '' }],
    })).toEqual({
      id: 'custom_wine_club_box',
      name: 'Wine club box',
      description: '',
      variables: [
        { name: 'box_id', kind: 'id', required: true },
        { name: 'colour', kind: 'enum', required: false, values: ['red', 'white'], description: 'Its colour' },
        { name: 'label', kind: 'file', required: false },
      ],
      states: ['shipped', 'out_for_delivery'],
      notices: ['price_change'],
      identity: [['box_id']],
      data_fields: [{ path: 'bottles', kind: 'list' }, { path: 'order.gift_note', kind: 'text' }],
    });
  });

  it('keeps what a saved kind tells things apart by, whatever its rows say', () => {
    const form = { original: wine, name: wine.name, description: '', states: '', notices: '', dataFields: [] };
    const variables = wine.variables.map((variable) => ({
      name: variable.name, kind: variable.kind, required: variable.required, values: (variable.values ?? []).join(', '),
      description: '', identity: variable.name === 'colour', locked: true,
    }));
    expect(specFromTypeForm({ ...form, variables }).identity).toEqual([['club']]);
  });
});

describe('the editor', () => {
  const harness = (callers: Parameters<typeof createMailFactTypeEditor>[0]['callers']) => {
    const onSaved = vi.fn();
    const onCancelled = vi.fn();
    const render = vi.fn();
    const editor = createMailFactTypeEditor({
      callers, actionAttr: ACTION, fieldAttr: FIELD, focusAttr: FOCUS, render, focus: vi.fn(), onSaved, onCancelled,
    });
    const act = (action: string, attrs: Record<string, string> = {}) => editor.handleAction(action, el(attrs));
    return { editor, onSaved, onCancelled, render, act };
  };

  it('makes a new kind: its variables, what tells one from another, and saves it', async () => {
    const createType = vi.fn(async ({ spec }: { spec: MailFactTypeSpec }) => ({ type: spec }));
    const h = harness({ createType });
    h.editor.open(null);
    expect(h.editor.render()).toContain('A new kind of email');
    h.editor.handleInput(el({ [FIELD]: 'ty:name' }, 'Wine club box'));
    h.editor.handleInput(el({ [FIELD]: 'ty:var-name:0' }, 'club'));
    h.editor.handleChange(el({ [FIELD]: 'ty:var-name:0' }, 'club'));
    h.act('mail-facts-ty-var-add');
    h.editor.handleInput(el({ [FIELD]: 'ty:var-name:1' }, 'colour'));
    h.editor.handleChange(el({ [FIELD]: 'ty:var-kind:1' }, 'enum'));
    expect(h.editor.render()).toContain(`${FIELD}="ty:var-values:1"`);
    h.editor.handleInput(el({ [FIELD]: 'ty:var-values:1' }, 'red, white'));
    h.editor.handleChange(el({ [FIELD]: 'ty:var-identity:0' }, '', true));
    expect(h.editor.render()).toMatch(/ty:var-identity:0"[^>]*checked/);
    h.editor.handleInput(el({ [FIELD]: 'ty:states' }, 'shipped'));
    h.act('mail-facts-ty-save');
    await vi.waitFor(() => expect(h.onSaved).toHaveBeenCalled());
    expect(createType.mock.calls[0]![0].spec).toEqual({
      id: 'custom_wine_club_box',
      name: 'Wine club box',
      description: '',
      variables: [
        { name: 'club', kind: 'text', required: true },
        { name: 'colour', kind: 'enum', required: false, values: ['red', 'white'] },
      ],
      states: ['shipped'],
      notices: [],
      identity: [['club']],
      data_fields: [],
    });
    expect(h.editor.isOpen()).toBe(false);
  });

  it('grows a saved kind: its variables stay as they are, and what tells things apart is fixed', async () => {
    const updateType = vi.fn(async () => {
      throw Object.assign(new Error('The kind of email cannot be saved'), {
        code: 'bad_request',
        details: { problems: ["variable 'colour' keeps its value 'white': facts and triggers name it"] },
      });
    });
    const h = harness({ updateType });
    h.editor.open(wine);
    const html = h.editor.render();
    expect(html).toContain('Edit “Wine club box”');
    expect(html).toMatch(/ty:var-name:0"[^>]*disabled/);
    expect(html).toMatch(/ty:var-kind:0"[^>]*disabled/);
    expect(html).not.toContain('mail-facts-ty-var-remove" data-index="0"');
    expect(html).toContain('Its id is <code>custom_wine_club_box</code>');
    // What tells one apart is said, not offered.
    expect(html).toContain('Emails are joined as one when <code>club</code> match.');
    expect(html).not.toContain('ty:var-identity');
    h.editor.handleInput(el({ [FIELD]: 'ty:var-values:1' }, 'red'));
    h.act('mail-facts-ty-save');
    await vi.waitFor(() => expect(h.editor.render()).toContain('keeps its value &#39;white&#39;'));
    expect(h.editor.isOpen()).toBe(true);
    h.act('mail-facts-ty-cancel');
    expect(h.onCancelled).toHaveBeenCalled();
    expect(h.editor.isOpen()).toBe(false);
  });

  // A text field's `change` fires as focus leaves it — on the press of the
  // button clicked next. A repaint then replaces that button before the click
  // lands, and the click is lost (found driving the page: "Add a variable" did
  // nothing after a name was typed).
  it('never repaints on a text field’s change, which would take the next click', () => {
    const h = harness({});
    h.editor.open(null);
    h.act('mail-facts-ty-var-add');
    h.act('mail-facts-ty-data-add');
    h.editor.handleChange(el({ [FIELD]: 'ty:var-kind:1' }, 'enum'));
    h.render.mockClear();
    for (const field of ['ty:name', 'ty:description', 'ty:states', 'ty:notices', 'ty:var-name:0', 'ty:var-values:1', 'ty:data-path:0', 'ty:data-description:0']) {
      h.editor.handleInput(el({ [FIELD]: field }, 'typed'));
      expect(h.editor.handleChange(el({ [FIELD]: field }, 'typed')), field).toBe(true);
    }
    expect(h.render).not.toHaveBeenCalled();
    // A select or a box is its own click: it repaints.
    h.editor.handleChange(el({ [FIELD]: 'ty:var-required:0' }, '', true));
    expect(h.render).toHaveBeenCalledTimes(1);
  });

  it('keeps “Data fields” open or shut across repaints, and opening it repaints nothing', () => {
    const h = harness({});
    h.editor.open(null);
    expect(h.editor.render()).toContain('<details class="mail-facts-advanced">');
    h.render.mockClear();
    h.act('mail-facts-ty-data-toggle');
    expect(h.render).not.toHaveBeenCalled();
    // A select repaints the form: the section stays as the owner left it.
    h.editor.handleChange(el({ [FIELD]: 'ty:var-kind:0' }, 'enum'));
    expect(h.render).toHaveBeenCalled();
    expect(h.editor.render()).toContain('<details class="mail-facts-advanced" open>');
    h.act('mail-facts-ty-data-toggle');
    expect(h.editor.render()).toContain('<details class="mail-facts-advanced">');
    // A kind that has data fields opens on them.
    h.editor.open({ ...wine, data_fields: [{ path: 'bottles', kind: 'list' }] });
    expect(h.editor.render()).toContain('<details class="mail-facts-advanced" open>');
  });

  it('says whether it has changes, and a save that lands after it was left moves nothing', async () => {
    let finish: () => void = () => {};
    const createType = vi.fn(({ spec }: { spec: MailFactTypeSpec }) => new Promise<{ type: MailFactTypeSpec }>((resolve) => { finish = () => resolve({ type: spec }); }));
    let refuse: () => void = () => {};
    const updateType = vi.fn(() => new Promise<{ type: MailFactTypeSpec }>((_resolve, reject) => { refuse = () => reject(new Error('refused')); }));
    const h = harness({ createType, updateType });
    h.editor.open(null);
    expect(h.editor.isDirty()).toBe(false);
    h.editor.handleInput(el({ [FIELD]: 'ty:name' }, 'Club newsletter'));
    h.editor.handleInput(el({ [FIELD]: 'ty:var-name:0' }, 'issue'));
    expect(h.editor.isDirty()).toBe(true);
    h.act('mail-facts-ty-save');
    expect(h.editor.isSaving()).toBe(true);
    // Left while it saves, and another kind opened.
    h.act('mail-facts-ty-cancel');
    h.editor.open(wine);
    finish();
    await vi.waitFor(() => expect(h.onSaved).toHaveBeenCalled());
    expect(h.onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'custom_club_newsletter' }), false);
    expect(h.editor.isOpen()).toBe(true);
    expect(h.editor.render()).toContain('Edit “Wine club box”');

    // A refusal for a form that was left is not shown on the one open now.
    h.editor.handleInput(el({ [FIELD]: 'ty:description' }, 'Boxes of wine.'));
    h.act('mail-facts-ty-save');
    h.act('mail-facts-ty-cancel');
    h.editor.open(wine);
    refuse();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.editor.render()).not.toContain('refused');
    expect(h.editor.isSaving()).toBe(false);
  });

  it('an older new kind’s save leaves a newer new kind open: every new form is its own', async () => {
    const finish: Array<() => void> = [];
    const createType = vi.fn(({ spec }: { spec: MailFactTypeSpec }) =>
      new Promise<{ type: MailFactTypeSpec }>((resolve) => { finish.push(() => resolve({ type: spec })); }));
    const h = harness({ createType });
    // Save A, then leave it.
    h.editor.open(null);
    h.editor.handleInput(el({ [FIELD]: 'ty:name' }, 'Kind A'));
    h.editor.handleInput(el({ [FIELD]: 'ty:var-name:0' }, 'a_id'));
    h.act('mail-facts-ty-save');
    h.act('mail-facts-ty-cancel');
    // Open and save B, a new kind too.
    h.editor.open(null);
    h.editor.handleInput(el({ [FIELD]: 'ty:name' }, 'Kind B'));
    h.editor.handleInput(el({ [FIELD]: 'ty:var-name:0' }, 'b_id'));
    h.act('mail-facts-ty-save');
    // A lands first.
    finish[0]!();
    await vi.waitFor(() => expect(h.onSaved).toHaveBeenCalledTimes(1));
    expect(h.onSaved).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'custom_kind_a' }), false);
    expect(h.editor.isOpen()).toBe(true);
    expect(h.editor.isSaving()).toBe(true);
    // Then B, which is the form open.
    finish[1]!();
    await vi.waitFor(() => expect(h.onSaved).toHaveBeenCalledTimes(2));
    expect(h.onSaved).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'custom_kind_b' }), true);
    expect(h.editor.isOpen()).toBe(false);
  });

  it('an older new kind’s refusal is not shown on a newer new kind that is saving', async () => {
    const refuse: Array<() => void> = [];
    const createType = vi.fn(() =>
      new Promise<{ type: MailFactTypeSpec }>((_resolve, reject) => { refuse.push(() => reject(new Error('refused'))); }));
    const h = harness({ createType });
    h.editor.open(null);
    h.editor.handleInput(el({ [FIELD]: 'ty:name' }, 'Kind A'));
    h.act('mail-facts-ty-save');
    h.act('mail-facts-ty-cancel');
    h.editor.open(null);
    h.editor.handleInput(el({ [FIELD]: 'ty:name' }, 'Kind B'));
    h.act('mail-facts-ty-save');
    refuse[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.editor.render()).not.toContain('refused');
    expect(h.editor.isSaving()).toBe(true);
    refuse[1]!();
    await vi.waitFor(() => expect(h.editor.render()).toContain('refused'));
    expect(h.editor.isSaving()).toBe(false);
  });

  it('a change made while it saves is kept: the form stays on the kind it saved, the change not saved yet', async () => {
    let finish: () => void = () => {};
    const createType = vi.fn(({ spec }: { spec: MailFactTypeSpec }) =>
      new Promise<{ type: MailFactTypeSpec }>((resolve) => { finish = () => resolve({ type: spec }); }));
    const updateType = vi.fn(async ({ spec }: { spec: MailFactTypeSpec }) => ({ type: spec }));
    const h = harness({ createType, updateType });
    h.editor.open(null);
    h.editor.handleInput(el({ [FIELD]: 'ty:name' }, 'Club newsletter'));
    h.editor.handleInput(el({ [FIELD]: 'ty:var-name:0' }, 'issue'));
    h.act('mail-facts-ty-save');
    // While it saves, the owner writes a description.
    h.editor.handleInput(el({ [FIELD]: 'ty:description' }, 'The monthly letter.'));
    finish();
    await vi.waitFor(() => expect(h.onSaved).toHaveBeenCalledTimes(1));
    expect(createType.mock.calls[0]![0].spec.description).toBe('');
    expect(h.onSaved).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'custom_club_newsletter' }), true);
    // Still open, on the kind it made, with the description.
    expect(h.editor.isOpen()).toBe(true);
    expect(h.editor.isSaving()).toBe(false);
    expect(h.editor.isDirty()).toBe(true);
    const html = h.editor.render();
    expect(html).toContain('Edit “Club newsletter”');
    expect(html).toContain('The monthly letter.');
    expect(html).toContain('Saved. Your changes since are not saved yet.');
    // Its variable is saved now: it can no longer go or change its name.
    expect(html).toMatch(/ty:var-name:0"[^>]*disabled/);
    // What was saved is the measure now: back to it, nothing is unsaved.
    h.editor.handleInput(el({ [FIELD]: 'ty:description' }, ''));
    expect(h.editor.isDirty()).toBe(false);
    expect(h.editor.render()).not.toContain('Saved. Your changes since are not saved yet.');
    h.editor.handleInput(el({ [FIELD]: 'ty:description' }, 'The monthly letter.'));
    // Saving again updates that kind: no second one.
    h.act('mail-facts-ty-save');
    await vi.waitFor(() => expect(updateType).toHaveBeenCalledTimes(1));
    expect(updateType.mock.calls[0]![0].spec).toMatchObject({ id: 'custom_club_newsletter', description: 'The monthly letter.' });
    expect(createType).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.editor.isOpen()).toBe(false));
  });

  it('fixes its variables while it saves: one being saved cannot be renamed or removed', async () => {
    let finish: () => void = () => {};
    const createType = vi.fn(({ spec }: { spec: MailFactTypeSpec }) =>
      new Promise<{ type: MailFactTypeSpec }>((resolve) => { finish = () => resolve({ type: spec }); }));
    const h = harness({ createType });
    h.editor.open(null);
    h.editor.handleInput(el({ [FIELD]: 'ty:name' }, 'Club newsletter'));
    h.editor.handleInput(el({ [FIELD]: 'ty:var-name:0' }, 'issue'));
    h.act('mail-facts-ty-save');
    const saving = h.editor.render();
    expect(saving).toMatch(/ty:var-name:0"[^>]*disabled/);
    expect(saving).toMatch(/ty:var-kind:0"[^>]*disabled/);
    expect(saving).not.toContain('mail-facts-ty-var-remove');
    // Whatever arrives meanwhile changes nothing it sent.
    h.editor.handleInput(el({ [FIELD]: 'ty:var-name:0' }, 'volume'));
    h.editor.handleChange(el({ [FIELD]: 'ty:var-kind:0' }, 'number'));
    h.act('mail-facts-ty-var-remove', { 'data-index': '0' });
    finish();
    await vi.waitFor(() => expect(h.onSaved).toHaveBeenCalledTimes(1));
    // Nothing changed while it saved: it closes on the kind it made.
    expect(h.editor.isOpen()).toBe(false);
    expect(createType.mock.calls[0]![0].spec.variables).toEqual([{ name: 'issue', kind: 'text', required: true }]);
  });

  it('offers no attachment to tell one apart, and forgets the tick when a variable becomes one', async () => {
    const createType = vi.fn(async ({ spec }: { spec: MailFactTypeSpec }) => ({ type: spec }));
    const h = harness({ createType });
    h.editor.open(null);
    h.editor.handleInput(el({ [FIELD]: 'ty:name' }, 'Scans'));
    h.editor.handleInput(el({ [FIELD]: 'ty:var-name:0' }, 'scan'));
    h.editor.handleChange(el({ [FIELD]: 'ty:var-identity:0' }, '', true));
    h.editor.handleChange(el({ [FIELD]: 'ty:var-kind:0' }, 'file'));
    expect(h.editor.render()).not.toContain('ty:var-identity:0');
    h.editor.handleChange(el({ [FIELD]: 'ty:var-kind:0' }, 'text'));
    expect(h.editor.render()).not.toMatch(/ty:var-identity:0"[^>]*checked/);
    h.act('mail-facts-ty-save');
    await vi.waitFor(() => expect(h.onSaved).toHaveBeenCalled());
    expect(createType.mock.calls[0]![0].spec.identity).toEqual([]);
  });
});
