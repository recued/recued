/** D-145 PB6 — substrate ratchet tests.
 *
 *  Pins:
 *    - EXTRACTION_EVENT_KINDS = exactly 10 entries (§ B.7.1)
 *    - EXTRACTION_EVENT_CLASSES = exactly 3 entries (resolution / extraction / derived_effect)
 *    - EVENT_DISPATCH_KINDS = exactly 3 entries (auto_save / queue_for_confirm / annotate_only)
 *    - EXTRACTION_EVENT_VALIDATION_KINDS = exactly 3 entries
 *    - AI_OUTPUT_VALIDATION_KINDS = exactly 4 entries (contracts pins membership too)
 *    - AI_OUTPUT_COMPOSER_ISSUE_KINDS = exactly 2 entries
 *    - HIGH_CONFIDENCE_FLOOR = 0.85; MEDIUM_CONFIDENCE_FLOOR = 0.6
 *    - MULTI_EVENT_COLLAPSE_THRESHOLD = 6
 *    - composer ordering invariant: resolutions before extractions
 *    - composer per-event undo: independent counters per source */

import { describe, expect, it } from 'vitest';

import {
  AI_OUTPUT_VALIDATION_KINDS,
  EVENT_DISPATCH_KINDS,
  EXTRACTION_EVENT_CLASSES,
  EXTRACTION_EVENT_KINDS,
  EXTRACTION_EVENT_VALIDATION_KINDS,
  HIGH_CONFIDENCE_FLOOR,
  MEDIUM_CONFIDENCE_FLOOR,
  MULTI_EVENT_COLLAPSE_THRESHOLD,
  type AIOutput,
  type ExtractionEvent,
} from '@recued/contracts';

import {
  AI_OUTPUT_COMPOSER_ISSUE_KINDS,
  composeAIOutput,
} from '../ai-output/composer.js';
import { dispatchEvents } from '../ai-output/dispatch.js';

describe('D-145 PB6 — closed-list ratchets', () => {
  it('EXTRACTION_EVENT_KINDS pinned at 10 entries', () => {
    expect(EXTRACTION_EVENT_KINDS.length).toBe(10);
  });

  it('EXTRACTION_EVENT_CLASSES pinned at 3 entries', () => {
    expect(EXTRACTION_EVENT_CLASSES.length).toBe(3);
  });

  it('EVENT_DISPATCH_KINDS pinned at 3 entries', () => {
    expect(EVENT_DISPATCH_KINDS.length).toBe(3);
  });

  it('EXTRACTION_EVENT_VALIDATION_KINDS pinned at 3 entries', () => {
    expect(EXTRACTION_EVENT_VALIDATION_KINDS.length).toBe(3);
  });

  // Bumped 3 → 4 on 2026-07-27 for `tool_call_not_shaped`, added by
  // `61868a195 fix(contracts): reject a tool call with no name instead of
  // crashing the turn`. The member is justified: measured live on
  // qwen3.7-plus (substrate-bench task 155), a `tool_calls` entry with no
  // `tool` key passed the array-shape gate, reached
  // `registry.getByName(undefined)` and threw inside
  // `topicOfEnrichmentToolName`'s `name.startsWith(...)`, taking the whole
  // turn down. The number is recorded here rather than silently bumped —
  // a ratchet's job is to force exactly this review when the list grows.
  //
  // ⚠⚠ NOT a one-off — verified 2026-07-27: ALL FIVE contracts constants
  // pinned in this file (EXTRACTION_EVENT_KINDS, EXTRACTION_EVENT_CLASSES,
  // EVENT_DISPATCH_KINDS, EXTRACTION_EVENT_VALIDATION_KINDS, and this one)
  // are ALSO pinned contracts-side, there with count AND exact membership.
  // These copies pin only `.length` over the same imported constant, so they
  // add no signal contracts doesn't already carry — only a second place to
  // forget. `AI_OUTPUT_VALIDATION_KINDS` is simply the first to grow and
  // expose it; the other four carry the identical drift, and the next person
  // to add an extraction-event kind reddens a DIFFERENT package for a change
  // that was already correctly ratcheted. Fold these five into the contracts
  // ratchet; keep only genuinely middleware-local lists here (e.g.
  // AI_OUTPUT_COMPOSER_ISSUE_KINDS, whose source IS this package).
  it('AI_OUTPUT_VALIDATION_KINDS pinned at 4 entries', () => {
    expect(AI_OUTPUT_VALIDATION_KINDS.length).toBe(4);
  });

  it('AI_OUTPUT_COMPOSER_ISSUE_KINDS pinned at 2 entries', () => {
    expect(AI_OUTPUT_COMPOSER_ISSUE_KINDS.length).toBe(2);
  });

  it('confidence floors pinned per § B.7.7 (high=0.85, medium=0.6)', () => {
    expect(HIGH_CONFIDENCE_FLOOR).toBe(0.85);
    expect(MEDIUM_CONFIDENCE_FLOOR).toBe(0.6);
  });

  it('collapse threshold pinned at 6 per § B.7.10', () => {
    expect(MULTI_EVENT_COLLAPSE_THRESHOLD).toBe(6);
  });
});

describe('D-145 PB6 — composer-ordering.ratchet (§ B.7.8 invariant)', () => {
  // The named ratchet asserts that every composer invocation preserves
  // resolution-before-extraction ordering. § B.7.8 rule 1 is the
  // load-bearing read-along invariant — without it, "I bought a car
  // today (mom)" reads "purchase first; mom resolved second" which
  // makes the inline thought stream feel disjointed.
  it('every survivor batch has all resolutions before all extractions', () => {
    const inputs: ExtractionEvent[][] = [
      [
        { kind: 'extraction.commitment', confidence: 0.9, args: {} },
        { kind: 'resolution.alias', confidence: 0.99, args: {} },
      ],
      [
        { kind: 'extraction.purchase', confidence: 0.95, args: {} },
        { kind: 'extraction.commitment', confidence: 0.92, args: {} },
        { kind: 'resolution.network_domain_inferred', confidence: 0.88, args: {} },
      ],
      [
        { kind: 'extraction.note', confidence: 0.6, args: {} },
        { kind: 'resolution.contact_created_mention_only', confidence: 0.85, args: {} },
        { kind: 'extraction.task', confidence: 0.7, args: {} },
        { kind: 'resolution.alias', confidence: 0.99, args: {} },
      ],
    ];
    for (const events of inputs) {
      const out: AIOutput = {
        response: 'r',
        events,
        tool_calls: [],
      };
      const result = composeAIOutput(out);
      const ordered = result.composed!.dispatched_events.map(
        (d) => d.event.kind,
      );
      let firstExtractionAt: number | null = null;
      for (let i = 0; i < ordered.length; i++) {
        if (firstExtractionAt === null && ordered[i]!.startsWith('extraction.')) {
          firstExtractionAt = i;
        }
        if (firstExtractionAt !== null && ordered[i]!.startsWith('resolution.')) {
          throw new Error(
            `composer-ordering invariant violated: resolution at index ${i} after extraction at index ${firstExtractionAt}; full order = ${ordered.join(',')}`,
          );
        }
      }
    }
  });
});

describe('D-145 PB6 — per-event-undo.ratchet (§ B.7.9 invariant)', () => {
  // The named ratchet asserts that per-event undo tokens are
  // independent — accepting / rejecting the purchase event from a
  // message does not affect the alias resolution from the same
  // message. The substrate's discriminator is the per-event undo
  // token; this ratchet confirms every dispatched event gets a unique
  // token within its source message.
  it('every dispatched event has a unique undo_token within its source bucket', () => {
    const events: ExtractionEvent[] = [
      { kind: 'extraction.purchase', confidence: 0.92, args: {}, source_message_id: 'msg-1' },
      { kind: 'resolution.alias', confidence: 0.99, args: {}, source_message_id: 'msg-1' },
      { kind: 'extraction.plan', confidence: 0.7, args: {}, source_message_id: 'msg-1' },
      { kind: 'extraction.commitment', confidence: 0.85, args: {}, source_message_id: 'msg-2' },
      { kind: 'extraction.note', confidence: 0.4, args: {} },
      { kind: 'extraction.preference', confidence: 0.4, args: {} },
    ];
    const { dispatched } = dispatchEvents(events);
    const tokens = dispatched.map((d) => d.undo_token);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('cross-message undo tokens never collide (sourced A vs sourced B distinct)', () => {
    const events: ExtractionEvent[] = [
      { kind: 'extraction.commitment', confidence: 0.92, args: {}, source_message_id: 'msg-A' },
      { kind: 'extraction.commitment', confidence: 0.92, args: {}, source_message_id: 'msg-B' },
    ];
    const { dispatched } = dispatchEvents(events);
    expect(dispatched[0]!.undo_token).not.toBe(dispatched[1]!.undo_token);
  });

  // Codex P2 fold (2026-05-10) — token-discriminator ratchet. The
  // pre-fold format `<source_message_id>#<index>` collided when an AI
  // provider returned the literal source_message_id `'unsourced'`.
  // The substrate's prefix scheme (`s:` for sourced / `u#` for
  // unsourced) makes the discriminator structural rather than slug-
  // dependent. This ratchet pins the invariant going forward.
  it('source_message_id="unsourced" never collides with the unsourced bucket', () => {
    const events: ExtractionEvent[] = [
      { kind: 'extraction.commitment', confidence: 0.92, args: {}, source_message_id: 'unsourced' },
      { kind: 'extraction.commitment', confidence: 0.92, args: {} },
    ];
    const { dispatched } = dispatchEvents(events);
    expect(dispatched[0]!.undo_token).not.toBe(dispatched[1]!.undo_token);
    expect(dispatched[0]!.undo_token).toBe('s:unsourced#0');
    expect(dispatched[1]!.undo_token).toBe('u#0');
  });
});
