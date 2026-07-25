import { describe, it, expect } from 'vitest';
import {
  FILE_REF_VARIABLE_ATTR,
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
