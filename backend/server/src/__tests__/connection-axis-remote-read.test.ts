/** The `scope.connection_names` fence, finally given an access-time caller on the
 *  remote-byte path.
 *
 *  ⛔⛔ THE AXIS WAS AUTHORED AND NEVER READ. `derive-recipe-capability` completes it
 *  deliberately so "the fence would bite"; `mint-door-contract` writes it onto the
 *  door — and a census found the only enforcing caller of `contractScopeMatches` was
 *  the session-grant resolver. For a STANDING DOOR nothing consulted it. These tests
 *  are the first thing that does. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  contractScopeAdmitsConnection,
  type ContractScope,
  type ExecutionSource,
} from '@recued/contracts';

import {
  remoteFileConnectionName,
  remoteFileConnectionNamesIn,
} from '../collections/file/remote-file-byte-resolver.js';
import { remoteFileRecordId } from '../file-view-resolver.js';
import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';

const NOW = 1_750_000_000_000;
const DROPBOX_ID = remoteFileRecordId('dropbox.work.file', 'id-1');
const NOTION_ID = remoteFileRecordId('notion.notes.file', 'id-2');

describe('the connection a remote read will authenticate with, from the id alone', () => {
  it('recovers the connection name without touching any store', () => {
    expect(remoteFileConnectionName(DROPBOX_ID)).toBe('work');
    expect(remoteFileConnectionName(NOTION_ID)).toBe('notes');
  });

  it('is undefined — never a guess — for a CAS id, a non-string, or a malformed one', () => {
    expect(remoteFileConnectionName('file_abc123')).toBeUndefined();
    expect(remoteFileConnectionName(undefined)).toBeUndefined();
    expect(remoteFileConnectionName(42)).toBeUndefined();
    expect(remoteFileConnectionName('file:remote:not-b64:also-not')).toBeUndefined();
  });

  /** ⛔⛔ THE PROPERTY THE SCAN EXISTS FOR. `core.storage.file.read` names the id in
   *  `record_id`; the 101 CLI `input_materialize` ops name it in whatever arg their own
   *  bind declares. Keying the fence on a slug or an arg name enumerates a set that
   *  grows elsewhere, and the miss is SILENT. */
  it('finds a remote id under ANY arg name, not just record_id', () => {
    expect(remoteFileConnectionNamesIn({ record_id: DROPBOX_ID })).toEqual(['work']);
    // the CLI shape — `source` today, a pack's choice tomorrow
    expect(remoteFileConnectionNamesIn({ source: DROPBOX_ID })).toEqual(['work']);
    expect(remoteFileConnectionNamesIn({ some_future_arg: NOTION_ID })).toEqual(['notes']);
  });

  it('dedupes, and ignores everything that is not a remote id', () => {
    const names = remoteFileConnectionNamesIn({
      a: DROPBOX_ID, b: DROPBOX_ID, c: NOTION_ID, d: 'file_cas', e: 7, f: undefined,
    });
    expect([...names].sort()).toEqual(['notes', 'work']);
    expect(remoteFileConnectionNamesIn({})).toEqual([]);
    expect(remoteFileConnectionNamesIn(undefined)).toEqual([]);
  });
});

describe('contractScopeAdmitsConnection — the axis rule', () => {
  it('an EMPTY or absent axis is a wildcard (which is most doors)', () => {
    expect(contractScopeAdmitsConnection({}, 'work')).toBe(true);
    expect(contractScopeAdmitsConnection({ connection_names: [] }, 'work')).toBe(true);
    expect(contractScopeAdmitsConnection({}, undefined)).toBe(true);
  });

  it('a named axis admits only what it names', () => {
    const scope: ContractScope = { connection_names: ['work'] };
    expect(contractScopeAdmitsConnection(scope, 'work')).toBe(true);
    expect(contractScopeAdmitsConnection(scope, 'notes')).toBe(false);
  });

  /** ⚠ A dispatch that cannot say which connection it is about to use must not be
   *  admitted against a list that names some. */
  it('an ABSENT name against a restricted axis fails CLOSED', () => {
    expect(contractScopeAdmitsConnection({ connection_names: ['work'] }, undefined)).toBe(false);
  });
});

describe('overlay.admitsConnection — the access-time caller', () => {
  const withOverlay = <T>(fn: (o: ReturnType<typeof createContractOverlayResolver>,
                               defStore: ReturnType<typeof createContractDefinitionStore>) => T): T => {
    const db = new Database(':memory:');
    try {
      const store = createContractStore(db, { now: () => NOW });
      const definitionStore = createContractDefinitionStore(store, { now: () => NOW });
      return fn(
        createContractOverlayResolver({ definitionStore, now: () => NOW } as never),
        definitionStore,
      );
    } finally {
      db.close();
    }
  };

  const door = (contract_id: string): ExecutionSource => ({
    channel: 'mcp', actor: 'contracted_user', agent_id: 'a1', tool_call_id: 't1',
    mcp_token_id: 'tok', contract_id,
  });

  it('a CONTRACT-FREE source admits — there is no scope to consult', () => {
    withOverlay((overlay) => {
      const hid: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'o', client_token_id: 'c' };
      expect(overlay.admitsConnection(hid, 'work')).toBe(true);
    });
  });

  it('a door whose scope NAMES connections admits those and denies the rest', () => {
    withOverlay((overlay, defStore) => {
      const def = defStore.mint({
        minted_by: 'test',
        display_name: 'dropbox-only door',
        scope: { channels: ['mcp'], actors: ['contracted_user'], connection_names: ['work'] },
      });
      expect(overlay.admitsConnection(door(def.contract_id), 'work')).toBe(true);
      // ⛔ The assertion this whole slice exists for.
      expect(overlay.admitsConnection(door(def.contract_id), 'notes')).toBe(false);
    });
  });

  it('a door that names NO connections still admits (wildcard, unchanged behaviour)', () => {
    withOverlay((overlay, defStore) => {
      const def = defStore.mint({
        minted_by: 'test',
        display_name: 'open door',
        scope: { channels: ['mcp'], actors: ['contracted_user'] },
      });
      expect(overlay.admitsConnection(door(def.contract_id), 'notes')).toBe(true);
    });
  });
});
