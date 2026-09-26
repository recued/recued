/** A list setting typed into the settings form reads as the list it spells.
 *  The form has no list control, so the box's text is what gets saved. */

import { describe, expect, it } from 'vitest';
import { isListOfNumbers, listFromTypedText, readTypedListSettings } from '../list-setting.js';

describe('listFromTypedText', () => {
  it.each([
    ['blank', '', undefined],
    ['spaces only', '   ', undefined],
    ['only separators', ' , ;\n', undefined],
    ['comma-separated', 'slack, email', ['slack', 'email']],
    ['semicolons and new lines', 'a;b\nc', ['a', 'b', 'c']],
    ['an item holding a space', 'In progress, Done', ['In progress', 'Done']],
    ['empty items', 'a,, b ,', ['a', 'b']],
    ['a JSON array, for items with commas', '["Smith, J", "Doe"]', ['Smith, J', 'Doe']],
    ['text that only starts like JSON', '[draft], final', ['[draft]', 'final']],
  ])('%s', (_label, text, expected) => {
    expect(listFromTypedText(text)).toEqual(expected);
  });

  it('reads numbers when asked, and keeps what is not one', () => {
    expect(listFromTypedText('1, 2, 7', { numbers: true })).toEqual([1, 2, 7]);
    expect(listFromTypedText('1, Mon', { numbers: true })).toEqual([1, 'Mon']);
    expect(listFromTypedText('1, 2')).toEqual(['1', '2']);
  });
});

describe('isListOfNumbers', () => {
  it.each([
    [[1, 2, 3], true],
    [[1, 'a'], false],
    [[], false],
    [undefined, false],
    ['1,2', false],
  ])('%j → %s', (sample, expected) => {
    expect(isListOfNumbers(sample)).toBe(expected);
  });
});

describe('readTypedListSettings', () => {
  const variables = {
    channels: { label: 'Notification channels', type: 'array', optional: true },
    weekdays: { label: 'Weekdays', type: 'array', default: [1, 2, 3, 4, 5] },
    subject: { label: 'Subject', type: 'string', default: '' },
    mode: ['fast', 'slow'],
  };

  it('⛔ reads each list setting that holds text as its list, of numbers where the default is', () => {
    expect(readTypedListSettings(variables, { channels: 'Slack, in-app', weekdays: '1, 3' }))
      .toEqual({ channels: ['Slack', 'in-app'], weekdays: [1, 3] });
  });

  it('⛔ drops a blank one, so its default applies', () => {
    expect(readTypedListSettings(variables, { channels: '', weekdays: ' ' })).toEqual({});
  });

  it('leaves everything else alone', () => {
    const config = {
      channels: ['slack'],
      subject: 'a, b',
      mode: 'fast, slow',
      undeclared: 'x, y',
    };
    // Nothing is text in a list setting, so the same object comes back.
    expect(readTypedListSettings(variables, config)).toBe(config);
  });

  it('does not touch the config it was given', () => {
    const config = { channels: 'slack' };
    expect(readTypedListSettings(variables, config)).toEqual({ channels: ['slack'] });
    expect(config).toEqual({ channels: 'slack' });
  });

  it('a recipe with no variables passes its config through', () => {
    const config = { channels: 'slack' };
    expect(readTypedListSettings(undefined, config)).toBe(config);
  });
});
