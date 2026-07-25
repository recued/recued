/** D-207 slice 1b step 5 — the bind path + the dispatch resolver.
 *
 *  The bind is where every "no" happens. An ungranted op is a HARD DENY at fire, so a bind
 *  that admits a recipe it cannot honestly describe produces a public form that looks live
 *  and kills every submission — with the VISITOR eating the failure. */

import { describe, expect, it } from 'vitest';

import type { ContractDefinition, RecipeDefinition } from '@recued/contracts';

import {
  bindReceptionDoor,
  resolveReceptionDoorContractId,
  unbindReceptionDoor,
} from '../reception-door-bind.js';
import type { ContractDefinitionStore } from '../storage/contract-definition-store.js';
import type { ContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import type { ReceptionIntakeRecipePairStore } from '../storage/reception-intake-recipe-pair-store.js';

const NOW = () => 1_000;
const recipe = (steps: Record<string, unknown>[]): RecipeDefinition =>
  ({ prefetch_steps: [], steps }) as unknown as RecipeDefinition;

const harness = () => {
  const defs = new Map<string, ContractDefinition>();
  const grants: string[] = [];
  const pairs = new Map<string, { contract_id: string | null }>();
  let n = 0;
  const definitionStore = {
    mint: (i: Record<string, unknown>) => {
      const d = { contract_id: `c${++n}`, status: 'active', minted_at: NOW(), ...i } as unknown as ContractDefinition;
      defs.set(d.contract_id, d); return d;
    },
    get: (id: string) => defs.get(id) ?? null,
    revoke: (id: string) => {
      const d = defs.get(id); if (!d) return null;
      const r = { ...d, revoked_at: NOW() } as ContractDefinition; defs.set(id, r); return r;
    },
  } as unknown as ContractDefinitionStore;
  const grantEntryStore = { set: (_c: string, k: string) => { grants.push(k); } } as unknown as ContractGrantEntryStore;
  const pairStore = {
    findByEndpoint: (e: string) => (pairs.has(e) ? { contract_id: pairs.get(e)!.contract_id } : null),
    setContractId: (i: { endpoint_id: string; contract_id: string | null }) => {
      pairs.set(i.endpoint_id, { contract_id: i.contract_id }); return true;
    },
  } as unknown as ReceptionIntakeRecipePairStore;
  pairs.set('ep1', { contract_id: null });   // an existing, door-less pair
  return { definitionStore, grantEntryStore, pairStore, defs, grants, pairs,
    now: NOW, resolveConfig: () => ({ stripe: 'acct-1' }) };
};

const bind = (h: ReturnType<typeof harness>, steps: Record<string, unknown>[], confirmed?: boolean) =>
  bindReceptionDoor(
    { endpointId: 'ep1', recipeId: 'r1', recipe: recipe(steps), mintedBy: 'owner',
      ...(confirmed === undefined ? {} : { confirmed }) },
    h,
  );

describe('D-207 — the bind REFUSES what it cannot honestly describe', () => {
  it('refuses a dynamic-dispatch recipe — no honest capability list can exist', () => {
    const h = harness();
    const r = bind(h, [{ id: 'd', ingredient: '{{config.slug}}' }]);
    expect(r.kind).toBe('refused');
    // Nothing was written. A form that looks live and kills every submission is the one
    // outcome worse than refusing at bind.
    expect(h.defs.size).toBe(0);
    expect(h.pairs.get('ep1')?.contract_id).toBeNull();
  });

  it('refuses an unresolvable connection — which credential it would use is unknown', () => {
    const h = harness();
    const r = bind(h, [{ id: 'c', op: 'x.create', connection: '{{step.pick}}' }]);
    expect(r.kind).toBe('refused');
    expect(h.defs.size).toBe(0);
  });
});

describe('D-207 — widening ASKS; narrowing does not', () => {
  it('a FIRST bind is a widening — it asks, and writes nothing until confirmed', () => {
    const h = harness();
    const r = bind(h, [{ id: 'a', op: 'core.mail.send' }]);
    expect(r.kind).toBe('needs_consent');
    if (r.kind === 'needs_consent') expect(r.added).toEqual(['core.mail.send']);
    expect(h.defs.size).toBe(0);        // ← nothing written before consent
  });

  it('confirmed => mints the door, writes the grant rows, and links the pair', () => {
    const h = harness();
    const r = bind(h, [{ id: 'a', op: 'core.mail.send' }], true);
    expect(r.kind).toBe('bound');
    if (r.kind !== 'bound') return;
    expect(h.grants).toEqual(['core.mail.send']);
    expect(h.pairs.get('ep1')?.contract_id).toBe(r.contract_id);
    // and the dispatch hop finds it
    expect(resolveReceptionDoorContractId('ep1', h)).toBe(r.contract_id);
  });

  it('re-bind with the SAME ops is SILENT — no prompt, no re-mint', () => {
    const h = harness();
    const first = bind(h, [{ id: 'a', op: 'core.mail.send' }], true);
    const again = bind(h, [{ id: 'a2', op: 'core.mail.send' }]);   // renamed step, same op
    expect(again.kind).toBe('bound');
    if (again.kind === 'bound') {
      expect(again.unchanged).toBe(true);
      if (first.kind === 'bound') expect(again.contract_id).toBe(first.contract_id);
    }
    expect(h.defs.size).toBe(1);   // NOT re-minted
  });

  it('an ADDED op re-asks — and the diff IS the prompt', () => {
    const h = harness();
    bind(h, [{ id: 'a', op: 'core.mail.send' }], true);
    const r = bind(h, [{ id: 'a', op: 'core.mail.send' }, { id: 'b', op: 'x.charge' }]);
    expect(r.kind).toBe('needs_consent');
    if (r.kind === 'needs_consent') expect(r.added).toEqual(['x.charge']);
  });

  it('a NARROWING does not ask — removing an op is already safe', () => {
    const h = harness();
    bind(h, [{ id: 'a', op: 'core.mail.send' }, { id: 'b', op: 'x.charge' }], true);
    const r = bind(h, [{ id: 'a', op: 'core.mail.send' }]);   // no `confirmed`
    expect(r.kind).toBe('bound');
    if (r.kind === 'bound') expect(r.unchanged).toBe(false);
  });

  it('a re-bind REPLACES the door — the old contract is revoked, not left live', () => {
    const h = harness();
    const first = bind(h, [{ id: 'a', op: 'core.mail.send' }], true);
    bind(h, [{ id: 'a', op: 'core.mail.send' }, { id: 'b', op: 'x.charge' }], true);
    if (first.kind !== 'bound') throw new Error('expected bound');
    expect(h.defs.get(first.contract_id)?.revoked_at).toBeDefined();
  });
});

describe('D-207 — unbinding CLOSES the door', () => {
  it('revokes the contract AND unlinks the pair', () => {
    const h = harness();
    const r = bind(h, [{ id: 'a', op: 'core.mail.send' }], true);
    if (r.kind !== 'bound') throw new Error('expected bound');
    unbindReceptionDoor('ep1', h);
    // Revoked => `allowed_tools` collapses to [] in the snapshot, and the grant axis falls
    // to PUBLIC_CONTRACT_ID. Unbinding closes rather than opens.
    expect(h.defs.get(r.contract_id)?.revoked_at).toBeDefined();
    expect(resolveReceptionDoorContractId('ep1', h)).toBeNull();
  });

  it('a pair with NO door resolves null — which floors, it does not open', () => {
    const h = harness();
    expect(resolveReceptionDoorContractId('ep1', h)).toBeNull();
  });
});
