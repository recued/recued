/** D-207 slice 1b — the door contract: mint (grant axis) + snapshot (tool axis).
 *
 *  A door is gated on TWO independent axes and BOTH must be closed:
 *    - grant axis: `contract_grant` rows -> isOpGranted        (the mint)
 *    - tool  axis: ContractSnapshot.allowed_tools              (the snapshot)
 *  op-admission-gate is PERMISSIVE for a wildcard door — "its real gate is the per-token
 *  ContractSnapshot.allowed_tools" — so neither is load-bearing alone. */

import { describe, expect, it } from 'vitest';

import type { ContractDefinition, ExecutionSource } from '@recued/contracts';

import type { RecipeCapability } from '../derive-recipe-capability.js';
import {
  mintDoorContract,
  doorCapabilityChanged,
} from '../mint-door-contract.js';
import { buildReceptionContractSnapshot } from '../reception-contract-snapshot.js';
import type { ContractDefinitionStore } from '../storage/contract-definition-store.js';
import type { ContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';

const NOW = () => 1_000;

const cap = (ops: string[], tools: string[] = [], conns: string[] = []): RecipeCapability => ({
  // Attribution only — the mint reads the closure, never this.
  operation_steps: Object.fromEntries(ops.map((o) => [o, 's1'])),
  operation_ids: ops, ingredient_ids: tools, connection_names: conns,
  pack_bound_connection_ops: [],
});

/** Minimal fakes — real stores would need SQLite; the BEHAVIOUR under test is what the
 *  mint WRITES and what the snapshot READS, not the persistence. */
const fakeStores = () => {
  const defs = new Map<string, ContractDefinition>();
  const grants: Array<{ c: string; k: string; g: boolean }> = [];
  let n = 0;
  const definitionStore = {
    mint: (input: Record<string, unknown>) => {
      const d = {
        contract_id: `c${++n}`, minted_at: NOW(), status: 'active', ...input,
      } as unknown as ContractDefinition;
      defs.set(d.contract_id, d);
      return d;
    },
    get: (id: string) => defs.get(id) ?? null,
    revoke: (id: string) => {
      const d = defs.get(id);
      if (!d) return null;
      const r = { ...d, revoked_at: NOW() } as ContractDefinition;
      defs.set(id, r);
      return r;
    },
  } as unknown as ContractDefinitionStore;
  const grantEntryStore = {
    set: (c: string, k: string, g: boolean) => { grants.push({ c, k, g }); },
  } as unknown as ContractGrantEntryStore;
  return { definitionStore, grantEntryStore, defs, grants };
};

const anonSource = (contract_id?: string): ExecutionSource => ({
  channel: 'reception', actor: 'anonymous', reception_id: 'ep1',
  ...(contract_id === undefined ? {} : { contract_id }),
});

describe('D-207 — the MINT writes both the pin and the actual authority', () => {
  it('writes ONE granted row per derived op — the scope alone grants nothing', () => {
    const s = fakeStores();
    const { contract_id } = mintDoorContract(
      {
        door: 'reception', recipeId: 'r1', capability: cap(['core.mail.send', 'x.list']), mintedBy: 'owner' },
      { ...s, now: NOW },
    );
    // The ACCESS gate reads these rows, not the scope.
    expect(s.grants.filter((g) => g.c === contract_id && g.g)).toHaveLength(2);
    expect(s.grants.map((g) => g.k).sort()).toEqual(['core.mail.send', 'x.list']);
  });

  it('stamps door_types: [reception] — load-bearing, NOT a label', () => {
    // This is what makes usesExplicitOnlyGrantDefaults return true => DENY-BY-DEFAULT.
    // Without it, an EMPTY op closure (a pure-transform recipe) reads as a WILDCARD door
    // and is admitted ANY op.
    const s = fakeStores();
    const { contract_id } = mintDoorContract(
      {
        door: 'reception', recipeId: 'r', capability: cap([]), mintedBy: 'o' }, { ...s, now: NOW },
    );
    expect(s.defs.get(contract_id)?.door_types).toEqual(['reception']);
    expect(s.defs.get(contract_id)?.door_execution_policy).toEqual({
      max_steps: 64,
      allow_ai: false,
    });
  });

  it('OMITS grant_kind — omission IS standing; anything else and the door stops governing', () => {
    const s = fakeStores();
    const { contract_id } = mintDoorContract(
      {
        door: 'reception', recipeId: 'r', capability: cap(['a.op']), mintedBy: 'o' }, { ...s, now: NOW },
    );
    expect(s.defs.get(contract_id)?.grant_kind).toBeUndefined();
  });

  it('the SCOPE is the capability pin (no separate capability_hash)', () => {
    const s = fakeStores();
    const { contract_id } = mintDoorContract(
      {
        door: 'reception', recipeId: 'r', capability: cap(['a.op'], ['stripe'], ['acct']), mintedBy: 'o' },
      { ...s, now: NOW },
    );
    const sc = s.defs.get(contract_id)!.scope;
    expect(sc.operation_ids).toEqual(['a.op']);
    expect(sc.connection_names).toEqual(['acct']);
    expect(sc.channels).toEqual(['reception']);
    expect(sc.actors).toEqual(['anonymous']);
  });
});

describe('D-207 — the upgrade diff re-prompts on CAPABILITY, never on content', () => {
  const stored = (
    ops: string[],
    tools: string[] = [],
    conns: string[] = [],
  ) => ({
    scope: { operation_ids: ops, ingredient_ids: tools, connection_names: conns },
  } as unknown as ContractDefinition);

  it('same ops => NO re-prompt (a reworded subject or a version bump is silent)', () => {
    expect(doorCapabilityChanged(stored(['a', 'b']), cap(['b', 'a'])).changed).toBe(false);
  });

  it('an ADDED op re-prompts, and the DIFF is the prompt', () => {
    const d = doorCapabilityChanged(stored(['a']), cap(['a', 'core.mail.send']));
    expect(d.changed).toBe(true);
    expect(d.added).toEqual(['core.mail.send']);   // "this update adds: send email"
    expect(d.removed).toEqual([]);
  });

  it('a REMOVED op is reported too (narrowing — shown, but it is not a grant)', () => {
    const d = doorCapabilityChanged(stored(['a', 'b']), cap(['a']));
    expect(d.removed).toEqual(['b']);
  });

  it('a first bind (no stored contract) is entirely additive', () => {
    const d = doorCapabilityChanged(null, cap(['a', 'b']));
    expect(d.changed).toBe(true);
    expect(d.added).toEqual(['a', 'b']);
  });

  it('an ingredient change re-prompts even when the canonical op is unchanged', () => {
    const d = doorCapabilityChanged(
      stored(['a'], ['old-catalog']),
      cap(['a'], ['new-catalog']),
    );
    expect(d).toEqual({
      changed: true,
      added: ['ingredient:new-catalog'],
      removed: ['ingredient:old-catalog'],
    });
  });

  it('a connection change re-prompts instead of reusing a stale account pin', () => {
    const d = doorCapabilityChanged(
      stored(['a'], ['catalog'], ['primary']),
      cap(['a'], ['catalog'], ['secondary']),
    );
    expect(d).toEqual({
      changed: true,
      added: ['connection:secondary'],
      removed: ['connection:primary'],
    });
  });

  it('ingredient and connection removals are narrowing-only changes', () => {
    const d = doorCapabilityChanged(
      stored(['a'], ['old-catalog'], ['primary']),
      cap(['a']),
    );
    expect(d).toEqual({
      changed: true,
      added: [],
      removed: ['connection:primary', 'ingredient:old-catalog'],
    });
  });

  it('a legacy door is re-minted under a bounded policy without a widening prompt', () => {
    const d = doorCapabilityChanged(
      stored(['a']),
      cap(['a']),
      { max_steps: 64, allow_ai: false },
    );
    expect(d).toEqual({ changed: true, added: [], removed: [] });
  });

  it('AI policy is an explicit widening even when the op/tool scope is unchanged', () => {
    const prior = {
      ...stored(['core.ai.generate'], ['core-ai-generate']),
      door_execution_policy: { max_steps: 64, allow_ai: false },
    } as ContractDefinition;
    const d = doorCapabilityChanged(
      prior,
      cap(['core.ai.generate'], ['core-ai-generate']),
      { max_steps: 64, allow_ai: true },
    );
    expect(d).toEqual({ changed: true, added: ['cost:ai'], removed: [] });
  });
});

describe('D-207 — the SNAPSHOT is the tool axis, and a dead door is a kill-switch', () => {
  const deps = (s: ReturnType<typeof fakeStores>, tools: string[]) => ({
    definitionStore: s.definitionStore,
    allowedTools: () => tools,
    now: NOW,
  });

  it('a LIVE door exposes its tools', () => {
    const s = fakeStores();
    const { contract_id } = mintDoorContract(
      {
        door: 'reception', recipeId: 'r', capability: cap(['a.op'], ['stripe']), mintedBy: 'o' },
      { ...s, now: NOW },
    );
    const snap = buildReceptionContractSnapshot(anonSource(contract_id), deps(s, ['stripe']));
    expect(snap.allowed_tools).toEqual(['stripe']);
    expect(snap.contract_id).toBe(contract_id);
    expect(snap.contract_version).toMatch(/^authority-sha256-v1:[0-9a-f]{64}$/);
  });

  it('a REVOKED door authorizes NOTHING — allowed_tools collapses to empty', () => {
    // The live kill-switch over a form that is ALREADY public and already taking traffic.
    const s = fakeStores();
    const { contract_id } = mintDoorContract(
      {
        door: 'reception', recipeId: 'r', capability: cap(['a.op'], ['stripe']), mintedBy: 'o' },
      { ...s, now: NOW },
    );
    const live = buildReceptionContractSnapshot(anonSource(contract_id), deps(s, ['stripe']));
    s.definitionStore.revoke(contract_id, 'unbound');
    const revoked = buildReceptionContractSnapshot(anonSource(contract_id), deps(s, ['stripe']));
    expect(revoked.allowed_tools).toEqual([]);
    expect(revoked.contract_version).not.toBe(live.contract_version);
  });

  it('an UNKNOWN / deleted door authorizes NOTHING', () => {
    const s = fakeStores();
    const snap = buildReceptionContractSnapshot(anonSource('gone'), deps(s, ['stripe']));
    expect(snap.allowed_tools).toEqual([]);
  });

  it('a LIVE webhook contract cannot lend its tools to a reception source', () => {
    const s = fakeStores();
    const { contract_id } = mintDoorContract(
      {
        door: 'webhook', recipeId: 'r', capability: cap(['a.op'], ['stripe']), mintedBy: 'o',
      },
      { ...s, now: NOW },
    );
    const snap = buildReceptionContractSnapshot(anonSource(contract_id), deps(s, ['stripe']));
    expect(snap.allowed_tools).toEqual([]);
  });

  it('a source with NO contract_id THROWS — a wiring bug must not be swallowed', () => {
    const s = fakeStores();
    expect(() => buildReceptionContractSnapshot(anonSource(), deps(s, []))).toThrow(/contract_id/);
  });

  it('a non-reception source THROWS — the builder must not be reused by accident', () => {
    const s = fakeStores();
    const owner = { channel: 'chat', actor: 'user_self' } as unknown as ExecutionSource;
    expect(() => buildReceptionContractSnapshot(owner, deps(s, []))).toThrow(/reception/);
  });
});
