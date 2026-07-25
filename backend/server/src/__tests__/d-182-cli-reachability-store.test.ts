/** D-182 §7.2 — the `contract.cli_reachability` per-contract reachability store
 *  + the engine reachability resolver.
 *
 *  Proves the no-baseline allowlist in isolation: an absent row is DENIED
 *  (`isAllowed` false — capabilities default OFF, fail-closed), allow/deny
 *  round-trips, the `override` re-allow replaces, the row is keyed per
 *  (principal × ingredient × OPERATION) so one row never widens another, and the
 *  resolver admits ONLY a present `allowed:true` row — a `null` principal (an
 *  execution source with no definite principal) DENIES, and the ingredient key
 *  carries the catalog binding so a different ingredient/op is not authorized
 *  (F5). Each row is an INDEPENDENT grant read directly — never the tightening-only
 *  merge — which is what dissolves the per-contract-LOOSEN problem. cli is
 *  connection-less + pack-only, so this is the (contract × pack-op) grant shape;
 *  risk tier is orthogonal (owner-notification only) and is NOT a key. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import {
  createCliReachabilityResolver,
  createCliReachabilityStore,
  type CliReachabilityStore,
} from '../storage/cli-reachability-store.js';

/** Epoch-ms (the contract store's `datetime` convention). */
const NOW = 1_700_000_000_000;
const OWNER = 'user_self';
const CONTRACT_A = 'contract_a';
const WHISPER = 'recued-core/whisper';
const FFMPEG = 'recued-core/ffmpeg';
// Callable ops — the authorization leaf (the §7.2 grant row's key segment).
const TRANSCRIBE = 'transcribe';
const DETECT_LANGUAGE = 'detect-language';
const CONVERT = 'convert';

let db: Database.Database;
let contractStore: ContractStore;
let reach: CliReachabilityStore;

beforeEach(() => {
  db = new Database(':memory:');
  contractStore = createContractStore(db, { now: () => NOW });
  reach = createCliReachabilityStore(contractStore);
});

afterEach(() => {
  db.close();
});

describe('D-182 §7.2 cli-reachability store — no-baseline allowlist (absent ⇒ denied)', () => {
  it('an absent row is DENIED (the default — capabilities default OFF)', () => {
    expect(reach.isAllowed(OWNER, WHISPER, TRANSCRIBE)).toBe(false);
    expect(reach.get(OWNER, WHISPER, TRANSCRIBE)).toBeNull();
  });

  it('allow round-trips via get; deny → denied again', () => {
    reach.allow(OWNER, WHISPER, TRANSCRIBE, NOW);
    expect(reach.isAllowed(OWNER, WHISPER, TRANSCRIBE)).toBe(true);
    expect(reach.get(OWNER, WHISPER, TRANSCRIBE)).toEqual({
      principal: OWNER,
      ingredient_id: WHISPER,
      operation_id: TRANSCRIBE,
      allowed: true,
      set_at: NOW,
    });
    reach.deny(OWNER, WHISPER, TRANSCRIBE);
    expect(reach.isAllowed(OWNER, WHISPER, TRANSCRIBE)).toBe(false);
    expect(reach.get(OWNER, WHISPER, TRANSCRIBE)).toBeNull();
  });

  it('allow is idempotent (override merge) — a redundant allow does not error or duplicate', () => {
    reach.allow(OWNER, WHISPER, TRANSCRIBE, NOW);
    reach.allow(OWNER, WHISPER, TRANSCRIBE, NOW);
    expect(reach.list()).toHaveLength(1);
    expect(reach.isAllowed(OWNER, WHISPER, TRANSCRIBE)).toBe(true);
  });

  it('keyed per (principal × ingredient × operation) — one row never widens another', () => {
    reach.allow(OWNER, WHISPER, TRANSCRIBE, NOW);
    // a different principal, ingredient, or op is independently OFF.
    expect(reach.isAllowed(CONTRACT_A, WHISPER, TRANSCRIBE)).toBe(false);
    expect(reach.isAllowed(OWNER, FFMPEG, TRANSCRIBE)).toBe(false);
    expect(reach.isAllowed(OWNER, WHISPER, DETECT_LANGUAGE)).toBe(false);
  });

  it('list / listForPrincipal return the allowed rows (the Local-tools surface source)', () => {
    reach.allow(OWNER, WHISPER, TRANSCRIBE, NOW);
    reach.allow(CONTRACT_A, WHISPER, TRANSCRIBE, NOW);
    reach.allow(CONTRACT_A, FFMPEG, CONVERT, NOW);
    expect(reach.list()).toHaveLength(3);
    const forA = reach
      .listForPrincipal(CONTRACT_A)
      .map((r) => r.ingredient_id)
      .sort();
    expect(forA).toEqual([FFMPEG, WHISPER]);
  });

  it('the contract schema gate rejects a malformed value (a row can never be garbage via the store)', () => {
    // `allowed` must be a real boolean — the validated `put` is the first defense.
    expect(() =>
      contractStore.put('cli_reachability', [OWNER, WHISPER, TRANSCRIBE], {
        allowed: 'yes' as unknown as boolean,
      }),
    ).toThrow();
  });
});

describe('D-182 §7.2 cli-reachability resolver — default-denied, principal/ingredient bound', () => {
  it('admits ONLY a present allowed:true row; absent ⇒ deny', () => {
    const resolve = createCliReachabilityResolver(reach);
    expect(resolve(OWNER, WHISPER, TRANSCRIBE)).toBe(false);
    reach.allow(OWNER, WHISPER, TRANSCRIBE, NOW);
    expect(resolve(OWNER, WHISPER, TRANSCRIBE)).toBe(true);
  });

  it('a null principal DENIES (no definite principal ⇒ fail-closed)', () => {
    const resolve = createCliReachabilityResolver(reach);
    reach.allow(OWNER, WHISPER, TRANSCRIBE, NOW);
    // even with a matching row, a null principal can never resolve.
    expect(resolve(null, WHISPER, TRANSCRIBE)).toBe(false);
  });

  it('the ingredient + operation keys bind the grant (F5) — a different ingredient/op is not authorized', () => {
    const resolve = createCliReachabilityResolver(reach);
    reach.allow(OWNER, WHISPER, TRANSCRIBE, NOW);
    expect(resolve(OWNER, WHISPER, TRANSCRIBE)).toBe(true);
    // a different ingredient (a pack reusing the same binary) is NOT authorized.
    expect(resolve(OWNER, FFMPEG, TRANSCRIBE)).toBe(false);
    // a different op of the same ingredient is NOT authorized (cross-op isolation).
    expect(resolve(OWNER, WHISPER, DETECT_LANGUAGE)).toBe(false);
  });
});
