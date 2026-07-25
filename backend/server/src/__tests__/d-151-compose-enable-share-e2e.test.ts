/** D-151 — Compose acceptance E2E through the PRODUCTION substrate.
 *
 *  Where `d-151-compose-e2e.test.ts` hand-builds `ReceptionRpcDeps`
 *  (with a stub `getShareBaseUrl`) and stops at create/`enabled:false`,
 *  this drives the whole acquisition headline —
 *  propose → compile → preview → create → enable → share — through
 *  `composeReceptionSubstrate`, the assembly `cmdServe` wires at boot.
 *  So the two closures under test here are the REAL production ones, not
 *  test stubs:
 *
 *   - `getShareBaseUrl` (L2 launch-blocker fix) — reads the configured
 *     public base URL or a verified public hostname registry fallback,
 *     throws `not_configured`/503 when neither is available, and `create`
 *     mints `share_url_once` through it via `requirePublicShareBaseUrl`
 *     + `buildShareUrl`.
 *   - `preflightEnable` (P1) — the server-side `endpoint.enable` gate
 *     that requires a public base URL before flipping an endpoint live.
 *
 *  Only the leaf Compose AI response is stubbed (a deterministic
 *  `ProposedEndpointConfig`, like the sibling e2e); everything from the
 *  share-URL gate down is production code. The `now` seam is pinned for a
 *  deterministic preview-hash TTL — the share-URL path is clock-independent,
 *  so pinning it does not weaken what is under test.
 *
 *  Proves the headline completes (public base URL → reachable, non-localhost
 *  https share URL + a live endpoint) AND that an unconfigured server can no
 *  longer hand a visitor a dead `localhost` link (env unset → getShareBaseUrl
 *  throws + create refuses, nothing persisted).
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COMPOSE_CONTRACT_VERSION,
  CONTACT_FORM_TEMPLATE_SAFETY_MATRIX,
  RpcError,
  compileProposedEndpointConfig,
  isCompileError,
  type EndpointSummary,
  type ProposedEndpointConfig,
  type ReceptionEndpointCreateInput,
  type ReceptionEndpointPreviewInput,
} from '@recued/contracts';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
} from '@recued/storage';
import type { AISynthesizeAdapter } from '@recued/middleware/primitives/index.js';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import {
  createPublicEndpointRegistryStore,
  type PublicEndpointRegistryStore,
} from '../storage/public-endpoint-registry-store.js';
import { createPreviewHashStore } from '../ports/reception/preview-hash.js';
import { createReceptionRegistryCache } from '../ports/reception/registry-cache.js';
import { createReceptionRateLimiter } from '../ports/reception/rate-limiter.js';
import { createEventBus } from '../events/bus.js';
import type { KeyManager } from '../key-manager.js';
import type { BackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import { composeReceptionSubstrate } from '../composition/bin/wire-reception-substrate.js';
import {
  createReceptionComposePrimitiveRegistry,
  handleReceptionComposePropose,
  handleReceptionEndpointCreate,
  handleReceptionEndpointEnable,
  handleReceptionEndpointPreviewDraft,
  type ReceptionRpcDeps,
} from '../reception-rpc-handler.js';

const NOW = Date.UTC(2026, 5, 2, 12, 0, 0);
const CALLER = { instance_id: 'client-A' };
const PUBLIC_BASE_URL = 'https://alice.recued.cloud';
const RECEPTION_SUB_DEK = Buffer.alloc(32, 0xd1);
const LOCAL_SHARE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const CONTACT_FORM_INTENT = 'Create a contact form for project inquiries';

// A valid, non-over-collecting contact-form proposal — the AI leaf
// echoes this verbatim, so propose's internal safety-matrix check + the
// subsequent compile both pass. Mirrors the contact-form fixture in
// `d-151-compose-e2e.test.ts`.
const CONTACT_FORM_PROPOSAL: ProposedEndpointConfig = {
  version: COMPOSE_CONTRACT_VERSION,
  kind: 'intake_form',
  title: 'Contact me',
  description: 'Visitor-facing draft',
  source_template_ref: 'app/recued-core/contact-form',
  source_path: 'template',
  exposure_intent: 'public_anonymous',
  expiry_policy: { mode: 'rolling', rolling_days: 30 },
  form_definition: {
    form_definition_id: 'fd_contact_form',
    submit_button_label: 'Send message',
    success_message: 'Thanks, I will reply soon.',
    fields: [
      {
        name: 'full_name',
        type: 'text',
        label: 'Full name',
        required: true,
        visitor_pii_class: 'visitor_name',
      },
      {
        name: 'email',
        type: 'email',
        label: 'Email',
        required: true,
        visitor_pii_class: 'visitor_email',
      },
      {
        name: 'topic',
        type: 'enum',
        label: 'Topic',
        required: true,
        values: ['question', 'project', 'other'],
      },
      {
        name: 'message',
        type: 'textarea',
        label: 'Message',
        required: true,
      },
    ],
  },
};

// A KeyManager just rich enough for the reception substrate: it only
// calls `keys.keyProvider('reception')()` to source a 32-byte sub-DEK,
// from which the REAL `deriveReceptionPepperFromSubDek` derives the
// bearer-HMAC pepper (no FileVault, no mocks). `null` simulates a locked
// vault.
const fakeKeyManager = (subDek: Uint8Array | null): KeyManager =>
  ({ keyProvider: () => () => subDek }) as unknown as KeyManager;

// No-op registry — the substrate registers a 30s rate-snapshot interval;
// a real `setInterval` would leak past the test, so swallow it.
const noopBackgroundServices: BackgroundServiceRegistry = {
  register: () => {},
  registerInterval: () => () => {},
  stopAll: async () => {},
  list: () => [],
};

const buildSubstrate = async (
  subDek: Uint8Array | null = RECEPTION_SUB_DEK,
): Promise<{
  readonly rpcDeps: ReceptionRpcDeps;
  readonly store: PublicEndpointRegistryStore;
}> => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const auditLog = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );

  // Reads `RECUED_PUBLIC_BASE_URL` HERE (compose time) and has no hostname
  // registry fallback in this harness — callers set the env before invoking.
  // LLM deps are undefined → the assembly omits its own `composePropose`; the
  // deterministic one is layered on below so the share-URL gate / preflight /
  // pepper closures stay production.
  const bundle = await composeReceptionSubstrate({
    publicEndpointRegistryStore: store,
    receptionRegistryCache: createReceptionRegistryCache(),
    receptionRateLimiter: createReceptionRateLimiter({ db }),
    previewHashStore: createPreviewHashStore(),
    auditLog,
    keys: fakeKeyManager(subDek),
    eventBus: createEventBus(),
    dbPath: '/tmp/recued/d-151-acceptance-e2e/server.db',
    backgroundServices: noopBackgroundServices,
    executeRecuedRequestPersist: undefined,
    llmConfig: undefined,
    llmQuota: undefined,
    llmAdapterRegistry: undefined,
    emptyTabProbe: undefined,
    approvalIntentStore: undefined,
    statusProjectionStore: undefined,
    ipBlockStore: undefined,
    schedulingFormNonceStore: undefined,
    intakeFormSubmissionStore: undefined,
    intakeFormNonceStore: undefined,
    dropBlobStore: undefined,
    blobStore: undefined,
    dropLinkNonceStore: undefined,
    approvalLinkNonceStore: undefined,
  });
  if (!bundle) throw new Error('expected a reception substrate bundle');

  let callId = 0;
  const aiAdapter: AISynthesizeAdapter = {
    synthesize: async () => ({
      response: JSON.stringify(CONTACT_FORM_PROPOSAL),
      events: [],
      provider: 'openai',
      model_id: 'gpt-deterministic-test',
      total_tokens: 1,
    }),
  };
  const rpcDeps: ReceptionRpcDeps = {
    ...bundle.receptionRpcDeps,
    // Pin the clock for a deterministic preview-hash TTL window. The
    // production assembly wires `() => Date.now()`; the share-URL path is
    // clock-independent, so this only stabilises preview/expiry math.
    now: () => NOW,
    composePropose: {
      registry: createReceptionComposePrimitiveRegistry(aiAdapter),
      now: () => NOW,
      mintRequestId: () => 'compose:req-e2e',
      mintId: () => `compose-call-${++callId}`,
    },
  };
  return { rpcDeps, store };
};

const previewInputFromCompiled = (
  compiled: ReceptionEndpointCreateInput,
): ReceptionEndpointPreviewInput => {
  if (compiled.expires_at === null) {
    throw new Error('D-151 contact-form fixture should compile to a bounded preview input');
  }
  return {
    kind: compiled.kind,
    packet_declaration: compiled.packet_declaration,
    ...(compiled.expires_at !== undefined ? { expires_at: compiled.expires_at } : {}),
    ...(compiled.metadata !== undefined ? { metadata: compiled.metadata } : {}),
  };
};

const proposeCompilePreview = async (
  deps: ReceptionRpcDeps,
): Promise<{
  readonly compiled: ReceptionEndpointCreateInput;
  readonly preview_hash: string;
}> => {
  const proposed = await handleReceptionComposePropose(
    deps,
    { intent_text: CONTACT_FORM_INTENT },
    CALLER,
  );
  expect(proposed.source_template_ref).toBe('app/recued-core/contact-form');

  const compiled = compileProposedEndpointConfig(
    proposed,
    CONTACT_FORM_TEMPLATE_SAFETY_MATRIX,
    { now: NOW },
  );
  expect(isCompileError(compiled)).toBe(false);
  if (isCompileError(compiled)) {
    throw new Error(`expected create input, got compile error ${compiled.kind}`);
  }
  expect(compiled.kind).toBe('intake_form');

  const preview = await handleReceptionEndpointPreviewDraft(
    deps,
    previewInputFromCompiled(compiled),
    CALLER,
  );
  expect(preview.preview_hash.length).toBeGreaterThan(0);
  return { compiled, preview_hash: preview.preview_hash };
};

const captureThrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected function to throw');
};

const originalPublicBaseUrl = process.env.RECUED_PUBLIC_BASE_URL;

beforeEach(() => {
  delete process.env.RECUED_PUBLIC_BASE_URL;
});

afterEach(() => {
  if (originalPublicBaseUrl === undefined) {
    delete process.env.RECUED_PUBLIC_BASE_URL;
  } else {
    process.env.RECUED_PUBLIC_BASE_URL = originalPublicBaseUrl;
  }
});

describe('D-151 — Compose acceptance E2E (production reception substrate)', () => {
  it('completes propose→compile→preview→create→enable→share with a public base URL', async () => {
    process.env.RECUED_PUBLIC_BASE_URL = PUBLIC_BASE_URL;
    const { rpcDeps, store } = await buildSubstrate();

    const { compiled, preview_hash } = await proposeCompilePreview(rpcDeps);

    // create — mints `share_url_once` through the production
    // `requirePublicShareBaseUrl` → `getShareBaseUrl` → `buildShareUrl`.
    const created = await handleReceptionEndpointCreate(
      rpcDeps,
      { ...compiled, preview_hash },
      CALLER,
    );
    expect(created.enabled).toBe(false);

    // The share link is reachable, https, and NOT localhost — derived
    // straight from RECUED_PUBLIC_BASE_URL (the L2 fix's whole point).
    const shareUrl = new URL(created.share_url_once);
    expect(shareUrl.protocol).toBe('https:');
    expect(shareUrl.hostname).toBe('alice.recued.cloud');
    expect(LOCAL_SHARE_HOSTS.has(shareUrl.hostname.toLowerCase())).toBe(false);
    expect(created.share_url_once.startsWith(`${PUBLIC_BASE_URL}/reception/intake/`)).toBe(true);
    expect(created.share_url_once).toContain(
      `/reception/intake/${encodeURIComponent(created.endpoint_id)}`,
    );

    // enable — the server-side preflight passes because the base URL is
    // public, and the endpoint goes live (persisted enabled).
    const enabled = await handleReceptionEndpointEnable(
      rpcDeps,
      { endpoint_id: created.endpoint_id },
      CALLER,
    );
    expect(enabled).toEqual({ ok: true });
    expect(store.findById(created.endpoint_id)?.enabled).toBe(true);
  });

  it('refuses to mint a dead localhost share when RECUED_PUBLIC_BASE_URL is unset', async () => {
    // beforeEach already cleared the env; build the substrate against it.
    const { rpcDeps, store } = await buildSubstrate();

    // getShareBaseUrl throws directly — the explicit L2 assertion.
    const thrown = captureThrown(() => rpcDeps.getShareBaseUrl());
    expect(thrown).toBeInstanceOf(RpcError);
    expect(thrown).toMatchObject({ code: 'not_configured', status: 503 });

    // preflight_enable refuses too, so a future enable can't go live.
    expect(
      rpcDeps.preflightEnable?.({
        endpoint: { endpoint_id: 'ep-unconfigured' } as unknown as EndpointSummary,
        now: NOW,
      }),
    ).toMatchObject({ ok: false });

    // End-to-end: propose + compile + preview all succeed (none need the
    // share base), but create refuses — no endpoint, no dead link.
    const { compiled, preview_hash } = await proposeCompilePreview(rpcDeps);
    await expect(
      handleReceptionEndpointCreate(rpcDeps, { ...compiled, preview_hash }, CALLER),
    ).rejects.toMatchObject({ code: 'not_configured', status: 503 });

    expect(store.list()).toHaveLength(0);
  });
});
