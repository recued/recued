/** D-319 — the switch-on form: the settings editor asking for a dish's name,
 *  saying what will start it, offering a schedule, and refusing to switch on
 *  without a required setting. And the sentence it says. The DOM wiring is
 *  checked in Chrome; what it decides is here. */

import { describe, expect, it, vi } from 'vitest';

import type { VariableDefault } from '@recued/contracts';

import {
  CONFIG_EDITOR_NAME_ATTR,
  CONFIG_EDITOR_SCHEDULE_ATTR,
  requiredSettingProblem,
  wireConfigEditorOverlay,
} from '../config-editor-overlay.js';
import { intervalInWords, whatStartsIt } from '../dish-lead.js';

interface FakeElement {
  className: string;
  innerHTML: string;
  textContent: string;
  removed: boolean;
  children: FakeElement[];
  attrs: Map<string, string>;
  listeners: Map<string, Array<(event: Event) => void>>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeElement): FakeElement;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  remove(): void;
}

const makeElement = (): FakeElement => {
  const element: FakeElement = {
    className: '', innerHTML: '', textContent: '', removed: false, children: [],
    attrs: new Map(), listeners: new Map(),
    setAttribute(name, value) { element.attrs.set(name, value); },
    getAttribute(name) { return element.attrs.get(name) ?? null; },
    appendChild(child) { element.children.push(child); return child; },
    addEventListener(type, listener) {
      element.listeners.set(type, [...(element.listeners.get(type) ?? []), listener]);
    },
    removeEventListener() { /* not needed */ },
    remove() { element.removed = true; },
  };
  return element;
};

const makeDocument = () => {
  const body = makeElement();
  const head = makeElement();
  return {
    body,
    head: { querySelector: () => null, appendChild: (element: FakeElement) => head.appendChild(element) },
    activeElement: null,
    createElement: () => makeElement(),
    addEventListener() { /* not needed */ },
    removeEventListener() { /* not needed */ },
  };
};

const mount = (opts: Partial<Parameters<typeof wireConfigEditorOverlay>[0]>) => {
  const onConfirm = vi.fn();
  const handle = wireConfigEditorOverlay({
    document: makeDocument() as unknown as Document,
    title: 'Switch on “Shop parcels”',
    confirmLabel: 'Switch on',
    variables: {},
    currentOverlay: {},
    onConfirm,
    ...opts,
  });
  const overlay = handle.element as unknown as FakeElement;
  const confirm = () => {
    for (const listener of overlay.listeners.get('click') ?? []) {
      listener({ target: { closest: () => ({ getAttribute: () => 'confirm' }) } } as unknown as Event);
    }
  };
  return { overlay, onConfirm, confirm };
};

const template = { label: 'Mail template', type: 'mail_template' } as unknown as VariableDefault;
const connection = { label: 'Slack', type: 'connection', default: '' } as unknown as VariableDefault;

describe('the switch-on form', () => {
  it('asks for a name, says what starts it, and offers a schedule — only when asked to', () => {
    const { overlay } = mount({
      name: { value: '', required: true },
      lead: 'It starts when a shipment’s state changes.',
      schedules: [{ label: 'Weekdays at 9:00', cron: '0 9 * * 1-5' }],
    });
    expect(overlay.innerHTML).toContain(CONFIG_EDITOR_NAME_ATTR);
    expect(overlay.innerHTML).toContain('aria-required="true"');
    expect(overlay.innerHTML).toContain('It starts when a shipment’s state changes.');
    expect(overlay.innerHTML).toContain(CONFIG_EDITOR_SCHEDULE_ATTR);
    expect(overlay.innerHTML).toContain('<option value="" selected>No schedule</option>');
    expect(overlay.innerHTML).toContain('<option value="0 9 * * 1-5">Weekdays at 9:00</option>');

    const plain = mount({});
    expect(plain.overlay.innerHTML).not.toContain(CONFIG_EDITOR_NAME_ATTR);
    expect(plain.overlay.innerHTML).not.toContain(CONFIG_EDITOR_SCHEDULE_ATTR);
    expect(plain.overlay.innerHTML).not.toContain('config-editor-lead');
  });

  it('⛔ will not switch a second dish on without a name to tell it apart', () => {
    const { onConfirm, confirm } = mount({ name: { value: '', required: true } });
    confirm();
    expect(onConfirm).not.toHaveBeenCalled();
    const named = mount({ name: { value: 'Home mailbox', required: true } });
    named.confirm();
    expect(named.onConfirm).toHaveBeenCalledWith({}, { name: 'Home mailbox' });
  });

  it('⛔ will not switch on while a required setting is empty — the dish would run without it', () => {
    const { onConfirm, confirm } = mount({ variables: { template }, requireSettings: true });
    confirm();
    expect(onConfirm).not.toHaveBeenCalled();
    const filled = mount({ variables: { template }, currentOverlay: { template: 'mtpl_a' }, requireSettings: true });
    filled.confirm();
    expect(filled.onConfirm).toHaveBeenCalledWith({ template: 'mtpl_a' }, {});
    // A plain settings editor saves what it has, as before.
    const editor = mount({ variables: { template } });
    editor.confirm();
    expect(editor.onConfirm).toHaveBeenCalledWith({}, {});
  });
});

describe('requiredSettingProblem', () => {
  it('names the first setting the recipe asks for that is empty, as the owner would fix it', () => {
    expect(requiredSettingProblem({ template, connection }, {})).toBe('Mail template: Choose a template');
    expect(requiredSettingProblem({ template, connection }, { template: 'mtpl_a' })).toBe('Slack: Required');
    expect(requiredSettingProblem({ template, connection }, { template: 'mtpl_a', connection: 'slack-work' })).toBeNull();
  });

  it('a plain default — even an empty one — is the recipe’s own value and never blocks; optional ones never do', () => {
    expect(requiredSettingProblem({ note: '', count: 0, flag: false }, {})).toBeNull();
    expect(requiredSettingProblem({ maybe: { label: 'Maybe', type: 'text', optional: true } as unknown as VariableDefault }, {})).toBeNull();
    // Declared with no value: asked for.
    expect(requiredSettingProblem({ owner_email: null }, {})).toMatch(/Required/);
  });
});

describe('what starts it', () => {
  it('an interval, in words, as "every …" says it', () => {
    expect(intervalInWords(900_000)).toBe('15 minutes');
    expect(intervalInWords(60_000)).toBe('minute');
    expect(intervalInWords(3_600_000)).toBe('hour');
    expect(intervalInWords(2 * 86_400_000)).toBe('2 days');
    expect(whatStartsIt({ auto_run: { interval_ms: 3_600_000 } })).toBe('It runs every hour.');
  });

  it('says an auto-run recipe’s interval, a manual one’s owner, and a triggered one’s events', () => {
    expect(whatStartsIt({ auto_run: { interval_ms: 900_000 } })).toBe('It runs every 15 minutes.');
    expect(whatStartsIt({})).toBe('It runs when you run it.');
    expect(whatStartsIt({ event_triggers: [{ on: 'mail_fact.shipment', fields: ['state'] }] as never }))
      .toBe('It starts when a shipment’s state changes.');
    expect(whatStartsIt({ event_triggers: [{ event: 'data.mail.**.created' }, { event: 'data.calendar.**.updated' }] as never }))
      .toBe('It starts when an email arrives, or when a calendar event changes.');
    expect(whatStartsIt({ event_triggers: [{ on: 'mail_fact.shipment', where: { state: 'delivered' } }] as never }))
      .toBe('It starts when mail about a shipment is read and its state is delivered.');
  });

  /** 2026-10-05 — a trigger whose folder a setting fills says which one, as a
   *  run of the dish reads it: the dish's value, else the recipe's default. */
  it('says the folder, mailbox or calendar a trigger’s setting names', () => {
    const arrivals = {
      variables: { file_slug: { label: 'Folder to watch', type: 'file_slug' } },
      event_triggers: [{ event: 'data.file.{{config.file_slug}}.*.created' }],
    } as never;
    expect(whatStartsIt(arrivals, { file_slug: 'scans' })).toBe('It starts when a file arrives in the “scans” folder.');
    expect(whatStartsIt(arrivals)).toBe('It starts when a file arrives in the folder you choose.');
    expect(whatStartsIt(arrivals, { file_slug: '' })).toBe('It starts when a file arrives in the folder you choose.');
    expect(whatStartsIt({
      variables: { mail_slug: { label: 'Mailbox to read', type: 'mail_slug', default: 'work' } },
      event_triggers: [{ event: 'data.mail.{{config.mail_slug}}.*.created' }],
    } as never)).toBe('It starts when an email arrives in the “work” mailbox.');
  });
});
