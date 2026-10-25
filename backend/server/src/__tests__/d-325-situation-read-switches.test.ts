/** D-325 — a situation shows mail and files on switches that exist.
 *
 *  The situation code gated a mail or file item on `core.data.mail.get` and
 *  `core.data.file.get`. No registry lists either id, so no switch could turn them on
 *  or off. An AI app's key gets only what is switched on, so it never saw mail or files
 *  in a situation. The owner's switch-off of `core.mail.get` did nothing there, because
 *  a made-up id has no row and the owner's default is yes. Found under D-327, whose
 *  Contracts page tells the owner each kind of item needs its own read switch.
 *
 *  ⛔ REAL contract stores, not a stub checker. The D-325 tests answer every op with
 *  `() => true`, and a checker that cannot tell one op from another cannot see a
 *  made-up one. */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  D165_CONTRACT_SCHEMA,
  KERNEL_OP_REGISTRY,
  OWNER_CONTRACT_ID,
  type ExecutionSource,
  type SituationFact,
} from '@recued/contracts';

import { createSituationAccess } from '../situations/access.js';
import { situationSourceReadOp, wholeSituationSnapshotAllowed } from '../situations/event-visibility.js';
import { createSituationQuery, type SituationSource } from '../situations/query.js';
import { situationSourceAccess } from '../situations/sources.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createContractStore } from '../storage/contract-store.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const WEEK = { time: { from: NOW, to: NOW + 7 * DAY } };

const TASK = { collection: 'task', id: 'task-1' };
const MAIL = { collection: 'mail', id: 'inbox:m-1' };
const FILE = { collection: 'file', id: 'docs:f-1' };

// What an AI app needs to see the task at all, then the email and the file behind it.
const TASK_SWITCHES = { 'core.situation.read': true, 'core.work-entity.read': true, 'data.task': true };
const MAIL_SWITCHES = { 'core.mail.get': true, 'data.mail': true };
const FILE_SWITCHES = { 'core.storage.file.get': true, 'data.file': true };

const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', user_id: 'owner', chat_session_id: 'chat-1' };

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

/** One server: the real contract stores, an AI app's agreement (it gets only what is
 *  switched on), and the production situation access over one task whose evidence is
 *  an email and a file. */
const rig = () => {
  const db = new Database(':memory:');
  dbs.push(db);
  const contracts = createContractStore(db, { now: () => NOW });
  contracts.seedSchema(D165_CONTRACT_SCHEMA);
  const definitions = createContractDefinitionStore(contracts, { now: () => NOW, newId: () => 'ct_app' });
  const grants = createContractGrantEntryStore(contracts);
  const agreement = definitions.mint({ minted_by: 'owner', display_name: 'An AI app', scope: {}, key_authority: 'contract' });
  const app: ExecutionSource = {
    channel: 'mcp', actor: 'contracted_user', contract_id: agreement.contract_id,
    mcp_token_id: 'key-1', agent_id: 'app', tool_call_id: 'call-1',
  };
  const fact: SituationFact = {
    ref: TASK, title: 'Send the signed lease', kind: 'task', basis: 'declared',
    when: { from: NOW + DAY, to: NOW + DAY }, people: [], subjects: [], related: [],
    evidence: [{ ...TASK }, { ...MAIL }, { ...FILE }], updated_at: NOW, consequence: 'routine',
  };
  let duringRead = (): void => {};
  const task: SituationSource = {
    id: 'task', collection: 'task', verb_op: situationSourceReadOp('task')!,
    read: () => {
      duringRead();
      return [fact];
    },
  };
  const query = createSituationQuery({ sources: [task], now: () => NOW, sourceForCollection: situationSourceAccess });
  const access = createSituationAccess({ contracts, query, now: () => NOW, isVaultUnlocked: () => true });
  const set = (contract_id: string, entries: Record<string, boolean>): void => {
    for (const [entry, granted] of Object.entries(entries)) grants.set(contract_id, entry, granted, NOW);
  };
  /** The kinds of evidence a situation read shows this caller for the task. */
  const shown = async (source: ExecutionSource): Promise<string[]> => {
    const result = await access.read(WEEK, source);
    return result.clusters.flatMap((c) => c.items).flatMap((i) => i.evidence.map((e) => e.collection)).sort();
  };
  const onRead = (fn: () => void): void => {
    duringRead = fn;
  };
  return { access, app, appContract: agreement.contract_id, set, shown, onRead };
};

describe('an AI app on a key', () => {
  it('sees the email and the file once their read and data switches are on', async () => {
    const r = rig();
    r.set(r.appContract, TASK_SWITCHES);
    expect(await r.shown(r.app)).toEqual(['task']);
    r.set(r.appContract, { ...MAIL_SWITCHES, ...FILE_SWITCHES });
    expect(await r.shown(r.app)).toEqual(['file', 'mail', 'task']);
  });

  it('loses each one when its read switch goes off', async () => {
    const r = rig();
    r.set(r.appContract, { ...TASK_SWITCHES, ...MAIL_SWITCHES, ...FILE_SWITCHES });
    r.set(r.appContract, { 'core.mail.get': false });
    expect(await r.shown(r.app)).toEqual(['file', 'task']);
    r.set(r.appContract, { 'core.storage.file.get': false });
    expect(await r.shown(r.app)).toEqual(['task']);
  });
});

describe('the owner', () => {
  it('sees both by default, and switching a read off hides its kind', async () => {
    const r = rig();
    expect(await r.shown(owner)).toEqual(['file', 'mail', 'task']);
    r.set(OWNER_CONTRACT_ID, { 'core.mail.get': false });
    expect(await r.shown(owner)).toEqual(['file', 'task']);
    r.set(OWNER_CONTRACT_ID, { 'core.storage.file.get': false });
    expect(await r.shown(owner)).toEqual(['task']);
  });

  it('gets a refusal, not stale mail, when the mail read goes off during the read', async () => {
    const r = rig();
    r.onRead(() => r.set(OWNER_CONTRACT_ID, { 'core.mail.get': false }));
    await expect(r.access.read(WEEK, owner)).rejects.toThrow(/Permissions changed/u);
  });
});

describe('a saved situation, as the digest and the proactive feed check it', () => {
  it('is withheld while the mail read is off and shown once it is on', async () => {
    const r = rig();
    const [cluster] = (await r.access.read(WEEK, owner)).clusters;
    expect(cluster!.items[0]!.evidence.map((e) => e.collection)).toContain('mail');
    const snapshot = { id: 'situation-1', state: 'new' as const, cluster: cluster!, urgency: 'routine' as const };
    const allowed = (source: ExecutionSource): boolean => {
      const context = r.access.fence(source);
      return wholeSituationSnapshotAllowed(snapshot, context.grants, context);
    };
    r.set(r.appContract, { ...TASK_SWITCHES, ...FILE_SWITCHES });
    expect(allowed(r.app)).toBe(false);
    r.set(r.appContract, MAIL_SWITCHES);
    expect(allowed(r.app)).toBe(true);
    expect(allowed(owner)).toBe(true);
    r.set(OWNER_CONTRACT_ID, { 'core.mail.get': false });
    expect(allowed(owner)).toBe(false);
  });
});

describe('the op ids the server checks', () => {
  const SRC = fileURLToPath(new URL('..', import.meta.url));
  const sourceFiles = (dir: string): string[] =>
    (readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.split(/[\\/]/u).includes('__tests__'))
      .map((f) => join(dir, f));
  const registered = new Set(KERNEL_OP_REGISTRY.map((k) => k.op));

  it('are all registered ops, so each has a switch that turns it on and off', () => {
    const named = new Set<string>();
    // Every op the situation code names, and every literal verb-op check anywhere. Every
    // kernel op has two dots, so a one-dot name such as a family (`core.crm`) is not read.
    for (const file of sourceFiles(join(SRC, 'situations'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/'(core\.[a-z0-9-]+\.[a-z0-9.-]+)'/gu)) named.add(m[1]!);
    }
    for (const file of sourceFiles(SRC)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/isVerbOpGranted\('([^']+)'\)/gu)) named.add(m[1]!);
    }
    // The scan has to have seen the ids it guards, or an empty list would pass.
    expect(named).toContain('core.situation.read');
    expect(named).toContain('core.mail.get');
    expect(named).toContain('core.storage.file.get');
    expect([...named].filter((id) => !registered.has(id)).sort()).toEqual([]);
  });
});
