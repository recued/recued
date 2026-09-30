/** D-115 — Reactive recipes contract invariants.
 *
 *  Locks the Phase 1 schema additions:
 *    - constants (extension floor, server floor, breaker threshold)
 *    - TriggerOutput envelope shape
 *    - AutoRunSpec + RecipeDefinition.auto_run / trigger_steps fields
 *    - ProcessRetireReason union
 *    - InstalledRecipeRecord.process_id wiring
 *    - CircuitBreakerState shape
 *
 *  Type-shape assertions cast through `unknown` so the compiler enforces
 *  the shape without a runtime check.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTO_RUN_EXTENSION_FLOOR_MS,
  AUTO_RUN_SERVER_FLOOR_MS,
  CIRCUIT_BREAKER_THRESHOLD,
} from '../index.js';
import type {
  AutoRunSpec,
  CircuitBreakerState,
  InstalledRecipeRecord,
  ProcessRetireReason,
  RecipeDefinition,
  TriggerOutput,
} from '../index.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

describe('D-115 constants', () => {
  it('matches the spec values', () => {
    expect(AUTO_RUN_EXTENSION_FLOOR_MS).toBe(30_000);
    expect(AUTO_RUN_SERVER_FLOOR_MS).toBe(250);
    expect(CIRCUIT_BREAKER_THRESHOLD).toBe(5);
  });

  it('extension floor exceeds server floor — chrome.alarms is the binding constraint', () => {
    // The extension SW caps to chrome.alarms's 30s/1m granularity; the
    // server tolerates sub-second ticks. If anyone flipped these the
    // recipe author would silently get the wrong cadence.
    expect(AUTO_RUN_EXTENSION_FLOOR_MS).toBeGreaterThan(AUTO_RUN_SERVER_FLOOR_MS);
  });

  it('breaker threshold is positive — zero would auto-disable on first failure', () => {
    expect(CIRCUIT_BREAKER_THRESHOLD).toBeGreaterThan(0);
  });
});

// ────────────────────────────────────────────────────────────────
// TriggerOutput envelope
// ────────────────────────────────────────────────────────────────

describe('TriggerOutput envelope', () => {
  it('admits the minimal shape — should_run only', () => {
    const out: TriggerOutput = { should_run: false };
    expect(out.should_run).toBe(false);
  });

  it('admits arbitrary downstream data alongside should_run', () => {
    const out: TriggerOutput = {
      should_run: true,
      items: [{ id: '1' }, { id: '2' }],
      last_seen_at: 1_700_000_000_000,
      etag: 'W/"abc"',
    };
    expect(out.should_run).toBe(true);
    expect(out.items).toEqual([{ id: '1' }, { id: '2' }]);
  });
});

// ────────────────────────────────────────────────────────────────
// AutoRunSpec
// ────────────────────────────────────────────────────────────────

describe('AutoRunSpec', () => {
  it('admits a static interval (no dynamic flag)', () => {
    const spec: AutoRunSpec = { interval_ms: 60_000 };
    expect(spec.interval_ms).toBe(60_000);
    expect(spec.dynamic).toBeUndefined();
  });

  it('admits a dynamic spec', () => {
    const spec: AutoRunSpec = { interval_ms: 30_000, dynamic: true };
    expect(spec.dynamic).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// RecipeDefinition wiring
// ────────────────────────────────────────────────────────────────

describe('RecipeDefinition — D-115 fields', () => {
  const baseRecipe: RecipeDefinition = {
    recipe_id: 'reactive-mail-watcher',
    version: 1,
    ttl: 60,
    metadata: {
      name: 'Reactive Mail Watcher',
      description: 'Fires when a labelled email arrives.',
      author: 'recued',
      supported_platforms: ['gmail'],
    },
    variables: {},
    prefetch_steps: [],
    steps: [],
    output: { sidebar: [] },
  };

  it('auto_run is optional', () => {
    expect(baseRecipe.auto_run).toBeUndefined();
  });

  it('auto_run plugs in as AutoRunSpec', () => {
    const r: RecipeDefinition = {
      ...baseRecipe,
      auto_run: { interval_ms: 60_000, dynamic: false },
    };
    expect(r.auto_run?.interval_ms).toBe(60_000);
  });

  it('trigger_steps plugs in as RecipeStep[]', () => {
    const r: RecipeDefinition = {
      ...baseRecipe,
      auto_run: { interval_ms: 60_000 },
      trigger_steps: [
        {
          id: 'mail',
          ingredient: 'mail-watcher',
          input: { source: 'warehouse', filter: { label: 'urgent' } },
        },
      ],
    };
    expect(r.trigger_steps?.length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// InstalledRecipeRecord wiring
// ────────────────────────────────────────────────────────────────

describe('InstalledRecipeRecord — D-115 process_id', () => {
  it('process_id is optional — non-reactive installs leave it unset', () => {
    const rec: InstalledRecipeRecord = {
      recipe_id: 'manual-deal-risk',
      version: 1,
      installed_at: '2026-04-23T00:00:00Z',
      status: 'enabled',
      ingredient_pins: [],
    };
    expect(rec.process_id).toBeUndefined();
    expect(rec.process_retired_reason).toBeUndefined();
  });

  it('process_id + retired_reason carry through for reactive installs', () => {
    const rec: InstalledRecipeRecord = {
      recipe_id: 'reactive-mail-watcher',
      version: 1,
      installed_at: '2026-04-23T00:00:00Z',
      status: 'enabled',
      ingredient_pins: [],
      process_id: '01H8XYZ-uuid-like',
      process_retired_reason: 'paused',
    };
    expect(rec.process_id).toBe('01H8XYZ-uuid-like');
    expect(rec.process_retired_reason).toBe('paused');
  });

  it('ProcessRetireReason union covers every spec-listed retirement cause', () => {
    const causes: ProcessRetireReason[] = [
      'stopped',
      'paused',
      'uninstalled',
      'version_bump',
      'circuit_broken',
    ];
    // Compile-time exhaustiveness check — narrowing forces every case.
    const handle = (r: ProcessRetireReason): string => {
      switch (r) {
        case 'stopped':
        case 'paused':
        case 'uninstalled':
        case 'version_bump':
        case 'circuit_broken':
          return r;
        default: {
          const _never: never = r;
          return _never;
        }
      }
    };
    for (const c of causes) {
      expect(handle(c)).toBe(c);
    }
  });
});

// ────────────────────────────────────────────────────────────────
// CircuitBreakerState
// ────────────────────────────────────────────────────────────────

describe('CircuitBreakerState shape', () => {
  it('admits a healthy entry — counter zero, not disabled', () => {
    const st: CircuitBreakerState = {
      dish_id: 'dsh_mail_watcher',
      recipe_id: 'reactive-mail-watcher',
      consecutive_failures: 0,
      auto_disabled: false,
    };
    expect(st.auto_disabled).toBe(false);
    expect(st.last_failure_at).toBeUndefined();
  });

  it('admits a tripped entry with failure context', () => {
    const st: CircuitBreakerState = {
      dish_id: 'dsh_mail_watcher',
      recipe_id: 'reactive-mail-watcher',
      consecutive_failures: CIRCUIT_BREAKER_THRESHOLD,
      auto_disabled: true,
      last_failure_at: 1_700_000_000_000,
      last_failure_reason: 'no_paired_server',
    };
    expect(st.auto_disabled).toBe(true);
    expect(st.consecutive_failures).toBe(CIRCUIT_BREAKER_THRESHOLD);
  });
});
