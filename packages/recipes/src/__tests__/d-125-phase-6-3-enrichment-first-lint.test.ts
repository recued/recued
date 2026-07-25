/** D-125 Phase 6.3 — kernel + recued-core enrichment-first lint rule. */

import { describe, expect, it } from 'vitest';
import type { RecipeDefinition } from '@recued/contracts';
import { lintEnrichmentFirst } from '../lint/enrichment-first.js';

const baseMetadata = (author: string) => ({
  name: 'test',
  description: 'test',
  author,
  supported_platforms: ['*'],
});

const makeRecipe = (
  author: string,
  steps: ReadonlyArray<Record<string, unknown>>,
): RecipeDefinition =>
  ({
    recipe_id: 'test-recipe',
    version: 1,
    ttl: 60,
    metadata: baseMetadata(author),
    variables: {},
    prefetch_steps: [],
    steps: steps as unknown as RecipeDefinition['steps'],
    output: { sidebar: [] },
  } as unknown as RecipeDefinition);

describe('D-125 P6.3 — author scoping', () => {
  it('returns empty for third-party publishers', () => {
    const recipe = makeRecipe('alice', [
      {
        id: 'read_calendar',
        ingredient: 'calendar-get',
        input: { record_id: '{{data.calendar.evt_1.brief}}' },
      },
    ]);
    expect(lintEnrichmentFirst(recipe)).toEqual([]);
  });

  it('runs for recued-core', () => {
    const recipe = makeRecipe('recued-core', [
      {
        id: 'read_calendar',
        transform: 'pluck',
        input: '{{data.calendar.evt_1.brief}}',
        path: 'value',
      },
    ]);
    const issues = lintEnrichmentFirst(recipe);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.code).toBe('enrichment_first_violation');
  });

  it('runs for recued (kernel)', () => {
    const recipe = makeRecipe('recued', [
      {
        id: 'read_mail',
        transform: 'pluck',
        input: '{{data.mail.msg_1.summary}}',
        path: 'value',
      },
    ]);
    const issues = lintEnrichmentFirst(recipe);
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('D-125 P6.3 — allowance shapes', () => {
  it('allows the ref inside an enrichment-or-fetch step', () => {
    const recipe = makeRecipe('recued-core', [
      {
        id: 'rollup',
        transform: 'enrichment-or-fetch',
        ref: '{{data.calendar.evt_1.calendar_event_rollup}}',
        fallback_step: 'fetch_rollup',
      },
    ]);
    expect(lintEnrichmentFirst(recipe)).toEqual([]);
  });

  it('allows the ref in a fallback_step', () => {
    const recipe = makeRecipe('recued-core', [
      {
        id: 'rollup',
        transform: 'enrichment-or-fetch',
        ref: '{{data.calendar.evt_1.calendar_event_rollup}}',
        fallback_step: 'fetch_rollup',
      },
      {
        id: 'fetch_rollup',
        ingredient: 'calendar-get',
        skip_when: '{{step.rollup.value}} is_not_null',
        input: { record_id: '{{data.calendar.evt_1.brief}}' },
      },
    ]);
    expect(lintEnrichmentFirst(recipe)).toEqual([]);
  });

  it('allows steps tagged with the // no-enrich: marker', () => {
    const recipe = makeRecipe('recued-core', [
      {
        id: 'auth_probe',
        ingredient: 'connection-call',
        description: '// no-enrich: auth probe must hit the live endpoint',
        input: { url: '{{connection.api.hubspot.config.base_url}}/me' },
      },
    ]);
    expect(lintEnrichmentFirst(recipe)).toEqual([]);
  });

  it('flags refs in steps without any allowance', () => {
    const recipe = makeRecipe('recued-core', [
      {
        id: 'read_summary',
        transform: 'pluck',
        input: '{{data.mail.msg_1.summary}}',
        path: 'value',
      },
    ]);
    const issues = lintEnrichmentFirst(recipe);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.step_id).toBe('read_summary');
    expect(issues[0]!.ref).toBe('data.mail.msg_1.summary');
  });
});

describe('D-125 P6.3 — exempt namespaces', () => {
  it('exempts data.shared.*', () => {
    const recipe = makeRecipe('recued-core', [
      {
        id: 'read_shared',
        transform: 'pluck',
        input: '{{data.shared.foo}}',
        path: 'value',
      },
    ]);
    expect(lintEnrichmentFirst(recipe)).toEqual([]);
  });

  it('exempts data.memory.* and data.audit.*', () => {
    const recipe = makeRecipe('recued-core', [
      {
        id: 'read_mem',
        transform: 'pluck',
        input: '{{data.memory.entries}}',
        path: 'value',
      },
      {
        id: 'read_audit',
        transform: 'pluck',
        input: '{{data.audit.entries}}',
        path: 'value',
      },
    ]);
    expect(lintEnrichmentFirst(recipe)).toEqual([]);
  });

  it('exempts data.enrichment.* (already-the-substrate)', () => {
    const recipe = makeRecipe('recued-core', [
      {
        id: 'read_enrich',
        transform: 'pluck',
        input: '{{data.enrichment.calendar.evt_1.calendar_event_rollup}}',
        path: 'value',
      },
    ]);
    expect(lintEnrichmentFirst(recipe)).toEqual([]);
  });

  it('exempts data.contact.* (base canonical fields)', () => {
    const recipe = makeRecipe('recued-core', [
      {
        id: 'read_contact',
        transform: 'pluck',
        input: '{{data.contact.bob@x.com.email}}',
        path: 'value',
      },
    ]);
    expect(lintEnrichmentFirst(recipe)).toEqual([]);
  });

  it('flags data.mail and data.calendar reads', () => {
    const recipe = makeRecipe('recued-core', [
      {
        id: 'read_calendar',
        transform: 'pluck',
        input: '{{data.calendar.evt_1.calendar_event_rollup}}',
        path: 'value',
      },
    ]);
    const issues = lintEnrichmentFirst(recipe);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.ref).toBe('data.calendar.evt_1.calendar_event_rollup');
  });
});

describe('D-125 P6.3 — connection.* refs', () => {
  it('flags connection.<kind>.<name>.<field> reads', () => {
    const recipe = makeRecipe('recued-core', [
      {
        id: 'use_hubspot',
        ingredient: 'http-request',
        input: { url: '{{connection.api.hubspot.config.base_url}}' },
      },
    ]);
    const issues = lintEnrichmentFirst(recipe);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.ref).toBe('connection.api.hubspot.config.base_url');
  });
});
