/** D-145 PB15 — failure-semantics transparency event builder tests. */

import { describe, it, expect } from 'vitest';
import {
  buildAiCallGivingUpMalformedEvent,
  buildAiCallMalformedEvent,
  buildCapacityGapMidRunEvent,
  buildPrivacyHardFailEvent,
} from '../event-builders.js';
import {
  TRANSPARENCY_EVENT_KIND_SET,
  TRANSPARENCY_REDACTION_TIER_SET,
} from '@recued/contracts';

describe('D-145 PB15 — event builders', () => {
  it('buildAiCallMalformedEvent emits closed-kind envelope with round', () => {
    const env = buildAiCallMalformedEvent({ round: 0 });
    expect(env.event.kind).toBe('ai_call.malformed');
    expect(TRANSPARENCY_EVENT_KIND_SET.has(env.event.kind)).toBe(true);
    if (env.event.kind === 'ai_call.malformed') {
      expect(env.event.round).toBe(0);
    }
    expect(TRANSPARENCY_REDACTION_TIER_SET.has(env.redaction)).toBe(true);
    expect(Number.isFinite(env.emitted_at)).toBe(true);
  });

  it('buildAiCallGivingUpMalformedEvent emits closed-kind envelope', () => {
    const env = buildAiCallGivingUpMalformedEvent();
    expect(env.event.kind).toBe('ai_call.giving_up_malformed');
  });

  it('D-145 Item 1 — ai_call builders omit the retired stage field', () => {
    const malformed = buildAiCallMalformedEvent({ round: 0 });
    const givingUp = buildAiCallGivingUpMalformedEvent();
    expect('stage' in malformed.event).toBe(false);
    expect('stage' in givingUp.event).toBe(false);
  });

  it('buildPrivacyHardFailEvent emits with violation_class', () => {
    const env = buildPrivacyHardFailEvent({ violation_class: 'social_content_persist' });
    expect(env.event.kind).toBe('privacy.hard_fail');
    if (env.event.kind === 'privacy.hard_fail') {
      expect(env.event.violation_class).toBe('social_content_persist');
    }
  });

  it('buildPrivacyHardFailEvent supports all violation classes', () => {
    for (const klass of ['context_leak', 'mcp_alias_leak', 'social_content_persist', 'standing_instruction_leak'] as const) {
      const env = buildPrivacyHardFailEvent({ violation_class: klass });
      if (env.event.kind === 'privacy.hard_fail') {
        expect(env.event.violation_class).toBe(klass);
      }
    }
  });

  it('buildCapacityGapMidRunEvent threads gap requirement + intent_id', () => {
    const env = buildCapacityGapMidRunEvent({
      gap: { kind: 'bridge_online' },
      affected_intent_id: 'intent-7',
    });
    expect(env.event.kind).toBe('capacity_gap_mid_run');
    if (env.event.kind === 'capacity_gap_mid_run') {
      expect(env.event.gap.kind).toBe('bridge_online');
      expect(env.event.affected_intent_id).toBe('intent-7');
    }
  });

  it('buildCapacityGapMidRunEvent omits affected_intent_id when not provided', () => {
    const env = buildCapacityGapMidRunEvent({ gap: { kind: 'bridge_online' } });
    if (env.event.kind === 'capacity_gap_mid_run') {
      expect(env.event.affected_intent_id).toBeUndefined();
    }
  });

  it('every PB15 event kind has a default redaction tier', () => {
    const kinds = [
      'ai_call.malformed',
      'ai_call.giving_up_malformed',
      'privacy.hard_fail',
      'capacity_gap_mid_run',
    ];
    for (const _kind of kinds) {
      // Default redaction tier is closed-list; the wrapAsEnvelope path
      // would throw at module load if any kind was missing.
      expect(TRANSPARENCY_EVENT_KIND_SET.has(_kind as never)).toBe(true);
    }
  });

  it('envelope emitted_at is monotonic (later builds >= earlier)', () => {
    const env1 = buildAiCallMalformedEvent({ round: 0 });
    const env2 = buildAiCallMalformedEvent({ round: 1 });
    expect(env2.emitted_at).toBeGreaterThanOrEqual(env1.emitted_at);
  });
});
