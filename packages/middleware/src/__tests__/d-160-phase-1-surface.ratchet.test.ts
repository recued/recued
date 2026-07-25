/** D-160 — framework-not-container surface ratchet (Must Hold I-3).
 *
 *  Spec: D-160 Must Hold I-3. This file intentionally
 *  does not duplicate the D-159 I-1/I-2 import-boundary ratchets.
 *
 *  D-160 P1 ratcheted the framework's *presence* — the D-160 surface is
 *  exported, no cognition runtime container leaks, no first-party
 *  middleware implementation directory sits under `src/`. D-160 P2
 *  landed the strict narrowing: it moved every D-145-substrate consumer
 *  onto deep subpath imports (`@recued/middleware/<dir>/…`), narrowed
 *  `index.ts` to the framework surface, and tightened the barrel check
 *  below to exact-equality — a D-145-substrate re-export creeping back
 *  onto the barrel now fails this ratchet.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as middleware from '@recued/middleware';

const SRC = resolve(__dirname, '..');

const p1FrameworkFiles = [
  'capacity.ts',
  'dispatch.ts',
  'index.ts',
  'out-stream.ts',
  'pipeline.ts',
  'registry.ts',
  'types.ts',
];

/** The complete D-160 framework runtime surface — every value (non-type)
 *  export of the package barrel. `export type` produces no runtime key,
 *  so `Object.keys(middleware)` is exactly this set once the barrel is
 *  narrowed (I-3). D-164 P5 adds `dispatchToolCalls` — concurrent
 *  tool-call dispatch primitive (parallel iff every call declares
 *  `concurrency_safe: true`). */
const frameworkRuntimeExports = [
  'DEFAULT_MAX_TURNS',
  'capacityBreach',
  'createCapacity',
  'createMiddlewareRegistry',
  'createOutStream',
  'dispatchToolCalls',
  'narrowCapacity',
  'projectTurnToOutStream',
  'runStream',
];

/** D-145 Part-B substrate barrel namespaces / symbols D-159 P0
 *  relocated into `packages/middleware/src/`. They are framework
 *  *internals* — reached by deep subpath import, never re-exported from
 *  the package barrel (I-3). */
const d145SubstrateExports = [
  'capacity',
  'primitives',
  'orchestrator',
  'aiCooperative',
  'aiOutput',
  'transparencyStream',
  'failureSemantics',
  'createInternalToolRegistry',
  'tier1ToolNames',
];

const firstPartyMiddlewareDirs = [
  'cognition',
  'confidence-shape',
  'correction-learning',
  'personal-recipes',
  'scope-search',
  'standing-instructions',
  'two-stage',
];

describe('D-160 I-3 middleware surface', () => {
  it('ships the P1 framework source files', () => {
    expect(
      p1FrameworkFiles.filter((file) => existsSync(join(SRC, file))),
    ).toEqual(p1FrameworkFiles);
  });

  it('exports EXACTLY the D-160 framework runtime surface from the package barrel', () => {
    // D-160 P2 (I-3) — exact equality, not `arrayContaining`. The
    // barrel is the framework surface and nothing else; a D-145
    // substrate re-export creeping back fails here.
    expect(Object.keys(middleware).sort()).toEqual(
      frameworkRuntimeExports.slice().sort(),
    );
  });

  it('does not re-export the D-145 Part-B substrate from the framework barrel', () => {
    // The framework's internal building blocks (the D-159 P0
    // relocation) are reached by deep subpath import, never the
    // barrel. D-160 P2 moved every consumer onto deep imports.
    expect(
      d145SubstrateExports.filter((name) =>
        Object.prototype.hasOwnProperty.call(middleware, name),
      ),
    ).toEqual([]);
  });

  it('re-exports source modules only from the framework files', () => {
    // The runtime-key check above sees value exports only; a type-only
    // re-export — `export type { PlanDraft } from './orchestrator/…'` —
    // would slip past it. This source-level check pins every `from
    // './…'` re-export specifier in the barrel to the framework
    // modules, so a D-145-substrate *type* re-export fails too (I-3).
    const barrel = readFileSync(join(SRC, 'index.ts'), 'utf8');
    const specifiers = [...barrel.matchAll(/from '(\.\/[^']+)'/g)].map(
      (match) => match[1],
    );
    const frameworkModules = new Set([
      './pipeline.js',
      './registry.js',
      './out-stream.js',
      './capacity.js',
      './dispatch.js',
      './types.js',
    ]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(
      specifiers.filter((spec) => !frameworkModules.has(spec)),
    ).toEqual([]);
  });

  it('does not export a runtime cognition container from the framework barrel', () => {
    expect(Object.prototype.hasOwnProperty.call(middleware, 'cognition')).toBe(
      false,
    );
  });

  it('does not contain first-party middleware implementation directories under src', () => {
    const dirs = readdirSync(SRC, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(
      firstPartyMiddlewareDirs.filter((dir) => dirs.includes(dir)),
    ).toEqual([]);
  });
});
