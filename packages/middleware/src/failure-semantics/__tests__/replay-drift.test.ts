/** D-145 PB15 — replay drift detector tests. */

import { describe, it, expect } from 'vitest';
import type { ContextItem } from '@recued/contracts';
import { detectReplayDrift } from '../replay-drift.js';

const mk = (overrides: Partial<ContextItem>): ContextItem => ({
  source_ref: 'data.contact.a@x.com',
  content_class: 'work_entity',
  persist_policy: 'persist',
  ...overrides,
} as ContextItem);

describe('D-145 PB15 — replay drift', () => {
  it('returns ok with empty drifted_entries when current_state matches', () => {
    const result = detectReplayDrift({
      mode: 'refetch',
      original_context: [mk({ redacted_payload: 'v1' })],
      current_state: new Map([['data.contact.a@x.com', 'v1']]),
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.drifted_entries.length).toBe(0);
      expect(result.drift_summary).toBe('no_drift');
    }
  });

  it('detects drift when current_state differs', () => {
    const result = detectReplayDrift({
      mode: 'refetch',
      original_context: [mk({ redacted_payload: 'v1' })],
      current_state: new Map([['data.contact.a@x.com', 'v2']]),
    });
    if (result.kind === 'ok') {
      expect(result.drifted_entries.length).toBe(1);
      expect(result.drifted_entries[0]!.source_ref).toBe('data.contact.a@x.com');
      expect(result.drift_summary).toContain('changed');
    }
  });

  it('frozen mode blocks on immediate_use_only items', () => {
    const result = detectReplayDrift({
      mode: 'frozen',
      original_context: [
        mk({
          content_class: 'social_raw_body',
          persist_policy: 'immediate_use_only',
          redacted_payload: 'ephemeral',
        }),
      ],
      current_state: new Map(),
    });
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.reason).toBe('replay_unsupported_privacy_class');
      expect(result.offending_source_refs.length).toBeGreaterThan(0);
    }
  });

  it('frozen mode passes when no immediate_use_only items', () => {
    const result = detectReplayDrift({
      mode: 'frozen',
      original_context: [mk({ persist_policy: 'persist', redacted_payload: 'v1' })],
      current_state: new Map(),
    });
    expect(result.kind).toBe('ok');
  });

  it('Codex P2 fold: skips persist-policy items lacking redacted_payload (payload_ref-backed)', () => {
    // A normal persist-policy ContextItem has its content behind
    // payload_ref (D-120 pointer), NOT in redacted_payload. The
    // detector MUST skip these — coercing to '' produces false drift.
    const result = detectReplayDrift({
      mode: 'refetch',
      original_context: [
        mk({
          source_ref: 'r1',
          persist_policy: 'persist',
          // No redacted_payload — payload lives behind payload_ref.
          payload_ref: 'memory:row:001',
        }),
      ],
      current_state: new Map([['r1', 'v_now']]),
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // No drift reported even though current_state differs from the
      // (missing) redacted_payload — caller must resolve payload_ref
      // upstream to participate in drift detection.
      expect(result.drifted_entries.length).toBe(0);
      expect(result.drift_summary).toBe('no_drift');
    }
  });

  it('ignores entries not in current_state map (treats as no change)', () => {
    const result = detectReplayDrift({
      mode: 'refetch',
      original_context: [
        mk({ source_ref: 'r1', redacted_payload: 'v1' }),
        mk({ source_ref: 'r2', redacted_payload: 'v2' }),
      ],
      current_state: new Map([['r1', 'v1_different']]),
    });
    if (result.kind === 'ok') {
      expect(result.drifted_entries.length).toBe(1);
      expect(result.drifted_entries[0]!.source_ref).toBe('r1');
    }
  });
});
