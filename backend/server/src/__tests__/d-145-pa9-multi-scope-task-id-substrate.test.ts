/** D-145 PA9 — multi-scope task-id substrate tests.
 *
 *  Substrate-level tests for the `task_id_suffix` extension on
 *  `buildEnrichmentProducerTask` + `PerRecordProducerEntry`. Two
 *  producers may share one topic when their `source_scope` differs;
 *  the suffix disambiguates the `housekeeping_state` row key so both
 *  cursors persist independently. The first dual-scope tenant is
 *  `open_loop_pressure` (per-contact + per-project).
 *
 *  Covers:
 *    - `id` composition without suffix → `enrichment.${topic}` (back-compat)
 *    - `id` composition with suffix → `enrichment.${topic}.${suffix}`
 *    - Suffix validator rejects malformed values
 *    - `PER_RECORD_PRODUCERS` admits the dual-scope `open_loop_pressure`
 *      pair without ratchet failure */

import { describe, expect, it } from 'vitest';

import { ENRICHMENT_REGISTRY } from '@recued/contracts';

import {
  PER_RECORD_PRODUCERS,
} from '../housekeeping/registration.js';
import { buildEnrichmentProducerTask } from '../housekeeping/enrichment-producer.js';
import type {
  HousekeepingEnrichmentProducer,
  ProducerScopeReadDeclaration,
} from '../housekeeping/enrichment-producer.js';
import type { SourceCollectionWalker } from '../housekeeping/source-walkers.js';

// ────────────────────────────────────────────────────────────────
// Stub helpers — build a deterministic minimum-viable
// per-record producer + walker pair to exercise the harness shape.
// `open_loop_pressure` is the canonical dual-scope topic
// (`valid_scopes: ['contact', 'project']`) and its registry entry
// passes both validator gates the harness checks at construction.
// ────────────────────────────────────────────────────────────────

const STUB_SCOPE_READ: ReadonlyArray<ProducerScopeReadDeclaration> = [
  { collection: 'data.contact', sample_field_paths: ['email'] },
];

const makeProducer = (
  source_scope: 'contact' | 'project',
): HousekeepingEnrichmentProducer<unknown> => ({
  topic: 'open_loop_pressure',
  source_scope,
  scope_read_declaration: STUB_SCOPE_READ,
  estimate_per_record_tokens: () => 0,
  async produce() {
    return null;
  },
});

const STUB_WALKER: SourceCollectionWalker<unknown> = {
  *walkAfter() {},
  hashOf() {
    return 'h0';
  },
  fetchOne() {
    return null;
  },
};

// ────────────────────────────────────────────────────────────────
// id composition
// ────────────────────────────────────────────────────────────────

describe('buildEnrichmentProducerTask task_id_suffix', () => {
  it('composes id as `enrichment.${topic}` when no suffix is provided (back-compat)', () => {
    const task = buildEnrichmentProducerTask({
      producer: makeProducer('contact'),
      walker: STUB_WALKER,
    });
    expect(task.meta.id).toBe('enrichment.open_loop_pressure');
  });

  it('composes id as `enrichment.${topic}.${task_id_suffix}` when suffix provided', () => {
    const task = buildEnrichmentProducerTask({
      producer: makeProducer('project'),
      walker: STUB_WALKER,
      task_id_suffix: 'project',
    });
    expect(task.meta.id).toBe('enrichment.open_loop_pressure.project');
  });

  it('allows two scopes of the same topic to coexist with distinct task ids', () => {
    const a = buildEnrichmentProducerTask({
      producer: makeProducer('contact'),
      walker: STUB_WALKER,
    });
    const b = buildEnrichmentProducerTask({
      producer: makeProducer('project'),
      walker: STUB_WALKER,
      task_id_suffix: 'project',
    });
    expect(a.meta.id).not.toBe(b.meta.id);
    expect(a.meta.id).toBe('enrichment.open_loop_pressure');
    expect(b.meta.id).toBe('enrichment.open_loop_pressure.project');
  });

  it('rejects malformed task_id_suffix characters', () => {
    expect(() =>
      buildEnrichmentProducerTask({
        producer: makeProducer('contact'),
        walker: STUB_WALKER,
        task_id_suffix: 'has spaces',
      }),
    ).toThrow(/enrichment_task_id_suffix_malformed/);
    expect(() =>
      buildEnrichmentProducerTask({
        producer: makeProducer('contact'),
        walker: STUB_WALKER,
        task_id_suffix: 'UPPER',
      }),
    ).toThrow(/enrichment_task_id_suffix_malformed/);
    expect(() =>
      buildEnrichmentProducerTask({
        producer: makeProducer('contact'),
        walker: STUB_WALKER,
        task_id_suffix: 'has.dot',
      }),
    ).toThrow(/enrichment_task_id_suffix_malformed/);
  });

  it('accepts snake_case + numeric suffixes', () => {
    expect(() =>
      buildEnrichmentProducerTask({
        producer: makeProducer('contact'),
        walker: STUB_WALKER,
        task_id_suffix: 'snake_case_2',
      }),
    ).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// PER_RECORD_PRODUCERS substrate use
// ────────────────────────────────────────────────────────────────

describe('PER_RECORD_PRODUCERS dual-scope open_loop_pressure entry', () => {
  it('registers two open_loop_pressure entries with distinct source_scope', () => {
    const matches = PER_RECORD_PRODUCERS.filter((e) => e.producer.topic === 'open_loop_pressure');
    expect(matches).toHaveLength(2);
    const scopes = matches.map((e) => e.producer.source_scope).sort();
    expect(scopes).toEqual(['contact', 'project']);
  });

  it('reserves task_id_suffix only for the per-project entry (back-compat with legacy task id)', () => {
    const contact = PER_RECORD_PRODUCERS.find(
      (e) => e.producer.topic === 'open_loop_pressure' && e.producer.source_scope === 'contact',
    );
    const project = PER_RECORD_PRODUCERS.find(
      (e) => e.producer.topic === 'open_loop_pressure' && e.producer.source_scope === 'project',
    );
    expect(contact?.task_id_suffix).toBeUndefined();
    expect(project?.task_id_suffix).toBe('project');
  });

  it('registry valid_scopes covers both producers (contact + project)', () => {
    expect(ENRICHMENT_REGISTRY.open_loop_pressure.valid_scopes).toEqual(['contact', 'project']);
  });
});
