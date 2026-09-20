/** Real foreground boot, paired owner RPC and encrypted realm reopen. */
import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { IngredientManifest, PreapprovalCapabilities, PreapprovalResult, PreapprovalReview, PreapprovalInspection } from '@recued/contracts';
import { generateRecoveryKey } from '@recued/crypto';
import { opGrantEntry, type PreparePreapproval } from '@recued/contracts';
import { openDatabase } from '../open-database.js';
import { createClientTokenStore } from '../pairing/client-tokens.js';
import { createRecipeStore } from '../recipe-store.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createConnectionCatalogBindingStore } from '../storage/connection-catalog-binding-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createChatInboundTokenStore } from '../storage/chat-inbound-token-store.js';
import { fixtureRecipe } from './d-261-fixtures.js';

const root = resolve(import.meta.dirname, '../../../..');

/** The dispatch window, and the third clock this fixture was caught spending.
 *
 *  ⛔⛔ IT WAS 180s, AND THE SECOND BOOT LIVES INSIDE IT. Measured 2026-09-16
 *  under a saturated box, one case per row:
 *
 *      pending    second boot  22.7s   elapsed  22.9s   of 180s
 *      approved   second boot  26.4s   elapsed  41.4s   of 180s
 *      stdio      second boot 225.6s   elapsed 240.6s   of 180s   ← expired
 *
 *  The restarted server took longer to come up than the whole window, so the
 *  occurrence expired before the boot tick could reach it and the case failed on
 *  `preapproval_expired` — a product-shaped message for a cost the FIXTURE paid.
 *  Third time this file has been bitten by that shape; the first two are the
 *  comments on `openStdio` and on the authority fixture.
 *
 *  🔑 WIDENING IS THE RIGHT LEVER *HERE* AND THE WRONG ONE ONE LINE UP, and the
 *  difference is whether the test SLEEPS on the clock. It sleeps until `run_at`,
 *  so every second added there is a second of real wall-clock — which is why
 *  `decision_deadline` was pulled up to meet `run_at` instead of `run_at` being
 *  pushed out. Nothing ever waits on `dispatch_deadline`; it only has to still
 *  be open when the restarted server ticks. So this one is free.
 *
 *  ⚠ CHOSEN AGAINST THE PER-CASE TIMEOUT (720s), not against a measured boot.
 *  Larger than it, so a boot slow enough to threaten this window kills the case
 *  first and says "timeout" rather than "expired". Widening to merely "more than
 *  we measured" would just move the next flake. ⇒ A REAL expiry bug still fails
 *  the status assertion, because the product would report `expired` and nothing
 *  here asserts the window was tight.
 *
 *  ⛔ The validator's only constraint is ORDER — `decision_deadline <= run_at <
 *  dispatch_deadline` (`preapproval.ts:302`). There is no maximum. */
const DISPATCH_WINDOW_MS = 900_000;
const children = new Set<ChildProcess>();
const dirs: string[] = [];
const sockets = new Set<WebSocket>();
const providers = new Set<ReturnType<typeof createServer>>();
const stop = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>(resolveDone => child.once('exit', () => resolveDone()));
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 4_000);
  await ended; clearTimeout(force); children.delete(child);
};
afterEach(async () => {
  for (const socket of sockets) socket.terminate(); sockets.clear();
  await Promise.all([...children].map(stop));
  for (const server of providers) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  providers.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const rpc = <T>(socket: WebSocket, method: string, args: unknown = {}): Promise<T> => new Promise((resolveReply, reject) => {
  const request_id = randomUUID();
  const timer = setTimeout(() => { socket.off('message', receive); reject(new Error(`RPC timed out: ${method}`)); }, 8_000);
  const receive = (bytes: import('ws').RawData) => {
    const response = JSON.parse(bytes.toString()); if (response.request_id !== request_id) return;
    clearTimeout(timer); socket.off('message', receive);
    if (response.error) reject(new Error(`${method}: ${response.error.code}: ${response.error.message}`));
    else resolveReply(response.result as T);
  };
  socket.on('message', receive); socket.send(JSON.stringify({ type: 'rpc', request_id, method, args }));
});
const boot = async (dir: string, bearer: string) => {
  // ⚠ A RESERVED PORT IS NOT A HELD PORT, and this window is ~20s wide — the
  //   whole spawn + tsx boot. Measured 2026-09-16 while chasing a different
  //   flake: if anything takes this port in between, the server logs
  //   `path listener bind failed … EADDRINUSE` and EXITS CODE 4, which the poll
  //   below reports as "Foreground boot exited" with that line in the trace. So
  //   it is self-diagnosing, which is why it is documented rather than rebuilt.
  //   ⛔ It is also narrower than it looks: the reservation takes `127.0.0.1`
  //   while the server binds `0.0.0.0`, and under BSD `SO_REUSEADDR` a wildcard
  //   bind succeeds over a held loopback one — verified, a loopback squatter did
  //   NOT block the boot. ⇒ The reservation proves the port was free; it does
  //   not keep it free. If this ever becomes a real flake the fix is `--port 0`
  //   plus parsing the port back out of the bound log (which carries it, and
  //   `compose-listeners.ts` supports a configured 0), not a wider reservation.
  const reserve = createServer(); await new Promise<void>(done => reserve.listen(0, '127.0.0.1', done));
  const address = reserve.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const port = address.port; await new Promise<void>(done => reserve.close(() => done()));
  // ⛔ THE BOOT MUST OWN ITS INSTALL, NOT THE MACHINE'S. `bin.ts serve` takes an
  // early-boot update lease at `updateLeasePathFor(resolveUpdateBinaryPath(env))`,
  // and on every channel but `docker-thin` that resolves to `process.execPath` —
  // the shared Node binary. So this fixture contended with EVERY other spawned
  // server on the host (sibling suites, and a developer's real `recued serve`),
  // and the loser exited code 4 with "an update is in progress on this install"
  // before binding a listener. It passed alone and reds under any parallel run,
  // which is the worst shape for the evidence this file exists to produce.
  //
  // `docker-thin` + a per-`dir` `RECUED_BIN_DIR` moves the lease into the test's
  // own tmpdir, so each install contends only with itself. The boots below are
  // strictly sequential on one `dir` (each `boot` follows a `stop`), which is the
  // real reacquire this fixture wants to exercise anyway. Same isolation the
  // spawned `bin-router` cases and `serve-realm-snapshot-boot-ordering` use.
  const binDir = join(dir, 'bin'); mkdirSync(binDir, { recursive: true });
  const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'backend/server/src/bin.ts'), 'serve',
    '--db', join(dir, 'realm.db'), '--config', join(dir, 'config.toml'), '--port', String(port)], {
    cwd: root, env: { ...process.env, TSX_TSCONFIG_PATH: join(root, 'backend/server/tsconfig.json'),
      RECUED_LLM_API_KEY: '', RECUED_LLM_SLOT2_API_KEY: '', RECUED_BOOT_TRACE: '1',
      RECUED_DISTRIBUTION_CHANNEL: 'docker-thin', RECUED_BIN_DIR: binDir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  child.stdout!.on('data', bytes => { output += String(bytes); });
  child.stderr!.on('data', bytes => { output += String(bytes); });
  await new Promise<void>((ready, reject) => {
    // A full cold import/enrolled boot can spend over 20 seconds on CPU during
    // the corpus checks. This bounds startup, not the reviewed dispatch window.
    //
    // ⛔ 45s → 120s (2026-09-10). A boot costs ~9s when this file runs alone,
    // but under a full `backend/server/src/__tests__` sweep — 1,610 files
    // across 16 workers, each spawning real Node servers — one boot stretched
    // past 45s and reddened the whole sweep. Measured, not guessed: this file
    // passes standalone in 85s AND costs the same 85s at the commit before the
    // change that was under suspicion, so the slowdown is CONTENTION, not the
    // tree.
    //
    // 🔑 THE TWO BOUNDS MUST STAY ORDERED: this per-boot timer has to fire
    // BEFORE the per-case timeout at the bottom of the file, or a stalled boot
    // surfaces as a bare vitest timeout carrying NO boot trace instead of the
    // `phase:` log that says exactly where startup stopped.
    //
    // ⚠ RAISED 120s → 240s FOR FULL-SUITE CONTENTION (D-269 REV 26). Under a
    // bare `vitest run` this boot lost the CPU race and fired at 120s having
    // reached only `dispatch-start` — a starved boot, not a stalled one. The
    // per-case bound below moves WITH it, or the ordering this note exists to
    // protect inverts: one boot (240s) < one case (720s), which is exactly the
    // three boots a case performs.
    const timer = setTimeout(() => { clearInterval(poll); reject(new Error(`Foreground boot timed out: ${output.slice(-6000)}`)); }, 240_000);
    const poll = setInterval(() => {
      if (output.includes('[listener] path listener bound')) { clearTimeout(timer); clearInterval(poll); ready(); }
      else if (child.exitCode !== null) { clearTimeout(timer); clearInterval(poll); reject(new Error(`Foreground boot exited: ${output.slice(-6000)}`)); }
    }, 25);
  });
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${bearer}` } }); sockets.add(socket);
  await new Promise<void>((ready, reject) => { socket.once('open', ready); socket.once('error', reject); });
  return { child, socket };
};

/** A live stdio MCP session, split so the EXPENSIVE half can be paid before the
 *  review clock starts.
 *
 *  ⛔⛔ THIS SPLIT IS THE FIX FOR A REAL FLAKE, AND THE SHAPE MATTERS MORE THAN
 *  THE NUMBERS. `stdioRequest` used to spawn `node --import tsx … bin.ts --mcp`
 *  — a full TypeScript boot in a fresh process — AND send the reviewed request,
 *  all inside `decision_deadline`. Its own timeout was 20s while that deadline
 *  was 15s, so a boot taking 16-20s satisfied the helper and then found the
 *  window already gone. Measured: ~20% failure in isolation and far higher
 *  under a full-tree run (clean at ~640s of suite time, failing at ~780s+),
 *  surfacing as `preapproval_expired` — "The review or dispatch window has
 *  already passed", a message that reads like an approval bug and is really a
 *  clock the FIXTURE was spending.
 *
 *  🔑 WIDENING THE WINDOW WOULD HAVE BEEN THE WRONG FIX. The validator requires
 *  `decision_deadline <= run_at` and the test then sleeps until `run_at`, so
 *  every second of headroom is a second of real wall-clock added to a test that
 *  already runs ~78s. Hoisting the boot removes the variance instead of paying
 *  for it — the same remedy this file already applied to the authority fixture
 *  one comment below.
 *
 *  ⇒ `openStdio` pays spawn + boot + `initialize` + `notifications/initialized`
 *  BEFORE the clock; `send` is one round-trip inside it. */
interface StdioSession {
  readonly child: ReturnType<typeof spawn>;
  readonly send: (request: PreparePreapproval) => Promise<unknown>;
}

const openStdio = async (dir: string, bearer: string): Promise<StdioSession> => {
  const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'backend/server/src/bin.ts'), '--mcp', '--db', join(dir, 'realm.db')], {
    cwd: root, env: { ...process.env, TSX_TSCONFIG_PATH: join(root, 'backend/server/tsconfig.json'), RECUED_MCP_TOKEN: bearer,
      RECUED_LLM_API_KEY: '', RECUED_LLM_SLOT2_API_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child); let output = ''; let errors = '';
  child.stderr.on('data', bytes => { errors += String(bytes); });
  // ⛔⛔ A NEGATIVE MUST NAME ITS CAUSE, AND THE TAIL OF STDERR IS NOT THE CAUSE.
  //   This used to report `Stdio exited: ${errors.slice(-3000)}`, which threw away
  //   the exit CODE and SIGNAL — so a clean `exit 0`, a crash, and a SIGKILL all
  //   read identically — and quoted only the LAST 3000 chars, so whatever the boot
  //   happened to chatter last stood where the cause should be. A run that failed
  //   here printed the D-259 stale-pack warning, which is emitted on a HEALTHY boot
  //   and had nothing to do with the exit; chasing it cost a reader the whole trail
  //   through `installed-manifest-boot-check` and `cli-context/mcp` before landing
  //   back at "the child just exited". Head AND tail, code AND signal.
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.once('exit', (code, signal) => { exited = { code, signal }; });
  const why = (what: string): string => {
    const how = exited === null
      ? 'still running'
      : `exit code=${exited.code} signal=${exited.signal}`;
    // ⚠ Only ELIDE when there is something to elide. Head 1200 + tail 1800 = 3000,
    //   so below that the two halves would overlap and the count would go NEGATIVE
    //   — "…[-1000 chars elided]…" in the very message that exists to be trusted.
    if (errors.length <= 3_000) return `${what} (${how})\n--- stderr ---\n${errors}`;
    const head = errors.slice(0, 1_200);
    const tail = errors.slice(-1_800);
    return `${what} (${how})\n--- stderr head ---\n${head}`
      + `\n  …[${errors.length - 3_000} chars elided]…\n--- stderr tail ---\n${tail}`;
  };
  // One reader for the whole session — the id-keyed waiters replace the single
  // in-flight promise the old helper closed over.
  const waiters = new Map<number, { ok: (v: unknown) => void; no: (e: Error) => void }>();
  child.stdout.on('data', bytes => {
    output += String(bytes);
    while (output.includes('\n')) {
      const index = output.indexOf('\n'); const line = output.slice(0, index); output = output.slice(index + 1);
      let reply; try { reply = JSON.parse(line); } catch { continue; }
      const waiter = waiters.get(reply.id); if (waiter) { waiters.delete(reply.id); waiter.ok(reply); }
    }
  });
  // ⛔ An exit must reject EVERY waiter, not just the current one: a dead child
  //   otherwise hangs the test until vitest's timeout, which reports nothing.
  child.once('exit', () => {
    for (const waiter of waiters.values()) waiter.no(new Error(why('Stdio exited')));
    waiters.clear();
  });
  const await_ = (id: number, ms: number, what: string) => new Promise<unknown>((ok, no) => {
    const timer = setTimeout(() => { waiters.delete(id); no(new Error(why(`Stdio ${what} timed out`))); }, ms);
    waiters.set(id, { ok: v => { clearTimeout(timer); ok(v); }, no: e => { clearTimeout(timer); no(e); } });
  });
  const ready = await_(1, 60_000, 'boot');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  await ready;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  return {
    child,
    // ⚠ 20s, and it now fits INSIDE the review window rather than exceeding it —
    //   the inversion that let a slow call succeed here and expire there.
    send: async (request: PreparePreapproval) => {
      const reply = await_(2, 20_000, 'request');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'recued_ingredient_preapproval-request', arguments: request } }) + '\n');
      return await reply;
    },
  };
};

it.each(['pending', 'approved', 'stdio'] as const)('boots the actual owner service and reopens its encrypted review in a new process: %s', async state => {
  const execute = state !== 'pending';
  const dir = mkdtempSync(join(tmpdir(), 'd261-boot-')); dirs.push(dir);
  const received: string[] = [];
  const provider = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain the controlled request */ }
    received.push(request.url!); response.setHeader('content-type', 'application/json'); response.end('{"delivered":true}');
  });
  providers.add(provider); await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
  const providerAddress = provider.address(); if (!providerAddress || typeof providerAddress === 'string') throw new Error('No provider address');
  const providerUrl = `http://127.0.0.1:${providerAddress.port}`;
  writeFileSync(join(dir, 'config.toml'), '');
  const db = await openDatabase(join(dir, 'realm.db'));
  let bearer: string;
  const manifest: IngredientManifest = { slug: 'boot-reviewed-catalog', name: 'Boot review', description: 'Controlled boot review operation.',
    version: 1, author: 'fixture', kind: 'connection', category: 'data', risk_tier: 'read', input: {}, output: {},
    operations: { 'item.write': { operation_id: 'fixture/boot.item.write', risk_tier: 'write', approval: 'ask', groups: [] } },
    surfaces: { api: { transport: 'rest', default_base_url: providerUrl, auth: { kind: 'none' },
      executes: { 'item.write': { kind: 'rest', method: 'POST', path_template: '/reviewed' } } } } };
  try {
    const token = await createClientTokenStore(db, { argon2_params: { t: 1, m: 8, p: 1 } })
      .issue({ client_kind: 'webclient', metadata: { instance_id: 'boot-owner' } });
    bearer = `${token.token_id}.${token.bearer}`;
    createLocalManifestStore(db).put({ manifest, entity_schemas: [] });
    createConnectionCatalogBindingStore(createContractStore(db)).bind('boot-review', manifest.slug, 'fixture-pack');
    createRecipeStore('/no-bundled-recipes', db).save({ ...fixtureRecipe,
      metadata: { ...fixtureRecipe.metadata, description: 'Exercise a retained review across actual server boots.' },
      steps: [{ id: 'send', ingredient: manifest.slug, connection: 'boot-review', input: { operation: 'item.write', args: {} } }] }, 'core', 'inline');
  } finally { db.close(); }
  const enrollment = await boot(dir, bearer!);
  await rpc(enrollment.socket, 'pair.registerRecoveryKey', { recoveryKey: generateRecoveryKey().mnemonic });
  enrollment.socket.terminate(); await stop(enrollment.child);
  // Finish the enrollment-dependent foundation install before reviewing its
  // authority. The following two boots exercise a fully enrolled realm.
  const first = await boot(dir, bearer!);
  await rpc(first.socket, 'collection.connection.enroll', { kind: 'api', name: 'boot-review', display_name: 'Boot review',
    auth: { type: 'none' }, config: { base_url: providerUrl } });
  const capabilities = await rpc<PreapprovalCapabilities>(first.socket, 'preapproval.capabilities');
  expect(capabilities.activation_kinds).toContain('one_shot');
  // ⛔ THE AUTHORITY FIXTURE IS BUILT BEFORE THE CLOCK STARTS.
  //
  // `decision_deadline` is measured from `now`, and EVERYTHING between `now`
  // and `preapproval.decide` has to fit inside it. Minting a contract, writing
  // three grants and issuing a token is FIXTURE SETUP — it is not part of the
  // reviewed decision, and it only ever sat inside the budget because `now`
  // was captured first. That is what made `stdio` the tightest case in this
  // file and the one that flaked under a full-tree run, surfacing as
  // `preapproval_expired` (a message that reads like an expiry bug and is
  // really a clock the fixture was spending).
  //
  // Hoisting it costs nothing and changes nothing the test asserts: the budget
  // now covers the stdio process spawn plus review/decide, which is what it is
  // for. `mintedAt` is the fixture's own clock — the grants and token only need
  // A timestamp, not THE one the deadline is measured from.
  let contractId: string | undefined;
  let stdioToken: string | undefined;
  if (state === 'stdio') {
    const mintedAt = Date.now();
    const authorityDb = await openDatabase(join(dir, 'realm.db'));
    try {
      const store = createContractStore(authorityDb);
      const contract = createContractDefinitionStore(store).mint({ minted_by: 'owner', display_name: 'Stdio scheduling assistant',
        door_types: ['mcp'], scope: { channels: ['mcp'], actors: ['contracted_user'], connection_names: ['boot-review'],
          operation_ids: ['core.preapproval.request', 'core.schedule.recipe', 'fixture/boot.item.write'] } });
      contractId = contract.contract_id;
      const grants = createContractGrantEntryStore(store);
      for (const op of ['core.preapproval.request', 'core.schedule.recipe', 'fixture/boot.item.write']) {
        grants.set(contract.contract_id, opGrantEntry(op), true, mintedAt);
      }
      stdioToken = createChatInboundTokenStore(authorityDb).issueToken({ value: { label: 'Controlled stdio driver', concurrency_tier: 3,
        chat_mode: null, contract_id: contract.contract_id, grants: { 'recued_ingredient_preapproval-request': true, [`core/${fixtureRecipe.recipe_id}`]: true } }, now: mintedAt }).bearer_plaintext;
    } finally { authorityDb.close(); }
  }

  // ⛔ THE STDIO PROCESS BOOTS BEFORE THE CLOCK, for the same reason the
  //   authority fixture above does: spawning `bin.ts --mcp` under tsx is a full
  //   TypeScript boot whose cost is variable and has nothing to do with the
  //   reviewed decision. Inside the window it was the flake; outside it, it is
  //   setup. What remains in the budget is ONE stdio round-trip.
  const stdio = state === 'stdio' ? await openStdio(dir, stdioToken!) : null;

  // The clock the deadlines are measured from starts HERE.
  const now = Date.now();
  const request: PreparePreapproval = { idempotency_key: 'boot-review',
    subject: { kind: 'recipe', recipe_id: fixtureRecipe.recipe_id, publisher_id: 'core', config: {} },
    activation: { kind: 'one_shot', run_at: now + (execute ? 15_000 : 120_000), time_zone: 'UTC' },
    // ⚠ 10s → 15s on the execute path. The validator requires
    // `decision_deadline <= run_at`, so pulling it up to EQUAL `run_at` is the
    // most headroom available without moving `run_at` — which would cost real
    // wall-clock, because the test then sleeps until that instant.
    decision_deadline: now + (execute ? 15_000 : 90_000), dispatch_deadline: now + DISPATCH_WINDOW_MS };
  let pending: PreapprovalResult;
  if (state === 'stdio') {
    const reply = await stdio!.send(request);
    expect(reply, JSON.stringify(reply)).not.toHaveProperty('error');
    expect(reply, JSON.stringify(reply)).not.toHaveProperty('result.isError', true);
    await stop(stdio!.child);
    const list = await rpc<{ proposals: PreapprovalInspection[] }>(first.socket, 'preapproval.list');
    expect(list.proposals, JSON.stringify(reply)).toHaveLength(1); pending = list.proposals[0]!;
  } else pending = await rpc<PreapprovalResult>(first.socket, 'preapproval.prepare', request);
  expect(pending.coverage).toBe('complete');
  if (execute) {
    const review = await rpc<PreapprovalReview>(first.socket, 'preapproval.review', { proposal_id: pending.proposal_id });
    if (contractId) expect(review.requested_through.contract_id).toBe(contractId);
    // ⛔⛔ NAME THE CAUSE BEFORE THE SYMPTOM. If the work ever creeps back up to
    //   the window, this fails saying so — where `preapproval_expired` reads as
    //   an approval bug and sent a previous session bisecting the wrong commit.
    const consumed = Date.now() - now;
    expect(consumed, `consumed ${String(consumed)}ms of the ${String(execute ? 15_000 : 90_000)}ms review window `
      + '— the fixture is spending the budget again; hoist the slow part above `now` rather than widening it')
      .toBeLessThan((execute ? 15_000 : 90_000) * 0.8);
    await rpc(first.socket, 'preapproval.decide', { proposal_id: pending.proposal_id, expected_revision: review.revision,
      review_digest: review.review_digest, challenge: review.challenge, decision: 'approve', request_id: randomUUID() });
  }
  first.socket.terminate(); await stop(first.child);
  // Reopen after the due instant, inside the approved dispatch window. The
  // real scheduler's immediate boot tick must recover this exact occurrence.
  if (execute) await new Promise(done => setTimeout(done, Math.max(0, now + 15_000 - Date.now())));
  const second = await boot(dir, bearer!);
  // ⛔⛔ NAME THE CAUSE BEFORE THE SYMPTOM — the same guard the review window got,
  //   on the clock that actually broke. Without it a fixture slow enough to eat
  //   the window surfaces as `preapproval_expired`, which reads as an approval
  //   bug and cost a session's investigation before it was measured.
  const spent = Date.now() - now;
  expect(spent, `the reopen spent ${String(spent)}ms of the ${String(DISPATCH_WINDOW_MS)}ms dispatch window `
    + '— the fixture is spending the budget again, and the next symptom is `preapproval_expired`')
    .toBeLessThan(DISPATCH_WINDOW_MS * 0.8);
  const reopened = await rpc<PreapprovalInspection>(second.socket, 'preapproval.get', { proposal_id: pending.proposal_id });
  const observedDb = await openDatabase(join(dir, 'realm.db'));
  let drift: unknown;
  try { drift = observedDb.prepare(`SELECT d.kind,d.key,d.revision AS expected,r.revision AS actual,q.scope,q.segments_json
    FROM preapproval_dependencies d LEFT JOIN preapproval_resource_identity r ON r.kind=d.kind AND r.key=d.key
    LEFT JOIN preapproval_contract_queries q ON q.query_key=d.key WHERE d.future_ref=?
    AND (r.incarnation<>d.incarnation OR r.revision<>d.revision OR r.content_hash<>d.content_hash OR r.present=0)`)
    .all(pending.future_execution_ref); } finally { observedDb.close(); }
  expect(execute ? ['active', 'running', 'succeeded'] : ['prepared'], JSON.stringify({ reason: reopened.status_reason, drift }))
    .toContain(reopened.execution_status);
  if (execute) {
    let result = reopened;
    const until = Date.now() + 45_000;
    while (Date.now() < until && ['active', 'running'].includes(result.execution_status)) {
      await new Promise(done => setTimeout(done, 500));
      result = await rpc<PreapprovalInspection>(second.socket, 'preapproval.get', { proposal_id: pending.proposal_id });
    }
    expect(result.execution_status, JSON.stringify(result)).toBe('succeeded');
    expect(received).toEqual(['/reviewed']);
    expect(result.members.every(member => member.status === 'succeeded' && member.action_ref && member.commit_id)).toBe(true);
    if (contractId) {
      const evidenceDb = await openDatabase(join(dir, 'realm.db'));
      try {
        const committed = JSON.parse((evidenceDb.prepare('SELECT data FROM commits WHERE key=?').get(result.members[0]!.commit_id) as { data: string }).data);
        expect(committed.source).toMatchObject({ channel: 'mcp', actor: 'contracted_user', contract_id: contractId });
      } finally { evidenceDb.close(); }
    }
    return;
  }
  const review = await rpc<PreapprovalReview>(second.socket, 'preapproval.review', { proposal_id: pending.proposal_id });
  expect(review.proposal_id).toBe(pending.proposal_id);
  const receipt = await rpc(second.socket, 'preapproval.decide', { proposal_id: pending.proposal_id, expected_revision: review.revision,
    review_digest: review.review_digest, challenge: review.challenge, decision: 'deny', request_id: randomUUID() });
  expect(receipt).toMatchObject({ decision: 'deny' });
  const final = await rpc<PreapprovalInspection>(second.socket, 'preapproval.get', { proposal_id: pending.proposal_id });
  expect(final.execution_status).toBe('cancelled');
// ⚠ PER-CASE timeout — this SILENTLY OVERRIDES vitest's global 30s
// `testTimeout`, so the global is not what bounds this file. Raised 120s → 300s
// (original), then 300s → 720s in D-269 REV 26 alongside the per-boot timer
// above, so that timer stays the first thing to fire (see the ordering note
// there). Each case performs THREE boots — 3 × 240s — which is why a
// proportional raise of the inner bound alone would have overrun this one.
//
// ⚠ NOT RAISED: the 45s execution-completion poll further up is a
// different clock (waiting for a dispatched op to reach `succeeded`, not
// for startup) and it did not fire. Left alone deliberately rather than
// swept along — if it starts failing it is saying something else.
}, 720_000);
