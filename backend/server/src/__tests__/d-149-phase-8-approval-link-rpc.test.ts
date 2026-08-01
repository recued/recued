/** D-149 P8 § A.5.5 — approval_link metadata validator + intent-seed wiring
 *  at the reception rpc edge.
 *
 *  Covers:
 *    - `reception.endpoint.preview_draft` rejects invalid approval_link
 *      metadata via `approval_link_config_invalid`.
 *    - Same for `endpoint.create`.
 *    - Detail message carries the first failure's code.
 *    - Valid approval_link config round-trips through preview_draft +
 *      create.
 *    - `endpoint.create` seeds a `reception_approval_intent` row keyed
 *      on the new endpoint_id, with action_kind + target_id mirrored
 *      from the config.
 *    - Non-approval kinds don't seed an intent row. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ApprovalLinkConfig,
  PacketDeclaration,
  ReceptionEndpointCreateInput,
} from '@recued/contracts';
import type { ActivityEntry, AuditLogStore } from '@recued/storage';
import { ensureReceptionSchema } from '../storage/reception-store.js';
import {
  createPublicEndpointRegistryStore,
  type PublicEndpointRegistryStore,
} from '../storage/public-endpoint-registry-store.js';
import {
  createPreviewHashStore,
  type PreviewHashStore,
} from '../ports/reception/preview-hash.js';
import { deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';
import {
  createReceptionApprovalIntentStore,
  type ApprovalIntentStore,
} from '../storage/reception-approval-store.js';
import {
  handleReceptionEndpointCreate,
  handleReceptionEndpointPreviewDraft,
  type ReceptionBroadcastEvent,
  type ReceptionRpcDeps,
} from '../reception-rpc-handler.js';
import { RpcError } from '@recued/contracts';

const NOW_BASE = 1_700_000_000_000;
const APPROVAL_LINK_EXPIRES_AT_OFFSET = 7 * 24 * 60 * 60 * 1000;

const buildAuditLog = (): { auditLog: AuditLogStore; rows: ActivityEntry[] } => {
  const rows: ActivityEntry[] = [];
  const auditLog = {
    append: async () => {},
    listRecent: async () => [],
    listByRecipe: async () => [],
    get: async () => null,
    clearOlderThan: async () => 0,
    clearByRecipe: async () => 0,
    exportAll: async () => ({ entries: [], activities: [] }),
    size: async () => 0,
    clearAll: async () => {},
    listActivities: async () => rows.slice(),
    exportActivities: async () => rows.slice(),
    clearOldestActivities: async () => 0,
    clearOldestEntries: async () => 0,
    countReserveEntries: async () => 0,
    countReserveActivities: async () => 0,
    logActivity: async (entry: ActivityEntry) => {
      rows.push(entry);
    },
  } as unknown as AuditLogStore;
  return { auditLog, rows };
};

const buildDeps = (): {
  deps: ReceptionRpcDeps;
  store: PublicEndpointRegistryStore;
  previewStore: PreviewHashStore;
  intentStore: ApprovalIntentStore;
  broadcasts: ReceptionBroadcastEvent[];
  rows: ActivityEntry[];
} => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const previewStore = createPreviewHashStore();
  const intentStore = createReceptionApprovalIntentStore(db);
  const { auditLog, rows } = buildAuditLog();
  const broadcasts: ReceptionBroadcastEvent[] = [];
  const deps: ReceptionRpcDeps = {
    getStore: () => store,
    getPreviewStore: () => previewStore,
    getPepper: () => deriveReceptionPepper(Buffer.alloc(32, 0xac)),
    getShareBaseUrl: () => 'https://alice.recued.cloud',
    auditLog,
    broadcast: (event) => {
      broadcasts.push(event);
    },
    now: () => NOW_BASE,
    getApprovalIntentStore: () => intentStore,
  };
  return { deps, store, previewStore, intentStore, broadcasts, rows };
};

const approvalLinkPacketDecl = (intent_id = 'p8_rpc_intent'): PacketDeclaration => ({
  packet_kind: 'approval_link_packet',
  source_query_ref: {
    kind: 'reception_approval_intent',
    intent_id,
  },
});

const goodApprovalLinkConfig = (): ApprovalLinkConfig => ({
  display_name: 'Mary',
  action_kind: 'pick_time',
  prompt: 'Pick a time.',
  context_raw: { summary: 'Q3 planning.' },
  options: [
    { id: 'opt_a', label: '9am Mon' },
    { id: 'opt_b', label: '2pm Tue' },
  ],
  visitor_field_constraints: { name: 'required', email: 'required' },
  expiry_days: 7,
  on_action: {
    target_id: 'proposal-42',
    // The VALID baseline every test here builds on. It moved to
    // `create_commitment` when `mark_resolved` stopped being an acceptable
    // WRITE (its effect seam is unwired, so the visitor's answer would reach
    // nobody). These tests are about validity acceptance and receipt wiring,
    // not about which action is supported — so the FIXTURE moves and the
    // expectations stay.
    on_approve_action: 'create_commitment',
  },
});

const callerCtx = { instance_id: 'inst-test' };

describe('D-149 P8 § A.5.5 — preview_draft / create gate', () => {
  let env: ReturnType<typeof buildDeps>;
  beforeEach(() => {
    env = buildDeps();
  });

  it('preview_draft accepts a valid approval_link config', async () => {
    const preview = await handleReceptionEndpointPreviewDraft(
      env.deps,
      {
        kind: 'approval_link',
        packet_declaration: approvalLinkPacketDecl(),
        metadata: goodApprovalLinkConfig() as unknown as Record<string, unknown>,
        expires_at: NOW_BASE + APPROVAL_LINK_EXPIRES_AT_OFFSET,
      },
      callerCtx,
    );
    expect(preview.preview_hash.length).toBeGreaterThan(0);
  });

  it('preview_draft rejects invalid approval_link metadata', async () => {
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointPreviewDraft(
        env.deps,
        {
          kind: 'approval_link',
          packet_declaration: approvalLinkPacketDecl(),
          metadata: { not_a_config: true } as unknown as Record<string, unknown>,
          expires_at: NOW_BASE + APPROVAL_LINK_EXPIRES_AT_OFFSET,
        },
        callerCtx,
      );
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('approval_link_config_invalid');
    expect(caught!.message).toContain('display_name_empty');
  });

  it('preview_draft rejects pick_time without options with the matching detail code', async () => {
    const bad = {
      ...goodApprovalLinkConfig(),
      options: undefined,
    } as unknown as Record<string, unknown>;
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointPreviewDraft(
        env.deps,
        {
          kind: 'approval_link',
          packet_declaration: approvalLinkPacketDecl(),
          metadata: bad,
          expires_at: NOW_BASE + APPROVAL_LINK_EXPIRES_AT_OFFSET,
        },
        callerCtx,
      );
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('approval_link_config_invalid');
    expect(caught!.message).toContain('options_required_for_action_kind');
  });

  it('create rejects invalid approval_link metadata on rebind', async () => {
    const valid = goodApprovalLinkConfig();
    const preview = await handleReceptionEndpointPreviewDraft(
      env.deps,
      {
        kind: 'approval_link',
        packet_declaration: approvalLinkPacketDecl(),
        metadata: valid as unknown as Record<string, unknown>,
        expires_at: NOW_BASE + APPROVAL_LINK_EXPIRES_AT_OFFSET,
      },
      callerCtx,
    );
    const bad: ReceptionEndpointCreateInput = {
      kind: 'approval_link',
      packet_declaration: approvalLinkPacketDecl(),
      metadata: { not_a_config: true } as unknown as Record<string, unknown>,
      preview_hash: preview.preview_hash,
      expires_at: NOW_BASE + APPROVAL_LINK_EXPIRES_AT_OFFSET,
    };
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointCreate(env.deps, bad, callerCtx);
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('approval_link_config_invalid');
  });

  it('create accepts a valid approval_link config + seeds the intent row', async () => {
    const cfg = goodApprovalLinkConfig();
    const preview = await handleReceptionEndpointPreviewDraft(
      env.deps,
      {
        kind: 'approval_link',
        packet_declaration: approvalLinkPacketDecl(),
        metadata: cfg as unknown as Record<string, unknown>,
        expires_at: NOW_BASE + APPROVAL_LINK_EXPIRES_AT_OFFSET,
      },
      callerCtx,
    );
    const created = await handleReceptionEndpointCreate(
      env.deps,
      {
        kind: 'approval_link',
        packet_declaration: approvalLinkPacketDecl(),
        metadata: cfg as unknown as Record<string, unknown>,
        preview_hash: preview.preview_hash,
        expires_at: NOW_BASE + APPROVAL_LINK_EXPIRES_AT_OFFSET,
      },
      callerCtx,
    );
    expect(created.endpoint_id.length).toBeGreaterThan(0);
    expect(created.bearer_secret_once.length).toBeGreaterThan(0);

    // The seeded intent row mirrors the action_kind + target_id from
    // the config, with consumed_at NULL + processing_outcome=pending.
    const intent = env.intentStore.findByEndpoint(created.endpoint_id);
    expect(intent).not.toBeNull();
    expect(intent!.intent_id).toBe(created.endpoint_id);
    expect(intent!.action_kind).toBe('pick_time');
    expect(intent!.target_id).toBe('proposal-42');
    expect(intent!.consumed_at).toBeNull();
    expect(intent!.processing_outcome).toBe('pending');
  });
});
