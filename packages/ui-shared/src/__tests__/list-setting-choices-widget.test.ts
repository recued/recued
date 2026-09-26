/** D-314 — a list setting with options is a set of checkboxes.
 *
 *  Weekdays tick Mon to Sun and read back as the watcher's numbers. Channels
 *  tick where a notification goes, and nothing ticked is every channel the
 *  owner has set up, as a blank box was. A required list with nothing ticked
 *  is refused before it is saved or run. */

import { describe, expect, it } from 'vitest';
import type { VariableDefault } from '@recued/contracts';
import {
  choiceListProblem,
  readWidgetValue,
  renderVariableWidget,
  toWidgetShape,
  validateWidgetValue,
} from '../variable-widgets.js';

const WEEKDAYS = {
  label: 'Weekdays', type: 'array', options: ['@weekdays'], default: [1, 2, 3, 4, 5],
} as unknown as VariableDefault;
const CHANNELS = {
  label: 'Notification channels', type: 'array', optional: true, options: ['@notification_channels'],
  help: 'Sends to every channel you have set up, unless you choose some, such as Slack, email or in-app.',
} as unknown as VariableDefault;

/** A checkbox grid as the reader walks it, jsdom-free like the rest of the suite. */
const grid = (
  boxes: Array<[option: string, checked: boolean]>,
  dataset: Record<string, string>,
): Element => {
  const inputs = boxes.map(([option, checked]) => ({
    dataset: { varKey: 'k', varType: 'multi', option },
    checked,
  }));
  return {
    dataset: { varKey: 'k', varType: 'multi', ...dataset },
    matches: (selector: string) => selector === '.var-multi-grid',
    closest: () => null,
    querySelectorAll: () => inputs,
  } as unknown as Element;
};

/** The boxes a rendered grid ticks, by their value. */
const tickedIn = (html: string): string[] =>
  [...html.matchAll(/data-option="([^"]*)"\s*checked/gu)].map((match) => match[1]!);

describe('weekdays', () => {
  const shape = toWidgetShape('weekdays', WEEKDAYS);

  it('are checkboxes Mon to Sun, the default ticked', () => {
    expect(shape).toMatchObject({ type: 'multi', list: 'numbers', value: [1, 2, 3, 4, 5] });
    expect(shape.choices?.map((choice) => choice.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    const html = renderVariableWidget(shape);
    expect(tickedIn(html)).toEqual(['1', '2', '3', '4', '5']);
    expect(html).toContain('<span>Sat</span>');
    expect(html).toContain('data-var-list="numbers"');
    expect(html).not.toContain('data-var-optional');
    expect(html).not.toContain('type="text"');
    expect(html).toContain('class="var-multi-grid var-multi-grid--compact"');
  });

  it('⛔ show what is saved: a saved 0 ticks Sunday, and text an older box saved still reads', () => {
    expect(toWidgetShape('weekdays', WEEKDAYS, [0, 6]).value).toEqual([6, 7]);
    expect(toWidgetShape('weekdays', WEEKDAYS, '1, 3').value).toEqual([1, 3]);
  });

  it('⛔ read back as numbers, which is all the time watcher accepts', () => {
    expect(readWidgetValue(grid([['1', true], ['2', false], ['3', true]], { varList: 'numbers' })))
      .toEqual([1, 3]);
  });

  it('⛔ with nothing ticked read as an empty list, which the form refuses', () => {
    // Dropped instead, the default would come back: the boxes the owner unticked.
    const none = readWidgetValue(grid([['1', false], ['2', false]], { varList: 'numbers' }));
    expect(none).toEqual([]);
    expect(validateWidgetValue(shape, none)).toBe('Tick at least one');
    expect(validateWidgetValue(shape, [2])).toBeNull();
    expect(choiceListProblem({ weekdays: WEEKDAYS }, { weekdays: [] })).toBe('Weekdays: tick at least one.');
  });

  it('left alone is fine: the saved value or the default stands', () => {
    expect(choiceListProblem({ weekdays: WEEKDAYS }, {})).toBeNull();
    expect(choiceListProblem({ weekdays: WEEKDAYS }, { weekdays: [6, 7] })).toBeNull();
  });
});

describe('notification channels', () => {
  const shape = toWidgetShape('channels', CHANNELS);

  it('are checkboxes with the channels\' names, none ticked when nothing is saved', () => {
    expect(shape).toMatchObject({ type: 'multi', list: 'text', value: [], optional: true });
    const html = renderVariableWidget(shape);
    expect(tickedIn(html)).toEqual([]);
    expect(html).toContain('<span>In-app</span>');
    expect(html).toContain('data-option="in_app"');
    expect(html).toContain('data-var-optional=""');
    expect(html).toContain('Sends to every channel you have set up, unless you choose some');
    expect(html).toContain('class="var-multi-grid"');
  });

  it('⛔ tick names as the adapter reads them: any case, in-app for in_app', () => {
    const saved = toWidgetShape('channels', CHANNELS, ['Slack', 'in-app']);
    expect(saved.value).toEqual(['slack', 'in_app']);
    expect(tickedIn(renderVariableWidget(saved))).toEqual(['slack', 'in_app']);
    expect(toWidgetShape('channels', CHANNELS, 'email, slack').value).toEqual(['slack', 'email']);
  });

  it('⛔ keep a saved name that is no channel visible and ticked, not dropped on the next save', () => {
    const saved = toWidgetShape('channels', CHANNELS, ['slak', 'email']);
    expect(saved.value).toEqual(['email', 'slak']);
    expect(saved.choices?.at(-1)).toEqual({ value: 'slak', label: 'slak' });
    expect(tickedIn(renderVariableWidget(saved))).toEqual(['email', 'slak']);
  });

  it('⛔ with nothing ticked read as no value: every channel set up, never an empty list', () => {
    // The adapter refuses an empty list ("channels[] is required"); no value is
    // what it reads as every channel the owner has set up.
    expect(readWidgetValue(grid([['slack', false], ['email', false]], { varList: 'text', varOptional: '' })))
      .toBeUndefined();
    expect(readWidgetValue(grid([['slack', true], ['in_app', true]], { varList: 'text', varOptional: '' })))
      .toEqual(['slack', 'in_app']);
    expect(choiceListProblem({ channels: CHANNELS }, {})).toBeNull();
  });
});

describe('what does not change', () => {
  it('a list setting without options is still the box', () => {
    const box = toWidgetShape('ids', { label: 'Ids', type: 'array' } as unknown as VariableDefault);
    expect(box).toMatchObject({ type: 'text', list: 'text' });
    expect(box.choices).toBeUndefined();
  });

  it('a bare list default is still a grid of its own values, read as they are written', () => {
    expect(toWidgetShape('tags', ['a', 'b']).choices).toBeUndefined();
    expect(readWidgetValue(grid([['a', true], ['b', false]], {}))).toEqual(['a']);
    expect(readWidgetValue(grid([], {}))).toEqual([]);
  });
});
