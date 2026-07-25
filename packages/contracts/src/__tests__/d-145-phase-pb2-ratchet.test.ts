/** D-145 PB2 — closed-list drift ratchet (§ B.5).
 *
 *  Every drift-prone enum / map / union pairs with a ratchet test
 *  that fails on additions. Catches the closed-list-discipline
 *  invariant at PR time. Mirrors the PB1 ratchet pattern. */

import { describe, expect, it } from 'vitest';

import {
  CLASSIFICATION_INTENT_KINDS,
  CONTEXT_BREADTHS,
  CONTEXT_CLASS_PERSIST_POLICIES,
  CONTEXT_CONTENT_CLASSES,
  CONTEXT_CONTENT_CLASS_SET,
  CONTEXT_PERSIST_POLICIES,
  CONTEXT_PERSIST_POLICY_SET,
  FAILURE_CLASSES,
  MODEL_TIERS,
  NARROWING_REASON_CODES,
  OMISSION_REASON_CODES,
  PLAN_STATUSES,
  PRIMITIVE_CALL_STATUSES,
  RECUED_PLAN_MEMORY_KIND,
  RECUED_PLAN_VALIDATION_ISSUE_KINDS,
  RECUED_PRIMITIVES,
  RECUED_PRIMITIVE_SET,
} from '../index.js';

describe('D-145 PB2 — § B.5 closed-list ratchet', () => {
  it('RECUED_PRIMITIVES.length === 10 (PB1 v1)', () => {
    expect(RECUED_PRIMITIVES.length).toBe(10);
  });

  it('PRIMITIVE_CALL_STATUSES.length === 8 (PB2 v1)', () => {
    expect(PRIMITIVE_CALL_STATUSES.length).toBe(8);
  });

  it('OMISSION_REASON_CODES.length === 8 (§ B.5.1 v1)', () => {
    expect(OMISSION_REASON_CODES.length).toBe(8);
  });

  it('CONTEXT_CONTENT_CLASSES.length === 14 (§ B.2.3 v1)', () => {
    expect(CONTEXT_CONTENT_CLASSES.length).toBe(14);
  });

  it('CONTEXT_PERSIST_POLICIES.length === 3', () => {
    expect(CONTEXT_PERSIST_POLICIES.length).toBe(3);
  });

  it('PLAN_STATUSES.length === 9 (§ B.15.11 v1)', () => {
    expect(PLAN_STATUSES.length).toBe(9);
  });

  it('FAILURE_CLASSES.length === 7', () => {
    expect(FAILURE_CLASSES.length).toBe(7);
  });

  it('NARROWING_REASON_CODES.length === 9 (D-164 P6b/c retired state_filter; PB2 6 + D-137 P1.3 § A.6.1 widening of 3)', () => {
    expect(NARROWING_REASON_CODES.length).toBe(9);
  });

  it('CLASSIFICATION_INTENT_KINDS.length === 5 (D-164 P6b/c retired cognition_create + cognition_update; § B.17.2.1)', () => {
    expect(CLASSIFICATION_INTENT_KINDS.length).toBe(5);
  });

  it('CONTEXT_BREADTHS.length === 2', () => {
    expect(CONTEXT_BREADTHS.length).toBe(2);
  });

  it('MODEL_TIERS.length === 3', () => {
    expect(MODEL_TIERS.length).toBe(3);
  });

  it('RECUED_PLAN_VALIDATION_ISSUE_KINDS.length === 20 (D-145 Item 1 single-stage collapse dropped primitive_stage_misuse)', () => {
    expect(RECUED_PLAN_VALIDATION_ISSUE_KINDS.length).toBe(20);
  });

  it("RECUED_PLAN_MEMORY_KIND === 'recued_plan' literal", () => {
    expect(RECUED_PLAN_MEMORY_KIND).toBe('recued_plan');
  });

  it('every ContextContentClass has a CONTEXT_CLASS_PERSIST_POLICIES entry', () => {
    for (const c of CONTEXT_CONTENT_CLASSES) {
      const allowed = CONTEXT_CLASS_PERSIST_POLICIES[c];
      expect(allowed).toBeDefined();
      expect(allowed.length).toBeGreaterThan(0);
      // Every declared policy in the entry must be a known policy.
      for (const p of allowed) {
        expect(CONTEXT_PERSIST_POLICY_SET.has(p)).toBe(true);
      }
    }
  });

  it('CONTEXT_CONTENT_CLASS_SET predicate matches the closed list', () => {
    for (const c of CONTEXT_CONTENT_CLASSES) {
      expect(CONTEXT_CONTENT_CLASS_SET.has(c)).toBe(true);
    }
    expect(CONTEXT_CONTENT_CLASS_SET.size).toBe(CONTEXT_CONTENT_CLASSES.length);
  });

  it('RECUED_PRIMITIVE_SET predicate matches the closed list', () => {
    for (const p of RECUED_PRIMITIVES) {
      expect(RECUED_PRIMITIVE_SET.has(p)).toBe(true);
    }
    expect(RECUED_PRIMITIVE_SET.size).toBe(RECUED_PRIMITIVES.length);
  });

  it("'social_raw_body' admits ONLY 'immediate_use_only' (privacy invariant)", () => {
    expect(CONTEXT_CLASS_PERSIST_POLICIES.social_raw_body).toEqual([
      'immediate_use_only',
    ]);
  });

  it("'standing_instruction' + 'contact_alias' do NOT admit 'persist'", () => {
    expect(CONTEXT_CLASS_PERSIST_POLICIES.standing_instruction).not.toContain(
      'persist',
    );
    expect(CONTEXT_CLASS_PERSIST_POLICIES.contact_alias).not.toContain(
      'persist',
    );
  });

  it("substrate-clean classes admit 'persist' (work_entity / mail_subject_meta / etc.)", () => {
    expect(CONTEXT_CLASS_PERSIST_POLICIES.work_entity).toContain('persist');
    expect(CONTEXT_CLASS_PERSIST_POLICIES.mail_subject_meta).toContain('persist');
    expect(CONTEXT_CLASS_PERSIST_POLICIES.calendar_event).toContain('persist');
    expect(CONTEXT_CLASS_PERSIST_POLICIES.system_provenance).toContain('persist');
  });
});
