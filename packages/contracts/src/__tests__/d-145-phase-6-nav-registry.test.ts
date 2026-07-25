/** D-145 PA6 — work-entity nav registry.
 *
 *  Pin per § Phase PA6 (Per-kind icon registration in primary UI nav):
 *    - The closed map covers all four work-entity kinds.
 *    - Stable iteration order matches WORK_ENTITY_NAV_ORDER.
 *    - Each spec carries icon_name + plural_label + singular_label +
 *      empty_state_copy.
 *    - workEntityNavSpec throws on unknown kind.
 */

import { describe, expect, it } from 'vitest';

import {
  WORK_ENTITY_KINDS,
  WORK_ENTITY_NAV,
  WORK_ENTITY_NAV_ORDER,
  workEntityNavSpec,
  workEntityNavSpecsInOrder,
} from '../index.js';

describe('D-145 PA6 — WORK_ENTITY_NAV registry', () => {
  it('covers every canonical work-entity kind', () => {
    for (const kind of WORK_ENTITY_KINDS) {
      expect(WORK_ENTITY_NAV).toHaveProperty(kind);
    }
    // Count DERIVED, not the literal 4 it used to be — a hardcoded count
    // is the same copied-vocabulary bug one level up, and it fails with
    // "expected 5 to be 4" rather than naming the kind that is missing.
    expect(Object.keys(WORK_ENTITY_NAV).length).toBe(WORK_ENTITY_KINDS.length);
  });

  it('yields stable nav order task → commitment → booking → note → project', () => {
    expect(WORK_ENTITY_NAV_ORDER).toEqual([
      'task',
      'commitment',
      'booking',
      'note',
      'project',
    ]);
  });

  it('nav order covers every kind — a registered-but-unreachable kind is the bug', () => {
    // `WORK_ENTITY_NAV` is a Record so it FORCES registration, but the
    // order array only constrained membership, so a new kind could be
    // registered and still never render. `exhaustiveKindOrder` now fences
    // this at compile time; this pins the behaviour the fence protects.
    expect([...WORK_ENTITY_NAV_ORDER].sort()).toEqual([...WORK_ENTITY_KINDS].sort());
  });

  it('every spec carries icon_name + plural + singular + empty_state', () => {
    for (const kind of WORK_ENTITY_KINDS) {
      const spec = WORK_ENTITY_NAV[kind];
      expect(spec.kind).toBe(kind);
      expect(typeof spec.icon_name).toBe('string');
      expect(spec.icon_name.length).toBeGreaterThan(0);
      expect(typeof spec.plural_label).toBe('string');
      expect(spec.plural_label.length).toBeGreaterThan(0);
      expect(typeof spec.singular_label).toBe('string');
      expect(spec.singular_label.length).toBeGreaterThan(0);
      expect(typeof spec.empty_state_copy).toBe('string');
      expect(spec.empty_state_copy.length).toBeGreaterThan(0);
    }
  });

  it('icon_name matches the kind string (one-to-one with ui-shared icons.generated)', () => {
    // Closed correspondence: the icons.generated.ts entry name must
    // match the kind. Adding a top_tier_kind UI requires both the
    // contracts-side spec AND a matching SVG entry in ui-shared.
    expect(WORK_ENTITY_NAV.task.icon_name).toBe('task');
    expect(WORK_ENTITY_NAV.note.icon_name).toBe('note');
    expect(WORK_ENTITY_NAV.commitment.icon_name).toBe('commitment');
    expect(WORK_ENTITY_NAV.project.icon_name).toBe('project');
  });

  it('plural and singular labels are distinct per kind', () => {
    for (const kind of WORK_ENTITY_KINDS) {
      const spec = WORK_ENTITY_NAV[kind];
      expect(spec.plural_label).not.toBe(spec.singular_label);
    }
  });
});

describe('D-145 PA6 — workEntityNavSpec', () => {
  it('returns the registered spec for each kind', () => {
    for (const kind of WORK_ENTITY_KINDS) {
      expect(workEntityNavSpec(kind)).toBe(WORK_ENTITY_NAV[kind]);
    }
  });

  it('throws on unknown kind', () => {
    expect(() => workEntityNavSpec('mail_message' as never)).toThrow(
      /unknown work-entity kind/,
    );
    expect(() => workEntityNavSpec('' as never)).toThrow();
  });
});

describe('D-145 PA6 — workEntityNavSpecsInOrder', () => {
  it('iterates in WORK_ENTITY_NAV_ORDER', () => {
    const specs = workEntityNavSpecsInOrder();
    expect(specs.map((s) => s.kind)).toEqual([
      'task',
      'commitment',
      'booking',
      'note',
      'project',
    ]);
  });

  it('yields one spec per kind', () => {
    expect(workEntityNavSpecsInOrder().length).toBe(WORK_ENTITY_KINDS.length);
  });
});
