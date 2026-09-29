import { describe, it, expect } from 'vitest';
import {
  FILE_REF_VARIABLE_ATTR,
  dateInputValue,
  datetimeInputValue,
  fileRefVariablePickerId,
  toWidgetShape,
  renderVariableWidget,
  readWidgetValue,
  validateWidgetValue,
} from '../variable-widgets.js';

/** Fake Element matching the shape readWidgetValue touches — same
 *  approach as field-dispatcher.test.ts so the suite stays
 *  jsdom-free. */
const fakeEl = (
  opts: {
    dataset?: Record<string, string>;
    value?: string;
    checked?: boolean;
    matches?: (sel: string) => boolean;
    closest?: (sel: string) => unknown;
    querySelectorAll?: (sel: string) => ReadonlyArray<unknown>;
  },
): Element => ({
  ...opts,
  dataset: opts.dataset ?? {},
  matches: opts.matches ?? (() => false),
  closest: opts.closest ?? (() => null),
  querySelectorAll: opts.querySelectorAll ?? (() => []),
} as unknown as Element);

describe('toWidgetShape', () => {
  it('infers widget type from primitive defaults', () => {
    expect(toWidgetShape('name', 'alice').type).toBe('text');
    expect(toWidgetShape('count', 7).type).toBe('number');
    expect(toWidgetShape('enabled', false).type).toBe('boolean');
    expect(toWidgetShape('tags', ['a', 'b']).type).toBe('multi');
  });

  it('maps ValueHint enum to select widget', () => {
    const shape = toWidgetShape('priority', {
      label: 'Priority',
      type: 'enum',
      options: ['low', 'high'],
      default: 'low',
    });
    expect(shape.type).toBe('select');
    expect(shape.label).toBe('Priority');
    expect(shape.options).toEqual(['low', 'high']);
    expect(shape.value).toBe('low');
  });

  it('maps ValueHint secret to secret widget', () => {
    const shape = toWidgetShape('api_key', {
      label: 'API key',
      type: 'secret',
    });
    expect(shape.type).toBe('secret');
  });

  it('maps a durable file reference hint to the file_ref widget contract', () => {
    const shape = toWidgetShape('template_file_ref', {
      label: 'Markdown template',
      type: 'file_ref',
      default: null,
      accept_mime_types: ['text/markdown'],
    });
    expect(shape.type).toBe('file_ref');
    expect(shape.value).toBeNull();
  });

  it('honours override when provided', () => {
    const shape = toWidgetShape('days', 7, 14);
    expect(shape.value).toBe(14);
  });

  it('formats snake_case keys into a readable label', () => {
    expect(toWidgetShape('inactivity_days', 7).label).toBe('Inactivity days');
  });
});

describe('renderVariableWidget', () => {
  it('renders a text input with the current value', () => {
    const html = renderVariableWidget(toWidgetShape('name', 'alice'));
    expect(html).toContain('type="text"');
    expect(html).toContain('value="alice"');
    expect(html).toContain('data-var-key="name"');
    expect(html).toContain('data-var-type="text"');
  });

  it('renders a number input for numeric defaults', () => {
    const html = renderVariableWidget(toWidgetShape('days', 30));
    expect(html).toContain('type="number"');
    expect(html).toContain('value="30"');
  });

  it('renders a checkbox for boolean defaults with checked reflecting value', () => {
    const html = renderVariableWidget(toWidgetShape('flag', true));
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
  });

  it('renders a select for ValueHint enum with options + selected', () => {
    const shape = toWidgetShape('priority', {
      label: 'Priority',
      type: 'enum',
      options: ['low', 'med', 'high'],
      default: 'med',
    });
    const html = renderVariableWidget(shape);
    expect(html).toContain('<select');
    expect(html).toMatch(/value="med"\s+selected/);
    expect(html).toContain('value="low"');
    expect(html).toContain('value="high"');
  });

  it('renders a multi-select grid for string[] defaults', () => {
    const html = renderVariableWidget(toWidgetShape('stages', ['new', 'open']));
    expect(html).toContain('var-multi-grid');
    expect(html).toContain('data-option="new"');
    expect(html).toContain('data-option="open"');
    const checkedMatches = html.match(/checked/g) ?? [];
    expect(checkedMatches.length).toBe(2);
  });

  it('renders a password input for secret widget type', () => {
    const shape = toWidgetShape('api_key', {
      label: 'API key',
      type: 'secret',
    });
    const html = renderVariableWidget(shape);
    expect(html).toContain('type="password"');
  });

  it('renders a pasteable file_ref fallback when no inventory caller is wired', () => {
    const shape = toWidgetShape('template_file_ref', {
      label: 'Markdown template',
      type: 'file_ref',
      default: 'file:template-1',
    });
    const html = renderVariableWidget(shape);
    expect(html).toContain('data-var-type="file_ref"');
    expect(html).toContain('value="file:template-1"');
    expect(html).toContain('placeholder="file:…"');
    expect(html).not.toContain('role="combobox"');
  });

  it('renders a file inventory RefPicker plus a hidden committed id contract', () => {
    const shape = toWidgetShape('template_file_ref', {
      label: 'Markdown template',
      type: 'file_ref',
      default: 'file:template-1',
    });
    const html = renderVariableWidget(shape, {
      fileRefPicker: true,
      idPrefix: 'run',
    });
    expect(html).toContain(`${FILE_REF_VARIABLE_ATTR}="template_file_ref"`);
    expect(html).toContain(`data-ref-picker="${fileRefVariablePickerId(
      'template_file_ref',
      'run',
    )}"`);
    expect(html).toContain('role="combobox"');
    expect(html).toContain('type="hidden" data-var-key="template_file_ref"');
    expect(html).toContain('data-var-type="file_ref"');
    expect(html).toContain('value="file:template-1"');
  });

  it('escapes user-controlled help and label HTML', () => {
    const shape = toWidgetShape('x', {
      label: '<script>evil()</script>',
      type: 'text',
      help: 'hi <b>bold</b>',
    });
    const html = renderVariableWidget(shape);
    expect(html).not.toContain('<script>evil');
    expect(html).not.toContain('<b>bold');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('readWidgetValue', () => {
  it('returns the checkbox checked state for boolean', () => {
    const input = fakeEl({
      dataset: { varKey: 'flag', varType: 'boolean' },
      checked: true,
    });
    expect(readWidgetValue(input)).toBe(true);
  });

  it('returns a number for number widgets, 0 for empty', () => {
    const input = fakeEl({
      dataset: { varKey: 'days', varType: 'number' },
      value: '42',
    });
    expect(readWidgetValue(input)).toBe(42);
    const empty = fakeEl({
      dataset: { varKey: 'days', varType: 'number' },
      value: '',
    });
    expect(readWidgetValue(empty)).toBe(0);
  });

  it('returns an array of checked options for multi widgets', () => {
    const boxes = [
      fakeEl({ dataset: { varKey: 's', varType: 'multi', option: 'a' }, checked: true }),
      fakeEl({ dataset: { varKey: 's', varType: 'multi', option: 'b' }, checked: false }),
      fakeEl({ dataset: { varKey: 's', varType: 'multi', option: 'c' }, checked: true }),
    ];
    const grid = fakeEl({
      dataset: { varKey: 's', varType: 'multi' },
      matches: (sel) => sel === '.var-multi-grid',
      querySelectorAll: () => boxes,
    });
    expect(readWidgetValue(grid)).toEqual(['a', 'c']);
  });

  it('returns the string value for text widgets', () => {
    const input = fakeEl({
      dataset: { varKey: 'name', varType: 'text' },
      value: 'alice',
    });
    expect(readWidgetValue(input)).toBe('alice');
  });

  it('returns the committed durable id for file_ref widgets', () => {
    const input = fakeEl({
      dataset: { varKey: 'template_file_ref', varType: 'file_ref' },
      value: 'file:template-1',
    });
    expect(readWidgetValue(input)).toBe('file:template-1');
  });
});

describe('validateWidgetValue', () => {
  it('flags empty required text as required', () => {
    const shape = toWidgetShape('name', 'seed');
    expect(validateWidgetValue(shape, '')).toBe('Required');
    expect(validateWidgetValue(shape, 'x')).toBeNull();
  });

  it('accepts anything when optional', () => {
    const shape = toWidgetShape('x', {
      label: 'X',
      type: 'text',
      optional: true,
    });
    expect(validateWidgetValue(shape, '')).toBeNull();
  });

  it('rejects out-of-enum select value', () => {
    const shape = toWidgetShape('p', {
      label: 'P',
      type: 'enum',
      options: ['a', 'b'],
      default: 'a',
    });
    expect(validateWidgetValue(shape, 'z')).toContain('Must be one of');
    expect(validateWidgetValue(shape, 'a')).toBeNull();
  });

  it('requires at least one selection for multi', () => {
    const shape = toWidgetShape('s', ['x', 'y']);
    expect(validateWidgetValue(shape, [])).toBe('Choose at least one');
    expect(validateWidgetValue(shape, ['x'])).toBeNull();
  });

  it('requires a non-empty file_ref unless optional', () => {
    const shape = toWidgetShape('template_file_ref', {
      label: 'Template',
      type: 'file_ref',
      default: null,
    });
    expect(validateWidgetValue(shape, '')).toBe('Required');
    expect(validateWidgetValue(shape, 'file:template-1')).toBeNull();
  });
});

describe('long_text renders a text area', () => {
  // ⛔⛔ THE POINT IS THE NEWLINES. Every other string-ish widget is a one-line
  // `<input>`, and a browser strips the line breaks out of a multi-line paste on
  // its way into one — the value still arrives, as a single run-on paragraph
  // with every list and heading flattened, and nothing anywhere reports that the
  // structure was lost. A recipe that asks you to paste meeting notes into that
  // is not doing what its name says.
  // ⚠ THE CAST IS THE SUBJECT, NOT A SHORTCUT. `long_text` is one of the
  // authored types that runs ahead of `ValueHintType` on purpose — the contract's
  // header comment rules that an unknown type is admitted and falls back to text
  // rather than being declared piecemeal. A recipe declares this in plain JSON,
  // where nothing narrows it; the cast is how a TS caller reproduces that.
  const shape = toWidgetShape('notes', {
    label: 'What happened',
    type: 'long_text',
    help: 'Write or paste what happened.',
  } as unknown as Parameters<typeof toWidgetShape>[1]);

  it('maps the recipe type to its own widget without touching `text`', () => {
    expect(shape.type).toBe('textarea');
    // ⚠ The 26 shipped `type: 'text'` variables are SHORT values — a search
    // window like `pw`, an address. Widening `text` into a text area would have
    // been a UI change to two dozen recipes nobody asked for.
    expect(toWidgetShape('freshness', { label: 'Freshness', type: 'text' }).type)
      .toBe('text');
  });

  it('renders a real textarea carrying the reader attributes', () => {
    const html = renderVariableWidget(shape);
    expect(html).toContain('<textarea');
    expect(html).toContain('data-var-key="notes"');
    expect(html).toContain('data-var-type="textarea"');
    expect(html).not.toContain('<input');
  });

  it('reads back through the SAME reader, with newlines intact', () => {
    // 🔑 `readWidgetValue` needed no branch: it falls through to `.value`, and
    // `HTMLTextAreaElement.value` is the same property. This is the assertion
    // that keeps that true — a future reader change that stops falling through
    // would break long text silently, since every other type has its own branch.
    const pasted = 'Decisions:\n- ship on the 25th\n\nPriya to write the spec.';
    const el = fakeEl({
      dataset: { varKey: 'notes', varType: 'textarea' },
      value: pasted,
    });
    expect(readWidgetValue(el)).toBe(pasted);
  });

  it('⛔ a required one left empty is Required, not silently valid', () => {
    // A widget type absent from `validateWidgetValue`'s list falls past every
    // branch and returns null — "no complaint". That is how a closed vocabulary
    // matches its own union and still lies, and it is the half that is easy to
    // forget when adding a member to `WidgetType`.
    expect(validateWidgetValue(shape, '')).toBe('Required');
    expect(validateWidgetValue(shape, '   ')).toBe('Required');
    expect(validateWidgetValue(shape, 'we agreed to ship')).toBeNull();
    expect(validateWidgetValue({ ...shape, optional: true }, '')).toBeNull();
  });

  it('an unknown type still renders something usable', () => {
    // A self-hosted server can be NEWER than the webclient paired to it, so a
    // recipe declaring a type this build has never heard of has to land
    // somewhere. A one-line input is degraded, not broken.
    const future = toWidgetShape('mystery', {
      label: 'Mystery', type: 'rich_text_v9',
    } as unknown as Parameters<typeof toWidgetShape>[1]);
    expect(future.type).toBe('text');
    expect(renderVariableWidget(future)).toContain('<input');
  });
});

describe('a list setting (`type: \'array\'`) is a list, not the text in its box', () => {
  // ⛔ D-312 — the box has no list control, so it saved "1, 3" and handed a
  // recipe the text; every consumer of the 628 list settings takes a list.
  const weekdays = toWidgetShape('weekdays', {
    label: 'Weekdays', type: 'array', default: [1, 2, 3, 4, 5],
  } as unknown as Parameters<typeof toWidgetShape>[1]);
  const channels = toWidgetShape('channels', {
    label: 'Notification channels', type: 'array', optional: true,
  } as unknown as Parameters<typeof toWidgetShape>[1]);

  it('stays a one-line box, marked with what its items read as', () => {
    expect(weekdays).toMatchObject({ type: 'text', list: 'numbers' });
    expect(channels).toMatchObject({ type: 'text', list: 'text' });
  });

  it('shows a list as "a, b"', () => {
    const html = renderVariableWidget(weekdays);
    expect(html).toContain('value="1, 2, 3, 4, 5"');
    expect(html).toContain('data-var-list="numbers"');
  });

  it('shows text saved before this as the text it is', () => {
    expect(renderVariableWidget({ ...channels, value: 'slack, email' })).toContain('value="slack, email"');
  });

  it('⛔ reads back the list it spells, of numbers where the default is', () => {
    const box = (value: string, varList: string) =>
      fakeEl({ dataset: { varKey: 'k', varType: 'text', varList }, value });
    expect(readWidgetValue(box('1, 3', 'numbers'))).toEqual([1, 3]);
    expect(readWidgetValue(box('Slack, in-app', 'text'))).toEqual(['Slack', 'in-app']);
  });

  it('⛔ a box emptied again is no value, so the key drops out and the default applies', () => {
    const box = fakeEl({ dataset: { varKey: 'k', varType: 'text', varList: 'text' }, value: '  ' });
    expect(readWidgetValue(box)).toBeUndefined();
  });

  it('a required one wants at least one item, and a good list is not "Required"', () => {
    const required = { ...channels, optional: false };
    expect(validateWidgetValue(required, ['slack'])).toBeNull();
    expect(validateWidgetValue(required, 'slack')).toBeNull();
    expect(validateWidgetValue(required, [])).toBe('Required');
    expect(validateWidgetValue(required, undefined)).toBe('Required');
    expect(validateWidgetValue(required, ' ')).toBe('Required');
  });
});

describe('a `datetime` setting leaves as an instant; a `date` setting is a day', () => {
  // ⛔⛔ THE ZONE IS ONLY KNOWN HERE. The control holds a zone-less wall clock,
  // and the server reads a zone-less time in ITS zone — or, for a record's date,
  // not at all: the store kept `2026-10-01T09:30` as text, and a promise dated
  // that way never came due. Every expectation below is computed from this
  // machine's own clock, so the file holds in any zone the suite runs in.
  const wall = new Date(2026, 9, 1, 9, 30); // 1 Oct 2026, 09:30 here
  const control = (varType: string, value: string) =>
    fakeEl({ dataset: { varKey: 'when', varType }, value });

  it('⛔ reads a datetime back WITH this browser\'s offset, naming the same instant', () => {
    const sent = readWidgetValue(control('datetime', '2026-10-01T09:30'));
    expect(sent).toMatch(/^2026-10-01T09:30:00[+-]\d{2}:\d{2}$/u);
    expect(Date.parse(String(sent))).toBe(wall.getTime());
  });

  it('takes the offset of THAT day, not of today (daylight saving)', () => {
    const winter = readWidgetValue(control('datetime', '2026-01-15T12:00'));
    const summer = readWidgetValue(control('datetime', '2026-07-15T12:00'));
    expect(Date.parse(String(winter))).toBe(new Date(2026, 0, 15, 12, 0).getTime());
    expect(Date.parse(String(summer))).toBe(new Date(2026, 6, 15, 12, 0).getTime());
  });

  it('an empty datetime is still empty, so an optional one stays unset', () => {
    expect(readWidgetValue(control('datetime', ''))).toBe('');
  });

  it('shows a saved instant as this browser\'s wall clock, whichever form it was saved in', () => {
    expect(datetimeInputValue(wall.getTime())).toBe('2026-10-01T09:30');
    expect(datetimeInputValue(readWidgetValue(control('datetime', '2026-10-01T09:30'))))
      .toBe('2026-10-01T09:30');
    expect(datetimeInputValue(new Date(wall).toISOString())).toBe('2026-10-01T09:30');
  });

  it('shows a wall clock saved before instants were sent as it was typed', () => {
    expect(datetimeInputValue('2026-10-01T09:30')).toBe('2026-10-01T09:30');
    expect(datetimeInputValue('2026-10-01T09:30:45')).toBe('2026-10-01T09:30');
  });

  it('shows nothing, rather than a value the control refuses, for anything else', () => {
    expect(datetimeInputValue(undefined)).toBe('');
    expect(datetimeInputValue('')).toBe('');
    expect(datetimeInputValue('next tuesday')).toBe('');
    expect(datetimeInputValue(Number.NaN)).toBe('');
  });

  it('renders the saved datetime inside the picker', () => {
    const html = renderVariableWidget({ ...toWidgetShape('when', { label: 'When', type: 'datetime' }), value: wall.getTime() });
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('value="2026-10-01T09:30"');
  });

  const day = toWidgetShape('target', { label: 'Target', type: 'date' } as Parameters<typeof toWidgetShape>[1]);

  it('maps the `date` hint to a date picker', () => {
    expect(day.type).toBe('date');
    const html = renderVariableWidget({ ...day, value: '2026-10-01' });
    expect(html).toContain('type="date"');
    expect(html).toContain('value="2026-10-01"');
  });

  it('reads a date back as the day, with no time and no zone', () => {
    expect(readWidgetValue(control('date', '2026-10-01'))).toBe('2026-10-01');
  });

  it('shows the day of what was saved — a day, a time as written, or a stored day', () => {
    expect(dateInputValue('2026-10-01')).toBe('2026-10-01');
    // The date it was written on, not the UTC one (that is 2 Oct).
    expect(dateInputValue('2026-10-01T23:30:00-05:00')).toBe('2026-10-01');
    // A day is stored as midnight UTC.
    expect(dateInputValue(Date.UTC(2026, 9, 1))).toBe('2026-10-01');
    expect(dateInputValue('soon')).toBe('');
    expect(dateInputValue(undefined)).toBe('');
  });

  it('⛔ a required one left empty is Required — for both types', () => {
    // A widget type missing from `validateWidgetValue`'s list falls past every
    // branch and returns null — "no complaint".
    expect(validateWidgetValue({ ...day, optional: false }, '')).toBe('Required');
    expect(validateWidgetValue({ ...day, optional: false }, '2026-10-01')).toBeNull();
    const when = toWidgetShape('when', { label: 'When', type: 'datetime' });
    expect(validateWidgetValue({ ...when, optional: false }, '')).toBe('Required');
  });
});
