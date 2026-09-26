/** D-314 — what a list setting's `options` may say.
 *
 *  They are its checkboxes: the values, or one list Recued keeps. An older
 *  server checks only that they are non-empty strings, so everything refused
 *  here is refused by this build alone. */

import { describe, expect, it } from 'vitest';
import { parseRecipe } from '../index.js';

const issuesFor = (variables: Record<string, unknown>): Array<{ code: string; message: string }> => {
  const parsed = parseRecipe({
    recipe_id: 'lists',
    version: 1,
    ttl: 0,
    metadata: { name: 'Lists', description: 'x', author: 'test', supported_platforms: [] },
    variables,
    prefetch_steps: [],
    steps: [{ id: 'x', transform: 'coalesce', values: ['{{meta.recipe_id}}'] }],
    output: { render: [{ type: 'summary', source: 'step.x' }] },
  });
  return (parsed.issues ?? [])
    .filter((issue) => issue.severity === 'error')
    .map((issue) => ({ code: issue.code, message: issue.message }));
};
const codes = (variables: Record<string, unknown>): string[] => issuesFor(variables).map((i) => i.code);

const WEEKDAYS = { label: 'Weekdays', type: 'array', options: ['@weekdays'], default: [1, 2, 3, 4, 5] };
const CHANNELS = { label: 'Notification channels', type: 'array', optional: true, options: ['@notification_channels'] };

describe('a list setting with options', () => {
  it('accepts the two shapes the corpus carries', () => {
    expect(codes({ weekdays: WEEKDAYS, channels: CHANNELS })).toEqual([]);
  });

  it('accepts plain options with a default among them', () => {
    expect(codes({ statuses: { label: 'S', type: 'array', options: ['open', 'done'], default: ['open'] } }))
      .toEqual([]);
  });

  it('⛔ refuses a list Recued does not keep, naming the ones it does', () => {
    const issues = issuesFor({ months: { label: 'M', type: 'array', options: ['@months'] } });
    expect(issues.map((i) => i.code)).toEqual(['variable_hint_invalid']);
    expect(issues[0]!.message).toContain('@weekdays, @notification_channels');
  });

  it('⛔ refuses a kept list on a setting that is not a list', () => {
    expect(codes({ day: { label: 'Day', type: 'enum', options: ['@weekdays'] } }))
      .toContain('variable_hint_invalid');
  });

  it('does not read an enum option that starts with @ as a list', () => {
    expect(codes({ mention: { label: 'Mention', type: 'enum', options: ['@here'] } })).toEqual([]);
  });

  it('⛔ refuses a default that is not a list of its options', () => {
    expect(codes({ weekdays: { ...WEEKDAYS, default: [1, 8] } })).toContain('variable_hint_invalid');
    expect(codes({ weekdays: { ...WEEKDAYS, default: 1 } })).toContain('variable_hint_invalid');
    expect(codes({ s: { label: 'S', type: 'array', options: ['open'], default: ['done'] } }))
      .toContain('variable_hint_invalid');
  });

  it('reads a default as the list reads it: 0 is Sunday', () => {
    expect(codes({ weekdays: { ...WEEKDAYS, default: [0, 6] } })).toEqual([]);
  });

  it('⛔ refuses an optional list with a default: unticking every box would bring it back', () => {
    const issues = issuesFor({ channels: { ...CHANNELS, default: ['email'] } });
    expect(issues.map((i) => i.code)).toEqual(['variable_hint_invalid']);
    expect(issues[0]!.message).toContain('would bring the default back');
  });

  it('still refuses options that are not non-empty strings, as every server does', () => {
    expect(codes({ days: { label: 'D', type: 'array', options: [1, 2] } })).toContain('variable_hint_invalid');
  });
});
