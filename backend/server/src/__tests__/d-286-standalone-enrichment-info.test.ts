/** D-286 — enrichment info for standalone housekeeping tasks.
 *
 *  ⛔ THE DEFECT. `getEnrichmentInfo` resolved out of the `enrichmentProducers`
 *  map, which only holds tasks built by `buildEnrichmentProducerTask` (they
 *  need a walker). A STANDALONE task got `undefined`, and the panel's
 *  `runNowDisabled = !enrichment || trustState === 'off'` turned that into a
 *  *Run now* button that could never be pressed. Measured live: 26 of 74 rows,
 *  with trust reading `auto` — including `confidence_drift_signal`, whose
 *  banner is the only drift surface the owner has.
 *
 *  ⛔ AND WHY THE ONE-LINE FIX WOULD HAVE BEEN WORSE. Filling the gap with
 *  `token_estimate_per_record: 0` reads as DETERMINISTIC everywhere, and five
 *  AI-surface standalone tasks declare no estimate at all — the confirm dialog
 *  would have said "pure SQL aggregation, no token cost" above a button that
 *  fires AI calls.
 *
 *  These run against the REAL task objects, so the premise cannot drift
 *  quietly: if someone later adds an estimate, flips a flag, or registers a
 *  new standalone task, the classification still has to agree with what the
 *  task declares about itself. */

import { describe, expect, it } from 'vitest';
import { isAiSurfaceEnrichment } from '@recued/contracts';

import { STANDALONE_TASKS } from '../housekeeping/registration.js';
import { standaloneEnrichmentBase } from '../composition/bin/wire-housekeeping-substrate.js';

const enrichmentTasks = STANDALONE_TASKS.filter((t) => t.meta.kind === 'enrichment');

describe('D-286 — standaloneEnrichmentBase over the real registry', () => {
  it('there are standalone enrichment tasks to speak about', () => {
    // Guards the whole file against going vacuous if the list is restructured.
    expect(enrichmentTasks.length).toBeGreaterThan(10);
  });

  it('answers for EVERY standalone enrichment task — none is left unpressable', () => {
    const unanswered = enrichmentTasks
      .filter((t) => standaloneEnrichmentBase(t) === undefined)
      .map((t) => t.meta.id);
    expect(unanswered).toEqual([]);
  });

  it('classifies each one the way the task declares itself', () => {
    const disagreements = enrichmentTasks
      .map((t) => ({
        id: t.meta.id,
        declared: t.is_ai_surface === true,
        derived: isAiSurfaceEnrichment(standaloneEnrichmentBase(t)),
      }))
      .filter((r) => r.declared !== r.derived);
    expect(disagreements).toEqual([]);
  });

  it('never reports a source-record count it cannot know', () => {
    // A standalone task declares no source scope. A 0 here renders "0 tokens"
    // on a run that spends them.
    for (const task of enrichmentTasks) {
      expect(standaloneEnrichmentBase(task)?.source_collection_count).toBeUndefined();
    }
  });

  it('an AI-surface task with no declared estimate reports NO estimate, not zero', () => {
    const aiTasks = enrichmentTasks.filter((t) => t.is_ai_surface === true);
    expect(aiTasks.length).toBeGreaterThan(0);
    for (const task of aiTasks) {
      const info = standaloneEnrichmentBase(task)!;
      expect(info.is_ai_surface).toBe(true);
      // Whatever the task declares is passed through; what it does not
      // declare stays absent. Never 0 — that is the deterministic reading.
      expect(info.token_estimate_per_record).toBe(task.token_estimate_per_record);
      expect(info.token_estimate_per_record).not.toBe(0);
    }
  });

  it('confidence_drift_signal in particular is answerable and deterministic', () => {
    // The row that started this: the owner could not ask for a fresh drift
    // check even after the banner told them drift had been detected.
    const drift = enrichmentTasks.find(
      (t) => t.meta.id === 'enrichment.confidence_drift_signal',
    );
    expect(drift).toBeDefined();
    const info = standaloneEnrichmentBase(drift)!;
    expect(info.is_ai_surface).toBe(false);
    expect(info.token_estimate_per_record).toBe(0);
  });

  it('declines a task that is not an enrichment task, and a missing one', () => {
    const core = STANDALONE_TASKS.find((t) => t.meta.kind !== 'enrichment');
    expect(core).toBeDefined();
    expect(standaloneEnrichmentBase(core)).toBeUndefined();
    expect(standaloneEnrichmentBase(undefined)).toBeUndefined();
  });
});
