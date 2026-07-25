/** D-136 P6 — Per-producer token estimate threading tests.
 *
 *  `buildEnrichmentProducerTask` stamps `token_estimate_per_record` on
 *  the registered `HousekeepingTaskInstance` from the producer's own
 *  `estimate_per_record_tokens()`. The drain task's planner-input
 *  collector reads the stamped value instead of the
 *  `DEFAULT_AI_TOKEN_ESTIMATE = 200` fallback.
 *
 *  Spec: D-136 §A.7. */

import { describe, expect, it } from 'vitest';

import {
  buildEnrichmentProducerTask,
} from '../housekeeping/enrichment-producer.js';
import type { HousekeepingEnrichmentProducer } from '../housekeeping/enrichment-producer.js';
import type {
  SourceCollectionWalker,
  SourceRecord,
} from '../housekeeping/source-walkers.js';

const STUB_SCOPE_READ = [
  { collection: 'data.mail', sample_field_paths: ['subject'] },
] as const;

const stubWalker: SourceCollectionWalker = {
  *walkAfter(_cursor: string, _batch: number) {
    return;
  },
  hashOf(_record: SourceRecord) {
    return 'h1';
  },
  fetchOne(_target_id: string) {
    return null;
  },
};

const flexibleProducer = (
  topic: string,
  scope: string,
  estimate: number,
  ai_surface?: 'chat' | 'embeddings',
): HousekeepingEnrichmentProducer => ({
  topic: topic as never,
  source_scope: scope as never,
  scope_read_declaration: STUB_SCOPE_READ,
  estimate_per_record_tokens: () => estimate,
  ...(ai_surface ? { ai_surface } : {}),
  async produce() {
    return null;
  },
});

describe('buildEnrichmentProducerTask — token_estimate_per_record stamping', () => {
  it('stamps the producer estimate on AI-surface tasks', () => {
    const producer = flexibleProducer('purpose', 'mail', 350, 'chat');
    const task = buildEnrichmentProducerTask({ producer, walker: stubWalker });
    expect(task.token_estimate_per_record).toBe(350);
    expect(task.is_ai_surface).toBe(true);
  });

  it('stamps 0 for deterministic producers', () => {
    const producer = flexibleProducer('thread_signals', 'mail', 0);
    const task = buildEnrichmentProducerTask({ producer, walker: stubWalker });
    expect(task.token_estimate_per_record).toBe(0);
    expect(task.is_ai_surface).toBe(false);
  });

  it('captures the estimate at construction time (not lazily)', () => {
    let dynamic = 100;
    const producer: HousekeepingEnrichmentProducer = {
      topic: 'purpose',
      source_scope: 'mail',
      scope_read_declaration: STUB_SCOPE_READ,
      ai_surface: 'chat',
      estimate_per_record_tokens: () => dynamic,
      async produce() { return null; },
    };
    const task = buildEnrichmentProducerTask({ producer, walker: stubWalker });
    expect(task.token_estimate_per_record).toBe(100);
    // Mutating the producer's closure after construction must not
    // change the stamped value — drain reads the snapshot.
    dynamic = 9999;
    expect(task.token_estimate_per_record).toBe(100);
  });
});
