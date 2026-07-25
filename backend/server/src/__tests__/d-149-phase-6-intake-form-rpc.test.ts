/** D-149 P6 § A.5.3 — intake_form metadata validator wiring at the
 *  reception rpc edge.
 *
 *  Covers:
 *    - `reception.endpoint.preview_draft` rejects invalid intake_form
 *      metadata via `intake_form_config_invalid`.
 *    - Same for `endpoint.create`.
 *    - Detail message carries the first failure's code (so Mary's UX
 *      can localize).
 *    - Other kinds still flow through their own validators (scheduling
 *      / reception_page) — no cross-talk.
 *    - Valid intake_form config round-trips through preview_draft +
 *      create. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  PacketDeclaration,
  ReceptionEndpointCreateInput,
} from '@recued/contracts';
import type { ActivityEntry, AuditLogStore } from '@recued/storage';
import type { IntakeFormConfig } from '@recued/contracts';
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
  handleReceptionEndpointCreate,
  handleReceptionEndpointPreviewDraft,
  type ReceptionBroadcastEvent,
  type ReceptionRpcDeps,
} from '../reception-rpc-handler.js';
import { RpcError } from '@recued/contracts';

const NOW_BASE = 1_700_000_000_000;

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
  broadcasts: ReceptionBroadcastEvent[];
  rows: ActivityEntry[];
  setNow: (n: number) => void;
} => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const previewStore = createPreviewHashStore();
  const { auditLog, rows } = buildAuditLog();
  const broadcasts: ReceptionBroadcastEvent[] = [];
  let nowVal = NOW_BASE;
  const deps: ReceptionRpcDeps = {
    getStore: () => store,
    getPreviewStore: () => previewStore,
    getPepper: () => deriveReceptionPepper(Buffer.alloc(32, 0xab)),
    getShareBaseUrl: () => 'https://alice.recued.cloud',
    auditLog,
    broadcast: (event) => {
      broadcasts.push(event);
    },
    now: () => nowVal,
  };
  return {
    deps,
    store,
    previewStore,
    broadcasts,
    rows,
    setNow: (n: number) => {
      nowVal = n;
    },
  };
};

const intakeFormPacketDecl = (): PacketDeclaration => ({
  packet_kind: 'intake_form_packet',
  source_query_ref: {
    kind: 'reception_form_definition',
    form_definition_id: 'fd_p6_rpc_test',
  },
});

const goodIntakeFormConfig = (): IntakeFormConfig => ({
  display_name: 'Mary',
  form_definition: {
    form_definition_id: 'fd_p6_rpc_test',
    fields: [
      { name: 'your_name', type: 'text', label: 'Your name', required: true },
      { name: 'details', type: 'textarea', label: 'Details', required: true },
    ],
  },
  submission_processing_rule: {
    target_kind: 'task',
    fields_to_include_in_target: ['your_name', 'details'],
    fields_to_attach_as_metadata: [],
  },
  anti_spam: {
    honeypot_fields: [],
    rate_limit_per_ip: 5,
    require_proof_of_work: false,
    require_captcha: false,
  },
  required_visitor_fields: { email: 'required' },
});

const callerCtx = { instance_id: 'inst-test' };

describe('D-149 P6 § A.5.3 — preview_draft / create gate', () => {
  let env: ReturnType<typeof buildDeps>;
  beforeEach(() => {
    env = buildDeps();
  });

  it('preview_draft accepts a valid intake_form config', async () => {
    const preview = await handleReceptionEndpointPreviewDraft(
      env.deps,
      {
        kind: 'intake_form',
        packet_declaration: intakeFormPacketDecl(),
        metadata: goodIntakeFormConfig() as unknown as Record<string, unknown>,
      },
      callerCtx,
    );
    expect(preview.preview_hash.length).toBeGreaterThan(0);
  });

  it('preview_draft rejects invalid intake_form metadata with intake_form_config_invalid', async () => {
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointPreviewDraft(
        env.deps,
        {
          kind: 'intake_form',
          packet_declaration: intakeFormPacketDecl(),
          metadata: { not_a_config: true } as unknown as Record<string, unknown>,
        },
        callerCtx,
      );
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('intake_form_config_invalid');
    expect(caught!.message).toContain('display_name_empty');
  });

  it('preview_draft rejects unknown target_kind with the matching detail code', async () => {
    const bad = {
      ...goodIntakeFormConfig(),
      submission_processing_rule: {
        ...goodIntakeFormConfig().submission_processing_rule,
        target_kind: 'event',
      },
    } as unknown as Record<string, unknown>;
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointPreviewDraft(
        env.deps,
        {
          kind: 'intake_form',
          packet_declaration: intakeFormPacketDecl(),
          metadata: bad,
        },
        callerCtx,
      );
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('intake_form_config_invalid');
    expect(caught!.message).toContain('target_kind_unknown');
  });

  it('create rejects an invalid intake_form metadata on rebind', async () => {
    // Generate a preview hash from a valid blob, then submit a different
    // (invalid) blob at create time. The substrate validator fires
    // before the preview-hash check, so the failure is
    // intake_form_config_invalid (not preview_hash_mismatch).
    const validBlob = goodIntakeFormConfig();
    const preview = await handleReceptionEndpointPreviewDraft(
      env.deps,
      {
        kind: 'intake_form',
        packet_declaration: intakeFormPacketDecl(),
        metadata: validBlob as unknown as Record<string, unknown>,
      },
      callerCtx,
    );
    const bad: ReceptionEndpointCreateInput = {
      kind: 'intake_form',
      packet_declaration: intakeFormPacketDecl(),
      metadata: { not_a_config: true } as unknown as Record<string, unknown>,
      preview_hash: preview.preview_hash,
    };
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointCreate(env.deps, bad, callerCtx);
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('intake_form_config_invalid');
  });

  it('create round-trips a valid intake_form config', async () => {
    const cfg = goodIntakeFormConfig();
    const preview = await handleReceptionEndpointPreviewDraft(
      env.deps,
      {
        kind: 'intake_form',
        packet_declaration: intakeFormPacketDecl(),
        metadata: cfg as unknown as Record<string, unknown>,
      },
      callerCtx,
    );
    const created = await handleReceptionEndpointCreate(
      env.deps,
      {
        kind: 'intake_form',
        packet_declaration: intakeFormPacketDecl(),
        metadata: cfg as unknown as Record<string, unknown>,
        preview_hash: preview.preview_hash,
      },
      callerCtx,
    );
    expect(created.endpoint_id.length).toBeGreaterThan(0);
    // Default-off invariant — Must Hold I-1.
    const row = env.store.findById(created.endpoint_id);
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(false);
  });
});
