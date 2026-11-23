import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTRACT_DEFINITION_SCOPE, D165_CONTRACT_SCHEMA, type ContractDefinition } from '@recued/contracts';
import { createSessionGrantResolver } from '../session-grant-resolver.js';
import { applyGrantOperation, GRANT_MODES, GRANT_NOW, openGrantStore, seedGrant, type GrantChildInput, type GrantMode, type GrantOperation, type GrantResult } from './helpers/session-grant-child.js';

const dirs: string[] = [];
const children: ChildProcess[] = [];
const handles: ReturnType<typeof openGrantStore>['db'][] = [];
interface LifecycleFixture {
  dir: string; database: string; contract_id: string;
  operation: GrantOperation; before: ContractDefinition;
}
const fixture = (mode: GrantMode = 'exact', budget = 1, finalBatchUse = false) => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-grant-transactions-'));
  dirs.push(dir);
  const database = join(dir, 'realm.sqlite');
  return { dir, database, ...seedGrant(database, mode, budget, finalBatchUse) };
};
const open = (database: string) => {
  const env = openGrantStore(database, GRANT_NOW + 10);
  handles.push(env.db);
  return env;
};
const waitFile = async (path: string) => {
  const deadline = Date.now() + 15_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error('Owned grant fixture did not reach ' + path);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const startChild = (f: LifecycleFixture, name: string, operation: GrantOperation, pause: boolean) => {
  const marker = join(f.dir, name);
  const input: GrantChildInput = { database: f.database, contract_id: f.contract_id, operation, marker, start: marker + '.start', release: marker + '.release', pause, now: GRANT_NOW + (name === 'a' ? 1 : 2) };
  const config = marker + '.json'; writeFileSync(config, JSON.stringify(input));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./helpers/session-grant-child.ts', import.meta.url)), config], {
    cwd: process.cwd(), env: { ...process.env, TSX_TSCONFIG_PATH: resolve('tsconfig.base.json') }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Grant child failed (${code ?? signal}): ${stderr}`)));
  });
  void done.catch(() => {});
  return { input, done, result: () => (JSON.parse(readFileSync(marker + '.result', 'utf8')) as { value: GrantResult }).value };
};

/** Observe native state to support both the old boundary and the fixed one;
 * assertions below concern only admitted operations and durable lifecycle state. */
const runPair = async (f: LifecycleFixture, aOperation: GrantOperation = f.operation, bOperation: GrantOperation = f.operation) => {
  const a = startChild(f, 'a', aOperation, true);
  await waitFile(a.input.marker + '.ready');
  const b = startChild(f, 'b', bOperation, false);
  await waitFile(b.input.marker + '.ready');
  writeFileSync(a.input.start, '');
  await waitFile(a.input.marker + '.read');
  const { in_transaction } = JSON.parse(readFileSync(a.input.marker + '.read', 'utf8')) as { in_transaction: boolean };
  writeFileSync(b.input.start, '');
  try {
    await waitFile(b.input.marker + (in_transaction ? '.attempt' : '.result'));
  } finally { writeFileSync(a.input.release, ''); }
  await Promise.all([a.done, b.done]);
  const final = open(f.database).definitions.get(f.contract_id)!;
  return { a: a.result(), b: b.result(), final, first: in_transaction ? a.result() : b.result() };
};
const claimed = (row: ContractDefinition) => row.batch_members?.filter(member => member.consumed_at != null).map(member => member.member_id).sort();
const revocation = (result: GrantResult): ContractDefinition => {
  if (result === null || typeof result !== 'object') throw new Error('Expected a revoked grant');
  return result;
};
const lifecycleOperations: GrantOperation[] = [
  { kind: 'consume', call: { canonical_payload_hash: 'payload' } },
  { kind: 'claim', member: 'm2', call: { arg_shape_hash: 'shape', canonical_payload_hash: 'payload-2' } },
  { kind: 'revoke', reason: 'Owner stopped the pass' },
  { kind: 'active-revoke' },
];

afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGKILL'); await exited;
    }
  }));
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type StandingEdit = Extract<GrantOperation, { kind: 'read-spheres' | 'door-types' | 'limits' }>;
const standingEdits: StandingEdit[] = [
  { kind: 'read-spheres', spheres: ['personal'] },
  { kind: 'door-types', door_types: ['mcp_chat'] },
  { kind: 'limits', limits: { max_uses: 2, use_period: 'total', expiry_at: GRANT_NOW + 120_000 } },
];
const standingFixture = (operation: StandingEdit): LifecycleFixture => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-standing-transactions-'));
  dirs.push(dir);
  const database = join(dir, 'realm.sqlite');
  const env = openGrantStore(database);
  handles.push(env.db);
  env.store.seedSchema(D165_CONTRACT_SCHEMA);
  const before = env.definitions.mint({ minted_by: 'fixture-owner', display_name: 'Standing agreement',
    scope: { channels: ['mcp'], actors: ['contracted_user'], ingredient_ids: ['mail.send'], operation_ids: ['mail.send'] },
    max_uses: 2, expiry_at: GRANT_NOW + 60_000, door_types: ['mcp'], read_spheres: ['professional'] });
  env.db.close();
  return { dir, database, contract_id: before.contract_id, operation, before };
};
const expectEdited = (row: ContractDefinition, operation: StandingEdit) => {
  switch (operation.kind) {
    case 'read-spheres': expect(row.read_spheres).toEqual(operation.spheres); break;
    case 'door-types': expect(row.door_types).toEqual(operation.door_types); break;
    case 'limits': expect(row).toMatchObject({ max_uses: operation.limits.max_uses, expiry_at: operation.limits.expiry_at }); break;
  }
};

describe('shared SQLite standing agreement edits', () => {
  it.each(standingEdits)('$kind preserves every successful spent use', async operation => {
    const f = standingFixture(operation);
    const result = await runPair(f, operation, { kind: 'reserve-use' });
    expect(result.b).toBe(true);
    expect(result.final.uses_remaining).toBe(1);
    expectEdited(result.final, operation);
  });

  it.each(standingEdits)('$kind preserves committed revocation and its provenance', async operation => {
    const f = standingFixture(operation);
    const result = await runPair(f, operation, { kind: 'revoke', reason: 'Owner ended agreement' });
    const revoked = revocation(result.b);
    expect(result.final).toMatchObject({ revoked_at: revoked.revoked_at, revocation_reason: revoked.revocation_reason });
    expectEdited(result.final, operation);
  });

  it.each(standingEdits)('$kind rolls back with an enclosing transaction', operation => {
    const f = standingFixture(operation);
    const { db, store, definitions } = open(f.database);
    expect(() => store.transaction(() => {
      expect(applyGrantOperation(definitions, f.contract_id, operation)).not.toBeNull();
      expectEdited(definitions.get(f.contract_id)!, operation);
      throw new Error('Outer edit failed');
    })).toThrow('Outer edit failed');
    expect(db.inTransaction).toBe(false);
    db.close();
    expect(open(f.database).definitions.get(f.contract_id)).toEqual(f.before);
  });

  it.each(standingEdits)('$kind leaves the agreement unchanged when native persistence fails', operation => {
    const f = standingFixture(operation);
    const { db, definitions } = open(f.database);
    db.exec(`CREATE TRIGGER fail_edit BEFORE UPDATE OF value_inline ON contract_store
      WHEN NEW.scope = '${CONTRACT_DEFINITION_SCOPE}' BEGIN SELECT RAISE(ABORT, 'Agreement write failed'); END`);
    expect(() => applyGrantOperation(definitions, f.contract_id, operation)).toThrow('Agreement write failed');
    expect(db.inTransaction).toBe(false);
    expect(definitions.get(f.contract_id)).toEqual(f.before);
  });

  it.each(standingEdits)('$kind refuses to author a session grant', operation => {
    const f = fixture(); const { definitions } = open(f.database);
    expect(applyGrantOperation(definitions, f.contract_id, operation)).toBeNull();
    expect(definitions.get(f.contract_id)).toEqual(f.before);
  });
});

describe('shared SQLite grant lifecycle', () => {
  it.each(GRANT_MODES)('admits exactly one final %s use across processes', async mode => {
    const f = fixture(mode, 1, mode.startsWith('batch-'));
    const { a, b, final } = await runPair(f);
    expect([a, b].filter(value => value === true)).toHaveLength(1);
    expect(final.uses_remaining).toBe(0);
  });

  it('retains both successful distinct batch claims and the matching budget', async () => {
    const f = fixture('batch-claim', 2);
    const result = await runPair(f, { kind: 'claim', member: 'm1', call: { arg_shape_hash: 'shape', canonical_payload_hash: 'payload-1' } });
    expect([result.a, result.b]).toEqual([true, true]);
    expect(claimed(result.final)).toEqual(['m1', 'm2']);
    expect(result.final.uses_remaining).toBe(0);
  });

  it.each(['revoke', 'active-revoke'] as const)('spending retains a committed %s and its provenance', async kind => {
    const f = fixture('exact', 2);
    const result = await runPair(f, f.operation, kind === 'revoke' ? { kind, reason: 'Owner stopped the pass' } : { kind });
    const revoked = revocation(result.b);
    expect(result.final).toMatchObject({ revoked_at: revoked.revoked_at, revocation_reason: revoked.revocation_reason, uses_remaining: 1 });
  });

  it.each(['revoke', 'active-revoke'] as const)('%s retains every successful spent use', async kind => {
    const f = fixture('exact', 2);
    const result = await runPair(f, kind === 'revoke' ? { kind, reason: 'Owner stopped the pass' } : { kind });
    expect(result.final.revoked_at).toBe(revocation(result.a).revoked_at);
    expect(result.final.uses_remaining).toBe(2 - Number(result.b === true));
  });

  it.each(['revoke', 'active-revoke'] as const)('%s retains the first committed revocation timestamp and reason', async kind => {
    const f = fixture('exact', 2);
    const result = await runPair(f, kind === 'revoke' ? { kind, reason: 'First request' } : { kind }, { kind: 'revoke', reason: 'Other request' });
    const first = revocation(result.first);
    expect(result.final).toMatchObject({ revoked_at: first.revoked_at, revocation_reason: first.revocation_reason });
  });

  it('a batch claim retains a committed revocation and its provenance', async () => {
    const f = fixture('batch-claim', 2);
    const result = await runPair(f, f.operation, { kind: 'revoke', reason: 'Owner stopped the batch' });
    const revoked = revocation(result.b);
    expect(result.final).toMatchObject({ revoked_at: revoked.revoked_at, revocation_reason: revoked.revocation_reason, uses_remaining: 1 });
    expect(claimed(result.final)).toEqual(['m2']);
  });

  it('revocation retains successful batch claims and their spent budget', async () => {
    const f = fixture('batch-claim', 2);
    const result = await runPair(f, { kind: 'revoke', reason: 'Owner stopped the batch' });
    expect(result.final.revoked_at).toBe(revocation(result.a).revoked_at);
    expect(claimed(result.final)).toEqual(result.b === true ? ['m2'] : []);
    expect(result.final.uses_remaining).toBe(2 - Number(result.b === true));
  });

  it.each(lifecycleOperations)('$kind remains part of an enclosing transaction and rolls back with it', operation => {
    const f = fixture(operation.kind === 'claim' ? 'batch-claim' : 'exact', 2);
    const { db, store, definitions } = open(f.database);
    expect(() => store.transaction(() => {
      expect(applyGrantOperation(definitions, f.contract_id, operation)).not.toBeNull();
      expect(definitions.get(f.contract_id)).not.toEqual(f.before);
      throw new Error('Outer write failed');
    })).toThrow('Outer write failed');
    expect(db.inTransaction).toBe(false);
    expect(definitions.get(f.contract_id)).toEqual(f.before);
    db.close();
    expect(open(f.database).definitions.get(f.contract_id)).toEqual(f.before);
  });

  it.each(lifecycleOperations)('$kind leaves no partial mutation when native persistence fails', operation => {
    const f = fixture(operation.kind === 'claim' ? 'batch-claim' : 'exact', 2);
    const { db, definitions } = open(f.database);
    db.exec(`CREATE TRIGGER fail_grant_write BEFORE UPDATE OF value_inline ON contract_store
      WHEN NEW.scope = '${CONTRACT_DEFINITION_SCOPE}' BEGIN SELECT RAISE(ABORT, 'Grant write failed'); END`);
    expect(() => applyGrantOperation(definitions, f.contract_id, operation)).toThrow('Grant write failed');
    expect(db.inTransaction).toBe(false);
    expect(definitions.get(f.contract_id)).toEqual(f.before);
  });

  it('notifies a successful spend only after the native transaction commits', () => {
    const f = fixture(); const env = open(f.database);
    const observer = open(f.database);
    const observed: Array<number | null | undefined> = [];
    const resolver = createSessionGrantResolver({ definitionStore: env.definitions, broadcast: () => {
      expect(env.db.inTransaction).toBe(false);
      observed.push(observer.definitions.get(f.contract_id)?.uses_remaining);
    } });
    expect(resolver.consume(f.contract_id)).toBe(true);
    expect(resolver.consume(f.contract_id)).toBe(false);
    expect(observed).toEqual([0]);
  });

  it('does not announce a spend whose native write rolls back', () => {
    const f = fixture(); const env = open(f.database); const observed: string[] = [];
    env.db.exec(`CREATE TRIGGER fail_grant_write BEFORE UPDATE ON contract_store
      WHEN NEW.scope = '${CONTRACT_DEFINITION_SCOPE}' BEGIN SELECT RAISE(ABORT, 'Grant write failed'); END`);
    const resolver = createSessionGrantResolver({ definitionStore: env.definitions, broadcast: event => { observed.push(event.contract_id); } });
    expect(() => resolver.consume(f.contract_id)).toThrow('Grant write failed');
    expect(observed).toEqual([]);
    expect(env.definitions.get(f.contract_id)).toEqual(f.before);
  });
});
