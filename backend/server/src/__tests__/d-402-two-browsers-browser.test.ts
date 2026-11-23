/** D-402 slice H6 (§8 item 7) — the two-browser task, in two real Chrome profiles with the shipped Bridge,
 *  through `handleExecute` and the server's routing.
 *
 *  In Work, read a value on site A that only a signed-in Work can see; in Home, enter it into a form on site
 *  B. Scored on what site B received, from which browser, and on nothing written in A. Then:
 *  - with Home not connected, and with Home's Bridge too old for the recipe, the run is refused before step
 *    1: no command reaches either browser;
 *  - two accounts on one site, in the two browsers, each keep their own saved password (ruling 3).
 *  (A browser setting changed under "Always" asking again is proved through `handleExecute` and the same
 *  routing in `d-402-browser-check.test.ts`.)
 *
 *  The recipe is a draft as slice H2's compiler writes one for this job: a setting per browser, a collect
 *  that reads the value, and the typing that uses it. */
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BRIDGE_ACTIONS,
  D165_CONTRACT_SCHEMA,
  setRole,
  type BridgeCapabilityProfile,
  type BridgeResult,
  type Checkpoint,
  type Commit,
  type ExecutionSource,
} from '@recued/contracts';
import {
  createAuditLogStore, createCommitStore, createInMemoryCollection, type ActivityEntry, type AuditEntry, type CheckpointStore,
} from '@recued/storage';
import { browserSecrets } from '../bridges/browser-secrets.js';
import { createBridgeDispatcher, createBridgeResultListener } from '../bridges/dispatcher.js';
import { createBridgeRegistry } from '../bridges/registry.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createOpAdmissionGate } from '../op-admission-gate.js';
import { createContractOverlayResolver } from '../policy-contract-overlay.js';
import { createRecipeStore } from '../recipe-store.js';
import { createSessionGrantResolver } from '../session-grant-resolver.js';
import { createBrowserLoginStore } from '../storage/browser-login-store.js';
import { createBrowserPassStore } from '../storage/browser-pass-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createContractScanFn, createContractStore } from '../storage/contract-store.js';
import { createReviewedBrowserFixture } from './d-261-browser-fixture.js';

setRole('server');

const A = 'https://site-a.test';
const B = 'https://site-b.test';
const C = 'https://site-c.test';
const CHAT = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-h6', user_id: 'owner-1', turn_id: 'turn-h6' } as ExecutionSource;
const VALUE = '{{step.act_1.tabs.0.reads.0.collection.records.0.values.value}}';

/** What each site received, by the browser that sent it (its profile cookie). */
const writes: Array<{ site: string; profile: string; value: string }> = [];
type Chrome = Awaited<ReturnType<typeof createReviewedBrowserFixture>>;
const chromes = new Map<'tok-work' | 'tok-home', Chrome>();

const capabilities = (over: Partial<BridgeCapabilityProfile> = {}): BridgeCapabilityProfile => ({ software_version: '0.0.13',
  chrome_version: '140', permissions_granted: ['tabs', 'scripting'], granted_origins: [`${A}/*`, `${B}/*`, `${C}/*`],
  offscreen_supported: true, alarms_supported: true, supported_actions: [...BRIDGE_ACTIONS], row_checks: true, structural_reads: true,
  guarded_links: true, ...over });

/** A site that answers by the profile its cookies name: A shows the order only to a signed-in session; B and
 *  C keep what is sent to them. */
const serve = async (chrome: Chrome) => {
  for (const site of [A, B, C]) {
    await chrome.browser.route(`${site}/**`, async (route) => {
      const request = route.request();
      const cookie = (await request.headerValue('cookie')) ?? '';
      const profile = /profile=(work|home)/u.exec(cookie)?.[1] ?? 'unknown';
      if (request.method() === 'POST') {
        writes.push({ site, profile, value: request.postData() ?? '' });
        await route.fulfill({ status: 200, body: 'Saved' });
        return;
      }
      const page = site === A
        ? (/session=ada/u.test(cookie) ? '<main><h1>Your account</h1><p>Order number <span id="order">4711</span></p></main>'
          : '<main><h1>Please sign in</h1></main>')
        : site === B
          ? '<main><h1>Send a reference</h1><label for="ref">Reference</label><input id="ref"><button id="save">Save</button>'
            + '<p id="result"></p><script>document.querySelector("#save").onclick=async()=>{await fetch("/save",{method:"POST",'
            + 'body:document.querySelector("#ref").value});document.querySelector("#result").textContent="Saved";};</script></main>'
          : '<main><h1>Sign in</h1><label for="password">Password</label><input id="password" name="password" type="password">'
            + '<button id="go">Sign in</button><p id="result"></p><script>document.querySelector("#go").onclick=async()=>{'
            + 'await fetch("/login",{method:"POST",body:document.querySelector("#password").value});'
            + 'document.querySelector("#result").textContent="Signed in";};</script></main>';
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>${site}</title>${page}` });
    });
  }
};

const registry = createBridgeRegistry();
const listener = createBridgeResultListener();
/** Every command the server sent, by the browser it went to. */
const sent: Array<{ to: string; action: string }> = [];
const connect = (token: 'tok-work' | 'tok-home', over: Partial<BridgeCapabilityProfile> = {}) => {
  registry.detach(token);
  registry.attach({ client_token_id: token, client_label: 'Chrome on macOS', session_id: `${token}-session`, online_since: 1,
    last_seen_at: 1, capabilities: capabilities(over) });
};
const dispatcher = createBridgeDispatcher({ registry, listener,
  // The pairing roster: each browser's token, its owner's name, its lasting id.
  pairedBridges: () => [{ bridge_id: 'tok-work', bridge_label: 'Work', browser_id: 'inst-work' },
    { bridge_id: 'tok-home', bridge_label: 'Home', browser_id: 'inst-home' }],
  transport: {
    cancel: async () => ({ ok: true }),
    send: async (id, envelope) => {
      if (envelope.kind !== 'command') throw new Error('Expected a command');
      sent.push({ to: id, action: envelope.command.action });
      const chrome = chromes.get(id as 'tok-work' | 'tok-home');
      if (chrome === undefined) throw new Error(`No browser ${id}`);
      const { result } = await chrome.ordinaryCommand(envelope.command) as { result: BridgeResult };
      if (dispatcher.canResolve(result.command_id, id)) listener.resolveResult(result);
      return { ok: true };
    },
  } });

const passes = createBrowserPassStore(new Database(':memory:'));
/** What a run held, kept so a test that expects no ask can say what asked, rather than failing on a
 *  missing store (no one answers a hold here). */
const held: Checkpoint[] = [];
const checkpointStore = {
  write: async (checkpoint: Checkpoint) => { held.push(checkpoint); },
  get: async (id: string) => held.find((checkpoint) => checkpoint.checkpoint_id === id) ?? null,
  delete: async (id: string) => { const at = held.findIndex((checkpoint) => checkpoint.checkpoint_id === id); if (at >= 0) held.splice(at, 1); },
  listByRun: async (run_id: string) => held.filter((checkpoint) => checkpoint.run_id === run_id),
  list: async () => [...held],
  size: async () => held.length,
} as unknown as CheckpointStore;
const deps = (() => {
  const contractStore = createContractStore(new Database(':memory:'));
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  const definitionStore = createContractDefinitionStore(contractStore);
  const grantEntryStore = createContractGrantEntryStore(contractStore);
  const manifests = createManifestRegistry('/nonexistent');
  for (const manifest of KERNEL_MANIFESTS) manifests.register(manifest);
  return {
    recipeStore: createRecipeStore('/nonexistent'),
    opAdmissionGate: createOpAdmissionGate({ grantEntryStore, definitionStore }),
    contractOverlay: createContractOverlayResolver({ definitionStore, grantEntryStore }),
    contractScan: createContractScanFn(contractStore),
    executorConfig: { manifests, bridgeDispatcherRef: () => dispatcher },
    baseVault: {},
    instanceId: 'd-402-h6',
    auditLog: createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>()),
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    sessionGrantResolver: createSessionGrantResolver({ definitionStore }),
    browserPasses: passes,
    checkpointStore,
    // Before a read-only batch goes without asking, the gate lists the tabs to see that it opens none
    // (`browserBatchReadsOnly`); a listing late or lost makes it ask. A loaded sweep held one about 20 s
    // (2026-11-18: this file's first test took 22.5 s, against 2.7 s in the sweep before and about 1 s
    // alone, and asked). The time the fixture gives Chrome's scheduling under load (`WORKER_READY_MS`)
    // is generous on purpose; this is given the same reason.
    heldBrowserDescribeTimeoutMs: 60_000,
  } as unknown as ExecuteHandlerDeps;
})();
/** "Always allow" on a site, in one browser, as the owner's answer mints it for a recipe that names its browsers. */
const allow = (recipe_id: string, site: string, browser: string) => passes.mint({
  key: { principal: { kind: 'owner_chat' }, recipe: recipe_id, site, browser }, host: new URL(site).host, kind: 'always', now: Date.now() });
const run = (recipe: Record<string, unknown>) => handleExecute(deps, { recipe, config: {}, trigger_source: 'manual',
  execution_source: CHAT } as Parameters<typeof handleExecute>[1]) as Promise<{ success?: boolean; errors?: Array<{ message?: string }> }>;

/** The job: read the order number in Work, where only Work is signed in; type it into site B's form in Home. */
const CARRY = {
  recipe_id: 'carry-the-order-number', version: 1, ttl: 0,
  metadata: { name: 'Carry the order number', description: 'Reads it in Work, sends it from Home.', author: 'you', supported_platforms: [] },
  variables: { browser_1: 'inst-work', browser_2: 'inst-home' },
  steps: [
    { id: 'act_1', op: 'core.dom.act', args: { target: `${A}/*`, bridge_id: '{{config.browser_1}}', steps: [
      { url: `${A}/account`, do: 'collect', items: '#order', fields: { value: { selector: ':scope' } }, max_pages: 1, max_items: 1, max_seconds: 10 }] } },
    { id: 'check_1', guard: `${VALUE} is_empty`, hand_off: true,
      fail_reason: 'What this recipe types was not on site-a.test, where the job read it.' },
    { id: 'act_2', op: 'core.dom.act', args: { target: `${B}/*`, bridge_id: '{{config.browser_2}}', steps: [
      { url: `${B}/form`, do: 'type', selector: '#ref', value: VALUE }, { do: 'click', selector: '#save' }] } },
  ],
  output: { render: [{ type: 'json', source: 'step.act_2', label: 'Done' }] },
};

beforeAll(async () => {
  for (const [token, profile] of [['tok-work', 'work'], ['tok-home', 'home']] as const) {
    const chrome = await createReviewedBrowserFixture('about:blank', { siteGrants: 'chrome', hostPermissions: [`${A}/*`, `${B}/*`, `${C}/*`] });
    chromes.set(token, chrome);
    await serve(chrome);
    await chrome.browser.addCookies([A, B, C].map((site) => ({ name: 'profile', value: profile, domain: new URL(site).host, path: '/' })));
    // Only Work is signed in on site A.
    if (profile === 'work') await chrome.browser.addCookies([{ name: 'session', value: 'ada', domain: new URL(A).host, path: '/' }]);
  }
  connect('tok-work'); connect('tok-home');
}, 240_000);
afterAll(async () => {
  await Promise.all([...chromes.values()].map((chrome) => chrome.close()));
});

describe('D-402 slice H6 — the two-browser task, in two real Chrome profiles', () => {
  it('reads in Work what only Work can see, sends it from Home: site B gets it from Home alone, nothing written in A', async () => {
    writes.length = 0;
    held.length = 0;
    await chromes.get('tok-work')!.reset(`${A}/account`);
    await chromes.get('tok-home')!.reset(`${B}/form`);
    // Once each Bridge has found its page, which a load does not promise (the fixture's `discovered`): a
    // read that finds its tab by address and finds none opens one, which asks, and this run has no hold.
    await chromes.get('tok-work')!.discovered(`${A}/account`);
    await chromes.get('tok-home')!.discovered(`${B}/form`);
    allow(CARRY.recipe_id, B, 'inst-home');
    const done = await run(CARRY);
    // Neither browser's step asks: the read goes without asking, and Home's write under its pass. A run that
    // asked says which step, and why.
    const said = JSON.stringify({ errors: done.errors, awaiting_approval: (done as { awaiting_approval?: unknown }).awaiting_approval,
      held: held.map((checkpoint) => ({ step: checkpoint.gated_step_id, context: checkpoint.preflight_context })) }).slice(0, 2_000);
    expect(done.errors ?? [], said).toEqual([]);
    expect(done.success, said).toBe(true);
    expect(writes).toEqual([{ site: B, profile: 'home', value: '4711' }]);
  }, 180_000);

  it('Home not connected, or its Bridge too old for the recipe: refused before step 1, no command sent to either browser', async () => {
    writes.length = 0;
    registry.detach('tok-home');
    let from = sent.length;
    const offline = await run(CARRY);
    expect(offline.errors).toMatchObject([{ message: '“Home” is not connected: open Chrome with its Browser Bridge. Nothing was done.' }]);
    expect(sent.slice(from)).toEqual([]);
    // Home's Bridge cannot type into a field (an old one): too old for what act_2 asks.
    connect('tok-home', { software_version: '0.0.4', supported_actions: BRIDGE_ACTIONS.filter((action) => action !== 'fill') });
    from = sent.length;
    const old = await run(CARRY);
    expect(old.errors).toMatchObject([{ message: '“Home” has a Browser Bridge too old for this recipe (0.0.4): update it. Nothing was done.' }]);
    expect(sent.slice(from)).toEqual([]);
    expect(writes).toEqual([]);
    connect('tok-home');
  }, 120_000);

  it('ruling 3 — two accounts on one site, in the two browsers, each keep their own saved password', async () => {
    writes.length = 0;
    const logins = createBrowserLoginStore(new Database(':memory:'), { key: () => new Uint8Array(32).fill(4) });
    await browserSecrets.install({ logins, notifier: {
      ask: async () => ({ ask_id: 'never' }), cancelAsk: async () => 'cancelled' as const, listOpenAsks: async () => [],
      registerAskHandler: () => undefined,
    } as never });
    const save = (browser: string, value: string) => logins.save({ browser, origin: C, field: 'name:password', label: 'Password',
      kind: 'password', value, now: Date.now() });
    await save('inst-work', 'work-account-secret');
    await save('inst-home', 'home-account-secret');
    const signIn = {
      recipe_id: 'sign-in-to-c', version: 1, ttl: 0,
      metadata: { name: 'Sign in to C', description: 'Signs in on site C in each browser.', author: 'you', supported_platforms: [] },
      variables: { browser_1: 'inst-work', browser_2: 'inst-home' },
      steps: ['browser_1', 'browser_2'].map((setting, index) => ({ id: `sign_in_${String(index + 1)}`, op: 'core.dom.act',
        args: { target: `${C}/*`, bridge_id: `{{config.${setting}}}`, steps: [
          { url: `${C}/login`, do: 'type', text: 'Password', secret: 'password' }, { do: 'click', selector: '#go' }] } })),
      output: { render: [{ type: 'json', source: 'step.sign_in_2', label: 'Done' }] },
    };
    await chromes.get('tok-work')!.reset(`${C}/login`);
    await chromes.get('tok-home')!.reset(`${C}/login`);
    await chromes.get('tok-work')!.discovered(`${C}/login`);
    await chromes.get('tok-home')!.discovered(`${C}/login`);
    allow(signIn.recipe_id, C, 'inst-work');
    allow(signIn.recipe_id, C, 'inst-home');
    const done = await run(signIn);
    expect(done.errors ?? [], JSON.stringify(done.errors)).toEqual([]);
    expect(writes.sort((a, b) => a.profile.localeCompare(b.profile))).toEqual([
      { site: C, profile: 'home', value: 'home-account-secret' },
      { site: C, profile: 'work', value: 'work-account-secret' },
    ]);
  }, 180_000);
});
