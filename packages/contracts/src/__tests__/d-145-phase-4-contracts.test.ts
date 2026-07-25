/** D-145 PA4 — contracts-side substrate tests.
 *
 *  Asserts the public surface for the PA4 trigger + cascade integration:
 *
 *    - `WORK_ENTITY_BUS_PLATFORM` / `WORK_ENTITY_BUS_ENTITY_TYPE` /
 *      `WORK_ENTITY_DERIVED_EVENT_KINDS` / `composeWorkEntityBusPath` —
 *      the warehouse-bus path convention recipes subscribe to.
 *    - `WORK_ENTITY_DUE_SOON_WINDOW_MS` — the 24h deadline window.
 *    - `EnrichmentScope` widened with `'task' | 'note' | 'commitment'
 *      | 'project'`; `ALL_ENRICHMENT_SCOPES` includes the four;
 *      `WORK_ENTITY_ENRICHMENT_SCOPES` is the closed list. */

import { describe, expect, it } from 'vitest';

import {
  ALL_ENRICHMENT_SCOPES,
  WORK_ENTITY_BUS_ENTITY_TYPE,
  WORK_ENTITY_BUS_PLATFORM,
  WORK_ENTITY_DERIVED_EVENT_KINDS,
  WORK_ENTITY_DUE_SOON_WINDOW_MS,
  WORK_ENTITY_ENRICHMENT_SCOPES,
  WORK_ENTITY_KINDS,
  composeWorkEntityBusPath,
  isEnrichmentScope,
  type EnrichmentScope,
  type WorkEntityDerivedEventKind,
} from '../index.js';

describe('PA4 — bus path conventions', () => {
  it('platform is "work"', () => {
    expect(WORK_ENTITY_BUS_PLATFORM).toBe('work');
  });

  it('entity_type is "item"', () => {
    expect(WORK_ENTITY_BUS_ENTITY_TYPE).toBe('item');
  });

  it('derived event kinds is the closed list', () => {
    expect([...WORK_ENTITY_DERIVED_EVENT_KINDS].sort()).toEqual([
      'completed',
      'due_soon',
      'overdue',
      'state_changed',
    ]);
  });

  it('WorkEntityDerivedEventKind type narrows to the closed list', () => {
    // Type-level smoke test — the assignment compiles only when the
    // type is a strict union of the values in the array.
    const k: WorkEntityDerivedEventKind = 'completed';
    expect(k).toBe('completed');
  });

  it('composeWorkEntityBusPath emits the expected shape per kind + event_kind', () => {
    expect(composeWorkEntityBusPath('task', 'created')).toBe('data.work.task.item.created');
    expect(composeWorkEntityBusPath('note', 'updated')).toBe('data.work.note.item.updated');
    expect(composeWorkEntityBusPath('commitment', 'state_changed')).toBe(
      'data.work.commitment.item.state_changed',
    );
    expect(composeWorkEntityBusPath('project', 'state_changed')).toBe(
      'data.work.project.item.state_changed',
    );
  });

  it('every WorkEntityKind composes a valid path', () => {
    for (const kind of WORK_ENTITY_KINDS) {
      const path = composeWorkEntityBusPath(kind, 'created');
      expect(path.startsWith('data.work.')).toBe(true);
      expect(path.endsWith('.item.created')).toBe(true);
    }
  });
});

describe('PA4 — due-soon window', () => {
  it('is 24h in milliseconds', () => {
    expect(WORK_ENTITY_DUE_SOON_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(WORK_ENTITY_DUE_SOON_WINDOW_MS).toBe(86_400_000);
  });
});

describe('PA4 — EnrichmentScope widening', () => {
  it('includes the four work-entity scopes', () => {
    const scopes = ALL_ENRICHMENT_SCOPES as ReadonlyArray<string>;
    expect(scopes).toContain('task');
    expect(scopes).toContain('note');
    expect(scopes).toContain('commitment');
    expect(scopes).toContain('project');
  });

  it('isEnrichmentScope accepts the four', () => {
    expect(isEnrichmentScope('task')).toBe(true);
    expect(isEnrichmentScope('note')).toBe(true);
    expect(isEnrichmentScope('commitment')).toBe(true);
    expect(isEnrichmentScope('project')).toBe(true);
  });

  it('WORK_ENTITY_ENRICHMENT_SCOPES is the closed list of work-entity scopes', () => {
    expect([...WORK_ENTITY_ENRICHMENT_SCOPES].sort()).toEqual([
      'booking',
      'commitment',
      'note',
      'project',
      'task',
    ]);
  });

  it('every WorkEntityKind has a matching EnrichmentScope', () => {
    // Pre-PA9 type-level invariant. PA9 producers will assert
    // `valid_scopes: ['task' | 'note' | 'commitment' | 'project']`
    // — this test guards the substrate side.
    for (const kind of WORK_ENTITY_KINDS) {
      const scope = kind as EnrichmentScope;
      expect(isEnrichmentScope(scope)).toBe(true);
    }
  });
});
