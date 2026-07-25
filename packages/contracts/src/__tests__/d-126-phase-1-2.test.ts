/** D-126 Phase 1.2 — `kindToScope` + `DeviceClass` + table-driven
 *  `deriveIngredientScope`.
 *
 *  Covers:
 *    - `DeviceClass` constants (ALL_DEVICE_CLASSES well-formed)
 *    - `kindToScope` per-kind expected output (§ A.2 table)
 *    - `kindToScope` exhaustive over INGREDIENT_KINDS
 *    - `deriveIngredientScope` semantics preserved post-refactor:
 *        - `service`  → ['server']                  (regression sentinel)
 *        - `dom`/`chat` → ['device']                (replaces shape/slug inference)
 *        - `http`/`ai`/`mcp`/`storage`/`connection` → ['device','server']
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_DEVICE_CLASSES,
  INGREDIENT_KINDS,
  deriveIngredientScope,
  kindToScope,
  type DeviceClass,
  type IngredientKind,
  type IngredientManifest,
} from '../index.js';

const baseManifest = (kind: IngredientKind): IngredientManifest => ({
  slug: `fixture-${kind}`,
  name: `Fixture ${kind}`,
  description: 'Fixture',
  author: 'recued-core',
  kind,
  category: 'data',
  risk_tier: 'read',
  input: {},
  output: {},
});

describe('D-126 Phase 1.2 — DeviceClass constants', () => {
  it('ALL_DEVICE_CLASSES enumerates ext / server / webapp without duplicates', () => {
    expect([...ALL_DEVICE_CLASSES].sort()).toEqual(['ext', 'server', 'webapp']);
    expect(new Set(ALL_DEVICE_CLASSES).size).toBe(ALL_DEVICE_CLASSES.length);
  });
});

describe('D-126 Phase 1.2 — kindToScope', () => {
  it('returns ext-only for dom + chat (browser-bound kinds)', () => {
    expect(kindToScope('dom')).toEqual(['ext']);
    expect(kindToScope('chat')).toEqual(['ext']);
  });

  it('returns server-only for service (D-118 long-running kind) and cli (D-182 local binary)', () => {
    expect(kindToScope('service')).toEqual(['server']);
    expect(kindToScope('cli')).toEqual(['server']);
  });

  it('returns ext + server + webapp for universal kinds (http/ai/mcp/storage/connection)', () => {
    const universal: readonly IngredientKind[] = ['http', 'ai', 'mcp', 'storage', 'connection'];
    for (const kind of universal) {
      expect(kindToScope(kind)).toEqual(['ext', 'server', 'webapp']);
    }
  });

  it('returns a non-empty DeviceClass[] for every member of INGREDIENT_KINDS', () => {
    for (const kind of INGREDIENT_KINDS) {
      const scope = kindToScope(kind);
      expect(scope.length).toBeGreaterThan(0);
      const unknown = scope.filter((c) => !ALL_DEVICE_CLASSES.includes(c as DeviceClass));
      expect(unknown).toEqual([]);
    }
  });
});

describe('D-126 Phase 1.2 — deriveIngredientScope (table-driven via kindToScope)', () => {
  it('preserves service semantics — ["server"] (regression sentinel for D-119 P15)', () => {
    expect(deriveIngredientScope(baseManifest('service'))).toEqual(['server']);
  });

  it('returns ["device"] for kind:dom (replaces isDomShaped inference)', () => {
    expect(deriveIngredientScope(baseManifest('dom'))).toEqual(['device']);
  });

  it('returns ["device"] for kind:chat (replaces web-chat- slug inference)', () => {
    expect(deriveIngredientScope(baseManifest('chat'))).toEqual(['device']);
  });

  it('returns ["device","server"] for universal kinds (collapses ext+webapp → device)', () => {
    const universal: readonly IngredientKind[] = ['http', 'ai', 'mcp', 'storage', 'connection'];
    for (const kind of universal) {
      expect(deriveIngredientScope(baseManifest(kind))).toEqual(['device', 'server']);
    }
  });
});
