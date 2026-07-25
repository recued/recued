/** D-145 PB7 — engine-side Transparency Stream composer tests.
 *
 *  Composer: validate → resolve redaction → apply Settings → stamp
 *  emitted_at → emit envelope. Plus extraction-mapping tests for the
 *  PB6 → PB7 surface bridge. */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
  defaultRedactionForKind,
  type TransparencyEvent,
  withEnabled,
  withMaxRedactionTier,
  withVisibleClasses,
} from '@recued/contracts';

import {
  TRANSPARENCY_COMPOSER_ISSUE_KINDS,
  composeTransparencyEvent,
  composeTransparencyEventWithAudit,
  mapDispatchedEventToTransparency,
  renderTransparencyEnvelope,
} from '../transparency-stream/index.js';
import type { DispatchedEvent } from '../ai-output/dispatch.js';

// ── composeTransparencyEvent ─────────────────────────────────────────

describe('D-145 PB7 — composeTransparencyEvent: shape gate', () => {
  it('halts on null event with closed-list issue', () => {
    const r = composeTransparencyEvent({ event: null });
    expect(r.envelope).toBeUndefined();
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues.every((i) => i.kind === 'event_invalid')).toBe(true);
    expect(TRANSPARENCY_COMPOSER_ISSUE_KINDS).toContain(r.issues[0]!.kind);
  });

  it('halts on unknown kind', () => {
    const r = composeTransparencyEvent({ event: { kind: 'no_such_kind' } });
    expect(r.envelope).toBeUndefined();
    expect(r.issues.some((i) => i.detail.kind === 'unknown_kind')).toBe(true);
  });

  it('halts on missing required field', () => {
    const r = composeTransparencyEvent({
      event: {
        kind: 'extraction.detected',
        fact_type: 'plan',
        // summary missing
        source_message_id: 'm_1',
      },
    });
    expect(r.envelope).toBeUndefined();
    expect(
      r.issues.some(
        (i) =>
          i.detail.kind === 'missing_required_string' &&
          i.detail.path === 'summary',
      ),
    ).toBe(true);
  });

  it('emits an envelope for a valid event', () => {
    const fixedNow = 1_736_000_000_111;
    const r = composeTransparencyEvent({
      event: {
        kind: 'extraction.saved',
        entity_kind: 'commitment',
        entity_id: 'c_1',
        confidence: 0.92,
      },
      now: () => fixedNow,
    });
    expect(r.issues).toEqual([]);
    expect(r.envelope?.event.kind).toBe('extraction.saved');
    expect(r.envelope?.redaction).toBe(defaultRedactionForKind('extraction.saved'));
    expect(r.envelope?.emitted_at).toBe(fixedNow);
  });

  it('threads provenance_ref through the envelope', () => {
    const r = composeTransparencyEvent({
      event: {
        kind: 'memory_lookup',
        query_summary: 'recent commitments',
        result_count: 3,
      },
      provenance_ref: 'audit_row_99',
      now: () => 1,
    });
    expect(r.envelope?.provenance_ref).toBe('audit_row_99');
  });
});

describe('D-145 PB7 — composeTransparencyEvent: redaction policy', () => {
  it('caller redaction_override beats per-kind default', () => {
    const r = composeTransparencyEvent({
      event: {
        kind: 'extraction.saved',
        entity_kind: 'commitment',
        entity_id: 'c_1',
        confidence: 0.9,
      },
      redaction_override: 'summary_only',
      now: () => 0,
    });
    expect(r.envelope?.redaction).toBe('summary_only');
  });

  it('ai_call reasoning tier widens summary_only → none (§ B.8.4 overlay)', () => {
    const r = composeTransparencyEvent({
      event: { kind: 'ai_call', tier: 'reasoning', round: 1 },
      now: () => 0,
    });
    // Per-kind default for ai_call is summary_only; reasoning-tier
    // overlay widens to none.
    expect(r.envelope?.redaction).toBe('none');
  });

  it('ai_call fast tier stays at summary_only', () => {
    const r = composeTransparencyEvent({
      event: { kind: 'ai_call', tier: 'fast', round: 1 },
      now: () => 0,
    });
    expect(r.envelope?.redaction).toBe('summary_only');
  });

  it('Settings master toggle off → redaction collapses to hidden', () => {
    const settings = withEnabled(DEFAULT_TRANSPARENCY_STREAM_SETTINGS, false);
    const r = composeTransparencyEvent({
      event: { kind: 'pattern.observation', observation: 'sunny days' },
      settings,
      now: () => 0,
    });
    expect(r.envelope?.redaction).toBe('hidden');
  });

  it('Settings per-class opt-out routes the event to hidden', () => {
    const settings = withVisibleClasses(DEFAULT_TRANSPARENCY_STREAM_SETTINGS, {
      ai_emitted: false,
    });
    const r = composeTransparencyEvent({
      event: {
        kind: 'pattern.observation',
        observation: 'sunny days',
      },
      settings,
      now: () => 0,
    });
    expect(r.envelope?.redaction).toBe('hidden');
  });

  it('Settings max_redaction_tier=none filters out summary_only kinds', () => {
    const settings = withMaxRedactionTier(
      DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
      'none',
    );
    const r = composeTransparencyEvent({
      event: {
        kind: 'context_omitted',
        source_ref: 'data.contact.bob',
        reason_code: 'privacy_class',
      },
      settings,
      now: () => 0,
    });
    expect(r.envelope?.redaction).toBe('hidden');
  });
});

describe('D-145 PB7 — composeTransparencyEventWithAudit', () => {
  it('returns matching envelope + audit detail with class-derived source', () => {
    const r = composeTransparencyEventWithAudit(
      {
        event: {
          kind: 'extraction.saved',
          entity_kind: 'commitment',
          entity_id: 'c_1',
          confidence: 0.9,
        },
        now: () => 1_736_000_000_222,
      },
      'plan_42',
    );
    expect(r.envelope?.event.kind).toBe('extraction.saved');
    expect(r.audit?.source).toBe('ai_emitted');
    expect(r.audit?.run_id).toBe('plan_42');
    expect(r.audit?.emitted_at).toBe(1_736_000_000_222);
  });

  it('returns issues + no audit when validation fails', () => {
    const r = composeTransparencyEventWithAudit({ event: 'oops' });
    expect(r.envelope).toBeUndefined();
    expect(r.audit).toBeUndefined();
    expect(r.issues.length).toBeGreaterThan(0);
  });
});

describe('D-145 PB7 — renderTransparencyEnvelope', () => {
  it('renders the Recued voice template when redaction is none', () => {
    const text = renderTransparencyEnvelope({
      event: {
        kind: 'action.completed',
        brief_outcome: 'sent the report',
      },
      redaction: 'none',
      emitted_at: 0,
    });
    expect(text).toContain('done ✓');
    expect(text).toContain('sent the report');
  });

  it('returns empty string when redaction is hidden (audit-only)', () => {
    const text = renderTransparencyEnvelope({
      event: {
        kind: 'cascade.fired',
        recipe_id: 'r_1',
      },
      redaction: 'hidden',
      emitted_at: 0,
    });
    expect(text).toBe('');
  });
});

// ── extraction-mapping ───────────────────────────────────────────────

describe('D-145 PB7 — mapDispatchedEventToTransparency', () => {
  const dispatchedHigh: DispatchedEvent = {
    event: {
      kind: 'extraction.commitment',
      confidence: 0.92,
      args: {
        entity_id: 'c_42',
        commitment_text: 'send report Friday',
      },
      source_message_id: 'msg_1',
    },
    dispatch: 'auto_save',
    undo_token: 's:msg_1#0',
  };

  const dispatchedMedium: DispatchedEvent = {
    event: {
      kind: 'extraction.task',
      confidence: 0.7,
      args: { queue_entry_id: 'q_5', summary: 'review the spec' },
      source_message_id: 'msg_2',
    },
    dispatch: 'queue_for_confirm',
    undo_token: 's:msg_2#0',
  };

  const dispatchedLow: DispatchedEvent = {
    event: {
      kind: 'extraction.note',
      confidence: 0.4,
      args: { fact: 'mentioned in passing' },
    },
    dispatch: 'annotate_only',
    undo_token: 'u#0',
  };

  it('auto_save → extraction.saved', () => {
    const ev = mapDispatchedEventToTransparency(dispatchedHigh);
    expect(ev?.kind).toBe('extraction.saved');
    if (ev?.kind === 'extraction.saved') {
      expect(ev.entity_kind).toBe('commitment');
      expect(ev.entity_id).toBe('c_42');
      expect(ev.confidence).toBe(0.92);
    }
  });

  it('queue_for_confirm → extraction.queued_for_confirm', () => {
    const ev = mapDispatchedEventToTransparency(dispatchedMedium);
    expect(ev?.kind).toBe('extraction.queued_for_confirm');
    if (ev?.kind === 'extraction.queued_for_confirm') {
      expect(ev.queue_entry_id).toBe('q_5');
      expect(ev.confidence).toBe(0.7);
    }
  });

  it('annotate_only → extraction.skipped_low_confidence', () => {
    const ev = mapDispatchedEventToTransparency(dispatchedLow);
    expect(ev?.kind).toBe('extraction.skipped_low_confidence');
    if (ev?.kind === 'extraction.skipped_low_confidence') {
      expect(ev.fact).toBe('mentioned in passing');
      expect(ev.confidence).toBe(0.4);
    }
  });

  it('resolution.alias preserves payload', () => {
    const dispatched: DispatchedEvent = {
      event: {
        kind: 'resolution.alias',
        confidence: 0.95,
        args: {
          alias: 'mom',
          contact_name: 'Mary Castellanos',
          network_domain: 'family',
        },
      },
      dispatch: 'auto_save',
      undo_token: 'u#0',
    };
    const ev = mapDispatchedEventToTransparency(dispatched);
    expect(ev).toEqual({
      kind: 'resolution.alias',
      alias: 'mom',
      contact_name: 'Mary Castellanos',
      network_domain: 'family',
    });
  });

  it('resolution.alias without network_domain emits without the optional field', () => {
    const dispatched: DispatchedEvent = {
      event: {
        kind: 'resolution.alias',
        confidence: 0.95,
        args: { alias: 'bob', contact_name: 'Bob Smith' },
      },
      dispatch: 'auto_save',
      undo_token: 'u#0',
    };
    const ev = mapDispatchedEventToTransparency(dispatched);
    expect(ev).toEqual({
      kind: 'resolution.alias',
      alias: 'bob',
      contact_name: 'Bob Smith',
    });
  });

  it('returns null for unmappable resolution kind missing required args', () => {
    const dispatched: DispatchedEvent = {
      event: {
        kind: 'resolution.alias',
        confidence: 0.9,
        args: {},
      },
      dispatch: 'auto_save',
      undo_token: 'u#0',
    };
    expect(mapDispatchedEventToTransparency(dispatched)).toBeNull();
  });

  it('Codex P2 fold: auto_save extraction without entity_id returns null (no sentinel)', () => {
    const dispatched: DispatchedEvent = {
      event: {
        kind: 'extraction.commitment',
        confidence: 0.92,
        args: {},
        source_message_id: 'msg_1',
      },
      dispatch: 'auto_save',
      undo_token: 's:msg_1#0',
    };
    expect(mapDispatchedEventToTransparency(dispatched)).toBeNull();
  });

  it('Codex P2 fold: queue_for_confirm extraction without queue_entry_id returns null', () => {
    const dispatched: DispatchedEvent = {
      event: {
        kind: 'extraction.task',
        confidence: 0.7,
        args: {},
      },
      dispatch: 'queue_for_confirm',
      undo_token: 'u#0',
    };
    expect(mapDispatchedEventToTransparency(dispatched)).toBeNull();
  });

  it('Codex P2 fold: annotate_only extraction without fact / summary returns null', () => {
    const dispatched: DispatchedEvent = {
      event: {
        kind: 'extraction.note',
        confidence: 0.3,
        args: {},
      },
      dispatch: 'annotate_only',
      undo_token: 'u#0',
    };
    expect(mapDispatchedEventToTransparency(dispatched)).toBeNull();
  });
});

describe('D-145 PB7 — full PB6 → PB7 surface bridge', () => {
  it('compose-from-mapped flow validates + renders + emits envelope', () => {
    const dispatched: DispatchedEvent = {
      event: {
        kind: 'extraction.commitment',
        confidence: 0.92,
        args: { entity_id: 'c_42' },
        source_message_id: 'msg_1',
      },
      dispatch: 'auto_save',
      undo_token: 's:msg_1#0',
    };
    const event = mapDispatchedEventToTransparency(dispatched);
    expect(event).not.toBeNull();
    if (event === null) return;
    const r = composeTransparencyEvent({
      event,
      now: () => 1_736_000_000_333,
    });
    expect(r.issues).toEqual([]);
    expect(r.envelope?.event.kind).toBe('extraction.saved');
    expect(r.envelope?.emitted_at).toBe(1_736_000_000_333);
    expect(renderTransparencyEnvelope(r.envelope!)).toBe(
      'saving as commitment ✓',
    );
  });
});

// ── Closed-list ratchets ─────────────────────────────────────────────

describe('D-145 PB7 — closed-list ratchets', () => {
  it('TRANSPARENCY_COMPOSER_ISSUE_KINDS pinned at 1 (event_invalid)', () => {
    expect(TRANSPARENCY_COMPOSER_ISSUE_KINDS).toEqual(['event_invalid']);
  });

  it('passes through TransparencyEvent variant types', () => {
    // Type-level check — if this compiles, the union is exported.
    const e: TransparencyEvent = {
      kind: 'engine.budget_exceeded',
      total_calls: 5,
      total_cost_cents: 12,
    };
    expect(e.kind).toBe('engine.budget_exceeded');
  });
});
