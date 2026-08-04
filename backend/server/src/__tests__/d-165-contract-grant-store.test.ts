/** D-165 P3.grant migration (Slice 1) — the `contract.grant`-backed user-grant store.
 *
 *  Proves the storage semantics in isolation (no rpc / profile wiring yet): grant /
 *  list / revoke / idempotency / ascending order, key-dimension isolation (by
 *  ingredient_id + connection_name, with a prefix-bleed guard), connection-delete
 *  cleanup that spares pack-owned grants, the exact `__user__`-keyed row shape, and
 *  the defensive `allowed === true` list filter. These are the semantics the retired
 *  `connection_operation_grant` store provided, now centralized on `contract.grant`.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { D165_CONTRACT_SCHEMA } from '@recued/contracts';

import {
  createContractStore,
  type ContractStore,
} from '../storage/contract-store.js';
import {
  createContractGrantStore,
  USER_GRANT_PACK_ID,
  wireConnectionGrantCleanup,
  type ContractGrantStore,
  type GrantPolicy,
} from '../storage/contract-grant-store.js';
import { createConnectionStore } from '../storage/connection-store.js';

const NOW = 1_700_000_000_000;
const HS = 'hubspot-catalog';
const SF = 'salesforce-catalog';

let db: Database.Database;
let contractStore: ContractStore;
let grants: ContractGrantStore;
let clock = NOW;

beforeEach(() => {
  clock = NOW;
  db = new Database(':memory:');
  contractStore = createContractStore(db, { now: () => clock });
  grants = createContractGrantStore(contractStore);
});

afterEach(() => {
  db.close();
});

describe('contract-grant-store — grant / list / revoke', () => {
  it('grants a group, then lists it', () => {
    grants.grantUserGroup(HS, 'my-hs', 'deals-write');
    expect(grants.listUserGroups(HS, 'my-hs')).toEqual(['deals-write']);
  });

  it('is idempotent — a repeat grant does not duplicate the group', () => {
    grants.grantUserGroup(HS, 'my-hs', 'deals-write');
    grants.grantUserGroup(HS, 'my-hs', 'deals-write');
    expect(grants.listUserGroups(HS, 'my-hs')).toEqual(['deals-write']);
  });

  it('returns granted groups in ascending order', () => {
    // grant out of order — list must come back sorted ascending (BINARY-equivalent).
    grants.grantUserGroup(HS, 'my-hs', 'deals-write');
    grants.grantUserGroup(HS, 'my-hs', 'contacts-write');
    grants.grantUserGroup(HS, 'my-hs', 'admin-ops');
    expect(grants.listUserGroups(HS, 'my-hs')).toEqual([
      'admin-ops',
      'contacts-write',
      'deals-write',
    ]);
  });

  it('revokes a single group, leaving the rest', () => {
    grants.grantUserGroup(HS, 'my-hs', 'deals-write');
    grants.grantUserGroup(HS, 'my-hs', 'contacts-write');
    grants.revokeUserGroup(HS, 'my-hs', 'deals-write');
    expect(grants.listUserGroups(HS, 'my-hs')).toEqual(['contacts-write']);
  });

  it('revoking an absent group is a no-op', () => {
    grants.grantUserGroup(HS, 'my-hs', 'deals-write');
    expect(() => grants.revokeUserGroup(HS, 'my-hs', 'never-granted')).not.toThrow();
    expect(grants.listUserGroups(HS, 'my-hs')).toEqual(['deals-write']);
  });

  it('lists nothing for a connection with no grants', () => {
    expect(grants.listUserGroups(HS, 'fresh-conn')).toEqual([]);
  });
});

describe('contract-grant-store — connection lifecycle cleanup', () => {
  const connection = (kind: 'api' | 'mcp', name: string) => ({
    kind,
    name,
    ...(kind === 'mcp' ? { subtype: 'sse' } : {}),
    display_name: `${kind} ${name}`,
    config_json: '{}',
    auth_ciphertext: 'CIPHER',
    enrolled_at: NOW,
    updated_at: NOW,
  } as const);

  it('drops both grant owners when the final MCP connection row is deleted', () => {
    const connections = createConnectionStore(db);
    wireConnectionGrantCleanup(connections, grants);
    grants.grantUserGroup(HS, 'peer', 'read');
    grants.grantPackGroup('peer-pack', HS, 'peer', 'write');
    connections.upsert(connection('mcp', 'peer'));

    connections.delete('mcp', 'peer');

    expect(grants.listUserGroups(HS, 'peer')).toEqual([]);
    expect(grants.listPackOwnedGroups(HS, 'peer')).toEqual([]);
  });

  it('preserves name-keyed grants until the last same-name connection kind is gone', () => {
    const connections = createConnectionStore(db);
    wireConnectionGrantCleanup(connections, grants);
    grants.grantUserGroup(HS, 'shared', 'read');
    grants.grantPackGroup('shared-pack', HS, 'shared', 'write');
    connections.upsert(connection('api', 'shared'));
    connections.upsert(connection('mcp', 'shared'));

    connections.delete('mcp', 'shared');
    expect(grants.listUserGroups(HS, 'shared')).toEqual(['read']);
    expect(grants.listPackOwnedGroups(HS, 'shared')).toEqual(['write']);

    connections.delete('api', 'shared');
    expect(grants.listUserGroups(HS, 'shared')).toEqual([]);
    expect(grants.listPackOwnedGroups(HS, 'shared')).toEqual([]);
  });
});

describe('contract-grant-store — upsert semantics', () => {
  it('re-granting upserts the row (advances written_at, not a no-op short-circuit)', () => {
    grants.grantUserGroup(HS, 'my-hs', 'deals-write');
    const first = contractStore.get('grant', [
      USER_GRANT_PACK_ID,
      HS,
      'my-hs',
      'deals-write',
    ]);
    clock = NOW + 5_000;
    grants.grantUserGroup(HS, 'my-hs', 'deals-write');
    const second = contractStore.get('grant', [
      USER_GRANT_PACK_ID,
      HS,
      'my-hs',
      'deals-write',
    ]);
    expect(first?.written_at).toBe(NOW);
    expect(second?.written_at).toBe(NOW + 5_000);
    // Still exactly one granted group — the upsert overwrote, it did not append.
    expect(grants.listUserGroups(HS, 'my-hs')).toEqual(['deals-write']);
  });

  it('grantUserGroup over an existing allowed:false row flips it to granted', () => {
    contractStore.put(
      'grant',
      [USER_GRANT_PACK_ID, HS, 'my-hs', 'deals-write'],
      { allowed: false } satisfies GrantPolicy,
    );
    expect(grants.listUserGroups(HS, 'my-hs')).toEqual([]);
    grants.grantUserGroup(HS, 'my-hs', 'deals-write');
    expect(grants.listUserGroups(HS, 'my-hs')).toEqual(['deals-write']);
    expect(
      contractStore.get('grant', [USER_GRANT_PACK_ID, HS, 'my-hs', 'deals-write'])?.value,
    ).toEqual({ allowed: true });
  });
});

describe('contract-grant-store — key-dimension isolation', () => {
  it('isolates grants by ingredient_id (catalog slug)', () => {
    // Same connection name under two different vendor catalogs — each list returns
    // only its own slug's grants (the ingredient_id segment separates them).
    grants.grantUserGroup(HS, 'shared-name', 'deals-write');
    grants.grantUserGroup(SF, 'shared-name', 'opportunities-write');
    expect(grants.listUserGroups(HS, 'shared-name')).toEqual(['deals-write']);
    expect(grants.listUserGroups(SF, 'shared-name')).toEqual(['opportunities-write']);
  });

  it('isolates grants by connection_name', () => {
    grants.grantUserGroup(HS, 'conn-a', 'deals-write');
    grants.grantUserGroup(HS, 'conn-b', 'contacts-write');
    expect(grants.listUserGroups(HS, 'conn-a')).toEqual(['deals-write']);
    expect(grants.listUserGroups(HS, 'conn-b')).toEqual(['contacts-write']);
  });

  it('does not bleed across a connection_name prefix boundary', () => {
    // `deal` must not match `dealflow` — the seg_key codec anchors prefix scans on
    // the `.` segment boundary.
    grants.grantUserGroup(HS, 'deal', 'deals-write');
    grants.grantUserGroup(HS, 'dealflow', 'contacts-write');
    expect(grants.listUserGroups(HS, 'deal')).toEqual(['deals-write']);
    expect(grants.listUserGroups(HS, 'dealflow')).toEqual(['contacts-write']);
  });
});

describe('contract-grant-store — connection-delete cleanup', () => {
  it('drops every user grant for the named connection, sparing others', () => {
    grants.grantUserGroup(HS, 'conn-a', 'deals-write');
    grants.grantUserGroup(HS, 'conn-a', 'contacts-write');
    grants.grantUserGroup(HS, 'conn-b', 'deals-write');

    grants.deleteAllUserGroupsForConnection('conn-a');

    expect(grants.listUserGroups(HS, 'conn-a')).toEqual([]);
    expect(grants.listUserGroups(HS, 'conn-b')).toEqual(['deals-write']);
  });

  it('does not bleed cleanup across a connection_name prefix boundary', () => {
    grants.grantUserGroup(HS, 'deal', 'deals-write');
    grants.grantUserGroup(HS, 'dealflow', 'contacts-write');

    grants.deleteAllUserGroupsForConnection('deal');

    expect(grants.listUserGroups(HS, 'deal')).toEqual([]);
    expect(grants.listUserGroups(HS, 'dealflow')).toEqual(['contacts-write']);
  });

  it('leaves pack-owned grants for the same connection intact (P3 forward-compat)', () => {
    // A pack-owned grant carries a REAL installed_pack_id, not the __user__ sentinel.
    // Connection-delete cleanup is the user-grant half only — pack grants belong to
    // the P3 install planner's uninstall path.
    grants.grantUserGroup(HS, 'conn-a', 'deals-write');
    contractStore.put(
      'grant',
      ['sales-pack', HS, 'conn-a', 'contacts-write'],
      { allowed: true } satisfies GrantPolicy,
    );

    grants.deleteAllUserGroupsForConnection('conn-a');

    expect(grants.listUserGroups(HS, 'conn-a')).toEqual([]);
    // The pack-owned row survives.
    expect(
      contractStore.get('grant', ['sales-pack', HS, 'conn-a', 'contacts-write']),
    ).not.toBeNull();
  });

  it('clears a connection across catalog slugs (filters by name, not slug)', () => {
    // A connection has one vendor in practice, but the cleanup hook carries only
    // the name (no slug), so it scans the __user__ rows and filters by the
    // connection_name segment — grants under any ingredient_id for that name go.
    grants.grantUserGroup(HS, 'multi', 'deals-write');
    grants.grantUserGroup(SF, 'multi', 'opportunities-write');
    grants.grantUserGroup(HS, 'other', 'contacts-write');

    grants.deleteAllUserGroupsForConnection('multi');

    expect(grants.listUserGroups(HS, 'multi')).toEqual([]);
    expect(grants.listUserGroups(SF, 'multi')).toEqual([]);
    expect(grants.listUserGroups(HS, 'other')).toEqual(['contacts-write']);
  });

  it('is a no-op on an empty grant store', () => {
    expect(() => grants.deleteAllUserGroupsForConnection('nope')).not.toThrow();
    expect(contractStore.scan('grant')).toEqual([]);
  });
});

describe('contract-grant-store — pack-owned connection-delete cleanup (D-194 S-2)', () => {
  it('drops every pack-owned grant for the named connection across packs + ingredients, sparing others', () => {
    grants.grantPackGroup('sales-pack', HS, 'conn-a', 'deals-write');
    grants.grantPackGroup('ops-pack', HS, 'conn-a', 'contacts-write'); // a second pack, same connection
    grants.grantPackGroup('sales-pack', SF, 'conn-a', 'opportunities-write'); // a second ingredient, same connection
    grants.grantPackGroup('sales-pack', HS, 'conn-b', 'deals-write'); // an untouched connection

    grants.deleteAllPackGroupsForConnection('conn-a');

    expect(grants.listPackOwnedGroups(HS, 'conn-a')).toEqual([]);
    expect(grants.listPackOwnedGroups(SF, 'conn-a')).toEqual([]);
    expect(grants.listPackOwnedGroups(HS, 'conn-b')).toEqual(['deals-write']);
  });

  it('spares __user__ grants for the same connection (the user-half method drops those)', () => {
    grants.grantPackGroup('sales-pack', HS, 'conn-a', 'deals-write');
    grants.grantUserGroup(HS, 'conn-a', 'admin-ops');

    grants.deleteAllPackGroupsForConnection('conn-a');

    expect(grants.listPackOwnedGroups(HS, 'conn-a')).toEqual([]);
    // The __user__ row is untouched — deleteAllUserGroupsForConnection owns that half;
    // the two are disjoint, so the delete hook can call both idempotently.
    expect(grants.listUserGroups(HS, 'conn-a')).toEqual(['admin-ops']);
  });

  it('does not bleed cleanup across a connection_name prefix boundary', () => {
    grants.grantPackGroup('sales-pack', HS, 'deal', 'deals-write');
    grants.grantPackGroup('sales-pack', HS, 'dealflow', 'contacts-write');

    grants.deleteAllPackGroupsForConnection('deal');

    expect(grants.listPackOwnedGroups(HS, 'deal')).toEqual([]);
    expect(grants.listPackOwnedGroups(HS, 'dealflow')).toEqual(['contacts-write']);
  });

  it('is a no-op on an empty grant store', () => {
    expect(() => grants.deleteAllPackGroupsForConnection('nope')).not.toThrow();
    expect(contractStore.scan('grant')).toEqual([]);
  });

  it('together with the user-half method, drops BOTH grant halves for the connection (the delete-hook contract)', () => {
    // compose-app-context wires BOTH deleteAllUserGroupsForConnection AND
    // deleteAllPackGroupsForConnection on an api-connection delete; simulate that
    // pair so a same-name re-enroll starts from deny-until-granted.
    grants.grantPackGroup('sales-pack', HS, 'conn-a', 'deals-write');
    grants.grantUserGroup(HS, 'conn-a', 'admin-ops');
    grants.grantPackGroup('sales-pack', HS, 'conn-b', 'deals-write'); // an unrelated connection

    grants.deleteAllUserGroupsForConnection('conn-a');
    grants.deleteAllPackGroupsForConnection('conn-a');

    // conn-a now holds no grant of either kind — re-consent required on re-enroll.
    expect(grants.listPackOwnedGroups(HS, 'conn-a')).toEqual([]);
    expect(grants.listUserGroups(HS, 'conn-a')).toEqual([]);
    // an unrelated connection keeps its grant.
    expect(grants.listPackOwnedGroups(HS, 'conn-b')).toEqual(['deals-write']);
  });
});

describe('contract-grant-store — contract.grant row shape', () => {
  it('writes the grant under the __user__ sentinel with the exact 4-tuple key', () => {
    grants.grantUserGroup(HS, 'my-hs', 'deals-write');
    const row = contractStore.get('grant', [
      USER_GRANT_PACK_ID,
      HS,
      'my-hs',
      'deals-write',
    ]);
    expect(row).not.toBeNull();
    expect(row?.segments).toEqual([USER_GRANT_PACK_ID, HS, 'my-hs', 'deals-write']);
    expect(row?.value).toEqual({ allowed: true });
  });

  it('does not list a pack-owned grant under the user view', () => {
    // A row with the same (ingredient_id, connection_name, group) but a pack owner
    // must not surface in the user-grant list (scoped to __user__).
    contractStore.put(
      'grant',
      ['sales-pack', HS, 'my-hs', 'deals-write'],
      { allowed: true } satisfies GrantPolicy,
    );
    expect(grants.listUserGroups(HS, 'my-hs')).toEqual([]);
  });

  it('revokeUserGroup spares a pack-owned grant at the same 4-tuple-minus-owner', () => {
    // Revoke deletes only the __user__ row; a pack grant for the same
    // (ingredient, connection, group) under a real installed_pack_id survives.
    grants.grantUserGroup(HS, 'my-hs', 'deals-write');
    contractStore.put(
      'grant',
      ['sales-pack', HS, 'my-hs', 'deals-write'],
      { allowed: true } satisfies GrantPolicy,
    );
    grants.revokeUserGroup(HS, 'my-hs', 'deals-write');
    expect(grants.listUserGroups(HS, 'my-hs')).toEqual([]);
    expect(
      contractStore.get('grant', ['sales-pack', HS, 'my-hs', 'deals-write']),
    ).not.toBeNull();
  });

  it('skips a user row whose policy is not allowed (defensive filter)', () => {
    // listUserGroups filters on allowed === true; a user row written allowed:false
    // (a future denial) is excluded from the granted set.
    contractStore.put(
      'grant',
      [USER_GRANT_PACK_ID, HS, 'my-hs', 'denied-group'],
      { allowed: false } satisfies GrantPolicy,
    );
    grants.grantUserGroup(HS, 'my-hs', 'deals-write');
    expect(grants.listUserGroups(HS, 'my-hs')).toEqual(['deals-write']);
  });
});

describe('contract-grant-store — segment escaping (seg_key codec)', () => {
  // The contract store escapes `.`→`%2E` and `%`→`%25` per segment; a grant's 4th
  // segment can legitimately carry dots (an operation_id is `<ingredient>.<op>`),
  // so the wrapper must round-trip dotted/percent group + connection names exactly
  // and keep prefix scans on the segment boundary.
  it('round-trips group ids containing dots and percent signs', () => {
    grants.grantUserGroup(HS, 'my-hs', 'deals.write%v2');
    grants.grantUserGroup(HS, 'my-hs', 'deals.write');
    expect(grants.listUserGroups(HS, 'my-hs')).toEqual([
      'deals.write',
      'deals.write%v2',
    ]);
    // The dotted group is ONE segment, not split into 'deals' + 'write'.
    expect(
      contractStore.get('grant', [USER_GRANT_PACK_ID, HS, 'my-hs', 'deals.write']),
    ).not.toBeNull();
  });

  it('revokeUserGroup deletes only the exact dotted group, sparing a sibling', () => {
    grants.grantUserGroup(HS, 'my-hs', 'deals.write');
    grants.grantUserGroup(HS, 'my-hs', 'deals.write.admin');
    grants.revokeUserGroup(HS, 'my-hs', 'deals.write');
    expect(grants.listUserGroups(HS, 'my-hs')).toEqual(['deals.write.admin']);
  });

  it('lists + cleans a connection name with a dot without bleeding to a sibling', () => {
    grants.grantUserGroup(HS, 'team.crm', 'deals-write');
    grants.grantUserGroup(HS, 'team.crm.staging', 'contacts-write');

    // The prefix scan stays on the segment boundary — `team.crm` does not match
    // `team.crm.staging`.
    expect(grants.listUserGroups(HS, 'team.crm')).toEqual(['deals-write']);

    grants.deleteAllUserGroupsForConnection('team.crm');
    expect(grants.listUserGroups(HS, 'team.crm')).toEqual([]);
    expect(grants.listUserGroups(HS, 'team.crm.staging')).toEqual(['contacts-write']);
  });
});

describe('contract-grant-store — schema authoring contract', () => {
  it('declares the user as a legitimate writer of the grant scope', () => {
    // The migration writes user-manual grants under __user__; the grant scope must
    // declare `user` authorship (not install_planner-only) so a future writeable_by
    // enforcement admits the user-grant path rather than rejecting it. Ratchet
    // against accidental reversion to `install_planner`.
    expect(D165_CONTRACT_SCHEMA.composite_keys.grant.writeable_by).toBe(
      'install_planner+user',
    );
  });
});

describe('contract-grant-store — pack-owned half (D-165 P3 install planner)', () => {
  it('grantPackGroup writes a row keyed on the REAL installed_pack_id', () => {
    grants.grantPackGroup('sales-pack', HS, 'my-hs', 'deals-write');
    const row = contractStore.get('grant', ['sales-pack', HS, 'my-hs', 'deals-write']);
    expect(row?.segments).toEqual(['sales-pack', HS, 'my-hs', 'deals-write']);
    expect(row?.value).toEqual({ allowed: true });
    // It is NOT a user grant — the user view stays empty.
    expect(grants.listUserGroups(HS, 'my-hs')).toEqual([]);
  });

  it('grantPackGroup is idempotent', () => {
    grants.grantPackGroup('sales-pack', HS, 'my-hs', 'deals-write');
    grants.grantPackGroup('sales-pack', HS, 'my-hs', 'deals-write');
    expect(grants.listPackOwnedGroups(HS, 'my-hs')).toEqual(['deals-write']);
  });

  it('listPackOwnedGroups lists across packs, ascending + deduped, EXCLUDING __user__', () => {
    grants.grantPackGroup('sales-pack', HS, 'my-hs', 'deals-write');
    grants.grantPackGroup('ops-pack', HS, 'my-hs', 'contacts-write');
    // a __user__ grant on the same (ingredient, connection) must NOT appear here
    // (the seed unions it separately via listUserGroups).
    grants.grantUserGroup(HS, 'my-hs', 'admin-ops');
    expect(grants.listPackOwnedGroups(HS, 'my-hs')).toEqual(['contacts-write', 'deals-write']);
  });

  it('listPackOwnedGroups dedupes a group two packs both grant', () => {
    grants.grantPackGroup('sales-pack', HS, 'my-hs', 'deals-write');
    grants.grantPackGroup('ops-pack', HS, 'my-hs', 'deals-write');
    expect(grants.listPackOwnedGroups(HS, 'my-hs')).toEqual(['deals-write']);
  });

  it('listPackOwnedGroups isolates by ingredient_id + connection_name', () => {
    grants.grantPackGroup('sales-pack', HS, 'conn-a', 'deals-write');
    grants.grantPackGroup('sales-pack', SF, 'conn-a', 'opportunities-write');
    grants.grantPackGroup('sales-pack', HS, 'conn-b', 'contacts-write');
    expect(grants.listPackOwnedGroups(HS, 'conn-a')).toEqual(['deals-write']);
    expect(grants.listPackOwnedGroups(SF, 'conn-a')).toEqual(['opportunities-write']);
    expect(grants.listPackOwnedGroups(HS, 'conn-b')).toEqual(['contacts-write']);
  });

  it('listPackOwnedGroups skips an allowed:false pack row (defensive filter)', () => {
    contractStore.put(
      'grant',
      ['sales-pack', HS, 'my-hs', 'denied'],
      { allowed: false } satisfies GrantPolicy,
    );
    grants.grantPackGroup('sales-pack', HS, 'my-hs', 'deals-write');
    expect(grants.listPackOwnedGroups(HS, 'my-hs')).toEqual(['deals-write']);
  });

  it('listPackOwnedGroups does not bleed across a connection_name prefix boundary', () => {
    grants.grantPackGroup('sales-pack', HS, 'deal', 'deals-write');
    grants.grantPackGroup('sales-pack', HS, 'dealflow', 'contacts-write');
    expect(grants.listPackOwnedGroups(HS, 'deal')).toEqual(['deals-write']);
    expect(grants.listPackOwnedGroups(HS, 'dealflow')).toEqual(['contacts-write']);
  });

  it('removePackGroups drops exactly ONE pack’s rows — per-pack isolation', () => {
    grants.grantPackGroup('sales-pack', HS, 'my-hs', 'deals-write');
    grants.grantPackGroup('ops-pack', HS, 'my-hs', 'contacts-write');
    grants.grantUserGroup(HS, 'my-hs', 'admin-ops'); // __user__ must survive

    grants.removePackGroups('sales-pack');

    // ops-pack's grant survives; uninstall of sales-pack revoked only its own.
    expect(grants.listPackOwnedGroups(HS, 'my-hs')).toEqual(['contacts-write']);
    expect(grants.listUserGroups(HS, 'my-hs')).toEqual(['admin-ops']);
    expect(contractStore.get('grant', ['sales-pack', HS, 'my-hs', 'deals-write'])).toBeNull();
  });

  it('removePackGroups drops a pack’s grants across ingredients + connections', () => {
    grants.grantPackGroup('sales-pack', HS, 'conn-a', 'deals-write');
    grants.grantPackGroup('sales-pack', SF, 'conn-b', 'opportunities-write');
    grants.removePackGroups('sales-pack');
    expect(contractStore.scan('grant', ['sales-pack'])).toEqual([]);
  });

  it('removePackGroups does not bleed across an installed_pack_id prefix boundary', () => {
    grants.grantPackGroup('sales', HS, 'my-hs', 'deals-write');
    grants.grantPackGroup('sales-extended', HS, 'my-hs', 'contacts-write');
    grants.removePackGroups('sales');
    expect(grants.listPackOwnedGroups(HS, 'my-hs')).toEqual(['contacts-write']);
  });

  it('grantPackGroup / removePackGroups refuse the reserved __user__ sentinel', () => {
    expect(() => grants.grantPackGroup(USER_GRANT_PACK_ID, HS, 'my-hs', 'g')).toThrow(
      /__user__/,
    );
    expect(() => grants.removePackGroups(USER_GRANT_PACK_ID)).toThrow(/__user__/);
  });

  it('the two halves are disjoint by owner + complementary (the effective-view union)', () => {
    // The effective grant view per (ingredient, connection) is
    // listUserGroups ∪ listPackOwnedGroups — the seed unions them. Prove each half
    // returns only its own owner's groups.
    grants.grantUserGroup(HS, 'my-hs', 'user-group');
    grants.grantPackGroup('sales-pack', HS, 'my-hs', 'pack-group');
    expect(grants.listUserGroups(HS, 'my-hs')).toEqual(['user-group']);
    expect(grants.listPackOwnedGroups(HS, 'my-hs')).toEqual(['pack-group']);
  });
});

describe('contract-grant-store — §1.6 grant-only-degradation reads', () => {
  it('listPackOwnedGroups(…, excludePackId) drops exactly ONE pack from the view', () => {
    grants.grantPackGroup('sales-pack', HS, 'my-hs', 'deals-write');
    grants.grantPackGroup('ops-pack', HS, 'my-hs', 'contacts-write');
    expect(grants.listPackOwnedGroups(HS, 'my-hs', 'sales-pack')).toEqual(['contacts-write']);
    // The unexcluded view is unchanged (the param is read-only simulation).
    expect(grants.listPackOwnedGroups(HS, 'my-hs')).toEqual(['contacts-write', 'deals-write']);
  });

  it('excludePackId keeps a group ANOTHER pack also grants (the shared-group survival case)', () => {
    // The §1.6 simulation's core question: does the group survive the uninstall?
    // Two packs granting the same group → excluding one leaves it granted.
    grants.grantPackGroup('sales-pack', HS, 'my-hs', 'deals-write');
    grants.grantPackGroup('ops-pack', HS, 'my-hs', 'deals-write');
    expect(grants.listPackOwnedGroups(HS, 'my-hs', 'sales-pack')).toEqual(['deals-write']);
  });

  it('an excludePackId matching nothing returns the full pack-owned view', () => {
    grants.grantPackGroup('sales-pack', HS, 'my-hs', 'deals-write');
    expect(grants.listPackOwnedGroups(HS, 'my-hs', 'no-such-pack')).toEqual(['deals-write']);
  });

  it('listPackGrantTargets returns the distinct (ingredient, connection) pairs, sorted', () => {
    grants.grantPackGroup('sales-pack', SF, 'conn-b', 'opportunities-write');
    grants.grantPackGroup('sales-pack', HS, 'conn-a', 'deals-write');
    // a second group on the SAME pair must not duplicate the pair
    grants.grantPackGroup('sales-pack', HS, 'conn-a', 'contacts-write');
    expect(grants.listPackGrantTargets('sales-pack')).toEqual([
      { ingredient_id: HS, connection_name: 'conn-a' },
      { ingredient_id: SF, connection_name: 'conn-b' },
    ]);
  });

  it("listPackGrantTargets scopes to ONE pack — other packs' and __user__ rows excluded", () => {
    grants.grantPackGroup('sales-pack', HS, 'conn-a', 'deals-write');
    grants.grantPackGroup('ops-pack', HS, 'conn-b', 'contacts-write');
    grants.grantUserGroup(HS, 'conn-c', 'admin-ops');
    expect(grants.listPackGrantTargets('sales-pack')).toEqual([
      { ingredient_id: HS, connection_name: 'conn-a' },
    ]);
    expect(grants.listPackGrantTargets('no-such-pack')).toEqual([]);
  });

  it('listPackGrantTargets does not bleed across an installed_pack_id prefix boundary', () => {
    grants.grantPackGroup('sales', HS, 'conn-a', 'deals-write');
    grants.grantPackGroup('sales-extended', HS, 'conn-b', 'contacts-write');
    expect(grants.listPackGrantTargets('sales')).toEqual([
      { ingredient_id: HS, connection_name: 'conn-a' },
    ]);
  });

  it('listPackGrantTargets mirrors removePackGroups: an allowed:false row still names its pair', () => {
    // The targets are what removal will TOUCH (and what the uninstall reconcile
    // must re-derive) — value-independent, unlike the allowed:true group reads.
    contractStore.put(
      'grant',
      ['sales-pack', HS, 'my-hs', 'denied'],
      { allowed: false } satisfies GrantPolicy,
    );
    expect(grants.listPackGrantTargets('sales-pack')).toEqual([
      { ingredient_id: HS, connection_name: 'my-hs' },
    ]);
  });
});

describe('contract-grant-store — listPacksForConnection (D-194 #6)', () => {
  it('returns the distinct pack slugs granted on the connection, sorted', () => {
    grants.grantPackGroup('sales-pack', HS, 'onedrive-work', 'deals-write');
    grants.grantPackGroup('ops-pack', HS, 'onedrive-work', 'contacts-write');
    expect(grants.listPacksForConnection('onedrive-work')).toEqual(['ops-pack', 'sales-pack']);
  });

  it('dedupes a pack that grants across ingredients / groups on the same connection', () => {
    grants.grantPackGroup('sales-pack', HS, 'onedrive-work', 'deals-write');
    grants.grantPackGroup('sales-pack', SF, 'onedrive-work', 'opportunities-write');
    grants.grantPackGroup('sales-pack', HS, 'onedrive-work', 'contacts-write');
    expect(grants.listPacksForConnection('onedrive-work')).toEqual(['sales-pack']);
  });

  it('discriminates two connections of one vendor (the S-1 fix)', () => {
    // The whole point: pack A on onedrive_work, pack B on onedrive_personal —
    // each connection lists only its own packs, not every onedrive pack.
    grants.grantPackGroup('pack-a', HS, 'onedrive-work', 'deals-write');
    grants.grantPackGroup('pack-b', HS, 'onedrive-personal', 'deals-write');
    expect(grants.listPacksForConnection('onedrive-work')).toEqual(['pack-a']);
    expect(grants.listPacksForConnection('onedrive-personal')).toEqual(['pack-b']);
  });

  it('excludes __user__ grants (they carry no pack attribution)', () => {
    grants.grantPackGroup('sales-pack', HS, 'onedrive-work', 'deals-write');
    grants.grantUserGroup(HS, 'onedrive-work', 'admin-ops');
    expect(grants.listPacksForConnection('onedrive-work')).toEqual(['sales-pack']);
  });

  it('does not bleed across a connection_name prefix boundary', () => {
    grants.grantPackGroup('pack-a', HS, 'deal', 'deals-write');
    grants.grantPackGroup('pack-b', HS, 'dealflow', 'contacts-write');
    expect(grants.listPacksForConnection('deal')).toEqual(['pack-a']);
    expect(grants.listPacksForConnection('dealflow')).toEqual(['pack-b']);
  });

  it('is empty for a connection with no pack grants', () => {
    grants.grantPackGroup('sales-pack', HS, 'onedrive-work', 'deals-write');
    expect(grants.listPacksForConnection('unused-conn')).toEqual([]);
    expect(grants.listPacksForConnection('nope')).toEqual([]);
  });
});
