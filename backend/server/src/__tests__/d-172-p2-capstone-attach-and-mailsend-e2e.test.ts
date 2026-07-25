/** D-172 P2 — REAL-FUNNEL CAPSTONE (attach + gated mail-send, one file, no workarounds).
 *
 *  The non-negotiable end-to-end test (the D-173 lesson): compose EVERY P2 lane
 *  through its PRODUCTION entry point on ONE real ingested file, with no
 *  per-seam stand-ins. The isolated lane tests each leave the cross-seam
 *  integration untested:
 *    - the gate test (`d-172-p2-mail-send-file-read-gate`) drives the real
 *      `handleExecute` gate but STUBS the mail-send dispatcher;
 *    - the resolve test (`d-172-p2-mail-collection-attachments`) drives the real
 *      `MailCollection.send` byte resolution but calls it DIRECTLY (no gate).
 *  This capstone wires them together: `handleExecute` → the F2 Commit-Gateway
 *  admission → the REAL kernel `mail-send` dispatcher → the REAL
 *  `MailCollection.send` → the REAL `handleFileRead` (audited byte egress) →
 *  the provider. The only stand-in is the SMTP provider itself (the genuine
 *  external edge — it captures what it was handed).
 *
 *  Three funnels on one ingested file:
 *    A — Lane A: `attachFile` to a contact (canonical dotted email) surfaces
 *        BOTH directions via the real annotation store, then recipe-mode inline
 *        refs resolve those attachment links through `handleExecute`.
 *    B-happy — Lane B + F2 gate: a `mail-send` recipe carrying the file ref,
 *        under a contract granting BOTH `mail-send` and `data-file-read`, flows
 *        all the way to the provider with the file's REAL bytes + a
 *        `file_content_read` audit row (I-4).
 *    B-denied — the same send under a contract DENIED `data-file-read` is
 *        refused at the gate: the provider is never reached and NO file bytes
 *        egress (the F2 security boundary, end-to-end through the real funnel).
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import {
  type Commit,
  type ContractSnapshot,
  type ExecutionSource,
  type IngredientManifest,
  type Link,
  type RecipeDefinition,
  type RecipeError,
} from '@recued/contracts';
import {
  createCommitStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditLogStore,
} from '@recued/storage';
import type { KernelDispatchers } from '@recued/ingredients';

import { createBlobStore, type BlobStore } from '../storage/blob-store.js';
import {
  createAnnotationStore,
  type AnnotationStore,
} from '../storage/annotation-store.js';
import type { AnnotationRpcDeps } from '../annotation-handler.js';
import { createInboundFileCollection } from '../collections/file/inbound-file-collection.js';
import { attachFile } from '../collections/file/attach-file.js';
import {
  createMailCollection,
  type MailCollectionConfig,
} from '../collections/mail/mail-collection.js';
import type {
  MailProvider,
  OutgoingMessage,
  ProviderHealth,
  SentMessageMeta,
} from '../collections/mail/provider.js';
import { createCollectionRegistry } from '../collections/registry.js';
import type { FileReadDeps } from '../collections/file/file-read-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';

const BIG_QUOTA = 100 * 1024 * 1024;

// An MCP / contracted-user source — the realistic untrusted threat surface
// (an agent driving recipes under a contract). The gate evaluates the
// contract's `allowed_tools` per dispatch.
const mcpSource: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent-1',
  tool_call_id: 'tool-call-1',
  mcp_token_id: 'mcp-token-1',
  contract_id: 'contract-1',
};

// D-187 slice 4 / D-209 #1 W3 — the unattended WEBHOOK-DOOR source: `anonymous`
// (the outbound-send review lift stays exempt — it fires only for `user_self`)
// carrying the recipe's stamped door contract. The door's AUTHORED `admin` ceiling
// (`max_risk_without_approval` on its snapshot, §1.4 — a door the owner wired on
// BOTH sides admits its granted ops) is the posture under which a `mail-send`
// WRITE completes without surfacing, so the HAPPY byte-path funnel can prove the
// send reaches the provider. (A `schedule`/`reactive` source FAILS CLOSED to the
// `read` ceiling and would HOLD the write — owner automation earns silence via
// the D-177 learner, not by default.)
const webhookSource: ExecutionSource = {
  channel: 'webhook',
  actor: 'anonymous',
  vendor: 'capstone-vendor',
  webhook_secret_id: 'whsec-capstone-1',
  contract_id: 'door-capstone-1',
};

// The webhook door's snapshot, as the W3 runner resolves it per fire
// (`buildWebhookContractSnapshot`): the recipe's derived tool closure + the
// minted `admin` ceiling.
const webhookDoorSnapshot = (): ContractSnapshot => ({
  contract_id: 'door-capstone-1',
  contract_version: '1',
  allowed_tools: ['mail-send', 'data-file-read'],
  approval_required: [],
  scope_restrictions: [],
  resolved_at: 1_700_000_000_000,
  max_risk_without_approval: 'admin',
});

const buildSnapshot = (allowed_tools: readonly string[]): ContractSnapshot => ({
  contract_id: 'contract-1',
  contract_version: '1',
  allowed_tools,
  approval_required: [],
  scope_restrictions: [],
  resolved_at: 1_700_000_000_000,
});

const mailSendManifest = {
  slug: 'mail-send',
  name: 'mail-send',
  description: 'capstone mail-send manifest',
  author: 'recued',
  kind: 'storage',
  risk_tier: 'write',
  version: 1,
  category: 'action',
  input: {},
  output: { message_id: 'message_id' },
} as unknown as IngredientManifest;

const dataFileReadManifest = {
  slug: 'data-file-read',
  name: 'data-file-read',
  description: 'capstone data-file-read manifest',
  author: 'recued',
  kind: 'storage',
  risk_tier: 'read',
  version: 1,
  category: 'data',
  input: { record_id: null },
  output: { bytes_b64: 'bytes_b64' },
} as unknown as IngredientManifest;

const mailSendRecipe = (attachments: string[]): RecipeDefinition => ({
  recipe_id: 'd-172-p2-capstone-send',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'capstone mail-send with attachment',
    description: 'sends an ingested data.file as a mail attachment through the gate',
    author: 'test',
    supported_platforms: ['test'],
    tags: ['test', 'd-172', 'capstone'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'send',
      ingredient: 'mail-send',
      input: {
        sender_mail_instance: 'work',
        to: ['bob@example.com'],
        subject: 'your signed contract',
        body: 'attached',
        attachments,
      },
    },
  ],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

const inlineAttachmentLinksRecipe = (
  email: string,
  fileId: string,
): RecipeDefinition => ({
  recipe_id: 'd-172-p2-followup-inline-attachment-links',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'inline attachment link surfacing',
    description: 'surfaces attachment links through recipe-mode data refs',
    author: 'test',
    supported_platforms: ['test'],
    tags: ['test', 'd-172', 'p2-followup'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'contact_attachment_links',
      transform: 'coalesce',
      values: [`{{data.contact.${email}.links.attachment}}`],
    },
    {
      id: 'file_attachment_owners',
      transform: 'coalesce',
      values: [`{{data.file.${fileId}.inbound_links.attachment}}`],
    },
  ],
  output: {
    sidebar: [
      {
        type: 'summary',
        label: 'contact_attachment_links',
        source: 'step.contact_attachment_links',
      },
      {
        type: 'summary',
        label: 'file_attachment_owners',
        source: 'step.file_attachment_owners',
      },
    ],
  },
} as unknown as RecipeDefinition);

interface StubHandle {
  provider: MailProvider;
  sendCalls: OutgoingMessage[];
}

const makeStubProvider = (): StubHandle => {
  const sendCalls: OutgoingMessage[] = [];
  const provider: MailProvider = {
    kind: 'imap',
    slug: 'work',
    sendCapable: true,
    accountEmail: 'alice@example.com',
    async connect() {},
    async initialScan() {},
    async startSync() { return async () => {}; },
    async close() {},
    health(): ProviderHealth {
      return { last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0 };
    },
    async send(msg: OutgoingMessage): Promise<SentMessageMeta> {
      sendCalls.push(msg);
      return {
        source_id: 'srcid-1',
        message_id: '<msgid-1@example.com>',
        sent_at: 1_700_000_000_000,
        thread_id: 'thread-1',
      };
    },
  };
  return { provider, sendCalls };
};

interface Harness {
  dir: string;
  db: Database.Database;
  blobs: BlobStore;
  store: AnnotationStore;
  stub: StubHandle;
  auditRows: ActivityEntry[];
  deps: ExecuteHandlerDeps;
  attachDeps: { annotationDeps: AnnotationRpcDeps; registry: ReturnType<typeof createCollectionRegistry> };
  ingestFile(bytes: Buffer, filename: string, mime: string, sourceId: string): Promise<string>;
  send(
    recipe: RecipeDefinition,
    snapshot?: ContractSnapshot,
    source?: ExecutionSource,
  ): ReturnType<typeof handleExecute>;
  close(): void;
}

const makeHarness = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), 'd172-capstone-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'test.db'));
  db.pragma('journal_mode = WAL');
  const blobs = createBlobStore(join(dataDir, 'blobs'));
  const bus = createWarehouseEventBus();
  const auditRows: ActivityEntry[] = [];
  const auditLog = {
    async logActivity(entry: ActivityEntry) { auditRows.push(entry); },
  } as unknown as AuditLogStore;

  // Real annotation store (Lane A) + real registry + real CAS-backed file
  // collection (P1), all on one db.
  let linkCounter = 0;
  const store = createAnnotationStore({
    db,
    blobs,
    now: () => 1_000_000 + ++linkCounter,
    newId: () => `link-${linkCounter}`,
  });
  const registry = createCollectionRegistry();
  const fileColl = createInboundFileCollection({
    db,
    blobs,
    gate: createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:file:received' }),
    bus,
    slug: 'received',
    auditLog,
    now: () => 1_000,
  });
  registry.register(fileColl);

  // Real MailCollection (Lane B) with the file-read deps wired (the lazy getter
  // the boot composer uses) + a stub provider that captures the outgoing message.
  const stub = makeStubProvider();
  const config: MailCollectionConfig = { backfill_days: 30, retention_days: 365, quota_bytes: BIG_QUOTA };
  const fileReadDeps = (): FileReadDeps => ({ registry, blobs, auditLog });
  const mailColl = createMailCollection({
    db,
    blobs,
    gate: createStorageGate({ quota: BIG_QUOTA, reservePct: 10, surface: 'collection:mail:work' }),
    bus,
    slug: 'work',
    provider: stub.provider,
    config: () => config,
    auditLog,
    fileReadDeps,
  });
  registry.register(mailColl);

  // Wire the REAL kernel `mail-send` dispatcher → the REAL MailCollection.send.
  // This is the production seam the gate test stubbed: handleExecute's engine
  // dispatches the `mail-send` kernel ingredient through this, so an attachment
  // ref flows through the real byte resolution + the real provider.
  const kernelDispatchers = {
    mailSend: async (input: {
      instance: string;
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      in_reply_to?: string;
      references?: string[];
      reply_to?: string;
      attachments?: string[];
      recipe_id?: string;
      step_id?: string;
    }) => {
      const result = await mailColl.send({
        to: input.to,
        subject: input.subject,
        body_text: input.body,
        ...(input.cc ? { cc: input.cc } : {}),
        ...(input.bcc ? { bcc: input.bcc } : {}),
        ...(input.in_reply_to ? { in_reply_to: input.in_reply_to } : {}),
        ...(input.references ? { references: input.references } : {}),
        ...(input.reply_to ? { reply_to: input.reply_to } : {}),
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.recipe_id ? { recipe_id: input.recipe_id } : {}),
        ...(input.step_id ? { step_id: input.step_id } : {}),
      });
      return {
        source_id: result.source_id,
        message_id: result.message_id,
        sent_at: result.sent_at,
        ...(result.thread_id ? { thread_id: result.thread_id } : {}),
        _id: null,
        _collection: 'data.mail' as const,
      };
    },
  } as unknown as KernelDispatchers;

  const manifests = createManifestRegistry('/nonexistent');
  manifests.register(mailSendManifest);
  manifests.register(dataFileReadManifest);
  const recipeStore = createRecipeStore('/nonexistent');
  const commitStore = createCommitStore(createInMemoryCollection<Commit>());

  const deps: ExecuteHandlerDeps = {
    recipeStore,
    executorConfig: { manifests, kernelDispatchers },
    baseVault: {},
    instanceId: 'server-capstone',
    commitStore,
    cacheBlobs: blobs,
    annotationStore: store,
  } as unknown as ExecuteHandlerDeps;

  return {
    dir, db, blobs, store, stub, auditRows, deps,
    attachDeps: { annotationDeps: { store } as AnnotationRpcDeps, registry },
    async ingestFile(bytes, filename, mime, sourceId) {
      const rec = await fileColl.ingest({
        bytes, filename, mime_type: mime, origin: 'mail_attachment', source_id: sourceId, scan_status: 'clean',
      });
      return rec.record_id;
    },
    // D-187 slice 4 / D-209 #1 W3 — `source` defaults to the mcp door (the access-gate
    // threat surface for the DENIED funnel). The HAPPY funnel passes `webhookSource` +
    // its door snapshot: a `mail-send` WRITE SURFACES (holds) on every LOW-ceiling
    // contracted source AND on attended user_self (the outbound-send lift), so the
    // byte-path proof — the send completing to the provider — runs on the one source
    // whose posture admits it: an anonymous webhook DOOR whose authored `admin` ceiling
    // (two-sided enrollment IS the standing approval) relaxes the write, with the lift
    // staying user_self-scoped. A `schedule`/`reactive` source fails closed to `read`
    // and would hold.
    send(recipe, snapshot, source: ExecutionSource = mcpSource) {
      recipeStore.register(recipe);
      return handleExecute(deps, {
        recipe_id: recipe.recipe_id,
        trigger_source: source.channel === 'mcp' ? 'mcp' : 'schedule',
        execution_source: source,
        ...(snapshot !== undefined ? { contract_snapshot: snapshot } : {}),
      });
    },
    close() {
      void mailColl.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

let refs: Harness[] = [];
const withHarness = (): Harness => { const h = makeHarness(); refs.push(h); return h; };
afterEach(() => {
  for (const h of refs) { try { h.close(); } catch { /* swallow */ } }
  refs = [];
});

const firstError = (errors: readonly unknown[]): RecipeError => errors[0] as RecipeError;
const fileReadAuditRows = (rows: ActivityEntry[]): ActivityEntry[] =>
  rows.filter((r) => r.action === 'file_content_read');
const sidebarData = (
  result: Awaited<ReturnType<typeof handleExecute>>,
  label: string,
): unknown => result.output.sidebar.find((section) => section.label === label)?.data;

describe('D-172 P2 CAPSTONE — one file: attach (Lane A) + gated mail-send (Lane B + F2)', () => {
  it('FUNNEL A — attaches an ingested file to a contact and surfaces BOTH directions (store-level)', async () => {
    const h = withHarness();
    const email = 'jane.doe@example.com'; // canonical contact id IS a dotted email
    const fileId = await h.ingestFile(Buffer.from('%PDF-1.4 signed'), 'contract.pdf', 'application/pdf', 'drop-1');

    const { link, already_attached } = await attachFile(
      { file_id: fileId, to_collection: 'contact', to_id: email },
      h.attachDeps,
    );
    expect(already_attached).toBe(false);
    expect(link.role).toBe('attachment');

    // Direction (N.3): from = entity, to = file. Surfaces both ways through the
    // real annotation store — the path the P3 drop-processor + the UI use, and
    // it works for a dotted email (the canonical contact key).
    const fromContact = await h.store.outboundLinks('contact', email);
    expect(fromContact.some((l) => l.role === 'attachment' && l.to_collection === 'file' && l.to_id === fileId)).toBe(true);
    const ontoFile = await h.store.inboundLinks('file', fileId);
    expect(ontoFile.some((l) => l.role === 'attachment' && l.from_collection === 'contact' && l.from_id === email)).toBe(true);

    // Idempotent re-attach — no duplicate edge (the link table has no UNIQUE).
    const again = await attachFile({ file_id: fileId, to_collection: 'contact', to_id: email }, h.attachDeps);
    expect(again.already_attached).toBe(true);
    expect((await h.store.outboundLinks('contact', email)).filter((l) => l.role === 'attachment').length).toBe(1);
  });

  it('FUNNEL A2 — recipe inline refs resolve attachment links for a dotted contact email and file owner side', async () => {
    const h = withHarness();
    const email = 'jane.doe@example.com'; // fails the old segments[1] parser
    const fileId = await h.ingestFile(Buffer.from('%PDF-1.4 signed'), 'contract.pdf', 'application/pdf', 'drop-1');

    await attachFile(
      { file_id: fileId, to_collection: 'contact', to_id: email },
      h.attachDeps,
    );

    const result = await handleExecute(h.deps, {
      recipe: inlineAttachmentLinksRecipe(email, fileId),
    });

    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    const contactLinks = sidebarData(result, 'contact_attachment_links') as Link[];
    expect(contactLinks).toHaveLength(1);
    expect(contactLinks[0]).toMatchObject({
      from_collection: 'contact',
      from_id: email,
      to_collection: 'file',
      to_id: fileId,
      role: 'attachment',
    });
    const fileOwners = sidebarData(result, 'file_attachment_owners') as Link[];
    expect(fileOwners).toHaveLength(1);
    expect(fileOwners[0]).toMatchObject({
      from_collection: 'contact',
      from_id: email,
      to_collection: 'file',
      to_id: fileId,
      role: 'attachment',
    });
  });

  it('FUNNEL B (happy) — the SAME file sends as a mail attachment THROUGH THE GATE; the provider gets the real bytes', async () => {
    const h = withHarness();
    const bytes = Buffer.from('%PDF-1.4 the actual signed contract bytes');
    const fileId = await h.ingestFile(bytes, 'contract.pdf', 'application/pdf', 'drop-1');

    // D-187 slice 4 / D-209 #1 W3 — sent on the anonymous WEBHOOK-DOOR source (its
    // authored `admin` ceiling admits the write; the outbound-send lift stays
    // user_self-scoped) so the byte path is exercised end-to-end: handleExecute →
    // real kernel mail-send dispatcher → real MailCollection.send → real
    // handleFileRead (the data-file-read read admits, never-class) → the stub
    // provider. (The mcp door's access-gate threat is the DENIED funnel below.)
    const result = await h.send(
      mailSendRecipe([fileId]),
      webhookDoorSnapshot(),
      webhookSource,
    );

    expect(result.success).toBe(true);
    // The provider received the attachment carrying the file's REAL bytes,
    // round-tripped from the warehouse CAS through the gated read.
    expect(h.stub.sendCalls).toHaveLength(1);
    const sent = h.stub.sendCalls[0];
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments?.[0]).toMatchObject({ filename: 'contract.pdf', mime_type: 'application/pdf', size_bytes: bytes.length });
    expect(Buffer.from(sent.attachments![0].bytes_b64, 'base64').equals(bytes)).toBe(true);
    // I-4 — the content read was audited (the one byte-egress path).
    expect(fileReadAuditRows(h.auditRows).length).toBeGreaterThanOrEqual(1);
  });

  it('FUNNEL B (denied) — the SAME send with data-file-read DENIED is refused at the gate; provider never reached, NO bytes egress', async () => {
    const h = withHarness();
    const bytes = Buffer.from('%PDF-1.4 the actual signed contract bytes');
    const fileId = await h.ingestFile(bytes, 'contract.pdf', 'application/pdf', 'drop-1');

    // Same funnel, but the contract grants mail-send and NOT data-file-read —
    // the F2 secondary gate refuses the dispatch before the inner send runs.
    const result = await h.send(mailSendRecipe([fileId]), buildSnapshot(['mail-send']));

    expect(result.success).toBe(false);
    const err = firstError(result.errors);
    expect(err.message).toContain('Gateway refused dispatch');
    expect(err.message).toContain('data-file-read');
    // Fail-closed end-to-end: the real provider was NEVER reached AND no file
    // content was read out of the warehouse (no egress).
    expect(h.stub.sendCalls).toHaveLength(0);
    expect(fileReadAuditRows(h.auditRows)).toHaveLength(0);
  });
});
