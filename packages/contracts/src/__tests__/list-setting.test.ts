/** A list setting typed into the settings form reads as the list it spells.
 *  The form has no list control, so the box's text is what gets saved. */

import { describe, expect, it } from 'vitest';
import {
  LIST_VOCABULARIES,
  isListOfNumbers,
  listFromTypedText,
  listSettingChoices,
  readTypedListSettings,
  splitSpacedItems,
} from '../list-setting.js';

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

/** Typed with spaces where commas were meant: `slack email`, `1 3`. The form's
 *  help asks for commas, and open lists still need them; a list that can tell an
 *  item from two reads the spaces too. */
describe('splitSpacedItems', () => {
  const channels = LIST_VOCABULARIES.notification_channels!;
  const statuses = listSettingChoices({ type: 'array', options: ['In progress', 'Done', 'Blocked'] })!;

  it('⛔ splits names every part of which is a choice: `slack email` is two channels', () => {
    expect(splitSpacedItems(['slack email'], { choices: channels })).toEqual(['slack', 'email']);
    expect(splitSpacedItems(['Slack  In-App'], { choices: channels })).toEqual(['Slack', 'In-App']);
  });

  it('⛔ splits numbers typed with spaces: `1 3 5`', () => {
    expect(splitSpacedItems(['1 3 5'], { numbers: true })).toEqual(['1', '3', '5']);
  });

  it('⛔ keeps an item that is itself a choice, spaces and all', () => {
    expect(splitSpacedItems(['In progress'], { choices: statuses })).toEqual(['In progress']);
    // Even when every part is a choice too: "Sales Ops" is the one team it names.
    const teams = listSettingChoices({ type: 'array', options: ['Sales', 'Ops', 'Sales Ops'] })!;
    expect(splitSpacedItems(['Sales Ops'], { choices: teams })).toEqual(['Sales Ops']);
    expect(splitSpacedItems(['Ops Sales'], { choices: teams })).toEqual(['Ops', 'Sales']);
  });

  it('keeps an item whole when a part is not one: it is refused by name, as before', () => {
    expect(splitSpacedItems(['slack emial'], { choices: channels })).toEqual(['slack emial']);
    expect(splitSpacedItems(['1 Mon'], { numbers: true })).toEqual(['1 Mon']);
  });

  it('⛔ leaves an open list alone: nothing can tell "In progress" from two words', () => {
    expect(splitSpacedItems(['In progress', 'slack email'])).toEqual(['In progress', 'slack email']);
  });

  it('keeps what is not text as it is', () => {
    expect(splitSpacedItems(['slack', 7, null], { choices: channels })).toEqual(['slack', 7, null]);
  });
});

describe('listFromTypedText, with a list that can tell', () => {
  it('reads spaces as separators beside commas', () => {
    expect(listFromTypedText('slack email, in-app', { choices: LIST_VOCABULARIES.notification_channels! }))
      .toEqual(['slack', 'email', 'in-app']);
    expect(listFromTypedText('1 3, 5', { numbers: true })).toEqual([1, 3, 5]);
  });

  it('an open list still needs commas', () => {
    expect(listFromTypedText('slack email')).toEqual(['slack email']);
  });
});

describe('readTypedListSettings, with a list that can tell', () => {
  it('⛔ reads a setting that offers choices, or holds numbers, typed with spaces', () => {
    const variables = {
      channels: { label: 'Notification channels', type: 'array', options: ['@notification_channels'] },
      weekdays: { label: 'Weekdays', type: 'array', default: [1, 2, 3, 4, 5] },
      tags: { label: 'Tags', type: 'array' },
    };
    expect(readTypedListSettings(variables, { channels: 'slack email', weekdays: '1 3', tags: 'to do' }))
      .toEqual({ channels: ['slack', 'email'], weekdays: [1, 3], tags: ['to do'] });
  });
});
