/** D-207 slice 1b — the PUBLIC contract floor.
 *
 *  The revoke that doesn't revoke: before this, `resolveGrantGoverningContractId`
 *  returned `undefined` for `(reception, anonymous)`, and `isOpGranted` reads
 *  `undefined` as "contract-free → no grant gate" → returns TRUE, skipping the ACCESS
 *  gate entirely. An owner who DELETED a paired recipe's door contract while leaving the
 *  pair enabled would therefore not TIGHTEN the door — they would BLOW IT OPEN.
 *
 *  These pin the floor: an anonymous public dispatch can never resolve to "no contract",
 *  and the floor grants nothing. */

import { describe, expect, it } from 'vitest';

import { OWNER_CONTRACT_ID, PUBLIC_CONTRACT_ID } from '@recued/contracts';
import type { ContractDefinition, ExecutionSource } from '@recued/contracts';

import { resolveGrantGoverningContractId } from '../grant-governing-contract.js';
import { usesExplicitOnlyGrantDefaults } from '../op-admission-gate.js';
import type { ContractDefinitionStore } from '../storage/contract-definition-store.js';

const NOW = () => 1_000;

const storeOf = (defs: Record<string, ContractDefinition>): ContractDefinitionStore =>
  ({ get: (id: string) => defs[id] }) as unknown as ContractDefinitionStore;

const ANON = (contract_id?: string): ExecutionSource => ({
  channel: 'reception',
  actor: 'anonymous',
  reception_id: 'ep_1',
  ...(contract_id === undefined ? {} : { contract_id }),
});

const liveReceptionDoor = (id: string): ContractDefinition => ({
  contract_id: id,
  grant_kind: 'standing',
  door_types: ['reception'],
  scope: { operation_ids: ['core.mail.send'] },
  status: 'active',
} as unknown as ContractDefinition);

describe('D-207 slice 1b — an anonymous public dispatch is NEVER contract-free', () => {
  // ⚠ NON-VACUITY GUARD. These assertions are `toBe(PUBLIC_CONTRACT_ID)`, and the
  // resolver's pre-fix answer was `undefined`. So if PUBLIC_CONTRACT_ID were ever
  // `undefined` — a missing barrel export, a stale `dist/` — every test below would
  // pass VACUOUSLY (`expect(undefined).toBe(undefined)`) while asserting nothing. That
  // is exactly what happened on the first run of this file. Pin the symbol first.
  it('GUARD — PUBLIC_CONTRACT_ID is a real, non-empty, distinct sentinel', () => {
    expect(typeof PUBLIC_CONTRACT_ID).toBe('string');
    expect(PUBLIC_CONTRACT_ID.length).toBeGreaterThan(0);
    expect(PUBLIC_CONTRACT_ID).not.toBe(OWNER_CONTRACT_ID);
  });

  it('with NO contract_id it resolves to the PUBLIC floor, not undefined', () => {
    // Pre-fix this returned `undefined` → isOpGranted returns true → ACCESS gate SKIPPED.
    expect(resolveGrantGoverningContractId(ANON(), storeOf({}), NOW)).toBe(PUBLIC_CONTRACT_ID);
  });

  it('a DELETED door contract falls to the PUBLIC floor — deleting never opens the door', () => {
    // The store has no def for 'door_x' (deleted). The dead-def path must NOT fall
    // through to contract-free for a visitor.
    expect(resolveGrantGoverningContractId(ANON('door_x'), storeOf({}), NOW))
      .toBe(PUBLIC_CONTRACT_ID);
  });

  it('a LIVE door contract governs normally', () => {
    const s = storeOf({ door_x: liveReceptionDoor('door_x') });
    expect(resolveGrantGoverningContractId(ANON('door_x'), s, NOW)).toBe('door_x');
  });

  it('the owner is untouched — a contract-free owner-AI source still resolves the owner', () => {
    const owner: ExecutionSource = {
      channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'u',
    };
    expect(resolveGrantGoverningContractId(owner, storeOf({}), NOW)).toBe(OWNER_CONTRACT_ID);
  });

  it('the system channels stay contract-free — the floor is anonymous-only', () => {
    const sched: ExecutionSource = { channel: 'schedule', actor: 'system' } as ExecutionSource;
    expect(resolveGrantGoverningContractId(sched, storeOf({}), NOW)).toBeUndefined();
  });
});

describe('D-207 slice 1b — deny-by-default is NOT an empty scope', () => {
  it('the PUBLIC floor is explicit-only, so it grants nothing', () => {
    // If the floor tried to say "grants nothing" with an empty scope, `opAuthorDefault`
    // would read that as a WILDCARD door and return TRUE — failing OPEN.
    expect(usesExplicitOnlyGrantDefaults(PUBLIC_CONTRACT_ID, storeOf({}))).toBe(true);
  });

  it('a reception door with an EMPTY op closure is explicit-only, NOT a wildcard', () => {
    // A pure-transform recipe (validate-and-render, no ops) derives an EMPTY closure.
    // Without this, that empty scope would read as "any op" — the worst possible reading
    // of "this recipe needs no operations".
    const pureTransform = {
      contract_id: 'door_pure', grant_kind: 'standing', door_types: ['reception'],
      scope: { operation_ids: [] }, status: 'active',
    } as unknown as ContractDefinition;
    expect(usesExplicitOnlyGrantDefaults('door_pure', storeOf({ door_pure: pureTransform })))
      .toBe(true);
  });

  it('the owner is still permissive — the floor never tightens the owner', () => {
    expect(usesExplicitOnlyGrantDefaults(OWNER_CONTRACT_ID, storeOf({}))).toBe(false);
  });
});
