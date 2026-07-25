/** D-166 Slice 2 — SQLite-backed `contract.*` substrate tests. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContractMergeError, D165_CONTRACT_SCHEMA, type ContractSchemaRegistry } from '@recued/contracts';

import {
  ContractSchemaSeedError,
  ContractWriteInvalidError,
  ContractWriteLoosensError,
  createContractStore,
  type ContractStore,
} from '../storage/contract-store.js';

const NOW = 1_700_000_000_000;

let db: Database.Database;
let store: ContractStore;

beforeEach(() => {
  db = new Database(':memory:');
  store = createContractStore(db, { now: () => NOW });
});

afterEach(() => {
  db.close();
});

const installedIngredientValue = () => ({
  ingredient_id: 'hubspot/deal-reader',
  version: '1.2.3',
  installed_at: NOW,
  catalog_kind: 'official',
});

const installedPackValue = () => ({
  pack_slug: 'sales-pack',
  version: '2.0.0',
  installed_at: NOW + 1,
  ingredient_ids: ['hubspot/deal-reader'],
});

const grantValue = () => ({
  allowed: true,
  approval: 'ask',
  risk_tier: 'read',
  denied_operation_ids: ['hubspot/deal-reader.delete_deal'],
  approval_required_operation_ids: ['hubspot/deal-reader.write_deal'],
  max_risk_without_approval: 'write',
});

const policyResolutionValue = () => ({
  pack_slug: 'sales-pack',
  group_id: 'deals',
  resolved_approval: 'ask',
  resolved_operations: ['hubspot/deal-reader.read_deals'],
  resolved_at: NOW + 2,
  resolved_by: 'user:1',
});

const overrideValue = () => ({
  denied: true,
  approval: 'always',
  max_risk_without_approval: 'write',
  timeout_ms: 5_000,
  cache_ttl_ms: 60_000,
});

const validRows: ReadonlyArray<{
  scope: string;
  segments: readonly string[];
  value: Record<string, unknown>;
}> = [
  {
    scope: 'installed_ingredient',
    segments: ['hubspot/deal-reader'],
    value: installedIngredientValue(),
  },
  {
    scope: 'installed_pack',
    segments: ['sales-pack'],
    value: installedPackValue(),
  },
  {
    scope: 'grant',
    segments: ['sales-pack', 'hubspot/deal-reader', 'primary', 'deals'],
    value: grantValue(),
  },
  {
    scope: 'policy_resolution',
    segments: ['sales-pack', 'deals'],
    value: policyResolutionValue(),
  },
  {
    scope: 'override',
    segments: ['user:1', 'hubspot/deal-reader', 'hubspot/deal-reader.read_deals'],
    value: overrideValue(),
  },
];

const expectInvalidWrite = (write: () => void): ContractWriteInvalidError => {
  try {
    write();
  } catch (err) {
    expect(err).toBeInstanceOf(ContractWriteInvalidError);
    const typed = err as ContractWriteInvalidError;
    expect(typed.issues.length).toBeGreaterThan(0);
    return typed;
  }
  throw new Error('expected ContractWriteInvalidError');
};

describe('createContractStore — data row CRUD', () => {
  it('put/get round-trips each D-165 scope', () => {
    for (const row of validRows) {
      store.put(row.scope, row.segments, row.value);

      expect(store.get(row.scope, row.segments)).toEqual({
        scope: row.scope,
        segments: row.segments,
        value: row.value,
        written_at: NOW,
      });
    }
  });

  it('delete removes one exact row and reports misses', () => {
    const row = validRows[0];
    store.put(row.scope, row.segments, row.value);

    expect(store.delete(row.scope, row.segments)).toBe(true);
    expect(store.get(row.scope, row.segments)).toBeNull();
    expect(store.delete(row.scope, row.segments)).toBe(false);
  });

  it('put throws ContractWriteInvalidError with issues for invalid writes', () => {
    const err = expectInvalidWrite(() => {
      store.put('grant', ['sales-pack', 'hubspot/deal-reader', 'primary'], grantValue());
    });

    expect(err.issues.map(issue => issue.code)).toContain('missing_required_segment');
  });

  it('put rejects reserved schema scope writes', () => {
    const err = expectInvalidWrite(() => {
      store.put('schema', ['composite_keys', 'grant'], D165_CONTRACT_SCHEMA.composite_keys.grant);
    });

    expect(err.issues.map(issue => issue.code)).toEqual(['unknown_scope']);
  });
});

describe('createContractStore — seedSchema', () => {
  it('writes composite_keys and value_shapes rows under contract.schema.*', () => {
    store.seedSchema(D165_CONTRACT_SCHEMA);

    expect(store.get('schema', ['composite_keys', 'grant'])?.value)
      .toEqual(D165_CONTRACT_SCHEMA.composite_keys.grant);
    expect(store.get('schema', ['value_shapes', 'grant_policy'])?.value)
      .toEqual(D165_CONTRACT_SCHEMA.value_shapes.grant_policy);
  });

  it('scan(schema, [composite_keys]) returns all composite key rows', () => {
    store.seedSchema(D165_CONTRACT_SCHEMA);

    const rows = store.scan('schema', ['composite_keys']);
    // Sorted by seg_key — cli_reachability sorts first ('cli' < 'con' < 'g').
    expect(rows.map(row => row.segments)).toEqual([
      // D-182 §7.2 — per-contract cli reachability ('cli' < 'con').
      ['composite_keys', 'cli_reachability'],
      ['composite_keys', 'connection_catalog_binding'],
      ['composite_keys', 'contract_definition'],
      // Grant-foundation slice 3 (D-187 amendment) — the unified grant set
      // (folded the retired per-topic `enrichment` visibility scope).
      ['composite_keys', 'contract_grant'],
      // D-177 N.13 (P6b) — staged-trust suggestion rows.
      ['composite_keys', 'delegation_rule_suggestion'],
      ['composite_keys', 'grant'],
      ['composite_keys', 'installed_ingredient'],
      ['composite_keys', 'installed_pack'],
      ['composite_keys', 'override'],
      ['composite_keys', 'owner_operation'],
      ['composite_keys', 'policy_resolution'],
      // D-202 — quality VERDICT signal rows (Slice 1) + suggestion rows (Task 5);
      // 'signal' < 'suggestion' by seg_key sort.
      ['composite_keys', 'quality_delegation_signal'],
      ['composite_keys', 'quality_delegation_suggestion'],
      // D-177 N.11 rule 5 (slice C) — scoped proposal rows.
      ['composite_keys', 'scoped_grant_suggestion'],
    ]);
  });

  it('is idempotent when seeding the same registry twice', () => {
    store.seedSchema(D165_CONTRACT_SCHEMA);
    store.seedSchema(D165_CONTRACT_SCHEMA);

    // 14 composite keys: 11 after the D-187 policy-matrix retirement, + D-202's
    // `quality_delegation_suggestion` (Task 5) + `quality_delegation_signal`
    // (Slice 1), + D-211's global owner operation defaults.
    expect(store.scan('schema', ['composite_keys'])).toHaveLength(14);
    // 22 value shapes: 17 after D-187, + D-202's `quality_delegation_snapshot` /
    // `_evidence` / `_suggestion` (Task 5) + `quality_delegation_signal` (Slice 1).
    // + D-211's `owner_operation_policy`.
    expect(store.scan('schema', ['value_shapes'])).toHaveLength(22);
  });

  it('throws ContractSchemaSeedError for a malformed registry', () => {
    const malformed = {
      composite_keys: {
        broken: {
          segments: ['id'],
          required: ['id'],
          value_shape: 'missing_value_shape',
          applies_to: ['grant_resolution'],
          merge_precedence: 0,
          merge_rule: 'override',
          writeable_by: 'user',
        },
      },
      value_shapes: {},
    } as unknown as ContractSchemaRegistry;

    expect(() => store.seedSchema(malformed)).toThrow(ContractSchemaSeedError);
  });
});

describe('createContractStore — scan and prefix deletion', () => {
  it('scan with an empty prefix returns the whole scope', () => {
    for (const row of validRows.filter(row => row.scope === 'override')) {
      store.put(row.scope, row.segments, row.value);
    }
    store.put('override', ['user:1', 'hubspot/deal-reader'], { approval: 'ask' });
    store.put('override', ['user:2', 'hubspot/deal-reader'], { denied: true });

    expect(store.scan('override').map(row => row.segments)).toEqual([
      ['user:1', 'hubspot/deal-reader'],
      ['user:1', 'hubspot/deal-reader', 'hubspot/deal-reader.read_deals'],
      ['user:2', 'hubspot/deal-reader'],
    ]);
  });

  it('scan returns the exact match-all row plus longer rows in key order', () => {
    store.put('override', ['user:1', 'hubspot/deal-reader'], { approval: 'ask' });
    store.put('override', ['user:1', 'hubspot/deal-reader', 'op_b'], { denied: true });
    store.put('override', ['user:1', 'hubspot/deal-reader', 'op_a'], { timeout_ms: 1_000 });
    store.put('override', ['user:1', 'other-ingredient', 'op_a'], { denied: true });
    store.put('override', ['user:2', 'hubspot/deal-reader'], { denied: true });

    expect(store.scan('override', ['user:1', 'hubspot/deal-reader']).map(row => row.segments))
      .toEqual([
        ['user:1', 'hubspot/deal-reader'],
        ['user:1', 'hubspot/deal-reader', 'op_a'],
        ['user:1', 'hubspot/deal-reader', 'op_b'],
      ]);
  });

  it('keeps prefix scans and deletes case-sensitive and segment-boundary anchored', () => {
    // REGRESSION 3 (case-sensitive prefix): SQL LIKE would conflate PackA with
    // packa; a loose string prefix would also let deal match dealflow.
    const packARead = ['PackA', 'deal', 'primary', 'read'] as const;
    const packAWrite = ['PackA', 'deal', 'primary', 'write'] as const;
    const packaRead = ['packa', 'deal', 'primary', 'read'] as const;
    const packADealflow = ['PackA', 'dealflow', 'primary', 'read'] as const;

    for (const segments of [packARead, packAWrite, packaRead, packADealflow]) {
      store.put('grant', segments, { allowed: true });
    }

    expect(store.scan('grant', ['PackA', 'deal']).map(row => row.segments)).toEqual([
      [...packARead],
      [...packAWrite],
    ]);

    expect(store.deleteByPrefix('grant', ['PackA', 'deal'])).toBe(2);
    expect(store.scan('grant').map(row => row.segments)).toEqual([
      [...packADealflow],
      [...packaRead],
    ]);
  });
});

describe('createContractStore — segment codec', () => {
  it('round-trips dotted override operation_id segments through get and scan', () => {
    const segments = [
      'user:1',
      'hubspot/deal-reader',
      'acme/deal-reader.read_deals',
    ] as const;
    const value = { denied: true };

    store.put('override', segments, value);

    expect(store.get('override', segments)?.segments).toEqual([...segments]);
    expect(store.get('override', segments)?.value).toEqual(value);
    expect(store.scan('override', ['user:1', 'hubspot/deal-reader']).map(row => row.segments))
      .toEqual([[...segments]]);
  });
});

describe('createContractStore — tightening_only write enforcement', () => {
  const ACTOR = 'user:1';
  const ING = 'hubspot/deal-reader';
  const OP = 'hubspot/deal-reader.read_deals';
  const OP2 = 'hubspot/deal-reader.delete_deal';

  const expectLoosens = (write: () => void): ContractWriteLoosensError => {
    try {
      write();
    } catch (err) {
      expect(err).toBeInstanceOf(ContractWriteLoosensError);
      return err as ContractWriteLoosensError;
    }
    throw new Error('expected ContractWriteLoosensError');
  };

  it('rejects an operation-specific actor override looser than its match-all', () => {
    store.put('override', [ACTOR, ING], { approval: 'always' });
    const err = expectLoosens(() =>
      store.put('override', [ACTOR, ING, OP], { approval: 'ask' }),
    );

    expect(err.loosenedFields).toEqual(['approval']);
    expect(store.get('override', [ACTOR, ING, OP])).toBeNull();
  });

  it('admits an operation-specific approval stricter than its match-all (most-specific-wins at resolve)', () => {
    store.put('override', [ACTOR, ING], { approval: 'ask' });
    store.put('override', [ACTOR, ING, OP], { approval: 'always' });

    expect(store.get('override', [ACTOR, ING, OP])?.value).toEqual({ approval: 'always' });
  });

  it('admits a fresh match-all even when a stricter operation-specific exists', () => {
    store.put('override', [ACTOR, ING, OP], { approval: 'always' });
    store.put('override', [ACTOR, ING], { approval: 'ask' });

    expect(store.get('override', [ACTOR, ING])?.value).toEqual({ approval: 'ask' });
  });

  it('ignores sibling operation overrides — they never co-apply at dispatch', () => {
    store.put('override', [ACTOR, ING], { approval: 'ask' });
    store.put('override', [ACTOR, ING, OP2], { approval: 'always' }); // stricter sibling
    // read_deals at the match-all level is admitted even though delete_deal is stricter
    store.put('override', [ACTOR, ING, OP], { approval: 'ask' });

    expect(store.get('override', [ACTOR, ING, OP])?.value).toEqual({ approval: 'ask' });
  });

  it('rejects a same-path actor override upsert that loosens an explicit value', () => {
    store.put('override', [ACTOR, ING, OP], { approval: 'always' });
    const err = expectLoosens(() =>
      store.put('override', [ACTOR, ING, OP], { approval: 'never' }),
    );

    expect(err.loosenedFields).toEqual(['approval']);
    expect(store.get('override', [ACTOR, ING, OP])?.value).toEqual({ approval: 'always' });
  });

  it('still rejects a same-path loosening of a TIGHTEN-ONLY field (max_risk_without_approval)', () => {
    // D-211 §2 keeps the tighten-only family lattice-gated: the ceiling can
    // only go DOWN (stricter LOW) at the store, exactly as before.
    store.put('override', [ACTOR, ING, OP], { max_risk_without_approval: 'read' });
    const err = expectLoosens(() =>
      store.put('override', [ACTOR, ING, OP], { max_risk_without_approval: 'admin' }),
    );

    expect(err.loosenedFields).toEqual(['max_risk_without_approval']);
    expect(store.get('override', [ACTOR, ING, OP])?.value).toEqual({
      max_risk_without_approval: 'read',
    }); // unchanged
  });

  it('admits a same-path upsert that tightens, and an idempotent rewrite', () => {
    store.put('override', [ACTOR, ING, OP], { approval: 'ask' });
    store.put('override', [ACTOR, ING, OP], { approval: 'always' }); // tighten
    expect(store.get('override', [ACTOR, ING, OP])?.value).toEqual({ approval: 'always' });

    store.put('override', [ACTOR, ING, OP], { approval: 'always' }); // idempotent
    expect(store.get('override', [ACTOR, ING, OP])?.value).toEqual({ approval: 'always' });
  });

  it('stores D-211 global owner defaults in the actorless owner_operation scope', () => {
    store.put('owner_operation', [ING, OP], {
      risk: 'write',
      approval: 'ask',
      op_hash: 'abc123',
    });

    expect(store.get('owner_operation', [ING, OP])?.value).toEqual({
      risk: 'write',
      approval: 'ask',
      op_hash: 'abc123',
    });
  });

  it('deny-flag denied:true tightens (admitted); denied:false clears (admitted)', () => {
    store.put('override', [ACTOR, ING], { approval: 'always' });
    store.put('override', [ACTOR, ING, OP], { denied: true }); // → allowed:false, a tightening
    expect(store.get('override', [ACTOR, ING, OP])?.value).toEqual({ denied: true });

    // denied:false projects to {} (no constraint) — delete-like clear, admitted
    store.put('override', [ACTOR, ING, OP], { denied: false });
    expect(store.get('override', [ACTOR, ING, OP])?.value).toEqual({ denied: false });
  });

  it('reports every loosening actor-override field', () => {
    store.put('override', [ACTOR, ING], {
      approval: 'always',
      max_risk_without_approval: 'read',
      timeout_ms: 1_000,
    });
    const err = expectLoosens(() =>
      store.put('override', [ACTOR, ING, OP], {
        approval: 'ask',
        max_risk_without_approval: 'admin',
        timeout_ms: 5_000,
      }),
    );

    expect([...err.loosenedFields].sort()).toEqual(
      ['approval', 'max_risk_without_approval', 'timeout_ms'].sort(),
    );
  });

  it('does not apply the loosening check to non-tightening_only scopes', () => {
    // grant is union_with_stricter_wins — a "looser" upsert is not a loosening error
    const seg = ['sales-pack', ING, 'primary', 'deals'];
    store.put('grant', seg, { allowed: true, approval: 'always' });
    expect(() => store.put('grant', seg, { allowed: true, approval: 'never' })).not.toThrow();
    expect(store.get('grant', seg)?.value).toEqual({ allowed: true, approval: 'never' });
  });

  it('fail-closed: a structurally-valid but below-floor lattice value is rejected', () => {
    // timeout_ms is `number?` structurally but the lattice floor is 1; the
    // tightening check validates lattice values, so timeout_ms:0 is rejected.
    expect(() => store.put('override', [ACTOR, ING, OP], { timeout_ms: 0 })).toThrow(ContractMergeError);
  });
});
