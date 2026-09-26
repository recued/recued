/** D-314 — the choices a list setting offers, and the lists Recued keeps.
 *
 *  A list setting with `options` is a set of checkboxes. Its options are the
 *  values themselves, or one list Recued keeps (`["@weekdays"]`), which says
 *  what each value reads as and how a saved item matches one. */

import { describe, expect, it } from 'vitest';
import {
  LIST_VOCABULARIES,
  listSettingChoices,
  listVocabularyRef,
  NOTIFICATION_DELIVERY_CHANNELS,
  notificationChannelName,
} from '../index.js';

const weekdays = LIST_VOCABULARIES.weekdays!;
const channels = LIST_VOCABULARIES.notification_channels!;

describe('the lists Recued keeps', () => {
  it('weekdays are 1 for Monday to 7 for Sunday, as the time watcher reads them', () => {
    expect(weekdays.choices).toEqual([
      { value: 1, label: 'Mon' },
      { value: 2, label: 'Tue' },
      { value: 3, label: 'Wed' },
      { value: 4, label: 'Thu' },
      { value: 5, label: 'Fri' },
      { value: 6, label: 'Sat' },
      { value: 7, label: 'Sun' },
    ]);
  });

  it('⛔ a saved 0 is Sunday: the watcher reads it so, and the box must show it ticked', () => {
    expect(weekdays.normalize(0)).toBe(7);
    expect(weekdays.normalize(7)).toBe(7);
    expect(weekdays.normalize('3')).toBe(3);
    for (const other of [8, -1, 1.5, 'Monday', '', null, [1]]) {
      expect(weekdays.normalize(other), JSON.stringify(other)).toBeUndefined();
    }
  });

  it('channels are the delivery vocabulary, each with a label', () => {
    expect(channels.choices.map((choice) => choice.value)).toEqual([...NOTIFICATION_DELIVERY_CHANNELS]);
    expect(channels.choices.every((choice) => choice.label.length > 0)).toBe(true);
    expect(channels.choices.find((choice) => choice.value === 'in_app')?.label).toBe('In-app');
  });

  it('⛔ a channel matches as the adapter reads it: any case, in-app for in_app', () => {
    expect(channels.normalize('Slack')).toBe('slack');
    expect(channels.normalize(' in-app ')).toBe('in_app');
    expect(channels.normalize('slak')).toBeUndefined();
    expect(channels.normalize(3)).toBeUndefined();
    expect(notificationChannelName('In-App')).toBe('in_app');
  });
});

describe('listVocabularyRef', () => {
  it('reads the one name in ["@weekdays"], and nothing else', () => {
    expect(listVocabularyRef(['@weekdays'])).toBe('weekdays');
    expect(listVocabularyRef(['@weekdays', 'x'])).toBeUndefined();
    expect(listVocabularyRef(['weekdays'])).toBeUndefined();
    expect(listVocabularyRef(['@Weekdays'])).toBeUndefined();
    expect(listVocabularyRef('@weekdays')).toBeUndefined();
  });
});

describe('listSettingChoices', () => {
  it('a list that names a kept list offers it', () => {
    expect(listSettingChoices({ label: 'W', type: 'array', options: ['@weekdays'] })).toBe(weekdays);
    expect(listSettingChoices({ label: 'C', type: 'array', options: ['@notification_channels'] })).toBe(channels);
  });

  it('plain options offer themselves, as numbers when the default is numbers', () => {
    const words = listSettingChoices({ label: 'S', type: 'array', options: ['open', 'done'] })!;
    expect(words.choices).toEqual([{ value: 'open', label: 'open' }, { value: 'done', label: 'done' }]);
    expect(words.normalize(' done ')).toBe('done');
    expect(words.normalize('Done')).toBeUndefined();

    const numbers = listSettingChoices({ label: 'N', type: 'array', options: ['1', '2'], default: [1] })!;
    expect(numbers.choices).toEqual([{ value: 1, label: '1' }, { value: 2, label: '2' }]);
    expect(numbers.normalize(2)).toBe(2);
    expect(numbers.normalize('2')).toBe(2);
  });

  it('⛔ a list this build does not keep offers nothing, so a newer recipe gets the box', () => {
    expect(listSettingChoices({ label: 'M', type: 'array', options: ['@months'] })).toBeUndefined();
  });

  it('offers nothing without options, or on a setting that is not a list', () => {
    expect(listSettingChoices({ label: 'L', type: 'array' })).toBeUndefined();
    expect(listSettingChoices({ label: 'L', type: 'array', options: [] })).toBeUndefined();
    expect(listSettingChoices({ label: 'L', type: 'array', options: ['a', 3] })).toBeUndefined();
    expect(listSettingChoices({ label: 'E', type: 'enum', options: ['@weekdays'] })).toBeUndefined();
    expect(listSettingChoices(['a', 'b'])).toBeUndefined();
  });
});
