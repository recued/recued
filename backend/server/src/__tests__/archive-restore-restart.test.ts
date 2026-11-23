/** Real foreground server restore and interruption recovery over encrypted realms. */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import type Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateRecoveryKey } from '@recued/crypto';
import type { ArchiveJobStatus, IngredientManifest, RecipeDefinition, PreparePreapproval,
  PreapprovalResult, PreapprovalReview, PreapprovalInspection } from '@recued/contracts';
import { bootServerIdentity } from '../identity/boot.js';
import { createKeyManager } from '../key-manager.js';
import { openDatabase } from '../open-database.js';
import { createClientTokenStore } from '../pairing/client-tokens.js';
import { createRecoveryKeyCheckStore } from '../recovery-key-store.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { enrollRealmRecoveryKey } from '../server-vault-enrollment.js';
import { createEncryptedBlobStore, DISPLACED_BLOB_SUFFIX } from '../storage/blob-store.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { createRecipeStore } from '../recipe-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createConnectionCatalogBindingStore } from '../storage/connection-catalog-binding-store.js';
import { serverEntry } from './helpers/server-bundle.js';

const root = resolve(import.meta.dirname, '../../../..');
const SMALL = 'data.shared.restore-restart.small';
const LARGE = 'data.shared.restore-restart.large';
const AFTER = 'data.shared.restore-restart.after';
const BLOB = 'encrypted restore fixture '.repeat(4_000);
const directories: string[] = [];
const sockets = new Set<WebSocket>();
const children = new Set<ChildProcess>();
const providers = new Set<ReturnType<typeof createServer>>();
type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Running = { child: ChildProcess; socket: WebSocket; closed: Promise<Exit>; log: () => string };
class RpcFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const rpc = <T>(socket: WebSocket, method: string, args: unknown = {}): Promise<T> => new Promise((done, reject) => {
  const request_id = randomUUID();
  const cleanup = () => {
    clearTimeout(timer); socket.off('message', receive); socket.off('close', disconnected); socket.off('error', failed);
  };
  const failed = (error: Error) => { cleanup(); reject(error); };
  const disconnected = () => failed(new Error(`Socket closed before RPC reply: ${method}`));
  const timer = setTimeout(() => failed(new Error(`RPC timed out: ${method}`)), 60_000);
  const receive = (bytes: import('ws').RawData) => {
    const response = JSON.parse(bytes.toString()); if (response.request_id !== request_id) return;
    cleanup();
    if (response.error) reject(new RpcFailure(response.error.code, response.error.message));
    else done(response.result as T);
  };
  socket.on('message', receive); socket.once('close', disconnected); socket.once('error', failed);
  socket.send(JSON.stringify({ type: 'rpc', request_id, method, args }), error => { if (error) failed(error); });
});

it('recovers an unfinished provider write across repeated server boots without resending it', async () => {
  const received: string[] = [];
  const provider = createServer(async (request, response) => {
    for await (const _bytes of request) { /* consume the controlled write */ }
    received.push(request.url!);
    // Keep the original attempt unfinished. Subsequent newly reviewed writes
    // use the same transport and receive an ordinary successful response.
    if (received.length === 1) return;
    response.setHeader('content-type', 'application/json'); response.end('{"delivered":true}');
  });
  providers.add(provider); await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('No local provider address');
  const fixture = await reviewedRealm(`http://127.0.0.1:${address.port}`);
  const first = await fixture.start(); await fixture.enroll(first);
  const pending = await fixture.prepare(first, 90_000);
  await rpc(first.socket, 'preapproval.decide', pending.decision);
  await vi.waitFor(() => expect(received).toEqual(['/reviewed']), { timeout: 180_000, interval: 25 });
  const original = await fixture.get(first, pending.proposal);
  expect(original.execution_status).toBe('running');
  expect(original.members).toHaveLength(1);
  const member = original.members[0]!;
  expect(member).toMatchObject({ status: 'dispatching', action_ref: expect.any(String), commit_id: expect.any(String) });
  const records = () => fixture.inspect(db => ({
    commit: JSON.parse((db.prepare('SELECT data FROM commits WHERE key = ?').get(member.commit_id) as { data: string }).data),
    receipt: JSON.parse((db.prepare('SELECT data FROM gated_action_receipts WHERE key = ?').get(member.action_ref) as { data: string }).data),
    commits: (db.prepare("SELECT COUNT(*) AS n FROM commits WHERE json_extract(data, '$.preapproval.future_execution_ref') = ?")
      .get(pending.proposal.future_execution_ref) as { n: number }).n,
    receipts: (db.prepare("SELECT COUNT(*) AS n FROM gated_action_receipts WHERE json_extract(data, '$.preapproval.future_execution_ref') = ?")
      .get(pending.proposal.future_execution_ref) as { n: number }).n,
  }));
  const before = await records();
  expect(['pending', 'running']).toContain(before.commit.status);
  expect(before.receipt).toMatchObject({ status: 'dispatching', dispatch_attempt_id: expect.any(String) });
  expect(before).toMatchObject({ commits: 1, receipts: 1 });
  expect(await fixture.inspect(db => db.prepare(`SELECT w.pid FROM preapproval_executions e
    JOIN preapproval_workers w ON w.worker_id = e.worker_id WHERE e.future_ref = ?`)
    .get(pending.proposal.future_execution_ref))).toEqual({ pid: first.child.pid });
  expect(first.child.kill('SIGKILL')).toBe(true);
  expect(await first.closed).toEqual({ code: null, signal: 'SIGKILL' });

  const assertRecovered = async (server: Running) => {
    const recovered = await fixture.get(server, pending.proposal);
    expect(recovered.execution_status).toBe('in_doubt');
    expect(recovered.members[0]).toMatchObject({ status: 'in_doubt', action_ref: member.action_ref, commit_id: member.commit_id });
    const current = await records();
    expect(current).toMatchObject({ commit: { status: 'in_doubt' }, receipt: { status: 'in_doubt' }, commits: 1, receipts: 1 });
    expect(current.commit.source).toEqual(before.commit.source);
    expect(current.commit.preapproval).toEqual(before.commit.preapproval);
    expect(current.commit.idempotency_key).toBe(before.commit.idempotency_key);
    expect(current.receipt.dispatch_attempt_id).toBe(before.receipt.dispatch_attempt_id);
  };
  const second = await fixture.start();
  expect(second.child.pid).not.toBe(first.child.pid);
  await assertRecovered(second);
  expect(received).toEqual(['/reviewed']);
  await stop(second.child);
  expect(await second.closed).toEqual({ code: 0, signal: null });

  const third = await fixture.start();
  expect(third.child.pid).not.toBe(second.child.pid);
  await assertRecovered(third);
  expect(received).toEqual(['/reviewed']);
  // The real scheduler must still run fresh reviewed work after recovery.
  const fresh = await fixture.prepare(third, 90_000);
  await rpc(third.socket, 'preapproval.decide', fresh.decision);
  let completed!: PreapprovalInspection;
  await vi.waitFor(async () => {
    completed = await fixture.get(third, fresh.proposal);
    expect(completed.execution_status).toBe('succeeded');
  }, { timeout: 180_000, interval: 500 });
  expect(completed.members).toHaveLength(1);
  expect(completed.members[0]).toMatchObject({ status: 'succeeded', commit_id: expect.any(String) });
  expect(completed.members[0]!.commit_id).not.toBe(member.commit_id);
  expect(received).toEqual(['/reviewed', '/reviewed']);
  await assertRecovered(third);
}, 1_200_000);
const stop = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(done => child.once('close', () => done()));
  child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try { await closed; } finally { clearTimeout(force); }
};
afterEach(async () => {
  for (const socket of sockets) socket.terminate(); sockets.clear();
  await Promise.all([...children].map(stop)); children.clear();
  for (const provider of providers) {
    provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done()));
  }
  providers.clear();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const boot = async (dir: string, bearer: string): Promise<Running> => {
  const bin = join(dir, 'bin'); mkdirSync(bin, { recursive: true });
  const child = spawn(process.execPath, [...await serverEntry(), 'serve', '--db', join(dir, 'realm.db'),
    '--config', join(dir, 'config.toml'), '--port', '0'], { cwd: root,
    env: { ...process.env, TSX_TSCONFIG_PATH: join(root, 'backend/server/tsconfig.json'),
      RECUED_LLM_API_KEY: '', RECUED_LLM_SLOT2_API_KEY: '',
      RECUED_IDENTITY_PASSPHRASE: '', RECUED_IDENTITY_PASSPHRASE_FILE: '',
      RECUED_BOOT_TRACE: '1', RECUED_DISTRIBUTION_CHANNEL: 'docker-thin', RECUED_BIN_DIR: bin,
      RECUED_SUPERVISOR_MODE: 'native' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const closed = new Promise<Exit>((done, reject) => { child.once('close', (code, signal) => done({ code, signal })); child.once('error', reject); });
  let output = '';
  const capture = (bytes: Buffer) => { output = (output + bytes.toString()).slice(-128_000); };
  child.stdout!.on('data', capture); child.stderr!.on('data', capture);
  let port: number | undefined;
  await new Promise<void>((ready, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer); clearInterval(poll);
      if (error) reject(error); else ready();
    };
    // Bound startup separately from the case, with immediate exit diagnostics.
    const timer = setTimeout(() => finish(new Error(`Server boot timed out: ${output.slice(-6_000)}`)), 240_000);
    const poll = setInterval(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        finish(new Error(`Server exited before ready: ${output.slice(-6_000)}`)); return;
      }
      const bound = [...output.matchAll(/\[listener\] path listener bound\s*\{([^}]{1,1000})\}/g)]
        .find(match => /\blistener:\s*['"]lan['"]/.test(match[1]!));
      const actual = Number(/\bport:\s*(\d+)/.exec(bound?.[1] ?? '')?.[1]);
      if (Number.isSafeInteger(actual) && actual > 0 && actual <= 65_535) { port = actual; finish(); }
    }, 25);
  });
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${bearer}` } });
  sockets.add(socket);
  await new Promise<void>((done, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer); socket.off('open', opened); socket.off('error', failed);
      if (error) reject(error); else done();
    };
    const opened = () => finish(), failed = (error: Error) => finish(error);
    const timer = setTimeout(() => finish(new Error(`Owner socket did not open: ${output.slice(-6_000)}`)), 60_000);
    socket.once('open', opened); socket.once('error', failed);
  });
  return { child, socket, closed, log: () => output };
};
const realm = async (seed?: (db: Database.Database) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-restart-')); directories.push(dir);
  const dbPath = join(dir, 'realm.db');
  writeFileSync(join(dir, 'config.toml'), '[runtime]\n"network.lan_bind_address" = "127.0.0.1"\n');
  // Tooling creates this realm's own keyfile without provisioning an OS keyring.
  const identity = await bootServerIdentity({ dbPath, passphrase: null, env: {} });
  const db = await openDatabase(dbPath, { databaseKey: null });
  const bundle = createServerBundleStore(dbPath);
  const keys = createKeyManager({ loadBundle: () => null, saveBundle: () => {},
    loadServerBundle: () => bundle.load(), saveServerBundle: value => bundle.save(value) });
  const { mnemonic } = generateRecoveryKey();
  let bearer: string, databaseKey: Buffer, blobKey: Buffer;
  try {
    const token = await createClientTokenStore(db, { argon2_params: { t: 1, m: 8, p: 1 } })
      .issue({ client_kind: 'webclient', metadata: { instance_id: 'archive-restart-owner' } });
    bearer = `${token.token_id}.${token.bearer}`;
    seed?.(db);
    expect(await enrollRealmRecoveryKey({ recoveryKeyCheck: createRecoveryKeyCheckStore(db),
      keys, keyStore: identity.keyStore, recoveryKey: mnemonic, database: db })).toMatchObject({ ok: true });
    databaseKey = Buffer.from(keys.getSubDEK('database'));
    blobKey = Buffer.from(keys.keyProvider('blob-store')()!);
  } finally { db.close(); keys.lock(); }
  const start = (token = bearer!) => boot(dir, token);
  const inspect = async <T>(reader: (db: Database.Database) => T): Promise<T> => {
    const database = await openDatabase(dbPath, { databaseKey: databaseKey!, readonly: true, fileMustExist: true });
    try { return reader(database); } finally { database.close(); }
  };
  const blob = async () => {
    const database = await openDatabase(dbPath, { databaseKey: databaseKey!, readonly: true, fileMustExist: true });
    try {
      const row = database.prepare('SELECT blob_hash FROM shared_store WHERE key = ?').get('restore-restart.large') as { blob_hash: string };
      expect(row.blob_hash).toMatch(/^[a-f0-9]{64}$/);
      const path = join(dir, 'blobs', 'objects', row.blob_hash.slice(0, 2), `${row.blob_hash.slice(2)}.bin`);
      const plaintext = await createEncryptedBlobStore(join(dir, 'blobs'), () => blobKey!).get(row.blob_hash);
      return { hash: row.blob_hash, path, plaintext, ciphertext: readFileSync(path) };
    } finally { database.close(); }
  };
  return { dir, dbPath, mnemonic, start, blob, inspect };
};
const write = (server: Running, key: string, value: unknown) => rpc(server.socket, 'shared.write', { key, value });
const read = (server: Running, key: string) => rpc<{ found: boolean; value?: unknown }>(server.socket, 'shared.read', { key });
const backup = async (server: Running, mnemonic: string): Promise<string> => {
  const job = await rpc<{ job_id: string }>(server.socket, 'server.archive.export',
    { include_blobs: true, include_passport: false, recoveryKey: mnemonic });
  let path: string | undefined;
  await vi.waitFor(async () => {
    const status = await rpc<ArchiveJobStatus>(server.socket, 'server.archive.status', job);
    expect(status.state, status.error).toBe('done'); expect(status.path).toBeTruthy(); path = status.path;
  }, { timeout: 60_000, interval: 25 });
  return path!;
};
type Accepted = { operation_id?: string; restored_at: number | null; rebind?: { token_id: string; bearer: string } };
const restore = async (server: Running, path: string, recoveryKey: string, operation_id: string) => {
  const accepted = await rpc<Accepted>(server.socket, 'server.archive.import', { path, recoveryKey, operation_id });
  expect(accepted.operation_id).toBe(operation_id); expect(accepted.restored_at).not.toBeNull();
  expect(accepted.rebind).toMatchObject({ token_id: expect.any(String), bearer: expect.any(String), instance_id: 'archive-restart-owner' });
  await vi.waitFor(() => expect(server.child.exitCode, server.log().slice(-4_000)).toBe(3), { timeout: 60_000, interval: 25 });
  expect(await server.closed).toEqual({ code: 3, signal: null });
  return accepted;
};

const reviewedRealm = async (providerUrl: string) => {
  const connection = 'restore-reviewed-write';
  const manifest: IngredientManifest = {
    slug: 'restore-reviewed-catalog', name: 'Restore review fixture', description: 'Controlled restore review operation.',
    version: 1, author: 'fixture', kind: 'connection', category: 'data', risk_tier: 'read', input: {}, output: {},
    operations: { 'item.write': { operation_id: 'fixture/restore.item.write', risk_tier: 'write', approval: 'ask', groups: [] } },
    surfaces: { api: { transport: 'rest', default_base_url: providerUrl, auth: { kind: 'none' },
      executes: { 'item.write': { kind: 'rest', method: 'POST', path_template: '/reviewed' } } } },
  };
  const recipe: RecipeDefinition = {
    recipe_id: 'restore-reviewed-write', version: 1, ttl: 300,
    metadata: { name: 'Restore review fixture', description: 'Exercise approval safety across an encrypted restore.',
      author: 'core', supported_platforms: [] },
    variables: {}, prefetch_steps: [], output: { sidebar: [] },
    steps: [{ id: 'send', ingredient: manifest.slug, connection, input: { operation: 'item.write', args: {} } }],
  };
  const fixture = await realm(db => {
    createLocalManifestStore(db).put({ manifest, entity_schemas: [] });
    createConnectionCatalogBindingStore(createContractStore(db)).bind(connection, manifest.slug, 'fixture-pack');
    createRecipeStore('/no-bundled-recipes', db).save(recipe, 'core', 'inline');
  });
  const enroll = (server: Running) => rpc(server.socket, 'collection.connection.enroll', {
    kind: 'api', name: connection, display_name: 'Restore review fixture', auth: { type: 'none' },
    config: { base_url: providerUrl },
  });
  const get = (server: Running, proposal: PreapprovalResult) =>
    rpc<PreapprovalInspection>(server.socket, 'preapproval.get', { proposal_id: proposal.proposal_id });
  const prepare = async (server: Running, delay: number) => {
    // Start the review clock only after the process and connection are ready.
    // The roomy dispatch window includes the real archive swap and boot.
    const now = Date.now();
    const request: PreparePreapproval = { idempotency_key: randomUUID(),
      subject: { kind: 'recipe', recipe_id: recipe.recipe_id, publisher_id: 'core', config: {} },
      activation: { kind: 'one_shot', run_at: now + delay, time_zone: 'UTC' },
      decision_deadline: now + delay, dispatch_deadline: now + 1_800_000 };
    const proposal = await rpc<PreapprovalResult>(server.socket, 'preapproval.prepare', request);
    expect(proposal).toMatchObject({ coverage: 'complete', eligible_members: 1, uncovered_calls: 0 });
    const review = await rpc<PreapprovalReview>(server.socket, 'preapproval.review', { proposal_id: proposal.proposal_id });
    const decision = { proposal_id: proposal.proposal_id, expected_revision: review.revision,
      review_digest: review.review_digest, challenge: review.challenge, decision: 'approve', request_id: randomUUID() };
    return { proposal, decision };
  };
  return { ...fixture, enroll, get, prepare };
};

describe('online restore over real server restart', () => {
  it('reopens restored SQLite and encrypted blobs, reports completion and refuses replay', async () => {
    const fixture = await realm(), first = await fixture.start();
    await write(first, SMALL, 'snapshot'); await write(first, LARGE, BLOB);
    const archived = await fixture.blob();
    expect(JSON.parse(archived.plaintext!.toString())).toBe(BLOB);
    expect(archived.ciphertext.equals(archived.plaintext!)).toBe(false);
    const path = await backup(first, fixture.mnemonic);
    await write(first, SMALL, 'live'); await write(first, LARGE, 'new live blob '.repeat(6_000));
    await write(first, AFTER, 'not in archive');
    const id = randomUUID(), accepted = await restore(first, path, fixture.mnemonic, id);
    const rebound = `${accepted.rebind!.token_id}.${accepted.rebind!.bearer}`;
    const second = await fixture.start(rebound);
    expect(second.child.pid).not.toBe(first.child.pid);
    expect(await read(second, SMALL)).toMatchObject({ found: true, value: 'snapshot' });
    expect(await read(second, LARGE)).toMatchObject({ found: true, value: BLOB });
    expect(await read(second, AFTER)).toMatchObject({ found: false });
    expect(await rpc(second.socket, 'server.archive.import_status', { operation_id: id })).toEqual({ status: 'completed' });
    expect((await fixture.blob()).hash).toBe(archived.hash);
    await write(second, AFTER, 'must survive replay');
    await expect(rpc(second.socket, 'server.archive.import', { path, recoveryKey: fixture.mnemonic, operation_id: id }))
      .rejects.toMatchObject({ code: 'invalid_args', message: expect.stringContaining('already in use') });
    expect(await read(second, AFTER)).toMatchObject({ found: true, value: 'must survive replay' });
    expect(second.child.exitCode).toBeNull();
    expect(await rpc(second.socket, 'server.archive.import_status', { operation_id: id })).toEqual({ status: 'completed' });
    expect(existsSync(path)).toBe(true);
  }, 660_000);

  it('preserves the live realm after a corrupt import and retains both receipts after a valid retry restarts', async () => {
    const fixture = await realm(), first = await fixture.start();
    await write(first, SMALL, 'snapshot'); await write(first, LARGE, BLOB);
    const path = await backup(first, fixture.mnemonic);
    await write(first, SMALL, 'live'); await write(first, AFTER, 'live-only');
    const predecessor = await fixture.blob();
    // The trailing HMAC fails after the archive's database and shared blob
    // have been streamed into staging.
    const corruptPath = join(fixture.dir, 'corrupt.recued-archive');
    const corrupt = readFileSync(path); corrupt[corrupt.length - 1]! ^= 1;
    writeFileSync(corruptPath, corrupt);
    const failedId = randomUUID();
    await expect(rpc(first.socket, 'server.archive.import',
      { path: corruptPath, recoveryKey: fixture.mnemonic, operation_id: failedId }))
      .rejects.toMatchObject({ message: expect.stringContaining('ARCHIVE_INVALID_SIGNATURE') });
    expect(await rpc(first.socket, 'server.archive.import_status', { operation_id: failedId })).toEqual({ status: 'not_applied' });
    expect(await read(first, SMALL)).toMatchObject({ found: true, value: 'live' });
    expect(await read(first, AFTER)).toMatchObject({ found: true, value: 'live-only' });
    expect(await read(first, LARGE)).toMatchObject({ found: true, value: BLOB });
    expect((await fixture.blob()).ciphertext).toEqual(predecessor.ciphertext);
    expect(first.child.exitCode).toBeNull();
    expect(readdirSync(fixture.dir).filter(name => name.startsWith('realm.db.staging-'))).toEqual([]);
    expect(readdirSync(join(fixture.dir, 'blobs'), { recursive: true })
      .filter(name => String(name).includes(DISPLACED_BLOB_SUFFIX))).toEqual([]);
    await expect(rpc(first.socket, 'server.archive.import',
      { path, recoveryKey: fixture.mnemonic, operation_id: failedId }))
      .rejects.toMatchObject({ code: 'invalid_args', message: expect.stringContaining('already in use') });

    const retryId = randomUUID(), accepted = await restore(first, path, fixture.mnemonic, retryId);
    const rebound = `${accepted.rebind!.token_id}.${accepted.rebind!.bearer}`;
    const second = await fixture.start(rebound);
    expect(second.child.pid).not.toBe(first.child.pid);
    expect(await read(second, SMALL)).toMatchObject({ found: true, value: 'snapshot' });
    expect(await read(second, AFTER)).toMatchObject({ found: false });
    expect(await read(second, LARGE)).toMatchObject({ found: true, value: BLOB });
    expect(await rpc(second.socket, 'server.archive.import_status', { operation_id: failedId })).toEqual({ status: 'not_applied' });
    expect(await rpc(second.socket, 'server.archive.import_status', { operation_id: retryId })).toEqual({ status: 'completed' });
  }, 660_000);

  it('invalidates restored approvals, preserves uncertain effects and executes only newly reviewed work', async () => {
    const received: string[] = [];
    const provider = createServer(async (request, response) => {
      for await (const _bytes of request) { /* consume the controlled write */ }
      received.push(request.url!);
      // The first write reaches the provider, whose reply is lost. The real
      // transport must retain that uncertainty rather than claiming success.
      if (received.length === 1) { response.destroy(); return; }
      response.setHeader('content-type', 'application/json'); response.end('{"delivered":true}');
    });
    providers.add(provider); await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('No local provider address');
    const providerUrl = `http://127.0.0.1:${address.port}`;
    const fixture = await reviewedRealm(providerUrl);
    const first = await fixture.start(); await fixture.enroll(first);
    const { get, prepare } = fixture;
    const pending = await prepare(first, 900_000);
    const approved = await prepare(first, 900_000);
    await rpc(first.socket, 'preapproval.decide', approved.decision);
    expect((await get(first, pending.proposal)).execution_status).toBe('prepared');
    expect(await get(first, approved.proposal)).toMatchObject({ execution_status: 'active', grant: { status: 'active' } });
    const uncertain = await prepare(first, 90_000);
    await rpc(first.socket, 'preapproval.decide', uncertain.decision);
    let original!: PreapprovalInspection;
    await vi.waitFor(async () => {
      original = await get(first, uncertain.proposal);
      expect(original.execution_status).toBe('in_doubt');
    }, { timeout: 180_000, interval: 500 });
    expect(received).toEqual(['/reviewed']);
    expect(original.members).toHaveLength(1);
    expect(original.members[0]).toMatchObject({ status: 'in_doubt', action_ref: expect.any(String), commit_id: expect.any(String) });
    const path = await backup(first, fixture.mnemonic);
    const id = randomUUID(), accepted = await restore(first, path, fixture.mnemonic, id);
    const second = await fixture.start(`${accepted.rebind!.token_id}.${accepted.rebind!.bearer}`);
    expect(second.child.pid).not.toBe(first.child.pid);
    expect(await rpc(second.socket, 'server.archive.import_status', { operation_id: id })).toEqual({ status: 'completed' });
    for (const old of [pending, approved]) {
      const restored = await get(second, old.proposal);
      expect(restored).toMatchObject({ execution_status: 'invalidated', status_reason: 'restored_lineage' });
      await expect(rpc(second.socket, 'preapproval.decide', old.decision)).rejects.toMatchObject({ code: 'preapproval_stale' });
    }
    // An unaccepted proposal has no grant/member rows yet. Its projection's
    // default member state grants no authority; the old review must be closed.
    expect(await get(second, pending.proposal)).toMatchObject({ status: 'invalidated', grant: null });
    const restoredApproved = await get(second, approved.proposal);
    expect(restoredApproved.grant?.status).toBe('invalidated');
    expect(restoredApproved.members.map(member => member.status)).toEqual(['invalidated']);
    const restoredUncertain = await get(second, uncertain.proposal);
    expect(restoredUncertain).toMatchObject({ execution_status: 'in_doubt', status_reason: 'restored_lineage' });
    expect(restoredUncertain.members[0]).toMatchObject({ status: 'in_doubt',
      action_ref: original.members[0]!.action_ref, commit_id: original.members[0]!.commit_id });
    const outcomes = () => fixture.inspect(db => ({
      commit: JSON.parse((db.prepare('SELECT data FROM commits WHERE key = ?').get(original.members[0]!.commit_id) as { data: string }).data).status,
      receipt: JSON.parse((db.prepare('SELECT data FROM gated_action_receipts WHERE key = ?').get(original.members[0]!.action_ref) as { data: string }).data).status,
    }));
    expect(await outcomes()).toEqual({ commit: 'in_doubt', receipt: 'in_doubt' });
    expect(received).toEqual(['/reviewed']);

    // A fresh owner review uses the same restored recipe, connection, scheduler
    // and provider. A disabled execution system cannot satisfy this control.
    const fresh = await prepare(second, 90_000);
    await rpc(second.socket, 'preapproval.decide', fresh.decision);
    let completed!: PreapprovalInspection;
    await vi.waitFor(async () => {
      completed = await get(second, fresh.proposal);
      expect(completed.execution_status).toBe('succeeded');
    }, { timeout: 180_000, interval: 500 });
    expect(completed.members.map(member => member.status)).toEqual(['succeeded']);
    expect(completed.members[0]!.commit_id).not.toBe(original.members[0]!.commit_id);
    expect(received).toEqual(['/reviewed', '/reviewed']);
    expect((await get(second, uncertain.proposal)).members[0]).toMatchObject({ status: 'in_doubt',
      action_ref: original.members[0]!.action_ref, commit_id: original.members[0]!.commit_id });
    expect(await outcomes()).toEqual({ commit: 'in_doubt', receipt: 'in_doubt' });
  }, 960_000);
});
