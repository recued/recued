import { describe, expect, it } from 'vitest';

import {
  PII_LIST_SEGMENT,
  deriveAutoPiiFieldInjections,
  tracePiiFlow,
} from '@recued/contracts';
import type {
  PiiEgressFinding,
  PiiPathProfile,
  PiiSourceClassifier,
} from '@recued/contracts';

const classifierFrom = (
  profiles: Record<string, PiiPathProfile>,
): PiiSourceClassifier => (step) => {
  if (typeof step.ingredient === 'string' && profiles[step.ingredient]) {
    return profiles[step.ingredient];
  }
  if (typeof step.op === 'string' && profiles[step.op]) {
    return profiles[step.op];
  }
  return undefined;
};

const trace = (
  steps: unknown[],
  profiles: Record<string, PiiPathProfile> = {},
) => tracePiiFlow({ steps }, classifierFrom(profiles));

const finding = (
  t: ReturnType<typeof tracePiiFlow>,
  stepId: string,
): PiiEgressFinding => {
  const f = t.findings.find((candidate) => candidate.step_id === stepId);
  expect(f).toBeDefined();
  return f as PiiEgressFinding;
};

const uncoveredOf = (f: PiiEgressFinding) =>
  f.uncovered
    .map((u) => ({
      input_key: u.input_key,
      path: u.path,
      kinds: [...u.kinds],
    }))
    .sort((a, b) => `${a.input_key}:${a.path}`.localeCompare(`${b.input_key}:${b.path}`));

const pathsOf = (f: PiiEgressFinding) => uncoveredOf(f).map((u) => u.path);

const tag = (path: string, kind: string) => ({ path, kind });

describe('tracePiiFlow', () => {
  it('trusts malformed recipes and steps without ids', () => {
    for (const input of [
      null,
      [],
      { steps: 'x' },
      { steps: [{ ingredient: 'contacts' }] },
      { steps: [null, []] },
    ]) {
      expect(tracePiiFlow(input, classifierFrom({
        contacts: { email: ['email'] },
      }))).toEqual({
        findings: [],
        untraced_steps: [],
        pii_untraced: false,
      });
    }
  });

  it('reports a classified source field reaching llm.data directly', () => {
    const t = trace([
      { id: 'contact', ingredient: 'contact-source' },
      { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.contact}}' } },
    ], {
      'contact-source': { email: ['email'] },
    });

    const f = finding(t, 'ai');
    expect(f.verdict).toBe('pii_reaches_llm');
    expect(uncoveredOf(f)).toEqual([
      { input_key: 'llm.data', path: 'email', kinds: ['email'] },
    ]);
  });

  it('§5 — a core-ai-* step is an LLM egress point too (PII tracing parity)', () => {
    // core-ai-classify reaches the LLM exactly like ai-classify, so PII flowing
    // into it must surface the same egress finding (not be silently untraced).
    const t = trace([
      { id: 'contact', ingredient: 'contact-source' },
      { id: 'ai', ingredient: 'core-ai-classify', input: { 'llm.data': '{{step.contact}}' } },
    ], {
      'contact-source': { email: ['email'] },
    });

    const f = finding(t, 'ai');
    expect(f.verdict).toBe('pii_reaches_llm');
    expect(uncoveredOf(f)).toEqual([
      { input_key: 'llm.data', path: 'email', kinds: ['email'] },
    ]);
  });

  it('applies curated AI output profiles only to downstream model consumers', () => {
    const steps = [
      {
        id: 'summary',
        ingredient: 'ai-summarize',
        input: { 'llm.data': { file_ref: 'ref-owner-authorized' } },
      },
      {
        id: 'draft_uncovered',
        ingredient: 'ai-generate',
        input: { 'llm.data': { summary: '{{step.summary.summary}}' } },
      },
      {
        id: 'draft_declared',
        ingredient: 'ai-generate',
        input: {
          'llm.data': { summary: '{{step.summary.summary}}' },
          'llm.pii_fields': { summary: 'content' },
        },
      },
    ];
    const t = trace(steps, {
      'ai-summarize': { summary: ['content'] },
    });

    expect(finding(t, 'summary')).toMatchObject({ verdict: 'clean', kinds: [] });
    expect(finding(t, 'draft_uncovered')).toMatchObject({
      verdict: 'content_reaches_llm',
      uncovered: [{ input_key: 'llm.data', path: 'summary', kinds: ['content'] }],
    });
    expect(finding(t, 'draft_declared').verdict).toBe('protected_declared');
  });

  it('preserves filter sort and slice output profiles', () => {
    const listEmail = `${PII_LIST_SEGMENT}.email`;
    const t = trace([
      { id: 'contacts', ingredient: 'contact-list' },
      { id: 'filtered', transform: 'filter', array: '{{step.contacts}}' },
      { id: 'sorted', transform: 'sort', array: '{{step.contacts}}' },
      { id: 'sliced', transform: 'slice', array: '{{step.contacts}}' },
      { id: 'ai_filtered', ingredient: 'ai-classify', input: { 'llm.data': '{{step.filtered}}' } },
      { id: 'ai_sorted', ingredient: 'ai-classify', input: { 'llm.data': '{{step.sorted}}' } },
      { id: 'ai_sliced', ingredient: 'ai-classify', input: { 'llm.data': '{{step.sliced}}' } },
    ], {
      'contact-list': { [listEmail]: ['email'] },
    });

    expect(pathsOf(finding(t, 'ai_filtered'))).toEqual([listEmail]);
    expect(pathsOf(finding(t, 'ai_sorted'))).toEqual([listEmail]);
    expect(pathsOf(finding(t, 'ai_sliced'))).toEqual([listEmail]);
  });

  it('destroys count math and date_diff values', () => {
    const t = trace([
      { id: 'contact', ingredient: 'contact-source' },
      { id: 'counted', transform: 'count', array: '{{step.contact.email}}' },
      { id: 'scored', transform: 'math', expression: '{{step.contact.email}} * 2' },
      { id: 'aged', transform: 'date_diff', start: '{{step.contact.email}}', end: '{{step.contact.phone}}' },
      {
        id: 'ai',
        ingredient: 'ai-classify',
        input: {
          'llm.data': {
            counted: '{{step.counted}}',
            scored: '{{step.scored}}',
            aged: '{{step.aged}}',
          },
        },
      },
    ], {
      'contact-source': { email: ['email'], phone: ['phone'] },
    });

    expect(finding(t, 'ai').verdict).toBe('clean');
  });

  it('collapses interpolation and rendering transforms to whole-value taint', () => {
    const t = trace([
      { id: 'contact', ingredient: 'contact-source' },
      { id: 'lowered', transform: 'lowercase', input: '{{step.contact.email}}' },
      { id: 'trimmed', transform: 'trim', input: '{{step.contact.email}}' },
      { id: 'rendered', transform: 'template', template: 'email={{step.contact.email}}' },
      { id: 'summary', transform: 'to_summary', fields: { e: '{{step.contact.email}}' } },
      { id: 'joined', transform: 'join', array: ['{{step.contact.email}}'] },
      { id: 'ai_interp', ingredient: 'ai-classify', input: { 'llm.data': 'x {{step.contact.email}}' } },
      { id: 'ai_lowered', ingredient: 'ai-classify', input: { 'llm.data': '{{step.lowered}}' } },
      { id: 'ai_trimmed', ingredient: 'ai-classify', input: { 'llm.data': '{{step.trimmed}}' } },
      { id: 'ai_rendered', ingredient: 'ai-classify', input: { 'llm.data': '{{step.rendered}}' } },
      { id: 'ai_summary', ingredient: 'ai-classify', input: { 'llm.data': '{{step.summary}}' } },
      { id: 'ai_joined', ingredient: 'ai-classify', input: { 'llm.data': '{{step.joined}}' } },
    ], {
      'contact-source': { email: ['email'] },
    });

    for (const id of ['ai_interp', 'ai_lowered', 'ai_trimmed', 'ai_rendered', 'ai_summary', 'ai_joined']) {
      expect(uncoveredOf(finding(t, id))).toEqual([
        { input_key: 'llm.data', path: '', kinds: ['email'] },
      ]);
    }
  });

  it('unions coalesce values without collapsing list element structure', () => {
    const listEmail = `${PII_LIST_SEGMENT}.email`;
    const t = trace([
      { id: 'contacts', ingredient: 'contact-list' },
      { id: 'coalesced', transform: 'coalesce', values: ['{{step.contacts}}', []] },
      { id: 'ai_list', ingredient: 'ai-classify', input: { 'llm.data': '{{step.coalesced}}' } },
      { id: 'ai_length', ingredient: 'ai-classify', input: { 'llm.data': '{{step.coalesced.length}}' } },
    ], {
      'contact-list': { [listEmail]: ['email'] },
    });

    expect(pathsOf(finding(t, 'ai_list'))).toEqual([listEmail]);
    expect(finding(t, 'ai_length').verdict).toBe('clean');
  });

  it('unions switch case templates as whole-value taint', () => {
    const t = trace([
      { id: 'contact', ingredient: 'contact-source' },
      {
        id: 'chosen',
        transform: 'switch',
        cases: {
          email: 'email={{step.contact.email}}',
          phone: 'phone={{step.contact.phone}}',
        },
      },
      { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.chosen}}' } },
    ], {
      'contact-source': { email: ['email'], phone: ['phone'] },
    });

    expect(uncoveredOf(finding(t, 'ai'))).toEqual([
      { input_key: 'llm.data', path: '', kinds: ['email', 'phone'] },
    ]);
  });

  it('drops omitted fields, remaps renamed fields, and adds set fields', () => {
    const t = trace([
      { id: 'contact', ingredient: 'contact-source' },
      { id: 'omitted', transform: 'omit', source: '{{step.contact}}', fields: ['phone'] },
      { id: 'renamed', transform: 'rename', source: '{{step.contact}}', mapping: { email: 'primary_email' } },
      { id: 'set', transform: 'set', source: '{{step.contact}}', field: 'copy.email', value: '{{step.contact.email}}' },
      { id: 'ai_omit', ingredient: 'ai-classify', input: { 'llm.data': '{{step.omitted}}' } },
      { id: 'ai_rename', ingredient: 'ai-classify', input: { 'llm.data': '{{step.renamed}}' } },
      { id: 'ai_set', ingredient: 'ai-classify', input: { 'llm.data': '{{step.set}}' } },
    ], {
      'contact-source': { email: ['email'], name: ['name'], phone: ['phone'] },
    });

    expect(pathsOf(finding(t, 'ai_omit'))).toEqual(['email', 'name']);
    expect(pathsOf(finding(t, 'ai_rename'))).toEqual(['name', 'phone', 'primary_email']);
    expect(pathsOf(finding(t, 'ai_set'))).toEqual(['copy.email', 'email', 'name', 'phone']);
  });

  it('remaps prefixed object keys without laundering their classified values', () => {
    const t = trace([
      { id: 'response', ingredient: 'form-response-source' },
      {
        id: 'values',
        transform: 'prefix_keys',
        source: '{{step.response}}',
        prefix: 'response.',
      },
      { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.values}}' } },
    ], {
      'form-response-source': { email: ['email'], full_name: ['name'] },
    });

    expect(pathsOf(finding(t, 'ai'))).toEqual(['response.email', 'response.full_name']);
    expect(t.untraced_steps).toEqual([]);
  });

  it('fails PII tracing closed when prefix_keys uses a dynamic prefix', () => {
    const t = trace([
      { id: 'response', ingredient: 'form-response-source' },
      {
        id: 'values',
        transform: 'prefix_keys',
        source: '{{step.response}}',
        prefix: '{{config.prefix}}',
      },
      { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.values}}' } },
    ], {
      'form-response-source': { email: ['email'] },
    });

    expect(finding(t, 'ai').verdict).toBe('pii_untraced');
    expect(t.untraced_steps).toEqual([{
      step_id: 'values',
      reason: "prefix_keys 'prefix' is not a static non-empty string",
    }]);
  });

  it('maps expression object projections through only projected refs', () => {
    const t = trace([
      { id: 'contacts', ingredient: 'contact-list' },
      {
        id: 'projected',
        transform: 'map',
        array: '{{step.contacts}}',
        expression: {
          contact: '{{item.email}}',
          display: '{{item.first}} {{item.last}}',
        },
      },
      { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.projected}}' } },
    ], {
      'contact-list': {
        [`${PII_LIST_SEGMENT}.email`]: ['email'],
        [`${PII_LIST_SEGMENT}.first`]: ['name'],
        [`${PII_LIST_SEGMENT}.last`]: ['name'],
        [`${PII_LIST_SEGMENT}.unused`]: ['phone'],
      },
    });

    expect(uncoveredOf(finding(t, 'ai'))).toEqual([
      { input_key: 'llm.data', path: `${PII_LIST_SEGMENT}.contact`, kinds: ['email'] },
      { input_key: 'llm.data', path: `${PII_LIST_SEGMENT}.display`, kinds: ['name'] },
    ]);
  });

  it('destroys item-only operator expressions in map context', () => {
    const t = trace([
      { id: 'rows', ingredient: 'row-list' },
      { id: 'math', transform: 'map', array: '{{step.rows}}', expression: '{{item.a}} * {{item.b}} / 100' },
      { id: 'name_join', transform: 'map', array: '{{step.rows}}', expression: '{{item.first}}-{{item.last}}' },
      { id: 'ai_math', ingredient: 'ai-classify', input: { 'llm.data': '{{step.math}}' } },
      { id: 'ai_name_join', ingredient: 'ai-classify', input: { 'llm.data': '{{step.name_join}}' } },
    ], {
      'row-list': {
        [`${PII_LIST_SEGMENT}.a`]: ['external_id'],
        [`${PII_LIST_SEGMENT}.b`]: ['account_id'],
        [`${PII_LIST_SEGMENT}.first`]: ['name'],
        [`${PII_LIST_SEGMENT}.last`]: ['name'],
      },
    });

    expect(finding(t, 'ai_math').verdict).toBe('clean');
    expect(finding(t, 'ai_name_join').verdict).toBe('clean');
  });

  it('preserves generic interpolation with an operator outside map expression context', () => {
    const t = trace([
      { id: 'x', ingredient: 'contact-source' },
      {
        id: 'ai',
        ingredient: 'ai-classify',
        input: { 'llm.data': '{{step.x.first_name}}-{{step.x.last_name}}' },
      },
    ], {
      'contact-source': { first_name: ['name'], last_name: ['name'] },
    });

    expect(uncoveredOf(finding(t, 'ai'))).toEqual([
      { input_key: 'llm.data', path: '', kinds: ['name'] },
    ]);
  });

  it('keeps map item profiles while date_diff destroys the derived output_field', () => {
    const t = trace([
      { id: 'contacts', ingredient: 'contact-list' },
      {
        id: 'mapped',
        transform: 'map',
        array: '{{step.contacts}}',
        field: 'dob',
        apply: 'date_diff',
        output_field: 'age',
      },
      { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.mapped}}' } },
    ], {
      'contact-list': {
        [`${PII_LIST_SEGMENT}.dob`]: ['content'],
        [`${PII_LIST_SEGMENT}.profile.email`]: ['email'],
      },
    });

    expect(pathsOf(finding(t, 'ai'))).toEqual([
      `${PII_LIST_SEGMENT}.dob`,
      `${PII_LIST_SEGMENT}.profile.email`,
    ]);
    expect(pathsOf(finding(t, 'ai'))).not.toContain(`${PII_LIST_SEGMENT}.age`);
  });

  it('keeps group_by key taint and destroys aggregate values', () => {
    const t = trace([
      { id: 'contacts', ingredient: 'contact-list' },
      {
        id: 'grouped',
        transform: 'group_by',
        array: '{{step.contacts}}',
        field: 'email',
        aggregates: { count: 'count', total: { op: 'sum', field: 'amount' } },
      },
      { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.grouped}}' } },
    ], {
      'contact-list': {
        [`${PII_LIST_SEGMENT}.email`]: ['email'],
        [`${PII_LIST_SEGMENT}.amount`]: ['account_id'],
      },
    });

    expect(uncoveredOf(finding(t, 'ai'))).toEqual([
      { input_key: 'llm.data', path: `${PII_LIST_SEGMENT}.email`, kinds: ['email'] },
    ]);
  });

  it('honors list-boundary reads, item picks, and pluck rewrapping', () => {
    const listEmail = `${PII_LIST_SEGMENT}.email`;
    const t = trace([
      { id: 'x', ingredient: 'contact-list' },
      { id: 'mapped', transform: 'map', array: '{{step.x}}', expression: { email: '{{item.email}}' } },
      { id: 'found', transform: 'find', array: '{{step.x}}' },
      { id: 'min', transform: 'min_by', array: '{{step.x}}' },
      { id: 'max', transform: 'max_by', array: '{{step.x}}' },
      { id: 'emails', transform: 'pluck', array: '{{step.x}}', field: 'email' },
      { id: 'ai_bad_ref', ingredient: 'ai-classify', input: { 'llm.data': '{{step.x.email}}' } },
      { id: 'ai_index_ref', ingredient: 'ai-classify', input: { 'llm.data': '{{step.x.0.email}}' } },
      { id: 'ai_mapped', ingredient: 'ai-classify', input: { 'llm.data': '{{step.mapped}}' } },
      { id: 'ai_found', ingredient: 'ai-classify', input: { 'llm.data': '{{step.found}}' } },
      { id: 'ai_min', ingredient: 'ai-classify', input: { 'llm.data': '{{step.min}}' } },
      { id: 'ai_max', ingredient: 'ai-classify', input: { 'llm.data': '{{step.max}}' } },
      { id: 'ai_pluck', ingredient: 'ai-classify', input: { 'llm.data': '{{step.emails}}' } },
    ], {
      'contact-list': { [listEmail]: ['email'] },
    });

    expect(finding(t, 'ai_bad_ref').verdict).toBe('clean');
    expect(pathsOf(finding(t, 'ai_index_ref'))).toEqual(['']);
    expect(pathsOf(finding(t, 'ai_mapped'))).toEqual([listEmail]);
    expect(pathsOf(finding(t, 'ai_found'))).toEqual(['email']);
    expect(pathsOf(finding(t, 'ai_min'))).toEqual(['email']);
    expect(pathsOf(finding(t, 'ai_max'))).toEqual(['email']);
    expect(pathsOf(finding(t, 'ai_pluck'))).toEqual([PII_LIST_SEGMENT]);
  });

  it('models pii-protect full, partial, omitted, dynamic, and content tags', () => {
    const t = trace([
      { id: 'contact', ingredient: 'contact-source' },
      {
        id: 'full',
        transform: 'pii-protect',
        data: '{{step.contact}}',
        fields: [tag('email', 'email'), tag('name', 'name'), tag('phone', 'phone')],
      },
      {
        id: 'partial',
        transform: 'pii-protect',
        data: '{{step.contact}}',
        fields: [tag('email', 'email')],
      },
      { id: 'omitted', transform: 'pii-protect', data: '{{step.contact}}' },
      { id: 'dynamic', transform: 'pii-protect', data: '{{step.contact}}', fields: '{{step.tags}}' },
      { id: 'note', ingredient: 'note-source' },
      { id: 'content_only', transform: 'pii-protect', data: '{{step.note}}', fields: [tag('note', 'content')] },
      {
        id: 'content_seeded',
        transform: 'pii-protect',
        data: '{{step.note}}',
        fields: [tag('email', 'email'), tag('note', 'content')],
      },
      { id: 'ai_full', ingredient: 'ai-classify', input: { 'llm.data': '{{step.full.aliased}}' } },
      { id: 'ai_partial', ingredient: 'ai-classify', input: { 'llm.data': '{{step.partial.aliased}}' } },
      { id: 'ai_omitted', ingredient: 'ai-classify', input: { 'llm.data': '{{step.omitted.aliased}}' } },
      { id: 'ai_dynamic', ingredient: 'ai-classify', input: { 'llm.data': '{{step.dynamic.aliased}}' } },
      { id: 'ai_content_only', ingredient: 'ai-classify', input: { 'llm.data': '{{step.content_only.aliased}}' } },
      { id: 'ai_content_seeded', ingredient: 'ai-classify', input: { 'llm.data': '{{step.content_seeded.aliased}}' } },
    ], {
      'contact-source': { email: ['email'], name: ['name'], phone: ['phone'] },
      'note-source': { email: ['email'], note: ['email'] },
    });

    expect(finding(t, 'ai_full').verdict).toBe('protected_alias');

    const partial = finding(t, 'ai_partial');
    expect(partial.verdict).toBe('pii_reaches_llm');
    expect(partial.kinds).toEqual(['alias:email', 'name', 'phone']);
    expect(pathsOf(partial)).toEqual(['name', 'phone']);

    expect(finding(t, 'ai_omitted').verdict).toBe('pii_reaches_llm');

    const dynamic = finding(t, 'ai_dynamic');
    expect(dynamic.verdict).toBe('pii_reaches_llm');
    expect(dynamic.untraced).toBe(true);
    expect(t.untraced_steps).toContainEqual({
      step_id: 'dynamic',
      reason: "pii-protect 'fields' is not a static tag array",
    });

    expect(finding(t, 'ai_content_only').verdict).toBe('pii_reaches_llm');
    expect(pathsOf(finding(t, 'ai_content_only'))).toEqual(['email', 'note']);
    expect(finding(t, 'ai_content_seeded').verdict).toBe('protected_alias');
  });

  it('models pii-restore as reintroducing original kinds under restored paths', () => {
    const t = trace([
      { id: 'contact', ingredient: 'contact-source' },
      {
        id: 'protected',
        transform: 'pii-protect',
        data: '{{step.contact}}',
        fields: [tag('email', 'email')],
      },
      {
        id: 'restored',
        transform: 'pii-restore',
        data: '{{step.protected.aliased}}',
        ledger_handle: '{{step.protected.ledger_handle}}',
      },
      { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.restored}}' } },
    ], {
      'contact-source': { email: ['email'] },
    });

    expect(uncoveredOf(finding(t, 'ai'))).toEqual([
      { input_key: 'llm.data', path: 'restored', kinds: ['email'] },
      { input_key: 'llm.data', path: 'restored.email', kinds: ['email'] },
    ]);
  });

  it('models hash_replace bare fields, ineffective path forms, mappings, and hash_restore', () => {
    const t = trace([
      { id: 'contact', ingredient: 'nested-contact' },
      { id: 'hash_bare', transform: 'hash_replace', data: '{{step.contact}}', fields: ['email'] },
      { id: 'hash_path', transform: 'hash_replace', data: '{{step.contact}}', fields: ['contact.email', 'contacts[].email'] },
      { id: 'restored', transform: 'hash_restore', data: '{{step.hash_bare.data}}' },
      { id: 'ai_bare', ingredient: 'ai-classify', input: { 'llm.data': '{{step.hash_bare.data}}' } },
      { id: 'ai_path', ingredient: 'ai-classify', input: { 'llm.data': '{{step.hash_path.data}}' } },
      { id: 'ai_mapping', ingredient: 'ai-classify', input: { 'llm.data': '{{step.hash_bare.mapping}}' } },
      { id: 'ai_restored', ingredient: 'ai-classify', input: { 'llm.data': '{{step.restored}}' } },
    ], {
      'nested-contact': {
        'contact.email': ['email'],
        'contact.name': ['name'],
        [`contacts.${PII_LIST_SEGMENT}.email`]: ['email'],
      },
    });

    expect(finding(t, 'ai_bare').kinds).toEqual(['alias:email', 'name']);
    expect(pathsOf(finding(t, 'ai_bare'))).toEqual(['contact.name']);
    expect(pathsOf(finding(t, 'ai_path'))).toEqual([
      'contact.email',
      'contact.name',
      `contacts.${PII_LIST_SEGMENT}.email`,
    ]);
    expect(uncoveredOf(finding(t, 'ai_mapping'))).toEqual([
      { input_key: 'llm.data', path: '', kinds: ['email', 'name'] },
    ]);
    expect(pathsOf(finding(t, 'ai_restored'))).toEqual([
      'data.contact.email',
      'data.contact.name',
      `data.contacts.${PII_LIST_SEGMENT}.email`,
    ]);
  });

  it('credits legacy bare pii_fields at any depth and rejects path-form entries', () => {
    const profiles: Record<string, PiiPathProfile> = {
      'contact-list': {
        [`${PII_LIST_SEGMENT}.email`]: ['email'],
        [`${PII_LIST_SEGMENT}.profile.phone`]: ['phone'],
      },
    };

    const covered = trace([
      { id: 'contacts', ingredient: 'contact-list' },
      {
        id: 'ai',
        ingredient: 'ai-classify',
        pii_fields: ['email', 'phone'],
        input: { 'llm.data': '{{step.contacts}}' },
      },
    ], profiles);
    expect(finding(covered, 'ai').verdict).toBe('protected_declared');

    const leaking = trace([
      { id: 'contacts', ingredient: 'contact-list' },
      {
        id: 'ai',
        ingredient: 'ai-classify',
        pii_fields: [`${PII_LIST_SEGMENT}.email`, 'profile.phone'],
        input: { 'llm.data': '{{step.contacts}}' },
      },
    ], profiles);
    expect(finding(leaking, 'ai').verdict).toBe('pii_reaches_llm');
  });

  // A legacy entry over free text is credited as cover, but the step-level hash
  // hides nothing inside text: the validator warns from `legacy_content`.
  it('records the free-text paths a legacy bare-name entry names', () => {
    const profiles: Record<string, PiiPathProfile> = {
      'mail-source': { subject: ['content'], from: ['email'] },
      'mail-list': { [`${PII_LIST_SEGMENT}.subject`]: ['content'], [`${PII_LIST_SEGMENT}.from`]: ['email'] },
    };
    const t = trace([
      { id: 'mail', ingredient: 'mail-source' },
      { id: 'mails', ingredient: 'mail-list' },
      {
        id: 'ai',
        ingredient: 'ai-classify',
        pii_fields: ['subject', 'from'],
        input: { 'llm.data': '{{step.mail}}' },
      },
      {
        // ⛔ The dispatch hashes before the AI executor, so a `content` tag on the
        // same path only ever sees the token: recorded all the same.
        id: 'ai_tagged',
        ingredient: 'ai-classify',
        pii_fields: ['subject'],
        input: { 'llm.data': '{{step.mail}}', 'llm.pii_fields': { subject: 'content', from: 'email' } },
      },
      {
        id: 'ai_batch',
        ingredient: 'ai-classify',
        pii_fields: ['subject', 'from'],
        input: { 'llm.data': '{{step.mails}}', 'llm.id_field': 'message_id' },
      },
    ], profiles);

    expect(finding(t, 'ai').verdict).toBe('protected_declared');
    expect(finding(t, 'ai').legacy_content).toEqual([
      { input_key: 'llm.data', path: 'subject', entry: 'subject' },
    ]);
    expect(finding(t, 'ai_tagged').legacy_content).toEqual([
      { input_key: 'llm.data', path: 'subject', entry: 'subject' },
    ]);
    expect(finding(t, 'ai_batch').legacy_content).toEqual([
      { input_key: 'llm.data', path: `${PII_LIST_SEGMENT}.subject`, entry: 'subject' },
    ]);
  });

  // The hash replaces everything under a named key, so any key along a path covers it:
  // a list the classifier profiles as a plain path (mail `to`), a list path, and an
  // ancestor. ⛔ It used to credit the LAST key only, for a walk that left a list in clear.
  it('credits any named key along the path — the list, its items, an ancestor — for pii_fields and hash_replace alike', () => {
    const profiles: Record<string, PiiPathProfile> = {
      'mail-source': { from: ['email'], to: ['email'], 'contact.email': ['email'], [`cc.${PII_LIST_SEGMENT}`]: ['email'], 'thread.subject': ['content'] },
    };
    const t = trace([
      { id: 'mail', ingredient: 'mail-source' },
      {
        id: 'ai',
        ingredient: 'ai-classify',
        pii_fields: ['to', 'cc', 'contact', 'thread'],
        input: { 'llm.data': '{{step.mail}}' },
      },
      { id: 'hashed', transform: 'hash_replace', data: '{{step.mail}}', fields: ['to', 'cc', 'contact', 'thread'] },
      { id: 'ai_hashed', ingredient: 'ai-classify', input: { 'llm.data': '{{step.hashed.data}}' } },
    ], profiles);

    expect(uncoveredOf(finding(t, 'ai'))).toEqual([{ input_key: 'llm.data', path: 'from', kinds: ['email'] }]);
    expect(finding(t, 'ai').legacy_content).toEqual([
      { input_key: 'llm.data', path: 'thread.subject', entry: 'thread' },
    ]);
    expect(uncoveredOf(finding(t, 'ai_hashed'))).toEqual([{ input_key: 'llm.data', path: 'from', kinds: ['email'] }]);
  });

  it('records nothing when the entries name identifiers, or nothing names the text', () => {
    const profiles: Record<string, PiiPathProfile> = { 'mail-source': { subject: ['content'], from: ['email'] } };
    const t = trace([
      { id: 'mail', ingredient: 'mail-source' },
      { id: 'ai_identifier', ingredient: 'ai-classify', pii_fields: ['from'], input: { 'llm.data': '{{step.mail}}' } },
      { id: 'ai_none', ingredient: 'ai-classify', input: { 'llm.data': '{{step.mail}}' } },
    ], profiles);

    expect(finding(t, 'ai_identifier').legacy_content).toEqual([]);
    expect(finding(t, 'ai_none').legacy_content).toEqual([]);
  });

  it('applies llm.pii_fields only to exact contracted llm.data paths', () => {
    const t = trace([
      { id: 'record', ingredient: 'record-source' },
      { id: 'contacts', ingredient: 'contact-list' },
      {
        id: 'ai_exact',
        ingredient: 'ai-classify',
        input: { 'llm.data': '{{step.record}}', 'llm.pii_fields': { 'profile.email': 'email' } },
      },
      {
        id: 'ai_root',
        ingredient: 'ai-classify',
        input: { 'llm.data': '{{step.record}}', 'llm.pii_fields': { profile: 'email' } },
      },
      {
        id: 'ai_prompt',
        ingredient: 'ai-prompt',
        input: { 'llm.data': '{{step.record}}', 'llm.pii_fields': { 'profile.email': 'email' } },
      },
      {
        id: 'ai_batch',
        ingredient: 'ai-classify',
        input: {
          'llm.data': '{{step.contacts}}',
          'llm.id_field': 'id',
          'llm.pii_fields': { email: 'email' },
        },
      },
      {
        id: 'ai_no_batch',
        ingredient: 'ai-classify',
        input: {
          'llm.data': '{{step.contacts}}',
          'llm.pii_fields': { email: 'email' },
        },
      },
    ], {
      'record-source': { 'profile.email': ['email'] },
      'contact-list': { [`${PII_LIST_SEGMENT}.email`]: ['email'] },
    });

    expect(finding(t, 'ai_exact').verdict).toBe('protected_declared');
    expect(finding(t, 'ai_root').verdict).toBe('pii_reaches_llm');
    expect(finding(t, 'ai_prompt').verdict).toBe('pii_reaches_llm');
    expect(finding(t, 'ai_batch').verdict).toBe('protected_declared');
    expect(finding(t, 'ai_batch').declared.batch).toBe(true);
    expect(finding(t, 'ai_no_batch').verdict).toBe('pii_reaches_llm');
    expect(finding(t, 'ai_no_batch').declared.batch).toBe(false);
  });

  it('orders verdicts across clean, protected, content, pii, and untraced states', () => {
    const t = trace([
      { id: 'contact', ingredient: 'contact-source' },
      { id: 'content', ingredient: 'content-source' },
      {
        id: 'alias',
        transform: 'pii-protect',
        data: '{{step.contact}}',
        fields: [tag('email', 'email')],
      },
      { id: 'opaque', transform: 'new_transform', input: '{{step.contact}}' },
      { id: 'ai_clean', ingredient: 'ai-classify', input: { 'llm.data': 'literal' } },
      { id: 'ai_alias', ingredient: 'ai-classify', input: { 'llm.data': '{{step.alias.aliased}}' } },
      {
        id: 'ai_declared',
        ingredient: 'ai-classify',
        input: { 'llm.data': '{{step.contact}}', 'llm.pii_fields': { email: 'email' } },
      },
      { id: 'ai_content', ingredient: 'ai-classify', input: { 'llm.data': '{{step.content}}' } },
      { id: 'ai_pii', ingredient: 'ai-classify', input: { 'llm.data': '{{step.contact}}' } },
      { id: 'ai_untraced', ingredient: 'ai-classify', input: { 'llm.data': '{{step.opaque}}' } },
      {
        id: 'ai_pii_with_untraced',
        ingredient: 'ai-classify',
        input: { 'llm.data': { opaque: '{{step.opaque}}', email: '{{step.contact.email}}' } },
      },
    ], {
      'contact-source': { email: ['email'] },
      'content-source': { summary: ['content'] },
    });

    expect(finding(t, 'ai_clean')).toMatchObject({ verdict: 'clean', kinds: [] });
    expect(finding(t, 'ai_alias').verdict).toBe('protected_alias');
    expect(finding(t, 'ai_declared').verdict).toBe('protected_declared');
    expect(finding(t, 'ai_content').verdict).toBe('content_reaches_llm');
    expect(finding(t, 'ai_pii').verdict).toBe('pii_reaches_llm');
    expect(finding(t, 'ai_untraced').verdict).toBe('pii_untraced');

    const concreteLeak = finding(t, 'ai_pii_with_untraced');
    expect(concreteLeak.verdict).toBe('pii_reaches_llm');
    expect(concreteLeak.untraced).toBe(true);
  });

  it('propagates unknown transforms as untraced and resolves foreach item refs', () => {
    const t = trace([
      { id: 'contacts', ingredient: 'contact-list' },
      { id: 'opaque', transform: 'future_transform', input: '{{step.contacts}}' },
      {
        id: 'foreach_set',
        foreach: '{{step.contacts}}',
        transform: 'set',
        source: {},
        field: 'email',
        value: '{{item.email}}',
      },
      { id: 'ai_opaque', ingredient: 'ai-classify', input: { 'llm.data': '{{step.opaque}}' } },
      { id: 'ai_foreach', ingredient: 'ai-classify', input: { 'llm.data': '{{step.foreach_set}}' } },
    ], {
      'contact-list': { [`${PII_LIST_SEGMENT}.email`]: ['email'] },
    });

    expect(t.untraced_steps).toEqual([
      { step_id: 'opaque', reason: "transform 'future_transform' has no PII-flow rule" },
    ]);
    expect(finding(t, 'ai_opaque').verdict).toBe('pii_untraced');
    expect(uncoveredOf(finding(t, 'ai_foreach'))).toEqual([
      { input_key: 'llm.data', path: 'email', kinds: ['email'] },
    ]);
  });

  it('ignores non-payload llm keys but traces other llm keys', () => {
    const t = trace([
      { id: 'contact', ingredient: 'contact-source' },
      {
        id: 'ai_hint',
        ingredient: 'ai-classify',
        input: { 'llm.model_hint': '{{step.contact.email}}' },
      },
      {
        id: 'ai_data_block',
        ingredient: 'ai-classify',
        input: { 'llm.data_block': '{{step.contact.email}}' },
      },
    ], {
      'contact-source': { email: ['email'] },
    });

    expect(finding(t, 'ai_hint').verdict).toBe('clean');
    expect(uncoveredOf(finding(t, 'ai_data_block'))).toEqual([
      { input_key: 'llm.data_block', path: '', kinds: ['email'] },
    ]);
  });

  it('derives auto llm.pii_fields injections and structured gaps', () => {
    const t = trace([
      { id: 'scalar', ingredient: 'scalar-source' },
      { id: 'prompt_source', ingredient: 'prompt-source' },
      { id: 'whole', ingredient: 'whole-source' },
      { id: 'list_value', ingredient: 'list-value-source' },
      { id: 'batch_list', ingredient: 'batch-list-source' },
      { id: 'content', ingredient: 'content-source' },
      { id: 'opaque', transform: 'future_transform' },
      { id: 'ai_scalar', ingredient: 'ai-classify', input: { 'llm.data': '{{step.scalar}}' } },
      { id: 'ai_prompt', ingredient: 'ai-prompt', input: { 'llm.data': '{{step.prompt_source}}' } },
      { id: 'ai_whole', ingredient: 'ai-classify', input: { 'llm.data': '{{step.whole.email}}' } },
      { id: 'ai_list_value', ingredient: 'ai-classify', input: { 'llm.data': '{{step.list_value}}' } },
      {
        id: 'ai_batch_list',
        ingredient: 'ai-classify',
        input: { 'llm.data': '{{step.batch_list}}', 'llm.id_field': 'id' },
      },
      { id: 'ai_content', ingredient: 'ai-classify', input: { 'llm.data': '{{step.content}}' } },
      { id: 'ai_opaque', ingredient: 'ai-classify', input: { 'llm.data': '{{step.opaque}}' } },
    ], {
      'scalar-source': { email: ['content', 'email'] },
      'prompt-source': { email: ['email'] },
      'whole-source': { email: ['email'] },
      'list-value-source': { [PII_LIST_SEGMENT]: ['email'] },
      'batch-list-source': { [`${PII_LIST_SEGMENT}.x`]: ['email'] },
      'content-source': { summary: ['content'] },
    });

    const plan = deriveAutoPiiFieldInjections(t);
    expect(plan.injections).toEqual(expect.arrayContaining([
      { step_id: 'ai_scalar', slug: 'ai-classify', fields: { email: 'email' } },
      { step_id: 'ai_batch_list', slug: 'ai-classify', fields: { x: 'email' } },
      // D-316 amendment (owner ruling 2026-10-05): a content-only finding is
      // injected too — on a server a `content` tag hides the known contacts
      // and every email in the text, so it is no longer decorative.
      { step_id: 'ai_content', slug: 'ai-classify', fields: { summary: 'content' } },
    ]));
    expect(plan.gaps).toEqual(expect.arrayContaining([
      { step_id: 'ai_prompt', slug: 'ai-prompt', reason: 'slug_not_contracted' },
      { step_id: 'ai_whole', slug: 'ai-classify', reason: 'unstructured_payload' },
      { step_id: 'ai_list_value', slug: 'ai-classify', reason: 'list_crossing' },
      { step_id: 'ai_opaque', slug: 'ai-classify', reason: 'untraced' },
    ]));
    expect(plan.gaps.map((g) => g.step_id)).not.toContain('ai_content');
  });

  it('de-aliases taint on ai output echo into a later ai step', () => {
    const t = trace([
      { id: 'contact', ingredient: 'contact-source' },
      {
        id: 'protected',
        transform: 'pii-protect',
        data: '{{step.contact}}',
        fields: [tag('email', 'email')],
      },
      { id: 'first_ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.protected.aliased}}' } },
      { id: 'second_ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.first_ai}}' } },
    ], {
      'contact-source': { email: ['email'] },
    });

    expect(finding(t, 'first_ai').verdict).toBe('protected_alias');
    expect(uncoveredOf(finding(t, 'second_ai'))).toEqual([
      { input_key: 'llm.data', path: '', kinds: ['email'] },
    ]);
  });
});
