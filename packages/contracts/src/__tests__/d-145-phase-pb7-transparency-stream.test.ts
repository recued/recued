/** D-145 PB7 — Transparency Stream substrate tests.
 *
 *  Closed taxonomy + Recued voice templates + redaction tier +
 *  Settings filter + audit emission round-trip per § B.8. */

import { describe, it, expect } from 'vitest';

import {
  TRANSPARENCY_EVENT_KINDS,
  TRANSPARENCY_EVENT_KIND_SET,
  TRANSPARENCY_EVENT_CLASSES,
  TRANSPARENCY_EVENT_CLASS_FOR_KIND,
  TRANSPARENCY_EVENT_VALIDATION_KINDS,
  TRANSPARENCY_DRIFT_SEVERITIES,
  TRANSPARENCY_BRIDGE_STATUSES,
  TRANSPARENCY_PRIVACY_VIOLATION_CLASSES,
  TRANSPARENCY_COST_HALT_REASONS,
  TRANSPARENCY_DECODER_UNAVAILABLE_REASONS,
  TRANSPARENCY_DECODER_UNAVAILABLE_SITES,
  TRANSPARENCY_MULTI_TURN_ROUND_OUTCOMES,
  TRANSPARENCY_MULTI_TURN_TERMINATION_REASONS,
  TRANSPARENCY_FIXED_SLOT_VIOLATION_KINDS,
  TRANSPARENCY_STANDING_INSTRUCTION_CONFLICT_KINDS,
  TRANSPARENCY_REDACTION_TIERS,
  TRANSPARENCY_REDACTION_TIER_PRIORITY,
  TRANSPARENCY_DEFAULT_REDACTION_FOR_KIND,
  TRANSPARENCY_TEMPLATES_EN,
  TRANSPARENCY_AUDIT_SOURCES,
  TRANSPARENCY_STREAM_AUDIT_ACTION,
  DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
  classForTransparencyEventKind,
  isTransparencyEventKind,
  validateTransparencyEvent,
  defaultRedactionForKind,
  renderTransparencyTemplate,
  applyVisibilityPolicy,
  withVisibleClasses,
  withEnabled,
  withMaxRedactionTier,
  withHiddenNetworkDomain,
  buildTransparencyAuditDetail,
  assertTransparencyEventInvariants,
  assertTransparencyTemplatesComplete,
  assertTransparencyRedactionInvariants,
  assertTransparencySettingsInvariants,
  assertTransparencyAuditInvariants,
  type TransparencyEvent,
  type TransparencyEventEnvelope,
  type TransparencyStreamSettings,
} from '../index.js';

// ── Closed taxonomy completeness ─────────────────────────────────────

describe('D-145 PB7 — § B.8.2 closed event taxonomy', () => {
  it('TRANSPARENCY_EVENT_KINDS is non-empty + unique + frozen', () => {
    expect(TRANSPARENCY_EVENT_KINDS.length).toBeGreaterThan(0);
    expect(TRANSPARENCY_EVENT_KIND_SET.size).toBe(TRANSPARENCY_EVENT_KINDS.length);
  });

  it('contains all spec § B.8.2 AI-emitted kinds', () => {
    const ai = [
      'extraction.detected',
      'extraction.saved',
      'extraction.queued_for_confirm',
      'extraction.skipped_low_confidence',
      'resolution.alias',
      'resolution.contact_created_mention_only',
      'resolution.network_domain_inferred',
      'pattern.observation',
      'drift.signal',
      'action.completed',
      'action.failed',
      'cascade.fired',
    ];
    for (const k of ai) {
      expect(TRANSPARENCY_EVENT_KIND_SET.has(k as never)).toBe(true);
    }
  });

  it('contains all spec § B.8.2 engine-brokering kinds (D-164 P6.7 widened)', () => {
    const eng = [
      'capacity_check.ok',
      'capacity_check.gap',
      'memory_lookup',
      'context_omitted',
      'ai_call',
      'bridge_dispatch',
      'approval_request',
      'identity_resolution',
      'standing_instruction_applied',
      // D-164 P6.7 — prompt-cache main-turn assembly.
      'engine.gate_short_circuit',
      'engine.catalog_assembled',
    ];
    for (const k of eng) {
      expect(TRANSPARENCY_EVENT_KIND_SET.has(k as never)).toBe(true);
    }
  });

  it('contains all spec § B.8.2 failure kinds (D-164 P6.7 absorbs engine.budget_exceeded)', () => {
    const rest = [
      'ai_call.malformed',
      'ai_call.giving_up_malformed',
      'standing_instruction_conflict',
      'privacy.hard_fail',
      'capacity_gap_mid_run',
      'cost_ceiling.demoted',
      'cost_ceiling.halted',
      // D-164 P6.7 — moved from retired `two_stage` class.
      'engine.budget_exceeded',
    ];
    for (const k of rest) {
      expect(TRANSPARENCY_EVENT_KIND_SET.has(k as never)).toBe(true);
    }
  });

  it('contains the four PB5/PB4 orchestration kinds (substrate-extension)', () => {
    const orch = [
      'recued.multi_turn.round_started',
      'recued.multi_turn.round_completed',
      'recued.multi_turn.loop_terminated',
      'fixed_slot_drift',
    ];
    for (const k of orch) {
      expect(TRANSPARENCY_EVENT_KIND_SET.has(k as never)).toBe(true);
    }
  });

  it('TRANSPARENCY_EVENT_CLASSES has four distinct classes (D-164 P6.7 retired two_stage)', () => {
    expect(TRANSPARENCY_EVENT_CLASSES).toHaveLength(4);
    expect(new Set(TRANSPARENCY_EVENT_CLASSES).size).toBe(4);
    expect(TRANSPARENCY_EVENT_CLASSES).not.toContain('two_stage' as never);
  });

  it('D-164 P6f — cognition class + cognition.* event kinds are absent', () => {
    expect(TRANSPARENCY_EVENT_CLASSES).not.toContain('cognition');
    expect(TRANSPARENCY_AUDIT_SOURCES).not.toContain('cognition');
    for (const k of [
      'cognition.item_committed',
      'cognition.item_dropped',
      'cognition.reopen_reconciled',
    ]) {
      expect(TRANSPARENCY_EVENT_KIND_SET.has(k as never)).toBe(false);
    }
  });

  it('every kind maps to exactly one class', () => {
    for (const kind of TRANSPARENCY_EVENT_KINDS) {
      const cls = TRANSPARENCY_EVENT_CLASS_FOR_KIND[kind];
      expect(TRANSPARENCY_EVENT_CLASSES).toContain(cls);
    }
    expect(Object.keys(TRANSPARENCY_EVENT_CLASS_FOR_KIND).length).toBe(
      TRANSPARENCY_EVENT_KINDS.length,
    );
  });

  it('classForTransparencyEventKind matches the registry', () => {
    for (const kind of TRANSPARENCY_EVENT_KINDS) {
      expect(classForTransparencyEventKind(kind)).toBe(
        TRANSPARENCY_EVENT_CLASS_FOR_KIND[kind],
      );
    }
  });

  it('isTransparencyEventKind: true for valid + false for invalid', () => {
    expect(isTransparencyEventKind('extraction.saved')).toBe(true);
    expect(isTransparencyEventKind('not_a_real_kind')).toBe(false);
    expect(isTransparencyEventKind(undefined)).toBe(false);
    expect(isTransparencyEventKind(42)).toBe(false);
  });
});

describe('D-145 PB7 — closed-list constants are non-empty + unique', () => {
  const cases: Array<[string, ReadonlyArray<string>]> = [
    ['TRANSPARENCY_DRIFT_SEVERITIES', TRANSPARENCY_DRIFT_SEVERITIES],
    ['TRANSPARENCY_BRIDGE_STATUSES', TRANSPARENCY_BRIDGE_STATUSES],
    ['TRANSPARENCY_PRIVACY_VIOLATION_CLASSES', TRANSPARENCY_PRIVACY_VIOLATION_CLASSES],
    ['TRANSPARENCY_COST_HALT_REASONS', TRANSPARENCY_COST_HALT_REASONS],
    ['TRANSPARENCY_MULTI_TURN_ROUND_OUTCOMES', TRANSPARENCY_MULTI_TURN_ROUND_OUTCOMES],
    ['TRANSPARENCY_MULTI_TURN_TERMINATION_REASONS', TRANSPARENCY_MULTI_TURN_TERMINATION_REASONS],
    ['TRANSPARENCY_FIXED_SLOT_VIOLATION_KINDS', TRANSPARENCY_FIXED_SLOT_VIOLATION_KINDS],
    ['TRANSPARENCY_STANDING_INSTRUCTION_CONFLICT_KINDS', TRANSPARENCY_STANDING_INSTRUCTION_CONFLICT_KINDS],
    ['TRANSPARENCY_REDACTION_TIERS', TRANSPARENCY_REDACTION_TIERS],
    ['TRANSPARENCY_AUDIT_SOURCES', TRANSPARENCY_AUDIT_SOURCES],
    ['TRANSPARENCY_EVENT_VALIDATION_KINDS', TRANSPARENCY_EVENT_VALIDATION_KINDS],
  ];
  for (const [name, list] of cases) {
    it(`${name} non-empty + unique`, () => {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
    });
  }
});

// ── Validator ────────────────────────────────────────────────────────

describe('D-145 PB7 — validateTransparencyEvent', () => {
  it('null / undefined → event_not_object', () => {
    const a = validateTransparencyEvent(null);
    const b = validateTransparencyEvent(undefined);
    expect(a.some((i) => i.kind === 'event_not_object')).toBe(true);
    expect(b.some((i) => i.kind === 'event_not_object')).toBe(true);
  });

  it('primitive top-level → event_not_object', () => {
    const a = validateTransparencyEvent('hello');
    const b = validateTransparencyEvent(42);
    expect(a.some((i) => i.kind === 'event_not_object')).toBe(true);
    expect(b.some((i) => i.kind === 'event_not_object')).toBe(true);
  });

  it('unknown kind → unknown_kind', () => {
    const issues = validateTransparencyEvent({ kind: 'totally_made_up' });
    expect(issues.some((i) => i.kind === 'unknown_kind')).toBe(true);
  });

  it('D-164 P6f — rejects stale cognition event payloads as unknown kinds', () => {
    // mutate: restore any deleted cognition event kind → this unknown_kind ratchet fails.
    for (const raw of [
      { kind: 'cognition.item_committed', item_id: 'foo' },
      { kind: 'cognition.item_dropped', item_id: 'foo' },
      { kind: 'cognition.reopen_reconciled', item_id: 'foo' },
    ]) {
      const issues = validateTransparencyEvent(raw);
      expect(issues.some((i) => i.kind === 'unknown_kind')).toBe(true);
    }
  });

  it('valid event passes with empty issues', () => {
    const ok = validateTransparencyEvent({
      kind: 'extraction.detected',
      fact_type: 'commitment',
      summary: 'send report Friday',
      source_message_id: 'msg_1',
    });
    expect(ok).toEqual([]);
  });

  it('D-145 Item 1 — ai_call malformed events validate without stage', () => {
    expect(
      validateTransparencyEvent({
        kind: 'ai_call.malformed',
        round: 1,
      }),
    ).toEqual([]);
    expect(
      validateTransparencyEvent({
        kind: 'ai_call.giving_up_malformed',
      }),
    ).toEqual([]);
  });

  it('D-164 P6.7 — engine.catalog_assembled validates per-section count shape', () => {
    expect(
      validateTransparencyEvent({
        kind: 'engine.catalog_assembled',
        section_counts: { 'entity-query': 3, recipes: 5 },
      }),
    ).toEqual([]);
    expect(
      validateTransparencyEvent({
        kind: 'engine.catalog_assembled',
        section_counts: {},
      }),
    ).toEqual([]);
    // Non-finite values surface as missing_required_number with the
    // section name in the issue path.
    const issues = validateTransparencyEvent({
      kind: 'engine.catalog_assembled',
      section_counts: { enrichment: 'lots' },
    });
    expect(
      issues.some(
        (i) =>
          i.kind === 'missing_required_number' &&
          i.path === 'section_counts.enrichment',
      ),
    ).toBe(true);
  });

  it('D-164 P6.7 — engine.gate_short_circuit requires template_hash', () => {
    expect(
      validateTransparencyEvent({
        kind: 'engine.gate_short_circuit',
        template_hash: 'sha256:abc',
      }),
    ).toEqual([]);
    const missing = validateTransparencyEvent({
      kind: 'engine.gate_short_circuit',
    });
    expect(
      missing.some(
        (i) => i.kind === 'missing_required_string' && i.path === 'template_hash',
      ),
    ).toBe(true);
  });

  it('D-164 P6.7 — retired event kinds reject as unknown_kind', () => {
    for (const kind of [
      'engine.stage1_classified',
      'engine.context_filtered',
      'engine.stage2_composed',
      'engine.stage1_fallback',
    ]) {
      const issues = validateTransparencyEvent({ kind });
      expect(issues.some((i) => i.kind === 'unknown_kind')).toBe(true);
    }
  });

  it('missing required string flagged', () => {
    const issues = validateTransparencyEvent({
      kind: 'extraction.detected',
      fact_type: 'commitment',
      // summary missing
      source_message_id: 'msg_1',
    });
    expect(
      issues.some(
        (i) => i.kind === 'missing_required_string' && i.path === 'summary',
      ),
    ).toBe(true);
  });

  it('missing required number flagged', () => {
    const issues = validateTransparencyEvent({
      kind: 'memory_lookup',
      query_summary: 'recent commitments',
      // result_count missing
    });
    expect(
      issues.some(
        (i) => i.kind === 'missing_required_number' && i.path === 'result_count',
      ),
    ).toBe(true);
  });

  it('invalid enum flagged', () => {
    const issues = validateTransparencyEvent({
      kind: 'drift.signal',
      topic: 'purpose',
      severity: 'banana',
    });
    expect(
      issues.some((i) => i.kind === 'invalid_enum_value' && i.path === 'severity'),
    ).toBe(true);
  });

  it('missing required object flagged', () => {
    const issues = validateTransparencyEvent({
      kind: 'capacity_check.gap',
      // gap + remediation missing
    });
    expect(
      issues.some(
        (i) => i.kind === 'missing_required_object' && i.path === 'gap',
      ),
    ).toBe(true);
    expect(
      issues.some(
        (i) => i.kind === 'missing_required_object' && i.path === 'remediation',
      ),
    ).toBe(true);
  });

  it('orchestration: multi-turn round_started validates', () => {
    const issues = validateTransparencyEvent({
      kind: 'recued.multi_turn.round_started',
      round_index: 0,
      expected_max_rounds: 3,
      tier: 'reasoning',
    });
    expect(issues).toEqual([]);
  });

  it('orchestration: round_completed with optional counts omitted is valid', () => {
    const issues = validateTransparencyEvent({
      kind: 'recued.multi_turn.round_completed',
      round_index: 0,
      outcome: 'aborted',
    });
    expect(issues).toEqual([]);
  });

  it('orchestration: fixed_slot_drift validates closed-list violation_kind', () => {
    const issues = validateTransparencyEvent({
      kind: 'fixed_slot_drift',
      violation_kind: 'fixed_slot_drift',
      slot: 'person',
      alternative_index: 1,
    });
    expect(issues).toEqual([]);
  });

  it('cost_ceiling.demoted accepts optional demotion_steps', () => {
    const ok = validateTransparencyEvent({
      kind: 'cost_ceiling.demoted',
      from_tier: 'reasoning',
      to_tier: 'mid',
      demotion_steps: 1,
    });
    expect(ok).toEqual([]);
  });

  it('Codex P2 fold: ai_call rejects off-list tier', () => {
    const issues = validateTransparencyEvent({
      kind: 'ai_call',
      tier: 'slow',
      round: 1,
    });
    expect(
      issues.some(
        (i) => i.kind === 'invalid_enum_value' && i.path === 'tier',
      ),
    ).toBe(true);
  });

  it('Codex P2 fold: cost_ceiling.demoted rejects off-list from_tier / to_tier', () => {
    const issues = validateTransparencyEvent({
      kind: 'cost_ceiling.demoted',
      from_tier: 'slow',
      to_tier: 'huge',
    });
    expect(
      issues.some(
        (i) => i.kind === 'invalid_enum_value' && i.path === 'from_tier',
      ),
    ).toBe(true);
    expect(
      issues.some(
        (i) => i.kind === 'invalid_enum_value' && i.path === 'to_tier',
      ),
    ).toBe(true);
  });

  it('Codex P2 fold: standing_instruction_conflict rejects off-list min_tier / max_tier', () => {
    const issues = validateTransparencyEvent({
      kind: 'standing_instruction_conflict',
      instruction_ids: ['si_1'],
      min_tier: 'glacial',
      max_tier: 'turbo',
    });
    expect(
      issues.some(
        (i) => i.kind === 'invalid_enum_value' && i.path === 'min_tier',
      ),
    ).toBe(true);
    expect(
      issues.some(
        (i) => i.kind === 'invalid_enum_value' && i.path === 'max_tier',
      ),
    ).toBe(true);
  });

  it('Codex P2 fold: cost_ceiling.halted rejects off-list halted_at_tier', () => {
    const issues = validateTransparencyEvent({
      kind: 'cost_ceiling.halted',
      reason: 'no_lower_tier',
      halted_at_tier: 'turbo',
    });
    expect(
      issues.some(
        (i) => i.kind === 'invalid_enum_value' && i.path === 'halted_at_tier',
      ),
    ).toBe(true);
  });

  it('Codex P2 fold: recued.multi_turn.round_started rejects off-list tier', () => {
    const issues = validateTransparencyEvent({
      kind: 'recued.multi_turn.round_started',
      round_index: 0,
      expected_max_rounds: 2,
      tier: 'turbo',
    });
    expect(
      issues.some(
        (i) => i.kind === 'invalid_enum_value' && i.path === 'tier',
      ),
    ).toBe(true);
  });

  it('standing_instruction_conflict accepts conflict_kind discriminator + tier bounds', () => {
    const ok = validateTransparencyEvent({
      kind: 'standing_instruction_conflict',
      instruction_ids: ['si_1'],
      conflict_kind: 'tier_bound',
      min_tier: 'mid',
      max_tier: 'fast',
    });
    expect(ok).toEqual([]);
  });

  it('standing_instruction_applied accepts the MCP-safe ok projection', () => {
    const ok = validateTransparencyEvent({
      kind: 'standing_instruction_applied',
      result: {
        kind: 'ok',
        action_kinds: ['require_approval', 'force_redirect', 'min_tier'],
        require_approval: true,
        force_redirect: true,
        redact_context: false,
        ban_omission_class: false,
        tag_response: false,
        redirect_to: 'pub/specialist-recipe',
        min_tier: 'mid',
        max_tier: null,
        final_approval_required: true,
      },
    });
    expect(ok).toEqual([]);
  });

  it('standing_instruction_applied accepts conflict kind + instruction ids only', () => {
    const ok = validateTransparencyEvent({
      kind: 'standing_instruction_applied',
      result: {
        kind: 'conflict',
        conflicts: [
          {
            kind: 'redirect_collision',
            instruction_ids: ['si-a', 'si-b'],
          },
        ],
      },
    });
    expect(ok).toEqual([]);
  });

  it('standing_instruction_applied rejects off-list action kinds', () => {
    const issues = validateTransparencyEvent({
      kind: 'standing_instruction_applied',
      result: {
        kind: 'ok',
        action_kinds: ['free_text_instruction'],
        require_approval: false,
        force_redirect: false,
        redact_context: false,
        ban_omission_class: false,
        tag_response: false,
        redirect_to: null,
        min_tier: null,
        max_tier: null,
      },
    });
    expect(
      issues.some(
        (i) => i.kind === 'invalid_enum_value' && i.path === 'result.action_kinds[0]',
      ),
    ).toBe(true);
  });
});

// ── Templates ────────────────────────────────────────────────────────

describe('D-145 PB7 — § B.8.4 Recued voice templates', () => {
  it('every kind has a template entry', () => {
    expect(() => assertTransparencyTemplatesComplete()).not.toThrow();
    expect(Object.keys(TRANSPARENCY_TEMPLATES_EN).length).toBe(
      TRANSPARENCY_EVENT_KINDS.length,
    );
  });

  it('extraction.saved → "saving as <entity_kind> ✓"', () => {
    const event: TransparencyEvent = {
      kind: 'extraction.saved',
      entity_kind: 'commitment',
      entity_id: 'c_1',
      confidence: 0.92,
    };
    expect(renderTransparencyTemplate(event)).toBe('saving as commitment ✓');
  });

  it('resolution.alias renders with network_domain', () => {
    const event: TransparencyEvent = {
      kind: 'resolution.alias',
      alias: 'mom',
      contact_name: 'Mary Castellanos',
      network_domain: 'family',
    };
    expect(renderTransparencyTemplate(event)).toBe(
      'resolving "mom" → Mary Castellanos (family)',
    );
  });

  it('resolution.alias renders without network_domain', () => {
    const event: TransparencyEvent = {
      kind: 'resolution.alias',
      alias: 'bob',
      contact_name: 'Bob Smith',
    };
    expect(renderTransparencyTemplate(event)).toBe(
      'resolving "bob" → Bob Smith',
    );
  });

  it('cascade.fired renders empty (silent by default per § B.8.4)', () => {
    const event: TransparencyEvent = {
      kind: 'cascade.fired',
      recipe_id: 'detect-deal-risk-hubspot',
    };
    expect(renderTransparencyTemplate(event)).toBe('');
  });

  it('capacity_check.ok renders empty (silent by default)', () => {
    const event: TransparencyEvent = {
      kind: 'capacity_check.ok',
      capacities_passed: ['bridge_online', 'logged_in:facebook.com'],
    };
    expect(renderTransparencyTemplate(event)).toBe('');
  });

  it('ai_call reasoning tier carries reasoning prefix', () => {
    const event: TransparencyEvent = {
      kind: 'ai_call',
      tier: 'reasoning',
      round: 2,
    };
    expect(renderTransparencyTemplate(event)).toMatch(/^reasoning/);
  });

  it('ai_call fast tier carries thinking prefix', () => {
    const event: TransparencyEvent = {
      kind: 'ai_call',
      tier: 'fast',
      round: 1,
    };
    expect(renderTransparencyTemplate(event)).toMatch(/^thinking/);
  });

  it('cost_ceiling.demoted renders with from_tier → to_tier', () => {
    const event: TransparencyEvent = {
      kind: 'cost_ceiling.demoted',
      from_tier: 'reasoning',
      to_tier: 'mid',
    };
    expect(renderTransparencyTemplate(event)).toMatch(/reasoning.*→.*mid/);
  });

  it('multi_turn.loop_terminated renders different copy by reason', () => {
    const completed = renderTransparencyTemplate({
      kind: 'recued.multi_turn.loop_terminated',
      total_rounds: 1,
      termination_reason: 'completed',
    });
    const exhausted = renderTransparencyTemplate({
      kind: 'recued.multi_turn.loop_terminated',
      total_rounds: 3,
      termination_reason: 'max_rounds_exhausted',
    });
    expect(completed).toBe('1 round ✓');
    expect(exhausted).toContain('budget reached');
  });

  it('fixed_slot_drift renders with slot + alternative_index', () => {
    const event: TransparencyEvent = {
      kind: 'fixed_slot_drift',
      violation_kind: 'fixed_slot_drift',
      slot: 'person',
      alternative_index: 2,
    };
    const out = renderTransparencyTemplate(event);
    expect(out).toContain('#2');
    expect(out).toContain('person');
  });

  it('D-164 P6.7 — engine.catalog_assembled template surfaces per-section counts', () => {
    const rendered = renderTransparencyTemplate({
      kind: 'engine.catalog_assembled',
      section_counts: { 'entity-query': 4, recipes: 12 },
    });
    expect(rendered).toContain('entity-query:4');
    expect(rendered).toContain('recipes:12');
    expect(rendered).not.toContain('cognition');
  });

  it('D-164 P6.7 — engine.catalog_assembled with empty counts still renders', () => {
    expect(
      renderTransparencyTemplate({
        kind: 'engine.catalog_assembled',
        section_counts: {},
      }),
    ).toBe('catalog assembled');
  });

  it('D-164 P6.7 — engine.gate_short_circuit names truncated template hash', () => {
    expect(
      renderTransparencyTemplate({
        kind: 'engine.gate_short_circuit',
        template_hash: 'sha256:abcdef1234567890',
      }),
    ).toContain('sha256:a');
  });

  it('standing_instruction_applied renders without user-authored SI text', () => {
    const rendered = renderTransparencyTemplate({
      kind: 'standing_instruction_applied',
      result: {
        kind: 'ok',
        action_kinds: ['require_approval', 'redact_context', 'tag_response'],
        require_approval: true,
        force_redirect: false,
        redact_context: true,
        ban_omission_class: false,
        tag_response: true,
        redirect_to: null,
        min_tier: null,
        max_tier: null,
      },
    });
    expect(rendered).toContain('standing instructions applied');
    expect(rendered).toContain('approval');
    expect(rendered).toContain('redaction');
    expect(rendered).toContain('response tag');
  });
});

// ── Redaction ────────────────────────────────────────────────────────

describe('D-145 PB7 — § B.8.2.1 redaction tier defaults', () => {
  it('every kind has a default redaction tier', () => {
    expect(() => assertTransparencyRedactionInvariants()).not.toThrow();
    for (const kind of TRANSPARENCY_EVENT_KINDS) {
      expect(TRANSPARENCY_REDACTION_TIERS).toContain(
        TRANSPARENCY_DEFAULT_REDACTION_FOR_KIND[kind],
      );
    }
  });

  it('cascade.fired + capacity_check.ok default to hidden (§ B.8.4)', () => {
    expect(defaultRedactionForKind('cascade.fired')).toBe('hidden');
    expect(defaultRedactionForKind('capacity_check.ok')).toBe('hidden');
  });

  it('context_omitted + ai_call default to summary_only (§ B.8.4)', () => {
    expect(defaultRedactionForKind('context_omitted')).toBe('summary_only');
    expect(defaultRedactionForKind('ai_call')).toBe('summary_only');
  });

  it('standing_instruction_applied defaults to visible after MCP-safe projection', () => {
    expect(defaultRedactionForKind('standing_instruction_applied')).toBe('none');
  });

  it('failure-class events default to none (user must see)', () => {
    expect(defaultRedactionForKind('privacy.hard_fail')).toBe('none');
    expect(defaultRedactionForKind('cost_ceiling.halted')).toBe('none');
    expect(defaultRedactionForKind('capacity_gap_mid_run')).toBe('none');
  });

  it('redaction tier priority is unique + monotonic', () => {
    const seen = new Set<number>();
    let last = -1;
    for (const t of TRANSPARENCY_REDACTION_TIERS) {
      const p = TRANSPARENCY_REDACTION_TIER_PRIORITY[t];
      expect(seen.has(p)).toBe(false);
      seen.add(p);
      expect(p).toBeGreaterThan(last);
      last = p;
    }
  });
});

// ── Settings + visibility filter ─────────────────────────────────────

describe('D-145 PB7 — § B.8.9 Settings controls', () => {
  it('default Settings has every class entry + orchestration off by default', () => {
    expect(() => assertTransparencySettingsInvariants()).not.toThrow();
    expect(DEFAULT_TRANSPARENCY_STREAM_SETTINGS.enabled).toBe(true);
    expect(DEFAULT_TRANSPARENCY_STREAM_SETTINGS.visible_classes.ai_emitted).toBe(true);
    expect(DEFAULT_TRANSPARENCY_STREAM_SETTINGS.visible_classes.engine_brokering).toBe(true);
    expect(DEFAULT_TRANSPARENCY_STREAM_SETTINGS.visible_classes.failure).toBe(true);
    // § B.6.1 low-noise default — orchestration hidden until user opts in.
    expect(DEFAULT_TRANSPARENCY_STREAM_SETTINGS.visible_classes.orchestration).toBe(false);
  });

  it('D-164 P6.7 — default visible classes have exactly four keys (cognition + two_stage absent)', () => {
    const keys = Object.keys(DEFAULT_TRANSPARENCY_STREAM_SETTINGS.visible_classes).sort();
    expect(keys).toHaveLength(4);
    expect(keys).toEqual([
      'ai_emitted',
      'engine_brokering',
      'failure',
      'orchestration',
    ]);
    expect(keys).not.toContain('cognition');
    expect(keys).not.toContain('two_stage');
  });

  it('master toggle off → all events hidden', () => {
    const settings = withEnabled(DEFAULT_TRANSPARENCY_STREAM_SETTINGS, false);
    const event: TransparencyEvent = {
      kind: 'extraction.saved',
      entity_kind: 'commitment',
      entity_id: 'c_1',
      confidence: 0.9,
    };
    expect(applyVisibilityPolicy(event, 'none', settings)).toBe('hidden');
  });

  it('per-class opt-out hides every event in that class', () => {
    const settings = withVisibleClasses(DEFAULT_TRANSPARENCY_STREAM_SETTINGS, {
      ai_emitted: false,
    });
    const event: TransparencyEvent = {
      kind: 'extraction.saved',
      entity_kind: 'commitment',
      entity_id: 'c_1',
      confidence: 0.9,
    };
    expect(applyVisibilityPolicy(event, 'none', settings)).toBe('hidden');
    // Other class still visible.
    const failure: TransparencyEvent = {
      kind: 'cost_ceiling.halted',
      reason: 'no_lower_tier',
    };
    expect(applyVisibilityPolicy(failure, 'none', settings)).toBe('none');
  });

  it('per-network-domain hide suppresses resolution.alias for that domain', () => {
    const settings = withHiddenNetworkDomain(
      DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
      'family',
      true,
    );
    const a: TransparencyEvent = {
      kind: 'resolution.alias',
      alias: 'mom',
      contact_name: 'Mary',
      network_domain: 'family',
    };
    const b: TransparencyEvent = {
      kind: 'resolution.alias',
      alias: 'colleague',
      contact_name: 'Pat',
      network_domain: 'work',
    };
    expect(applyVisibilityPolicy(a, 'none', settings)).toBe('hidden');
    expect(applyVisibilityPolicy(b, 'none', settings)).toBe('none');
  });

  it('max_redaction_tier filter routes higher-tier events to hidden', () => {
    const settings = withMaxRedactionTier(
      DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
      'none',
    );
    const event: TransparencyEvent = {
      kind: 'context_omitted',
      source_ref: 'data.contact.bob',
      reason_code: 'privacy_class',
    };
    // context_omitted defaults to summary_only; user requested only `none`.
    expect(applyVisibilityPolicy(event, 'summary_only', settings)).toBe('hidden');
  });

  it('orchestration class opt-in unhides multi-turn events', () => {
    const settings = withVisibleClasses(DEFAULT_TRANSPARENCY_STREAM_SETTINGS, {
      orchestration: true,
    });
    const event: TransparencyEvent = {
      kind: 'recued.multi_turn.round_started',
      round_index: 0,
      expected_max_rounds: 2,
      tier: 'mid',
    };
    expect(applyVisibilityPolicy(event, 'summary_only', settings)).toBe('summary_only');
  });

  it('Codex P2 fold: failure-class events bypass master toggle (user-must-see § B.8.2)', () => {
    const settings = withEnabled(DEFAULT_TRANSPARENCY_STREAM_SETTINGS, false);
    const failures: ReadonlyArray<TransparencyEvent> = [
      {
        kind: 'privacy.hard_fail',
        violation_class: 'social_content_persist',
      },
      { kind: 'cost_ceiling.halted', reason: 'no_lower_tier' },
      { kind: 'cost_ceiling.demoted', from_tier: 'reasoning', to_tier: 'mid' },
      {
        kind: 'standing_instruction_conflict',
        instruction_ids: ['si_1'],
      },
      { kind: 'capacity_gap_mid_run', gap: { kind: 'bridge_online' } },
      { kind: 'ai_call.malformed', round: 1 },
      { kind: 'ai_call.giving_up_malformed' },
    ];
    for (const ev of failures) {
      // Even with master toggle off, failure events still surface at
      // their incoming tier. Truthful failure messaging is a
      // substrate invariant — Settings cannot suppress it.
      expect(applyVisibilityPolicy(ev, 'none', settings)).toBe('none');
    }
  });

  it('Codex P2 fold: failure-class events bypass per-class hide', () => {
    const settings = withVisibleClasses(DEFAULT_TRANSPARENCY_STREAM_SETTINGS, {
      failure: false,
    });
    const ev: TransparencyEvent = {
      kind: 'privacy.hard_fail',
      violation_class: 'context_leak',
    };
    expect(applyVisibilityPolicy(ev, 'none', settings)).toBe('none');
  });

  it('Codex P2 fold: failure-class events bypass per-tier hide', () => {
    // User asks for `none`-only rendering; failure events default to
    // `none` so they pass. Even if the incoming tier somehow widens
    // (engine-side override) the failure invariant guarantees the
    // event surfaces as the engine intended.
    const settings = withMaxRedactionTier(
      DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
      'none',
    );
    const ev: TransparencyEvent = {
      kind: 'cost_ceiling.halted',
      reason: 'min_tier_floor',
    };
    expect(applyVisibilityPolicy(ev, 'summary_only', settings)).toBe('summary_only');
  });
});

// ── Audit emission ───────────────────────────────────────────────────

describe('D-145 PB7 — § B.8.7.1 audit emission shape', () => {
  it('audit detail mirrors the event + redaction + emitted_at', () => {
    expect(() => assertTransparencyAuditInvariants()).not.toThrow();
    const envelope: TransparencyEventEnvelope = {
      event: {
        kind: 'extraction.saved',
        entity_kind: 'commitment',
        entity_id: 'c_1',
        confidence: 0.9,
      },
      redaction: 'none',
      emitted_at: 1_736_000_000_500,
      provenance_ref: 'audit_row_42',
    };
    const detail = buildTransparencyAuditDetail(envelope, 'ai_emitted', 'plan_1');
    expect(detail.event).toBe(envelope.event);
    expect(detail.chat_log_redaction).toBe('none');
    expect(detail.emitted_at).toBe(1_736_000_000_500);
    expect(detail.source).toBe('ai_emitted');
    expect(detail.run_id).toBe('plan_1');
  });

  it('omits run_id when not supplied', () => {
    const envelope: TransparencyEventEnvelope = {
      event: {
        kind: 'cascade.fired',
        recipe_id: 'detect-deal-risk-hubspot',
      },
      redaction: 'hidden',
      emitted_at: 1_736_000_000_600,
    };
    const detail = buildTransparencyAuditDetail(envelope, 'ai_emitted');
    expect('run_id' in detail).toBe(false);
  });

  it('TRANSPARENCY_AUDIT_SOURCES match TRANSPARENCY_EVENT_CLASSES', () => {
    expect(new Set(TRANSPARENCY_AUDIT_SOURCES)).toEqual(
      new Set(TRANSPARENCY_EVENT_CLASSES),
    );
  });

  it('D-164 P6.7 — audit sources have exactly four entries (cognition + two_stage absent)', () => {
    expect(TRANSPARENCY_AUDIT_SOURCES).toHaveLength(4);
    expect(TRANSPARENCY_AUDIT_SOURCES).not.toContain('cognition' as never);
    expect(TRANSPARENCY_AUDIT_SOURCES).not.toContain('two_stage' as never);
  });

  it('TRANSPARENCY_STREAM_AUDIT_ACTION is the canonical activity action', () => {
    expect(TRANSPARENCY_STREAM_AUDIT_ACTION).toBe('transparency_stream');
  });
});

// ── Substrate self-check ─────────────────────────────────────────────

describe('D-145 PB7 — substrate self-checks', () => {
  it('event invariants pass', () => {
    expect(() => assertTransparencyEventInvariants()).not.toThrow();
  });

  it('full pipeline: validate → render → wrap envelope → audit detail', () => {
    const raw: unknown = {
      kind: 'capacity_check.gap',
      gap: { kind: 'bridge_online' },
      remediation: {
        action: 'show_bridge_install_prompt',
        user_facing_copy: 'install the Bridge to use logged-in session context',
      },
    };
    expect(validateTransparencyEvent(raw)).toEqual([]);
    const event = raw as TransparencyEvent;
    const text = renderTransparencyTemplate(event);
    expect(text).toContain('bridge_online');
    expect(text).toContain('install the Bridge');
    const envelope: TransparencyEventEnvelope = {
      event,
      redaction: defaultRedactionForKind(event.kind),
      emitted_at: 1_736_000_000_700,
    };
    const audit = buildTransparencyAuditDetail(envelope, 'engine_brokering');
    expect(audit.event).toBe(event);
    expect(audit.source).toBe('engine_brokering');
  });
});

// ── Settings builder fluency ─────────────────────────────────────────

describe('D-145 PB7 — Settings builder helpers (immutable)', () => {
  it('withVisibleClasses returns a new object without mutating base', () => {
    const base = DEFAULT_TRANSPARENCY_STREAM_SETTINGS;
    const next = withVisibleClasses(base, { ai_emitted: false });
    expect(next).not.toBe(base);
    expect(base.visible_classes.ai_emitted).toBe(true);
    expect(next.visible_classes.ai_emitted).toBe(false);
  });

  it('withEnabled returns a new object', () => {
    const next = withEnabled(DEFAULT_TRANSPARENCY_STREAM_SETTINGS, false);
    expect(next.enabled).toBe(false);
    expect(DEFAULT_TRANSPARENCY_STREAM_SETTINGS.enabled).toBe(true);
  });

  it('withHiddenNetworkDomain add+remove round trip', () => {
    const added = withHiddenNetworkDomain(
      DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
      'family',
      true,
    );
    expect(added.hidden_network_domains.has('family')).toBe(true);
    const removed = withHiddenNetworkDomain(added, 'family', false);
    expect(removed.hidden_network_domains.has('family')).toBe(false);
  });

  it('TransparencyStreamSettings.max_redaction_tier override', () => {
    const settings: TransparencyStreamSettings = withMaxRedactionTier(
      DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
      'hidden',
    );
    expect(settings.max_redaction_tier).toBe('hidden');
  });
});


describe('D-145 PB7 — engine.decoder_unavailable failure event', () => {
  it('registers the kind and closed reason/site lists', () => {
    expect(TRANSPARENCY_EVENT_KIND_SET.has('engine.decoder_unavailable')).toBe(true);
    expect(TRANSPARENCY_DECODER_UNAVAILABLE_REASONS).toEqual([
      'no_source',
      'provider_failure',
      'invalid_output',
    ]);
    expect(new Set(TRANSPARENCY_DECODER_UNAVAILABLE_REASONS).size).toBe(
      TRANSPARENCY_DECODER_UNAVAILABLE_REASONS.length,
    );
    expect(TRANSPARENCY_DECODER_UNAVAILABLE_SITES).toEqual([
      'initial',
      'tool_loop',
    ]);
    expect(new Set(TRANSPARENCY_DECODER_UNAVAILABLE_SITES).size).toBe(
      TRANSPARENCY_DECODER_UNAVAILABLE_SITES.length,
    );
  });

  it('validates a complete decoder_unavailable event', () => {
    expect(
      validateTransparencyEvent({
        kind: 'engine.decoder_unavailable',
        reason: 'provider_failure',
        site: 'initial',
      }),
    ).toEqual([]);
  });

  it('rejects off-list reason and site values', () => {
    const badReason = validateTransparencyEvent({
      kind: 'engine.decoder_unavailable',
      reason: 'quota_exhausted',
      site: 'initial',
    });
    expect(badReason).toEqual(
      expect.arrayContaining([
        {
          kind: 'invalid_enum_value',
          path: 'reason',
          detail: 'quota_exhausted',
        },
      ]),
    );

    const badSite = validateTransparencyEvent({
      kind: 'engine.decoder_unavailable',
      reason: 'provider_failure',
      site: 'retry',
    });
    expect(badSite).toEqual(
      expect.arrayContaining([
        {
          kind: 'invalid_enum_value',
          path: 'site',
          detail: 'retry',
        },
      ]),
    );
  });

  it('rejects missing reason and site fields', () => {
    const issues = validateTransparencyEvent({
      kind: 'engine.decoder_unavailable',
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        {
          kind: 'invalid_enum_value',
          path: 'reason',
          detail: 'undefined',
        },
        {
          kind: 'invalid_enum_value',
          path: 'site',
          detail: 'undefined',
        },
      ]),
    );
  });

  it('pins decoder_unavailable template copy by reason and provider-failure site', () => {
    expect(
      renderTransparencyTemplate({
        kind: 'engine.decoder_unavailable',
        reason: 'no_source',
        site: 'initial',
      }),
    ).toBe('no AI model source available for this turn — check Settings → AI / Models');

    expect(
      renderTransparencyTemplate({
        kind: 'engine.decoder_unavailable',
        reason: 'invalid_output',
        site: 'initial',
      }),
    ).toBe('the AI returned output that could not be decoded');

    expect(
      renderTransparencyTemplate({
        kind: 'engine.decoder_unavailable',
        reason: 'provider_failure',
        site: 'initial',
      }),
    ).toBe('the AI provider failed before answering');

    expect(
      renderTransparencyTemplate({
        kind: 'engine.decoder_unavailable',
        reason: 'provider_failure',
        site: 'tool_loop',
      }),
    ).toBe('the AI provider failed partway through this turn');
  });

  it('classifies decoder_unavailable as user-visible failure with no redaction', () => {
    expect(classForTransparencyEventKind('engine.decoder_unavailable')).toBe('failure');
    expect(defaultRedactionForKind('engine.decoder_unavailable')).toBe('none');
  });
});
