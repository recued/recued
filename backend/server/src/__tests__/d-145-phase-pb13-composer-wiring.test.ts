/** D-145 PB13 — RecuedPlan store composer-wiring tests.
 *
 *  Acceptance for the substrate slice:
 *    - The composer returns a `RecuedPlanStore` whose append / get /
 *      list round-trip a `RecuedPlan` through in-memory backing.
 *    - High-assurance plans (`audit_policy.high_assurance: true`) get
 *      a signature populated on `append`.
 *    - Non-high-assurance plans pass through unsigned.
 *    - `executeRecuedRequestPersist` has the same shape as
 *      `ExecuteRecuedRequestContext.persist?` (compile-time `satisfies`).
 *    - `getServerIdentity` is invoked per append (not cached at
 *      construction) so post-rotation writes use the fresh key. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createInMemoryCollection } from '@recued/storage';

import type { RecuedPlan } from '@recued/contracts';
// D-160 I-3 — the orchestrator is D-145 Part-B substrate, reached by
// deep subpath import (the framework barrel only re-exports the 6
// framework modules; a D-145-substrate type re-export fails the
// `d-160-phase-1-surface.ratchet` test).
import type { ExecuteRecuedRequestContext } from '@recued/middleware/orchestrator/index.js';

import { composeRecuedPlanStore } from '../composition/bin/wire-recued-plan-store.js';
import { generateEd25519Keypair, type Ed25519Keypair } from '../keys/index.js';
import { verifyRecuedPlan } from '../recued-plan/signing.js';
import { createSQLiteCollection } from '../sqlite-collection.js';

const baseSelectionTrace = () => ({
  recipe_candidates_considered: 0,
  recipe_candidates_selected: [],
  recipe_candidates_dropped: [],
  commitment_context_pulled: false,
  commitment_rows_count: 0,
  catalog_section_counts: {},
  catalog_short_circuited: false,
});

const buildPlan = (overrides: Partial<RecuedPlan> = {}): RecuedPlan => ({
  plan_id: 'plan-pb13-1',
  goal_id: 'goal-pb13-1',
  user_request: 'baseline pb13 request',
  considered_sources: [],
  capacity_checks: [],
  included_context: [],
  omitted_context: [],
  selection_trace: baseSelectionTrace(),
  model_tier: 'fast',
  ai_provider: 'anthropic',
  ai_model_id: 'claude-haiku-4-5',
  primitive_calls: [],
  status: 'completed',
  user_visible_internal_steps: [],
  user_response: 'ok',
  user_events: [],
  provenance_links: [],
  audit_policy: {
    retain_for_days: 90,
    high_assurance: false,
    redact_user_request: false,
  },
  started_at: 1_736_000_000_000,
  completed_at: 1_736_000_001_000,
  ...overrides,
});

describe('D-145 PB13 — composeRecuedPlanStore round-trip', () => {
  it('append + get + list round-trip a RecuedPlan through in-memory backing', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { recuedPlanStore } = composeRecuedPlanStore({
      getServerIdentity: () => identity,
      backing: createInMemoryCollection<RecuedPlan>(),
    });
    const plan = buildPlan();
    await recuedPlanStore.append(plan);
    const fetched = await recuedPlanStore.get('plan-pb13-1');
    expect(fetched).not.toBeNull();
    expect(fetched?.plan_id).toBe('plan-pb13-1');
    expect(await recuedPlanStore.size()).toBe(1);
    const list = await recuedPlanStore.list();
    expect(list.map((p) => p.plan_id)).toEqual(['plan-pb13-1']);
  });
});

describe('D-145 PB13 — signing gate via audit_policy.high_assurance', () => {
  it('signs plans when high_assurance: true', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { recuedPlanStore, executeRecuedRequestPersist } = composeRecuedPlanStore({
      getServerIdentity: () => identity,
      backing: createInMemoryCollection<RecuedPlan>(),
    });
    const plan = buildPlan({
      plan_id: 'plan-pb13-signed',
      audit_policy: {
        retain_for_days: 90,
        high_assurance: true,
        redact_user_request: false,
      },
    });
    await executeRecuedRequestPersist(plan);
    const stored = await recuedPlanStore.get('plan-pb13-signed');
    expect(stored?.signature).toBeDefined();
    expect(typeof stored?.signature).toBe('string');
    expect(stored?.signer_fingerprint).toBe(identity.public_key_fingerprint);
    // Delegate the byte-level verifier check to the existing PB2
    // signing tests; this test asserts only that the wiring fires the
    // signing wrapper.
    const verify = verifyRecuedPlan(stored!, identity.public_key_b64);
    expect(verify.ok).toBe(true);
  });

  it('leaves plans unsigned when high_assurance: false', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { recuedPlanStore } = composeRecuedPlanStore({
      getServerIdentity: () => identity,
      backing: createInMemoryCollection<RecuedPlan>(),
    });
    const plan = buildPlan({ plan_id: 'plan-pb13-unsigned' });
    await recuedPlanStore.append(plan);
    const stored = await recuedPlanStore.get('plan-pb13-unsigned');
    expect(stored?.signature).toBeUndefined();
    expect(stored?.signer_fingerprint).toBeUndefined();
  });
});

describe('D-145 PB13 — executeRecuedRequestPersist callback shape', () => {
  it('is assignable to ExecuteRecuedRequestContext.persist', () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const { executeRecuedRequestPersist } = composeRecuedPlanStore({
      getServerIdentity: () => identity,
      backing: createInMemoryCollection<RecuedPlan>(),
    });
    // Compile-time check that the callback shape matches
    // `ExecuteRecuedRequestContext.persist?`. Removing this satisfies
    // clause + a callback-shape drift on either side surfaces here as
    // a `tsc` error rather than a runtime crash on the next engine
    // wiring slice.
    const persist: ExecuteRecuedRequestContext['persist'] =
      executeRecuedRequestPersist;
    expect(typeof persist).toBe('function');
  });
});

describe('D-145 PB13 — getServerIdentity invoked per append', () => {
  it('resolves the signing identity on every signed append (no boot-time capture)', async () => {
    const identityA = generateEd25519Keypair('server_identity_key');
    const identityB = generateEd25519Keypair('server_identity_key');
    let calls = 0;
    let current: Ed25519Keypair = identityA;
    const { recuedPlanStore } = composeRecuedPlanStore({
      getServerIdentity: () => {
        calls += 1;
        return current;
      },
      backing: createInMemoryCollection<RecuedPlan>(),
    });
    const plan1 = buildPlan({
      plan_id: 'plan-pb13-rot-1',
      audit_policy: {
        retain_for_days: 90,
        high_assurance: true,
        redact_user_request: false,
      },
    });
    await recuedPlanStore.append(plan1);
    expect(calls).toBe(1);

    // Simulate a key rotation between the two appends.
    current = identityB;
    const plan2 = buildPlan({
      plan_id: 'plan-pb13-rot-2',
      audit_policy: {
        retain_for_days: 90,
        high_assurance: true,
        redact_user_request: false,
      },
    });
    await recuedPlanStore.append(plan2);
    expect(calls).toBe(2);

    const stored1 = await recuedPlanStore.get('plan-pb13-rot-1');
    const stored2 = await recuedPlanStore.get('plan-pb13-rot-2');
    expect(stored1?.signer_fingerprint).toBe(identityA.public_key_fingerprint);
    expect(stored2?.signer_fingerprint).toBe(identityB.public_key_fingerprint);
  });

  it('does NOT invoke getServerIdentity on non-signing path (high_assurance: false)', async () => {
    let calls = 0;
    const identity = generateEd25519Keypair('server_identity_key');
    const { recuedPlanStore } = composeRecuedPlanStore({
      getServerIdentity: () => {
        calls += 1;
        return identity;
      },
      backing: createInMemoryCollection<RecuedPlan>(),
    });
    const plan = buildPlan({ plan_id: 'plan-pb13-no-key' });
    await recuedPlanStore.append(plan);
    expect(calls).toBe(0);
  });
});

describe('D-145 PB13 — SQLite backing persists plans across store instances', () => {
  it('a signed plan survives a simulated restart and still verifies', async () => {
    const identity = generateEd25519Keypair('server_identity_key');
    const dir = mkdtempSync(join(tmpdir(), 'recued-plan-persist-'));
    const dbPath = join(dir, 'plans.sqlite');
    const plan = buildPlan({
      plan_id: 'plan-pb13-persist',
      audit_policy: {
        retain_for_days: 90,
        high_assurance: true,
        redact_user_request: false,
      },
    });

    // Store #1 — write the signed plan to a file-backed SQLite table,
    // then close the connection. `executeRecuedRequestPersist` runs the
    // signing wrapper so the stored bytes carry a real signature.
    const db1 = new Database(dbPath);
    const first = composeRecuedPlanStore({
      getServerIdentity: () => identity,
      backing: createSQLiteCollection<RecuedPlan>(db1, 'recued_plans'),
    });
    await first.executeRecuedRequestPersist(plan);
    db1.close();

    // Store #2 — a fresh connection over the SAME db file simulates a
    // server restart. An in-memory backing would have dropped the plan
    // and `get` would return null here.
    const db2 = new Database(dbPath);
    const second = composeRecuedPlanStore({
      getServerIdentity: () => identity,
      backing: createSQLiteCollection<RecuedPlan>(db2, 'recued_plans'),
    });
    try {
      const fetched = await second.recuedPlanStore.get('plan-pb13-persist');
      expect(fetched).not.toBeNull();
      expect(fetched?.plan_id).toBe('plan-pb13-persist');
      // The signature survived the JSON round-trip through SQLite and
      // still verifies against the signing identity post-"restart".
      expect(fetched?.signature).toBeDefined();
      expect(verifyRecuedPlan(fetched!, identity.public_key_b64).ok).toBe(true);
      // list() / size() read back through the SQLite backing too.
      const list = await second.recuedPlanStore.list();
      expect(list.map((p) => p.plan_id)).toEqual(['plan-pb13-persist']);
      expect(await second.recuedPlanStore.size()).toBe(1);
    } finally {
      db2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
