/** D-145 PB3 — closed-list ratchet tests.
 *
 *  Pin every closed list PB3 introduces. Drift requires a substrate
 *  D-spec change. */

import { describe, it, expect } from 'vitest';

import {
  COMPOSITION_RULE_KINDS,
  COMPOSITION_RULE_KIND_SET,
} from '../orchestrator/index.js';
import {
  AI_POOL_POLICIES,
  APPROVAL_DECISIONS,
  DATA_FETCH_COLLECTIONS,
  MEMORY_RECALL_AXES,
} from '../primitives/index.js';
import {
  RECUED_PRIMITIVES,
  RECUED_REQUEST_SURFACES,
  RECUED_REQUEST_VALIDATION_ISSUE_KINDS,
} from '@recued/contracts';

describe('PB3 — RECUED_PRIMITIVES is the canonical 10-entry closed list', () => {
  it('exposes exactly 10 entries', () => {
    expect(RECUED_PRIMITIVES).toHaveLength(10);
  });

  it('lists every required primitive per § B.1', () => {
    expect([...RECUED_PRIMITIVES].sort()).toEqual([
      'ai.synthesize',
      'approval.request',
      'bridge.dispatch',
      'capacity_spec',
      'data.fetch',
      'enrichment.lookup',
      'memory.recall',
      'memory.write',
      'provenance.link',
      'recipe.invoke',
    ]);
  });
});

describe('PB3 — COMPOSITION_RULE_KINDS', () => {
  it('exposes 5 closed-list rules (D-145 Item 1 dropped the 3 stage-coupled rules)', () => {
    expect(COMPOSITION_RULE_KINDS).toHaveLength(5);
  });
  it('matching ReadonlySet has the same cardinality', () => {
    expect(COMPOSITION_RULE_KIND_SET.size).toBe(COMPOSITION_RULE_KINDS.length);
  });
});

describe('PB3 — DATA_FETCH_COLLECTIONS', () => {
  it('exposes 9 closed-list warehouse collections', () => {
    expect(DATA_FETCH_COLLECTIONS).toEqual([
      'mail',
      'calendar',
      'contact',
      'engagement',
      'task',
      'note',
      'commitment',
      'project',
      'shared',
    ]);
  });
});

describe('PB3 — MEMORY_RECALL_AXES', () => {
  it('exposes 2 closed-list axes per D-120 P7.5', () => {
    expect(MEMORY_RECALL_AXES).toEqual(['event', 'ingestion']);
  });
});

describe('PB3 — AI_POOL_POLICIES', () => {
  it('exposes 3 pool policies per D-132', () => {
    expect(AI_POOL_POLICIES).toEqual(['free_only', 'free_then_byok', 'byok_only']);
  });
});

describe('PB3 — APPROVAL_DECISIONS', () => {
  it('exposes 4 closed-list decisions per D-113', () => {
    expect(APPROVAL_DECISIONS).toEqual(['approved', 'declined', 'cancelled', 'timeout']);
  });
});

describe('PB3 — RECUED_REQUEST_SURFACES', () => {
  it('exposes 7 closed-list surfaces', () => {
    expect(RECUED_REQUEST_SURFACES).toEqual([
      'webclient',
      'extension',
      'mcp_chat',
      'recipe_invoke',
      'scheduled',
      'reactive',
      'compose',
    ]);
  });
});

describe('PB3 — RECUED_REQUEST_VALIDATION_ISSUE_KINDS', () => {
  it('exposes 10 closed-list issue kinds', () => {
    expect(RECUED_REQUEST_VALIDATION_ISSUE_KINDS).toHaveLength(10);
  });
});
