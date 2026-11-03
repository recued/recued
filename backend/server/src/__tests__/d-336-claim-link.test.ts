/** D-336 slice Q, its open item — a save linked to the contact its AI app added, at any time
 *  (the owner, 2026-11-01: "Same app, any time"), as a chat's turn links them. Over the real
 *  ledger, memory and contact stores on SQLite; the tools' handlers tell the linker what they
 *  made as they run (`d-329-chat-held-write` drives that through the chat). */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatDispatchContext, ExecutionSource, MemoryClaim } from '@recued/contracts';
import { createInMemoryCollection } from '@recued/storage';

import { claimLinkScopeOf, createClaimLinker, recordMade } from '../claim-link.js';
import { ownerClaimRecords } from '../memory-claim.js';
import type { MemoryRedactionRecord } from '../memory-rpc-handler.js';
import { createClaimLinkLedger } from '../storage/claim-link-ledger.js';
import { createHeldResultTurnStore } from '../storage/chat-held-result-store.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createContactStore } from '../storage/contact-store.js';
import { createUserMemoryStore, type UserMemoryRow } from '../user-memory-store.js';

const disposals: Array<() => void> = [];
afterEach(() => { while (disposals.length > 0) disposals.pop()!(); });

const app = (contract_id: string): ChatDispatchContext => ({
  execution_source: {
    channel: 'mcp', actor: 'contracted_user', agent_id: 'codex', tool_call_id: 't', mcp_token_id: 'tok', contract_id,
  } as ExecutionSource,
} as ChatDispatchContext);
const NIECE: MemoryClaim = { subject: { text: 'Mia' }, relation: 'niece of', object: { owner: true } };

const fixture = () => {
  const db = new Database(':memory:');
  disposals.push(() => db.close());
  const contacts = createContactStore(db);
  const store = createUserMemoryStore(createInMemoryCollection<UserMemoryRow>(), {} as never, {});
  const ledger = createClaimLinkLedger(db);
  const linker = createClaimLinker({
    ledger: () => ledger, memory: () => store, contacts: () => contacts,
    ownerRecords: () => ownerClaimRecords({ contacts }),
    redactions: () => createInMemoryCollection<MemoryRedactionRecord>(),
  });
  /** As `contact.write` adds Mia from her name and tells the linker. */
  const add = async (name: string, ctx: ChatDispatchContext) => {
    const contact = contacts.createMentionOnlyContact({ name }, 1000, { origin_actor: 'user_self', origin_surface: 'client_rpc' });
    await linker.recordMade({ kind: 'contact', target_id: contact.email, name }, ctx);
    return contact;
  };
  /** As `memory.write` saves a note and tells the linker. */
  const save = async (summary: string, claim: MemoryClaim, ctx: ChatDispatchContext) => {
    const row = await store.create({ kind: 'note', summary, claim });
    await linker.recordMade({ kind: 'memory', memory_id: row.memory_id }, ctx);
    return row.memory_id;
  };
  const claimOf = async (memory_id: string) => (await store.getRow(memory_id))!.claim;
  return { contacts, store, add, save, claimOf };
};

describe('D-336 slice Q — an AI app\'s save and the contact it added', () => {
  it('links them whichever ran first, however far apart', async () => {
    const f = fixture();
    // The add first, the save on another day: an app's calls carry no turn.
    const mia = await f.add('Mia', app('app-codex'));
    const first = await f.save("Mia is the owner's niece", NIECE, app('app-codex'));
    expect(await f.claimOf(first)).toEqual({ ...NIECE, subject: { contact_id: mia.contact_id, name: 'Mia' } });
    // The save first: linked when the add runs.
    const sam = await f.save("Sam is the owner's nephew", { subject: { text: 'Sam' }, relation: 'nephew of', object: { owner: true } }, app('app-codex'));
    const added = await f.add('Sam', app('app-codex'));
    expect(await f.claimOf(sam)).toMatchObject({ subject: { contact_id: added.contact_id, name: 'Sam' } });
  });

  it('⛔ never another app\'s contact, nor a contact the owner added', async () => {
    const f = fixture();
    // Another app's save made before the add, and one made after it.
    const before = await f.save("Mia is the owner's niece", NIECE, app('app-claude'));
    await f.add('Mia', app('app-codex'));
    const other = await f.save("Mia is the owner's niece, aged 11", NIECE, app('app-claude'));
    expect(await f.claimOf(before)).toEqual(NIECE);
    expect(await f.claimOf(other)).toEqual(NIECE);
    // A contact the owner added from a name is no app's.
    f.contacts.createMentionOnlyContact({ name: 'Dana' }, 1000, { origin_actor: 'user_self', origin_surface: 'client_rpc' });
    const dana = await f.save("Dana is the owner's aunt", { subject: { text: 'Dana' }, relation: 'aunt of', object: { owner: true } }, app('app-codex'));
    expect((await f.claimOf(dana))!.subject).toEqual({ text: 'Dana' });
  });

  it('⛔ two contacts one app added under one name are not told apart', async () => {
    const f = fixture();
    await f.add('Mia', app('app-codex'));
    await f.add('Mia', app('app-codex'));
    const saved = await f.save("Mia is the owner's niece", NIECE, app('app-codex'));
    expect(await f.claimOf(saved)).toEqual(NIECE);
  });

  it('a link that throws never fails the write that told it', async () => {
    await expect(recordMade({ onRecordMade: async () => { throw new Error('ledger gone'); } },
      { kind: 'memory', memory_id: 'umem_1' }, app('app-codex'))).resolves.toBeUndefined();
  });

  it('a call\'s scope: an app by its contract, a chat by its turn, else none', () => {
    expect(claimLinkScopeOf(app('app-codex'))).toBe('app:app-codex');
    const chat = { channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'local', turn_id: 't1' } as ExecutionSource;
    expect(claimLinkScopeOf({ execution_source: chat })).toBe('turn:s1:t1');
    // A chat source minted without its turn takes the dispatch's.
    const bare = { channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'local' } as ExecutionSource;
    expect(claimLinkScopeOf({ execution_source: bare, turn_id: 't2' })).toBe('turn:s1:t2');
    // A messenger chat's write in its turn, and one resumed with no turn known.
    const messenger = { channel: 'messenger', actor: 'user_self', vendor: 'telegram', from: '42' } as ExecutionSource;
    expect(claimLinkScopeOf({ execution_source: messenger, session_id: 'm1', turn_id: 'mt' })).toBe('turn:m1:mt');
    expect(claimLinkScopeOf({ execution_source: messenger })).toBeUndefined();
  });

  it('a turn that carries the reply on is the turn it carries on; an app is its app', () => {
    const chat = { channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'local', turn_id: 't2' } as ExecutionSource;
    const roots = (turn: string) => (turn === 't2' ? 't1' : undefined);
    expect(claimLinkScopeOf({ execution_source: chat }, roots)).toBe('turn:s1:t1');
    expect(claimLinkScopeOf({ execution_source: { ...chat, turn_id: 't9' } as ExecutionSource }, roots)).toBe('turn:s1:t9');
    // A lookup that fails leaves the turn itself.
    expect(claimLinkScopeOf({ execution_source: chat }, () => { throw new Error('db closed'); })).toBe('turn:s1:t2');
    expect(claimLinkScopeOf(app('app-codex'), roots)).toBe('app:app-codex');
  });

  it('the turn store names the first turn of a chain of continuations, and none for a turn that is no continuation', () => {
    const db = new Database(':memory:');
    disposals.push(() => db.close());
    ensureChatSchema(db);
    createChatStore(db).createSession({ id: 's', now: 1_000 });
    const turns = createHeldResultTurnStore(db);
    turns.record({ turn_id: 'cont-1', session_id: 's', run_id: 'run-1', origin_turn_id: 'turn-1' });
    turns.record({ turn_id: 'cont-2', session_id: 's', run_id: 'run-2', origin_turn_id: 'cont-1' });
    expect(turns.rootTurnOf!('cont-2')).toBe('turn-1');
    expect(turns.rootTurnOf!('cont-1')).toBe('turn-1');
    expect(turns.rootTurnOf!('turn-1')).toBeUndefined();
  });
});
