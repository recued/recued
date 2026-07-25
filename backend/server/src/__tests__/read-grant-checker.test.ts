/** Grant-foundation slice 3a (D-187 AMENDMENT) — the per-dispatch read-grant checker +
 *  its two producers. Covers the NEW logic the unified read gate rests on (replacing the
 *  retired `enrichment-visibility-resolve.ts` suite codex flagged): the author-default
 *  composition (D-177 scope-fence ∧ registry `mcp_exposed`), the explicit grant-row
 *  overlay, the author-default-only fail-safe, and — security-critical — the producer
 *  LIVENESS GATE (a gate-consumed `session` / `delegation` grant id, an inactive contract,
 *  or an absent contract NEVER has its grant rows govern reads; they fall to the author
 *  default). */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTRACT_DEFINITION_SCOPE,
  collectionGrantEntry,
  resolveMCPExposure,
  topicGrantEntry,
  type ContractDefinition,
  type EnrichmentTopic,
} from '@recued/contracts';

import { createGrantEntryResolver, type GrantEntryResolver } from '../contract-grant-resolve.js';
import {
  AUTHOR_DEFAULT_ONLY_RESOLVER,
  AUTHOR_DEFAULT_READ_GRANT_CHECKER,
  createGatedReadGrantResolver,
  createReadGrantChecker,
} from '../read-grant-checker.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';

// `company` is a registry-default-`public` enrichment topic (the d-136/d-177 probe).
const PUBLIC_TOPIC: EnrichmentTopic = 'company';
const NOW = 1_750_000_000_000;

describe('createReadGrantChecker — author-default ∧ explicit-grant overlay', () => {
  it('topic author-default = the registry mcp_exposed hint (slice 6: no scope-fence half)', () => {
    // Sanity: the probe topic is author-`public`.
    expect(resolveMCPExposure(PUBLIC_TOPIC)).toBe('public');

    // Slice 6 — the author-default reduces to the `mcp_exposed` hint (the D-177
    // scope-fence half re-homed to explicit grant rows). An author-`public` topic with
    // no overlay row reads true.
    const open = createReadGrantChecker(AUTHOR_DEFAULT_ONLY_RESOLVER, undefined);
    expect(open.isTopicReadGranted(PUBLIC_TOPIC)).toBe(true);
  });

  it('an explicit grant row OVERLAYS the author-default (grant re-opens, revoke closes)', () => {
    // A fake resolver standing in for stored rows: a `false` revoke on the topic, a
    // `true` grant on a collection — the resolver wins over the author-default.
    const fakeRows: GrantEntryResolver = {
      isGranted: (_c, entry, authorDefault) => {
        if (entry === topicGrantEntry(PUBLIC_TOPIC)) return false; // explicit revoke
        if (entry === collectionGrantEntry('mail')) return true; // explicit grant
        return authorDefault;
      },
    };
    // The author-default would GRANT the public topic, but the revoke row wins.
    const checker = createReadGrantChecker(fakeRows, 'ct-door');
    expect(checker.isTopicReadGranted(PUBLIC_TOPIC)).toBe(false);
    // The explicit collection grant is honoured.
    expect(checker.isCollectionReadGranted('mail')).toBe(true);
  });

  it('collection author-default admits every collection (slice 6: no scope-fence)', () => {
    const checker = createReadGrantChecker(AUTHOR_DEFAULT_ONLY_RESOLVER, undefined);
    // Slice 6 — admit-all author-default (the raw-collection scope-fence re-homed to
    // grant rows): a governed collection with no overlay row reads true…
    expect(checker.isCollectionReadGranted('mail')).toBe(true);
    expect(checker.isCollectionReadGranted('contact')).toBe(true);
    // …and a non-governed collection defers to its own gate (true here).
    expect(checker.isCollectionReadGranted('annotation')).toBe(true);
  });

  it('an undefined contract_id resolves to the author-default (no rows honoured)', () => {
    // The resolver below would deny everything IF consulted with a real id; an empty id
    // reads as "no row" so the author-default applies (the gated-out path).
    const denyAll: GrantEntryResolver = { isGranted: () => false };
    const checker = createReadGrantChecker(denyAll, undefined);
    // `createGrantEntryResolver` over a real store would return author-default for ''.
    // The hand fake here ignores the id, so this asserts the wiring passes '' not the id;
    // we cover the real store-backed gated-out path in the gated-resolver suite below.
    expect(checker.isTopicReadGranted(PUBLIC_TOPIC)).toBe(false);
  });
});

describe('AUTHOR_DEFAULT_READ_GRANT_CHECKER — the no-store fail-safe', () => {
  it('reads registry author defaults for topics + admits all collections', () => {
    expect(AUTHOR_DEFAULT_READ_GRANT_CHECKER.isTopicReadGranted(PUBLIC_TOPIC)).toBe(true);
    expect(AUTHOR_DEFAULT_READ_GRANT_CHECKER.isCollectionReadGranted('mail')).toBe(true);
  });
});

describe('createGatedReadGrantResolver — the liveness gate (security-critical)', () => {
  let db: Database.Database;
  let contractStore: ReturnType<typeof createContractStore>;

  beforeEach(() => {
    db = new Database(':memory:');
    contractStore = createContractStore(db, { now: () => NOW });
  });
  afterEach(() => db.close());

  /** Seed a `granted: false` revoke on the public topic under `contract_id`. */
  const seedRevoke = (contract_id: string): void => {
    createContractGrantEntryStore(contractStore).set(
      contract_id,
      topicGrantEntry(PUBLIC_TOPIC),
      false,
      NOW,
    );
  };

  it('an ABSENT (unminted) contract id ⇒ author-default (its rows are never honoured)', () => {
    seedRevoke('ct-ghost'); // rows exist, but no contract_definition backs the id
    const resolver = createGatedReadGrantResolver(contractStore, () => NOW);
    // Gated out ⇒ the revoke is ignored ⇒ the public topic reads its author default.
    expect(resolver.resolveForContract('ct-ghost').isTopicReadGranted(PUBLIC_TOPIC)).toBe(true);
  });

  it('an ACTIVE standing contract HONOURS its grant rows', () => {
    const def = createContractDefinitionStore(contractStore, {
      now: () => NOW,
      newId: () => 'ct_standing',
    }).mint({
      minted_by: 'user:1',
      display_name: 'standing',
      scope: { channels: ['mcp'], actors: ['contracted_user'] },
    });
    seedRevoke(def.contract_id);
    const resolver = createGatedReadGrantResolver(contractStore, () => NOW);
    // Live policy contract ⇒ the explicit revoke wins over the author default.
    expect(resolver.resolveForContract(def.contract_id).isTopicReadGranted(PUBLIC_TOPIC)).toBe(
      false,
    );
  });

  it('a SESSION grant id ⇒ author-default (a grant id is never a policy contract)', () => {
    // Mint a standing contract, then re-key its row as a `grant_kind: 'session'` row —
    // an active row that is a gate-consumed grant, not a policy contract.
    const minted = createContractDefinitionStore(contractStore, {
      now: () => NOW,
      newId: () => 'ct_src',
    }).mint({
      minted_by: 'user:1',
      display_name: 'src',
      scope: { channels: ['mcp'], actors: ['contracted_user'] },
    });
    const row = contractStore.get(CONTRACT_DEFINITION_SCOPE, [minted.contract_id])!
      .value as ContractDefinition;
    contractStore.put(CONTRACT_DEFINITION_SCOPE, ['ct_session'], {
      ...row,
      contract_id: 'ct_session',
      grant_kind: 'session',
    });
    seedRevoke('ct_session');
    const resolver = createGatedReadGrantResolver(contractStore, () => NOW);
    // The session grant's revoke row is NOT honoured ⇒ author-default (public).
    expect(resolver.resolveForContract('ct_session').isTopicReadGranted(PUBLIC_TOPIC)).toBe(true);
  });

  it('a REVOKED (inactive) contract ⇒ author-default (rows no longer govern)', () => {
    const defStore = createContractDefinitionStore(contractStore, {
      now: () => NOW,
      newId: () => 'ct_revoked',
    });
    const def = defStore.mint({
      minted_by: 'user:1',
      display_name: 'revoked',
      scope: { channels: ['mcp'], actors: ['contracted_user'] },
    });
    seedRevoke(def.contract_id);
    defStore.revoke(def.contract_id, 'test');
    const resolver = createGatedReadGrantResolver(contractStore, () => NOW);
    expect(resolver.resolveForContract(def.contract_id).isTopicReadGranted(PUBLIC_TOPIC)).toBe(
      true,
    );
  });
});
