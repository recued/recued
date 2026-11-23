/** Disposable fixture/driver for the Docker runtime suite. The server under test
 * is always a separate process running the image's unmodified dist/bin.js. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fn, spyOn } from '@vitest/spy';
import {
  encodeBearerSubprotocol, WS_VERSION_SUBPROTOCOL, PREAPPROVAL_NOTIFICATION_HANDLER,
  type PreapprovalInspection,
} from '@recued/contracts';
import { createServerBundle, deriveSubDEK, generateServerKey, generateRecoveryKey } from '@recued/crypto';
import { bootServerIdentity } from '../identity/boot.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { openDatabase, rekeyDatabase } from '../open-database.js';
import { createPreapprovalCodec } from '../storage/preapproval-codec.js';
import { createRecoveryKeyCheckStore } from '../recovery-key-store.js';
import { processRecoveryKey } from '../recovery-key-processor.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { createRecordsStore } from '../records/store.js';
import { preapprovalHash } from '../preapproval-invocations.js';
import { createPreapprovalRequestOrigin } from '../preapproval-request-origin.js';
import { recordStep, recordsManifest, resourceFixture, resourceFixtureDisposers } from './preapproval-resources-fixture.js';

const passphrase = 'disposable-docker-lifecycle-fixture';
const caseName = process.argv[2];
assert(caseName === 'pending' || caseName === 'revocation');
const serverLogs: string[] = [];

const start = async (dir: string, token: { token_id: string; bearer: string }) => {
  const child = spawn(process.execPath, ['/opt/recued/dist/bin.js', '--db', join(dir, 'realm.sqlite'), '--port', '7717'], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RECUED_IDENTITY_PASSPHRASE: passphrase, RECUED_BOOT_TRACE: '1' },
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let log = '', ws: WebSocket | undefined, stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true; ws?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try { assert.deepEqual(await exited, { code: 0, signal: null }, log); }
    finally { clearTimeout(timeout); serverLogs.push(log); }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Packaged CLI did not reach readiness')), 60_000);
      let pending = '';
      const receive = (bytes: Buffer) => {
        const text = bytes.toString(); log += text; pending += text;
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          const match = line.match(/\[recued boot\] (\{.*\})/u);
          if (!match) continue;
          const event: { phase: string; detail?: string } = JSON.parse(match[1]!);
          if (event.phase === 'dispatch-error') { clearTimeout(timeout); reject(new Error(event.detail)); }
          if (event.phase === 'dispatch-complete') { clearTimeout(timeout); resolve(); }
        }
      };
      child.stdout.on('data', receive); child.stderr.on('data', receive);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Packaged CLI exited before readiness')); });
    });
    const health = await fetch('http://127.0.0.1:7717/health', { signal: AbortSignal.timeout(10_000) });
    assert.equal(health.status, 200);
    let connection: Promise<WebSocket> | undefined;
    const connect = () => connection ??= new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket('ws://127.0.0.1:7717/ws', [WS_VERSION_SUBPROTOCOL,
        encodeBearerSubprotocol(`${token.token_id}.${token.bearer}`)]);
      ws = socket;
      const timeout = setTimeout(() => reject(new Error('Paired WebSocket did not open')), 10_000);
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve(socket); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Paired WebSocket rejected')); }, { once: true });
      socket.addEventListener('close', event => { clearTimeout(timeout); reject(new Error(`Paired WebSocket closed: ${event.code}`)); }, { once: true });
    });
    const call = async <T>(method: string, args: object): Promise<T> => {
      const socket = await connect();
      return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timeout = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error(`${method} timed out`)); }, 10_000);
        const receive = (event: MessageEvent) => {
          const message: { type?: string; request_id?: string; result?: T; error?: unknown } = JSON.parse(String(event.data));
          if (message.type !== 'rpc_result' || message.request_id !== requestId) return;
          clearTimeout(timeout); socket.removeEventListener('message', receive);
          if (message.error) reject(new Error(JSON.stringify(message.error)));
          else resolve(message.result!);
        };
        socket.addEventListener('message', receive);
        socket.send(JSON.stringify({ type: 'rpc', request_id: requestId, method, args }));
      });
    };
    return { call, stop };
  } catch (error) {
    await stop();
    throw error;
  }
};

const prepare = async () => {
  let fixture = await resourceFixture(undefined, { spies: { fn, spyOn } });
  // Keep the reviewed ingredient resolvable by the packaged server after the
  // source fixture closes. Install it before capturing dependency identities.
  createLocalManifestStore(fixture.db).put({ manifest: recordsManifest, entity_schemas: [] });
  const recovery = generateRecoveryKey().mnemonic, serverKey = generateServerKey();
  const { bundle, masterDEK } = await createServerBundle({ recoveryKey: recovery, serverKey });
  const vaultKey = deriveSubDEK(masterDEK, 'vault'), databaseKey = deriveSubDEK(masterDEK, 'database');
  const oldCodec = createPreapprovalCodec(() => new Uint8Array(32).fill(5));
  const codec = createPreapprovalCodec(() => vaultKey);
  const dbPath = join(fixture.dir, 'realm.sqlite');
  const identity = await bootServerIdentity({ dbPath, passphrase, machineSealing: false });
  identity.keyStore.saveServerVaultKey(serverKey); await identity.keyStore.flush?.();
  createServerBundleStore(dbPath).save(bundle);
  assert((await processRecoveryKey(createRecoveryKeyCheckStore(fixture.db), recovery)).ok);
  fixture.db.prepare("INSERT OR REPLACE INTO server_config(key,value) VALUES('instance_id','realm')").run();
  rekeyDatabase(fixture.db, databaseKey);
  fixture.db.pragma('wal_checkpoint(TRUNCATE)');
  await fixture.close();
  // First boot installs the realm's ordinary declarations. Capture review
  // identities only after that work, just as an already-running server does.
  const bootstrap = await start(fixture.dir, fixture.token);
  await bootstrap.stop();
  fixture = await resourceFixture({ dir: fixture.dir, clock: { now: Date.now() }, token: fixture.token }, {
    spies: { fn, spyOn },
    openDatabase: path => openDatabase(path, { keyEnvironment: { RECUED_IDENTITY_PASSPHRASE: passphrase }, writeLockWarning: false }),
  });
  fixture.save([recordStep('a')]);
  const request = fixture.request();
  assert.equal(request.activation.kind, 'one_shot');
  request.activation = { kind: 'one_shot', run_at: fixture.clock.now + 3_600_000, time_zone: 'UTC' };
  request.decision_deadline = fixture.clock.now + 1_800_000;
  request.dispatch_deadline = fixture.clock.now + 7_200_000;
  const origin = caseName === 'pending' ? createPreapprovalRequestOrigin({ ownerId: 'realm',
    recipes: fixture.sources.recipes, definitions: fixture.definitions, clientTokens: fixture.clients,
  }, { step_id: 'docker-lifecycle-review', execution_source: fixture.origin.source }) : fixture.origin;
  const created = await fixture.service.prepare(request, origin);
  const approval = caseName === 'revocation' ? await fixture.decision(created.proposal_id) : undefined;
  if (approval) await fixture.storage.repository.decide(approval, fixture.responder);
  assert.equal(fixture.db.prepare('SELECT count(*) n FROM preapproval_prompts').pluck().get(), 0);
  // Only fixture preparation uses the source codec. Its plaintext is preserved
  // while the image reads the same plan through its normal vault provider.
  const row = fixture.db.prepare('SELECT snapshot_ciphertext FROM preapproval_executions WHERE future_ref=?')
    .get(created.future_execution_ref) as { snapshot_ciphertext: string };
  const plan = await oldCodec.open(row.snapshot_ciphertext), ciphertext = await codec.seal(plan);
  assert.deepEqual(await codec.open(ciphertext), plan);
  fixture.db.prepare('UPDATE preapproval_executions SET snapshot_ciphertext=? WHERE future_ref=?')
    .run(ciphertext, created.future_execution_ref);
  fixture.db.pragma('wal_checkpoint(TRUNCATE)');
  await fixture.close();
  serverKey.fill(0); masterDEK.fill(0); vaultKey.fill(0); databaseKey.fill(0);
  return { dir: fixture.dir, token: fixture.token, created, approval, owner: fixture.owner };
};

const snapshot = async (seed: Awaited<ReturnType<typeof prepare>>, replay?: Array<Record<string, unknown>>) => {
  const db = await openDatabase(join(seed.dir, 'realm.sqlite'), {
    keyEnvironment: { RECUED_IDENTITY_PASSPHRASE: passphrase }, writeLockWarning: false,
  });
  try {
    const authority = Object.fromEntries(['preapproval_executions', 'preapproval_proposals', 'preapproval_grants',
      'preapproval_decisions', 'preapproval_mutations', 'preapproval_members'].map(table => [table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const prompts = db.prepare('SELECT * FROM preapproval_prompts ORDER BY proposal_id,proposal_revision').all();
    const asks = (db.prepare('SELECT data FROM pending_asks').all() as Array<{ data: string }>)
      .map(row => JSON.parse(row.data) as { ask_id: string; status: string; handler_kind: string; handler_payload: { proposal_id: string } })
      .filter(ask => ask.handler_kind === PREAPPROVAL_NOTIFICATION_HANDLER);
    const events = db.prepare('SELECT event_id,state FROM preapproval_outbox ORDER BY event_id').all();
    const eventRows = db.prepare('SELECT * FROM preapproval_outbox ORDER BY event_id').all() as Array<Record<string, unknown>>;
    const members = db.prepare('SELECT attempt_id,action_ref,commit_id,actual_run_id FROM preapproval_members').all();
    const record = createRecordsStore(db).ownerGet(seed.owner, 'note', 'a');
    if (replay) {
      assert(replay.length > 0);
      // Normal maintenance may already have pruned acknowledged rows. Restore
      // the captured delivery entries to exercise replay of the same event IDs.
      for (const row of replay) {
        assert.equal(row.state, 'pending');
        const columns = Object.keys(row);
        db.prepare(`INSERT OR REPLACE INTO preapproval_outbox (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
          .run(...columns.map(column => row[column]));
      }
      assert.equal(db.prepare("SELECT count(*) FROM preapproval_outbox WHERE state='pending'").pluck().get(), replay.length);
    }
    return { authority, prompts, asks, events, eventRows, members, record };
  } finally { db.close(); }
};

const main = async () => {
  const seed = await prepare();
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const original = await snapshot(seed);
    const inspect = () => server!.call<PreapprovalInspection>('preapproval.get', { proposal_id: seed.created.proposal_id });
    server = await start(seed.dir, seed.token);
    const first = await inspect();
    if (caseName === 'pending') {
      assert.equal(first.status, 'awaiting_owner', JSON.stringify(first)); assert.equal(first.grant, null);
      await server.stop();
      const delivered = await snapshot(seed, original.eventRows);
      assert.deepEqual(delivered.authority, original.authority);
      assert.equal(delivered.prompts.length, 1); assert.equal(delivered.asks.length, 1);
      assert.equal(delivered.asks[0]!.status, 'open');
      assert.equal(delivered.asks[0]!.handler_payload.proposal_id, seed.created.proposal_id);
      server = await start(seed.dir, seed.token);
      assert.deepEqual(await inspect(), first);
      await server.stop();
      const reopened = await snapshot(seed);
      assert.deepEqual(reopened.authority, original.authority);
      assert.deepEqual(reopened.prompts, delivered.prompts);
      assert.equal(reopened.asks.length, 1); assert.equal(reopened.asks[0]!.ask_id, delivered.asks[0]!.ask_id);
      assert.equal(reopened.asks[0]!.status, 'open');
      assert.deepEqual(reopened.events, delivered.events);
      assert.deepEqual(reopened.record, original.record);
      console.log(JSON.stringify({ case: caseName, status: 'passed', restarts: 1, prompts: 1,
        ask_id_preserved: true, authority_unchanged: true, event_replay_completed: true }));
    } else {
      assert(first.grant); assert.equal(first.grant.status, 'active', JSON.stringify(first));
      const input = { grant_id: first.grant.grant_id, expected_revision: first.grant.revision, request_id: randomUUID() };
      const revoked = await server.call<PreapprovalInspection>('preapproval.revoke', input);
      assert.equal(revoked.grant?.status, 'revoked');
      assert.equal(revoked.grant?.revision, first.grant.revision + 1);
      assert.equal(revoked.execution_status, 'cancelled');
      assert(first.decision && revoked.decision);
      assert.equal(revoked.decision.decision_id, first.decision.decision_id);
      assert.deepEqual(await inspect(), revoked);
      await server.stop();
      const recorded = await snapshot(seed);
      assert.deepEqual(recorded.authority.preapproval_decisions, original.authority.preapproval_decisions);
      assert.deepEqual(recorded.authority.preapproval_mutations, [{ request_id: input.request_id,
        responder_key: seed.token.token_id, input_digest: preapprovalHash(input), future_ref: seed.created.future_execution_ref }]);
      server = await start(seed.dir, seed.token);
      assert.deepEqual(await inspect(), revoked);
      assert.deepEqual(await server.call<PreapprovalInspection>('preapproval.revoke', input), revoked);
      assert(seed.approval);
      await server.call('preapproval.decide', seed.approval);
      assert.deepEqual(await inspect(), revoked);
      await server.stop();
      const reopened = await snapshot(seed);
      assert.deepEqual(reopened.authority, recorded.authority);
      assert.equal(reopened.members.length, 1);
      assert.deepEqual(reopened.members, [{ attempt_id: null, action_ref: null, commit_id: null, actual_run_id: null }]);
      assert.deepEqual(reopened.record, original.record);
      console.log(JSON.stringify({ case: caseName, status: 'passed', restarts: 1,
        revocation_visible_without_restart: true, revocation_preserved: true,
        decision_and_revoker_provenance_preserved: true, approval_replay_did_not_reactivate: true,
        dispatched_members: 0, resource_unchanged: true }));
    }
  } finally { await server?.stop(); }
};

try { await main(); }
catch (error) { console.error(error); console.error(serverLogs.join('\n')); process.exitCode = 1; }
finally { for (const dispose of resourceFixtureDisposers.splice(0).reverse()) await dispose(); }
