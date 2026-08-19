/** D-247 slice 3 — the coverage predicate, its owner input path, and the
 *  boundary it must NOT cross.
 *
 *  ⛔ THE THREE THINGS THAT WOULD SHIP BROKEN SILENTLY, EACH PINNED HERE:
 *   1. `grantingRecipeEntry`'s owner arm SUBSTITUTING for the door arm rather
 *      than adding to it — every shipped MCP door loses its D-232 coverage and
 *      no owner-path test notices.
 *   2. `isOwnerRecipeGranted` answering `true` for a DOOR — a widening past what
 *      the door's inbound token grants, wearing the costume of consistency.
 *   3. `recipeCoversOp` ignoring whose coverage it was handed — the nested-run
 *      hazard D2 bounds, which looks like a working system. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OWNER_CONTRACT_ID,
  recipeGrantEntry,
  type ContractSnapshot,
  type ExecutionSource,
} from '@recued/contracts';

import { createOpAdmissionGate } from '../op-admission-gate.js';
import { grantingRecipeEntry, recipeCoversOp, type RecipeCoverage } from '../policy-gate.js';
import { recipeGrantKeyFor, resolveRecipePublisher } from '../recipe-grant-identity.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';

const NOW = 1_750_000_000_000;
const RECIPE_ID = 'overdue-invoice-chase';
const PUBLISHER = 'recued-core';
const KEY = recipeGrantEntry(PUBLISHER, RECIPE_ID);

const ownerChat: ExecutionSource = {
  channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'owner',
};
const humanHid: ExecutionSource = {
  channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'ct',
};
const door = (contract_id: string): ExecutionSource => ({
  channel: 'mcp', actor: 'contracted_user', agent_id: 'a1', tool_call_id: 'tc1',
  mcp_token_id: 'tok1', contract_id,
});

const snapshot = (allowed_tools: string[]): ContractSnapshot =>
  ({ contract_id: 'door-1', allowed_tools, approval_required: [], scope_restrictions: [] } as unknown as ContractSnapshot);

describe('grantingRecipeEntry — the door arm is UNCHANGED', () => {
  it('still finds a recipe wire name in allowed_tools, and returns the NAME', () => {
    // D-232 § 20.19: an MCP door's recipe grant rides its inbound token into
    // `allowed_tools`. Substituting the owner read for this scan would delete it.
    expect(
      grantingRecipeEntry(RECIPE_ID, snapshot([`${PUBLISHER}/${RECIPE_ID}`, 'mail-send'])),
    ).toBe(`${PUBLISHER}/${RECIPE_ID}`);
  });

  it('is undefined for a door whose allowed_tools names other recipes only', () => {
    expect(grantingRecipeEntry(RECIPE_ID, snapshot(['other/thing', 'mail-send']))).toBeUndefined();
  });

  it('does NOT consult the owner arm when a snapshot is present', () => {
    // A door must never pick up an owner grant. The arm is not even called.
    let called = false;
    const r = grantingRecipeEntry(RECIPE_ID, snapshot(['mail-send']), () => {
      called = true;
      return KEY;
    });
    expect(r).toBeUndefined();
    expect(called).toBe(false);
  });
});

describe('grantingRecipeEntry — the owner arm is an ADDITION', () => {
  it('fires only when there is no snapshot, and returns the ENTRY KEY', () => {
    expect(grantingRecipeEntry(RECIPE_ID, undefined, () => KEY)).toBe(KEY);
  });

  it('is undefined when the owner holds no grant', () => {
    expect(grantingRecipeEntry(RECIPE_ID, undefined, () => undefined)).toBeUndefined();
  });

  it('is undefined when no owner arm is wired at all (today’s behaviour)', () => {
    expect(grantingRecipeEntry(RECIPE_ID, undefined)).toBeUndefined();
  });
});

describe('isOwnerRecipeGranted — owner-only by design', () => {
  let db: Database.Database;
  let gate: ReturnType<typeof createOpAdmissionGate>;
  let grants: ReturnType<typeof createContractGrantEntryStore>;

  beforeEach(() => {
    db = new Database(':memory:');
    const store = createContractStore(db, { now: () => NOW });
    grants = createContractGrantEntryStore(store);
    gate = createOpAdmissionGate({
      grantEntryStore: grants,
      definitionStore: createContractDefinitionStore(store, { now: () => NOW }),
      now: () => NOW,
    });
  });
  afterEach(() => db.close());

  it('D7: FALSE for the owner with no row — the one inverted default', () => {
    expect(gate.isOwnerRecipeGranted(ownerChat, KEY)).toBe(false);
  });

  it('TRUE for the owner once the row is granted', () => {
    grants.set(OWNER_CONTRACT_ID, KEY, true, NOW);
    expect(gate.isOwnerRecipeGranted(ownerChat, KEY)).toBe(true);
  });

  it('FALSE again on an explicit revoke row', () => {
    grants.set(OWNER_CONTRACT_ID, KEY, false, NOW);
    expect(gate.isOwnerRecipeGranted(ownerChat, KEY)).toBe(false);
  });

  it('FALSE for a DOOR even when the OWNER holds the grant', () => {
    // The widening this function must never do: a door's recipe authority is its
    // inbound token, not the owner's contract.
    grants.set(OWNER_CONTRACT_ID, KEY, true, NOW);
    expect(gate.isOwnerRecipeGranted(door('door-1'), KEY)).toBe(false);
  });

  it('FALSE for a contract-free dispatch — inverts isOpGranted deliberately', () => {
    grants.set(OWNER_CONTRACT_ID, KEY, true, NOW);
    expect(gate.isOwnerRecipeGranted(humanHid, KEY)).toBe(false);
    // …while the op axis still admits it, which is the convention being inverted.
    expect(gate.isOpGranted(humanHid, 'core.mail.send')).toBe(true);
  });

  it('FALSE when no grant address resolved — never granted-by-absence', () => {
    grants.set(OWNER_CONTRACT_ID, KEY, true, NOW);
    expect(gate.isOwnerRecipeGranted(ownerChat, undefined)).toBe(false);
  });
});

describe('recipeCoversOp — ACCESS only, and it checks WHOSE coverage', () => {
  const coverage: RecipeCoverage = {
    recipe_id: RECIPE_ID,
    operation_ids: new Set(['core.mail.send', 'recued-core.fleet.quote']),
  };

  it('covers an op in the closure', () => {
    expect(recipeCoversOp(RECIPE_ID, 'core.mail.send', coverage)).toBe(true);
  });

  it('does not cover an op outside it', () => {
    expect(recipeCoversOp(RECIPE_ID, 'core.file.delete', coverage)).toBe(false);
  });

  it('REFUSES a different recipe handed the same coverage — D2’s nested-run bound', () => {
    // Recipe B re-entering handleExecute must not ride A's closure. This check is
    // the only thing standing between "one hop" and "everything A can reach".
    expect(recipeCoversOp('some-other-recipe', 'core.mail.send', coverage)).toBe(false);
  });

  it('is false with no coverage and false with no op id', () => {
    expect(recipeCoversOp(RECIPE_ID, 'core.mail.send', undefined)).toBe(false);
    expect(recipeCoversOp(RECIPE_ID, undefined, coverage)).toBe(false);
  });
});

describe('recipe-grant-identity — ONE place the key is formed', () => {
  const stored = (publisher_id: string) => ({
    getStored: () => ({ publisher_id }) as never,
    get: () => null,
  });

  it('prefers the stored publisher_id', () => {
    expect(resolveRecipePublisher(stored('recued-core'), RECIPE_ID)).toBe('recued-core');
    expect(recipeGrantKeyFor(stored('recued-core'), RECIPE_ID)).toBe(KEY);
  });

  it('falls to metadata.author for a BUNDLED recipe (no stored row)', () => {
    const src = {
      getStored: () => null,
      get: () => ({ recipe_id: RECIPE_ID, metadata: { author: 'recued' } }) as never,
    };
    expect(resolveRecipePublisher(src, RECIPE_ID)).toBe('recued');
  });

  it('returns undefined — never a default publisher — when nothing resolves', () => {
    const src = { getStored: () => null, get: () => null };
    expect(resolveRecipePublisher(src, RECIPE_ID)).toBeUndefined();
    expect(recipeGrantKeyFor(src, RECIPE_ID)).toBeUndefined();
  });

  it('survives a store double with no getStored (dbless harnesses)', () => {
    const src = { get: () => ({ metadata: { author: 'kitchen' } }) as never } as never;
    expect(resolveRecipePublisher(src, RECIPE_ID)).toBe('kitchen');
  });
});
