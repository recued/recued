/** D-149 P7 § A.5.4 — drop_link metadata validator wiring at the
 *  reception rpc edge.
 *
 *  Covers:
 *    - `reception.endpoint.preview_draft` rejects invalid drop_link
 *      metadata via `drop_link_config_invalid`.
 *    - Same for `endpoint.create`.
 *    - Detail message carries the first failure's code (so Mary's UX
 *      can localize).
 *    - Valid drop_link config round-trips through preview_draft +
 *      create. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  DropLinkConfig,
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
} => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const previewStore = createPreviewHashStore();
  const { auditLog, rows } = buildAuditLog();
  const broadcasts: ReceptionBroadcastEvent[] = [];
  const deps: ReceptionRpcDeps = {
    getStore: () => store,
    getPreviewStore: () => previewStore,
    getPepper: () => deriveReceptionPepper(Buffer.alloc(32, 0xab)),
    getShareBaseUrl: () => 'https://alice.recued.cloud',
    auditLog,
    broadcast: (event) => {
      broadcasts.push(event);
    },
    now: () => NOW_BASE,
  };
  return { deps, store, previewStore, broadcasts, rows };
};

const dropLinkPacketDecl = (): PacketDeclaration => ({
  packet_kind: 'drop_link_packet',
  source_query_ref: {
    kind: 'reception_drop_config',
    drop_config_id: 'drop_p7_rpc_test',
  },
});

const goodDropLinkConfig = (): DropLinkConfig => ({
  display_name: 'Mary',
  link_kind: 'repeated',
  size_cap_bytes: 1024 * 1024,
  allowed_mime_types: ['application/pdf'],
  expiry_days: 7,
  max_uploads_per_endpoint_per_day: 50,
  required_visitor_fields: {
    name: 'required',
    email: 'required',
    description: 'optional',
  },
  on_upload: {
    create_data_file_entity: true,
    auto_attach_to_contact: false,
  },
});

const callerCtx = { instance_id: 'inst-test' };

/** Spec § N.4 — drop_link is link-style with a hard 30d ceiling.
 *  Tests pin an expires_at 7d ahead of NOW so they don't trip the
 *  `long_lived_not_permitted_for_kind` gate. */
const DROP_LINK_EXPIRES_AT_OFFSET = 7 * 24 * 60 * 60 * 1000;

describe('D-149 P7 § A.5.4 — preview_draft / create gate', () => {
  let env: ReturnType<typeof buildDeps>;
  beforeEach(() => {
    env = buildDeps();
  });

  it('preview_draft accepts a valid drop_link config', async () => {
    const preview = await handleReceptionEndpointPreviewDraft(
      env.deps,
      {
        kind: 'drop_link',
        packet_declaration: dropLinkPacketDecl(),
        metadata: goodDropLinkConfig() as unknown as Record<string, unknown>,
        expires_at: NOW_BASE + DROP_LINK_EXPIRES_AT_OFFSET,
      },
      callerCtx,
    );
    expect(preview.preview_hash.length).toBeGreaterThan(0);
  });

  it('preview_draft rejects an invalid drop_link metadata with drop_link_config_invalid', async () => {
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointPreviewDraft(
        env.deps,
        {
          kind: 'drop_link',
          packet_declaration: dropLinkPacketDecl(),
          metadata: { not_a_config: true } as unknown as Record<string, unknown>,
          expires_at: NOW_BASE + DROP_LINK_EXPIRES_AT_OFFSET,
        },
        callerCtx,
      );
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('drop_link_config_invalid');
    expect(caught!.message).toContain('display_name_empty');
  });

  it('preview_draft rejects an unknown MIME with the matching detail code', async () => {
    const bad = {
      ...goodDropLinkConfig(),
      allowed_mime_types: ['application/x-msdownload'],
    } as unknown as Record<string, unknown>;
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointPreviewDraft(
        env.deps,
        {
          kind: 'drop_link',
          packet_declaration: dropLinkPacketDecl(),
          metadata: bad,
          expires_at: NOW_BASE + DROP_LINK_EXPIRES_AT_OFFSET,
        },
        callerCtx,
      );
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('drop_link_config_invalid');
    expect(caught!.message).toContain('allowed_mime_type_unknown');
  });

  it('create rejects invalid drop_link metadata on rebind', async () => {
    const valid = goodDropLinkConfig();
    const preview = await handleReceptionEndpointPreviewDraft(
      env.deps,
      {
        kind: 'drop_link',
        packet_declaration: dropLinkPacketDecl(),
        metadata: valid as unknown as Record<string, unknown>,
        expires_at: NOW_BASE + DROP_LINK_EXPIRES_AT_OFFSET,
      },
      callerCtx,
    );
    const bad: ReceptionEndpointCreateInput = {
      kind: 'drop_link',
      packet_declaration: dropLinkPacketDecl(),
      metadata: { not_a_config: true } as unknown as Record<string, unknown>,
      preview_hash: preview.preview_hash,
      expires_at: NOW_BASE + DROP_LINK_EXPIRES_AT_OFFSET,
    };
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointCreate(env.deps, bad, callerCtx);
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('drop_link_config_invalid');
  });

  it('create accepts a valid drop_link config round-trip', async () => {
    const cfg = goodDropLinkConfig();
    const preview = await handleReceptionEndpointPreviewDraft(
      env.deps,
      {
        kind: 'drop_link',
        packet_declaration: dropLinkPacketDecl(),
        metadata: cfg as unknown as Record<string, unknown>,
        expires_at: NOW_BASE + DROP_LINK_EXPIRES_AT_OFFSET,
      },
      callerCtx,
    );
    const created = await handleReceptionEndpointCreate(
      env.deps,
      {
        kind: 'drop_link',
        packet_declaration: dropLinkPacketDecl(),
        metadata: cfg as unknown as Record<string, unknown>,
        preview_hash: preview.preview_hash,
        expires_at: NOW_BASE + DROP_LINK_EXPIRES_AT_OFFSET,
      },
      callerCtx,
    );
    expect(created.endpoint_id.length).toBeGreaterThan(0);
    expect(created.bearer_secret_once.length).toBeGreaterThan(0);
  });
});
