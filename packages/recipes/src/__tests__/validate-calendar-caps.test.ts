/** D-117 Phase 6 — install-time calendar caps validator tests. */

import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import {
  validateCalendarInstanceCaps,
  type CalendarInstanceCaps,
} from '../validate-calendar-caps.js';

const inst = (
  slug: string,
  overrides: Partial<{
    create_event: 'yes' | 'no';
    update_event: 'yes' | 'no';
    delete_event: 'yes' | 'no';
    rsvp: 'yes' | 'no';
    search: 'local' | 'remote' | 'none';
    auth_state: CalendarInstanceCaps['auth_state'];
  }> = {},
): CalendarInstanceCaps => ({
  slug,
  caps: {
    read: 'yes',
    list_calendars: 'yes',
    create_event: overrides.create_event ?? 'yes',
    update_event: overrides.update_event ?? 'yes',
    delete_event: overrides.delete_event ?? 'yes',
    rsvp: overrides.rsvp ?? 'yes',
    search: overrides.search ?? 'remote',
    watch: 'poll',
    auth: 'oauth',
    recurrence: 'server',
  },
  auth_state: overrides.auth_state ?? 'healthy',
});

const recipe = (
  steps: Array<{ id: string; ingredient: string; input: Record<string, unknown> }>,
): RecipeDefinition => ({
  recipe_id: 't',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'test',
    description: '',
    author: 'test',
    supported_platforms: [],
    tags: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: steps.map((s) => ({ id: s.id, ingredient: s.ingredient, input: s.input })) as never,
  output: { sidebar: [] },
});

describe('validateCalendarInstanceCaps', () => {
  it('returns no issues for recipes without calendar steps', async () => {
    const r = recipe([{ id: 'x', ingredient: 'ai-summarize', input: {} }]);
    expect(await validateCalendarInstanceCaps(r, () => [])).toHaveLength(0);
  });

  it('passes when caps match calendar-create requirement', async () => {
    const r = recipe([{
      id: 'create',
      ingredient: 'calendar-create',
      input: { slug: 'work', calendar_id: 'cal', event: {} },
    }]);
    expect(await validateCalendarInstanceCaps(r, () => [inst('work')])).toHaveLength(0);
  });

  it('errors when caps deny calendar-create', async () => {
    const r = recipe([{
      id: 'create',
      ingredient: 'calendar-create',
      input: { slug: 'work', calendar_id: 'cal', event: {} },
    }]);
    const issues = await validateCalendarInstanceCaps(r, () => [
      inst('work', { create_event: 'no' }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: 'error',
      code: 'calendar_capability_denied',
      ingredient: 'calendar-create',
    });
  });

  it('errors when caps deny calendar-rsvp', async () => {
    const r = recipe([{
      id: 'rsvp',
      ingredient: 'calendar-rsvp',
      input: { slug: 'work', source_id: 'evt', response: 'accepted' },
    }]);
    const issues = await validateCalendarInstanceCaps(r, () => [
      inst('work', { rsvp: 'no' }),
    ]);
    expect(issues[0]).toMatchObject({
      code: 'calendar_capability_denied',
      ingredient: 'calendar-rsvp',
    });
  });

  it('errors when calendar-search targets an instance with caps.search=none', async () => {
    const r = recipe([{
      id: 'search',
      ingredient: 'calendar-search',
      input: { slug: 'work', query: 'x' },
    }]);
    const issues = await validateCalendarInstanceCaps(r, () => [
      inst('work', { search: 'none' }),
    ]);
    expect(issues[0]).toMatchObject({
      code: 'calendar_capability_denied',
      ingredient: 'calendar-search',
    });
  });

  it('warns when the instance is not enrolled', async () => {
    const r = recipe([{
      id: 'list',
      ingredient: 'calendar-list',
      input: { slug: 'unknown' },
    }]);
    const issues = await validateCalendarInstanceCaps(r, () => []);
    expect(issues[0]).toMatchObject({
      severity: 'warning',
      code: 'calendar_instance_unknown',
      instance: 'unknown',
    });
  });

  it('warns when the instance auth is degraded', async () => {
    const r = recipe([{
      id: 'create',
      ingredient: 'calendar-create',
      input: { slug: 'work', calendar_id: 'cal', event: {} },
    }]);
    const issues = await validateCalendarInstanceCaps(r, () => [
      inst('work', { auth_state: 'expired' }),
    ]);
    expect(issues[0]).toMatchObject({
      severity: 'warning',
      code: 'calendar_instance_degraded',
    });
  });

  it('errors when the slug field is missing entirely', async () => {
    const r = recipe([{
      id: 'create',
      ingredient: 'calendar-create',
      input: { calendar_id: 'cal', event: {} },
    }]);
    const issues = await validateCalendarInstanceCaps(r, () => [inst('work')]);
    expect(issues[0]).toMatchObject({
      severity: 'error',
      code: 'calendar_missing_target',
    });
  });

  it('ignores inherited calendar ingredient discriminators', async () => {
    const inheritedStep = Object.create({
      id: 'create',
      ingredient: 'calendar-create',
      input: { slug: 'work', calendar_id: 'cal', event: {} },
    });
    const r = {
      ...recipe([]),
      steps: [inheritedStep],
    } as unknown as RecipeDefinition;

    const issues = await validateCalendarInstanceCaps(r, () => [
      inst('work', { create_event: 'no' }),
    ]);

    expect(issues).toHaveLength(0);
  });

  it('treats inherited slug fields as missing', async () => {
    const inheritedInput = Object.create({ slug: 'work' });
    const r = recipe([{
      id: 'create',
      ingredient: 'calendar-create',
      input: inheritedInput,
    }]);

    const issues = await validateCalendarInstanceCaps(r, () => [inst('work')]);

    expect(issues[0]).toMatchObject({
      severity: 'error',
      code: 'calendar_missing_target',
    });
  });

  it('skips placeholder refs — they cannot be resolved at install time', async () => {
    const r = recipe([{
      id: 'create',
      ingredient: 'calendar-create',
      input: { slug: '{{config.calendar_slug}}', calendar_id: 'cal', event: {} },
    }]);
    expect(await validateCalendarInstanceCaps(r, () => [])).toHaveLength(0);
  });

  it('walks both prefetch_steps and steps', async () => {
    const r: RecipeDefinition = {
      recipe_id: 't',
      version: 1,
      ttl: 60,
      metadata: {
        name: 't', description: '', author: 'test',
        supported_platforms: [], tags: [],
      },
      variables: {},
      prefetch_steps: [
        { id: 'p1', ingredient: 'calendar-list', input: { slug: 'unknown' } } as never,
      ],
      steps: [
        { id: 's1', ingredient: 'calendar-create', input: { slug: 'work', calendar_id: 'cal', event: {} } } as never,
      ],
      output: { sidebar: [] },
    };
    const issues = await validateCalendarInstanceCaps(r, () => [inst('work')]);
    expect(issues).toHaveLength(1);
    expect(issues[0].step_id).toBe('p1');
  });
});
