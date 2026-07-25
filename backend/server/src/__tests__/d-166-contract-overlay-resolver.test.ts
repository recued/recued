/** D-187 slice 5 — contract-governance resolver tests.
 *
 *  The policy_matrix overlay CELL retired: `resolve()` (the `{ active, cell }`
 *  projection) collapsed to `shouldMeterUse(source, slug): boolean` (metering only),
 *  and the overlay-cell-sourced `resolveScopeRestrictions` became
 *  `resolveContractScopeRestrictions`, DERIVED from the governing contract's
 *  `data.<collection>` grant rows (`contract_grant`). Entity access is per-CONTRACT
 *  (Layer 2 — no per-door list). */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTRACT_DEFINITION_SCOPE,
  READABLE_COLLECTIONS,
  collectionGrantEntry,
  evaluateScopeRestrictions,
  type ContractDefinition,
  type ExecutionSource,
} from '@recued/contracts';

import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import {
  createContractDefinitionStore,
  type ContractDefinitionStore,
  type MintContractInput,
} from '../storage/contract-definition-store.js';
import {
  createContractGrantEntryStore,
  type ContractGrantEntryStore,
} from '../storage/contract-grant-entry-store.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';

const NOW = 1_700_000_000_000;

let db: Database.Database;
let store: ContractStore;
let definitionStore: ContractDefinitionStore;
let grantStore: ContractGrantEntryStore;
let resolver: ReturnType<typeof createContractOverlayResolver>;
let idSeq: number;

const makeSeqId = (): string => {
  idSeq += 1;
  return `ct_${idSeq}`;
};

const mintInput = (overrides: Partial<MintContractInput> = {}): MintContractInput => ({
  minted_by: 'user:1',
  display_name: 'MCP safe-http contract',
  scope: {},
  ...overrides,
});

const mcpSource = (contract_id: string): ExecutionSource => ({
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'stdio-local',
  tool_call_id: 'tool-call-1',
  mcp_token_id: 'mcp-token-1',
  contract_id,
});

const scheduleSource: ExecutionSource = {
  channel: 'schedule',
  actor: 'system',
  cron: '0 * * * *',
  source_recipe: 'recipe-1',
};

beforeEach(() => {
  db = new Database(':memory:');
  idSeq = 0;
  store = createContractStore(db, { now: () => NOW });
  definitionStore = createContractDefinitionStore(store, {
    now: () => NOW,
    newId: makeSeqId,
  });
  grantStore = createContractGrantEntryStore(store);
  resolver = createContractOverlayResolver({
    definitionStore,
    grantEntryStore: grantStore,
    now: () => NOW,
  });
});

afterEach(() => {
  db.close();
});

describe('createContractOverlayResolver — shouldMeterUse', () => {
  it('false for non-contract sources and recordUse is a no-op', () => {
    expect(resolver.shouldMeterUse(scheduleSource, 'safe-http')).toBe(false);
    expect(() => resolver.recordUse(scheduleSource)).not.toThrow();
  });

  it('false when the contract_id was never minted', () => {
    expect(resolver.shouldMeterUse(mcpSource('ct_missing'), 'safe-http')).toBe(false);
  });

  it('false for a revoked contract', () => {
    const def = definitionStore.mint(mintInput());
    definitionStore.revoke(def.contract_id, 'user revoked');
    expect(resolver.shouldMeterUse(mcpSource(def.contract_id), 'safe-http')).toBe(false);
  });

  it('false for an expired contract', () => {
    const def = definitionStore.mint(mintInput({ expiry_at: NOW - 1 }));
    expect(resolver.shouldMeterUse(mcpSource(def.contract_id), 'safe-http')).toBe(false);
  });

  it('false for an exhausted contract', () => {
    const def = definitionStore.mint(mintInput({ max_uses: 1 }));
    const source = mcpSource(def.contract_id);
    resolver.recordUse(source);
    expect(definitionStore.get(def.contract_id)).toEqual(
      expect.objectContaining({ uses_remaining: 0 }),
    );
    expect(resolver.shouldMeterUse(source, 'safe-http')).toBe(false);
  });

  it('false when the active contract scope excludes the ingredient', () => {
    const def = definitionStore.mint(
      mintInput({ scope: { ingredient_ids: ['other-ingredient'] } }),
    );
    expect(resolver.shouldMeterUse(mcpSource(def.contract_id), 'safe-http')).toBe(false);
  });

  it('true for an active wildcard contract (the policy_matrix cell is gone — metering keys on ingredient scope)', () => {
    const def = definitionStore.mint(mintInput());
    expect(resolver.shouldMeterUse(mcpSource(def.contract_id), 'safe-http')).toBe(true);
  });

  it('true for an in-scope contract', () => {
    const def = definitionStore.mint(mintInput({ scope: { ingredient_ids: ['safe-http'] } }));
    expect(resolver.shouldMeterUse(mcpSource(def.contract_id), 'safe-http')).toBe(true);
  });

  it('decrements uses_remaining when recordUse is called on an active bounded contract', () => {
    const def = definitionStore.mint(mintInput({ max_uses: 3 }));
    const source = mcpSource(def.contract_id);
    expect(resolver.shouldMeterUse(source, 'safe-http')).toBe(true);
    resolver.recordUse(source);
    expect(definitionStore.get(def.contract_id)).toEqual(
      expect.objectContaining({ uses_remaining: 2 }),
    );
  });
});

describe('createContractOverlayResolver — resolveBoundContractKind', () => {
  const putDefinition = (
    contract_id: string,
    grant_kind: ContractDefinition['grant_kind'],
    overrides: Partial<ContractDefinition> = {},
  ): ContractDefinition => {
    const def: ContractDefinition = {
      contract_id,
      minted_at: NOW,
      minted_by: 'user:1',
      display_name: contract_id,
      scope: {},
      ...(grant_kind !== undefined ? { grant_kind } : {}),
      ...overrides,
    };
    store.put(CONTRACT_DEFINITION_SCOPE, [contract_id], def);
    return def;
  };

  it('normalizes legacy and explicit standing rows to standing', () => {
    const legacy = definitionStore.mint(mintInput());
    const explicit = putDefinition('ct_standing', 'standing');

    expect(resolver.resolveBoundContractKind!(legacy.contract_id)).toBe('standing');
    expect(resolver.resolveBoundContractKind!(explicit.contract_id)).toBe('standing');
  });

  it('classifies only a live customer_instance as customer-bound', () => {
    const customer = putDefinition('ct_customer', 'customer_instance');
    const template = putDefinition('ct_template', 'customer_template');

    expect(resolver.resolveBoundContractKind!(customer.contract_id))
      .toBe('customer_instance');
    expect(resolver.resolveBoundContractKind!(template.contract_id)).toBeUndefined();
    expect(resolver.resolveBoundContractKind!('ct_missing')).toBeUndefined();
  });

  it('does not classify a revoked customer instance as live', () => {
    const customer = putDefinition('ct_customer_revoked', 'customer_instance');
    definitionStore.revoke(customer.contract_id, 'seller closed access');

    expect(resolver.resolveBoundContractKind!(customer.contract_id)).toBeUndefined();
  });
});

describe('createContractOverlayResolver — op axis RETIRED (grant-foundation slice 3, home #2 fold)', () => {
  // Metering no longer gates on the op axis: the unified `contract_grant` store
  // (`op-admission-gate.ts isOpGranted`) is the SOLE op-admission authority since home
  // #2. So an op-scoped contract meters on the INGREDIENT axis alone — whether a given
  // OP is admissible is the op gate's call, not the resolver's.
  const opScopedDef = (overrides: Partial<MintContractInput> = {}): { contract_id: string } =>
    definitionStore.mint(
      mintInput({
        scope: {
          ingredient_ids: ['hubspot-catalog'],
          operation_ids: ['recued-core/hubspot.deal.read'],
        },
        ...overrides,
      }),
    );

  it('meters an op-scoped contract on the INGREDIENT axis, regardless of the op (op axis retired)', () => {
    const def = opScopedDef();
    expect(resolver.shouldMeterUse(mcpSource(def.contract_id), 'hubspot-catalog')).toBe(true);
  });

  it('false when the INGREDIENT is out of the contract scope (ingredient axis still enforced)', () => {
    const def = opScopedDef();
    expect(resolver.shouldMeterUse(mcpSource(def.contract_id), 'other-catalog')).toBe(false);
  });

  it('an op-AGNOSTIC contract (no operation_ids) matches identically — ingredient axis only (no regression)', () => {
    const def = definitionStore.mint(mintInput({ scope: { ingredient_ids: ['hubspot-catalog'] } }));
    const src = mcpSource(def.contract_id);
    expect(resolver.shouldMeterUse(src, 'hubspot-catalog')).toBe(true);
    expect(resolver.shouldMeterUse(src, 'other-catalog')).toBe(false);
  });

  it('meters on the ingredient-matched dispatch; no decrement on an ingredient mismatch', () => {
    const def = opScopedDef({ max_uses: 3 });
    const src = mcpSource(def.contract_id);
    // Meterable on the ingredient axis ⇒ the host gates recordUse on `shouldMeterUse` ⇒
    // decrement. This op-scoped contract meters on an op-ABSENT dispatch — the deliberate
    // fail-safe OVER-count after the op-axis retirement (spec :253 "every dispatch
    // decrements"). An op-PRESENT out-of-scope op never reaches the proceed point (the op
    // gate denies it before metering), so this never UNDER-fences.
    expect(resolver.shouldMeterUse(src, 'hubspot-catalog')).toBe(true);
    resolver.recordUse(src);
    expect(definitionStore.get(def.contract_id)).toEqual(
      expect.objectContaining({ uses_remaining: 2 }),
    );
    // Ingredient mismatch ⇒ not meterable ⇒ host skips recordUse.
    expect(resolver.shouldMeterUse(src, 'other-catalog')).toBe(false);
  });
});

describe('createContractOverlayResolver — resolveContractScopeRestrictions (grant-sourced read-fence)', () => {
  // The execute-path collection fence DERIVES from the contract's `data.<collection>`
  // grant rows (slice 5 re-home). Assert via the readable-collection set the execute gate
  // consumes — each governed `data.<c>` evaluated through `evaluateScopeRestrictions` (the
  // SAME matcher the ingredient scope gate applies) — so the test pins the end-to-end
  // (grant rows → scope_restrictions → admitted collections), not a brittle array.
  const fence = (src: ExecutionSource): readonly string[] =>
    resolver.resolveContractScopeRestrictions!(src);
  const readable = (src: ExecutionSource): ReadonlySet<string> =>
    new Set(
      READABLE_COLLECTIONS.filter(
        (c) => evaluateScopeRestrictions(fence(src), `data.${c}`).verdict === 'admit',
      ),
    );

  it('a live door fences owner-only webhook and form-response collections', () => {
    const def = definitionStore.mint(mintInput());
    const set = readable(mcpSource(def.contract_id));
    // Admit-all-then-narrow: every normal READABLE_COLLECTION is on by default; only the
    // owner-default-only raw webhook + free-form response data are fenced for a
    // door (consistent with the read-grant checker).
    expect(set.has('mail')).toBe(true);
    expect(set.has('calendar')).toBe(true);
    expect(set.has('contact')).toBe(true);
    expect(set.has('webhook')).toBe(false);
    expect(set.has('form_response')).toBe(false);
    expect(fence(mcpSource(def.contract_id)).length).toBeGreaterThan(0);
  });

  it('narrows to the still-granted collections when some are explicitly revoked', () => {
    const def = definitionStore.mint(mintInput());
    // Revoke mail + contact (explicit `false` rows) — the rest stay author-default ON.
    grantStore.set(def.contract_id, collectionGrantEntry('mail'), false, NOW);
    grantStore.set(def.contract_id, collectionGrantEntry('contact'), false, NOW);
    const set = readable(mcpSource(def.contract_id));
    expect(set.has('mail')).toBe(false);
    expect(set.has('contact')).toBe(false);
    expect(set.has('calendar')).toBe(true);
    expect(set.has('note')).toBe(true);
    // A real fence is present (NOT admit-all).
    expect(fence(mcpSource(def.contract_id)).length).toBeGreaterThan(0);
  });

  it('a customer instance reads only explicitly stamped collection grants', () => {
    const def = definitionStore.mint(mintInput());
    store.put(CONTRACT_DEFINITION_SCOPE, [def.contract_id], {
      ...def,
      grant_kind: 'customer_instance',
    } satisfies ContractDefinition);

    let set = readable(mcpSource(def.contract_id));
    expect(set.has('mail')).toBe(false);
    expect(set.has('calendar')).toBe(false);

    grantStore.set(def.contract_id, collectionGrantEntry('mail'), true, NOW);
    set = readable(mcpSource(def.contract_id));
    expect(set.has('mail')).toBe(true);
    expect(set.has('calendar')).toBe(false);
  });

  it('keeps the non-collection scope families admitted when collections narrow (keep-patterns)', () => {
    const def = definitionStore.mint(mintInput());
    grantStore.set(def.contract_id, collectionGrantEntry('mail'), false, NOW);
    const f = fence(mcpSource(def.contract_id));
    // connection.* / data.enrichment.* / data.shared.* / data.memory.* must stay
    // admitted — only raw-collection reads narrow (a regression here would break a
    // door's connection calls / enrichment writes / shared + memory ops).
    expect(f).toContain('connection.*');
    expect(f).toContain('data.enrichment.*');
    expect(f).toContain('data.shared.*');
    expect(f).toContain('data.memory.*');
  });

  it('admit-all ([]) for a non-contract source', () => {
    expect(fence(scheduleSource)).toEqual([]);
  });

  it('admit-all ([]) for an unminted contract_id', () => {
    expect(fence(mcpSource('ct_missing'))).toEqual([]);
  });

  it('admit-all ([]) for an inactive (expired) contract even with collection revokes set', () => {
    const def = definitionStore.mint(mintInput({ expiry_at: NOW - 1 }));
    grantStore.set(def.contract_id, collectionGrantEntry('mail'), false, NOW);
    // A dead contract is liveness-gated OUT → the checker honours no grant rows → every
    // collection reads its author-default (admit) → [].
    expect(fence(mcpSource(def.contract_id))).toEqual([]);
  });

  it('admit-all ([]) for a revoked contract even with collection revokes set', () => {
    const def = definitionStore.mint(mintInput());
    grantStore.set(def.contract_id, collectionGrantEntry('mail'), false, NOW);
    definitionStore.revoke(def.contract_id, 'user revoked');
    expect(fence(mcpSource(def.contract_id))).toEqual([]);
  });
});
