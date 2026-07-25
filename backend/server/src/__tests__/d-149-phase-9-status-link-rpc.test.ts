/** D-149 P9 § A.5.6 — status_link metadata validator + projection-seed
 *  wiring at the reception rpc edge.
 *
 *  Covers:
 *    - `reception.endpoint.preview_draft` rejects invalid status_link
 *      metadata via `status_link_config_invalid`.
 *    - Same for `endpoint.create`.
 *    - Detail message carries the first failure's code.
 *    - Valid status_link config round-trips through preview_draft +
 *      create.
 *    - `endpoint.create` seeds a `reception_status_projection` row
 *      keyed on the new endpoint_id, with projection_kind +
 *      source_entity_kind + source_entity_id mirrored from the config.
 *    - source_ref kind mismatch with packet kind (status_link_packet
 *      doesn't allow reception_approval_intent ref) surfaces as the
 *      typed allowlist error.
 *    - source_ref kinds from D-097 forbidden namespaces are rejected. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  PacketDeclaration,
  ReceptionEndpointCreateInput,
  StatusLinkConfig,
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
  createReceptionStatusProjectionStore,
  type StatusProjectionStore,
} from '../storage/reception-status-projection-store.js';
import {
  handleReceptionEndpointCreate,
  handleReceptionEndpointPreviewDraft,
  type ReceptionBroadcastEvent,
  type ReceptionRpcDeps,
} from '../reception-rpc-handler.js';
import { RpcError } from '@recued/contracts';

const NOW_BASE = 1_700_000_000_000;
const STATUS_LINK_EXPIRES_AT_OFFSET = 30 * 24 * 60 * 60 * 1000;

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
  projectionStore: StatusProjectionStore;
  broadcasts: ReceptionBroadcastEvent[];
  rows: ActivityEntry[];
} => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const store = createPublicEndpointRegistryStore(db);
  const previewStore = createPreviewHashStore();
  const projectionStore = createReceptionStatusProjectionStore(db);
  const { auditLog, rows } = buildAuditLog();
  const broadcasts: ReceptionBroadcastEvent[] = [];
  const deps: ReceptionRpcDeps = {
    getStore: () => store,
    getPreviewStore: () => previewStore,
    getPepper: () => deriveReceptionPepper(Buffer.alloc(32, 0xbd)),
    getShareBaseUrl: () => 'https://alice.recued.cloud',
    auditLog,
    broadcast: (event) => {
      broadcasts.push(event);
    },
    now: () => NOW_BASE,
    getStatusProjectionStore: () => projectionStore,
  };
  return { deps, store, previewStore, projectionStore, broadcasts, rows };
};

const statusLinkPacketDecl = (project_id = 'proj-42'): PacketDeclaration => ({
  packet_kind: 'status_link_packet',
  source_query_ref: { kind: 'data.project', project_id },
});

const goodStatusLinkConfig = (overrides: Partial<StatusLinkConfig> = {}): StatusLinkConfig => ({
  display_name: 'Mary',
  projection_kind: 'project',
  source_ref: { kind: 'data.project', project_id: 'proj-42' },
  refresh_policy: { auto_refresh_enabled: true, refresh_interval_seconds: 60 },
  comments_enabled: false,
  shows_update_history: true,
  expiry_days: 30,
  ...overrides,
});

const callerCtx = { instance_id: 'inst-test' };

describe('D-149 P9 § A.5.6 — preview_draft / create gate', () => {
  let env: ReturnType<typeof buildDeps>;
  beforeEach(() => {
    env = buildDeps();
  });

  it('preview_draft accepts a valid status_link config', async () => {
    const preview = await handleReceptionEndpointPreviewDraft(
      env.deps,
      {
        kind: 'status_link',
        packet_declaration: statusLinkPacketDecl(),
        metadata: goodStatusLinkConfig() as unknown as Record<string, unknown>,
        expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
      },
      callerCtx,
    );
    expect(preview.preview_hash.length).toBeGreaterThan(0);
  });

  it('preview_draft rejects invalid status_link metadata', async () => {
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointPreviewDraft(
        env.deps,
        {
          kind: 'status_link',
          packet_declaration: statusLinkPacketDecl(),
          metadata: { not_a_config: true } as unknown as Record<string, unknown>,
          expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
        },
        callerCtx,
      );
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('status_link_config_invalid');
    expect(caught!.message).toContain('display_name_empty');
  });

  it('preview_draft rejects comments_enabled=true at v1', async () => {
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointPreviewDraft(
        env.deps,
        {
          kind: 'status_link',
          packet_declaration: statusLinkPacketDecl(),
          metadata: goodStatusLinkConfig({ comments_enabled: true }) as unknown as Record<
            string,
            unknown
          >,
          expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
        },
        callerCtx,
      );
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('status_link_config_invalid');
    expect(caught!.message).toContain('comments_enabled_must_be_false_at_v1');
  });

  it('preview_draft rejects fields_visible_override beyond projection ceiling', async () => {
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointPreviewDraft(
        env.deps,
        {
          kind: 'status_link',
          packet_declaration: statusLinkPacketDecl(),
          metadata: goodStatusLinkConfig({
            projection_kind: 'project',
            fields_visible_override: ['title', 'internal_codename'],
          }) as unknown as Record<string, unknown>,
          expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
        },
        callerCtx,
      );
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('status_link_config_invalid');
    expect(caught!.message).toContain('fields_visible_override_exceeds_ceiling');
  });

  it('packet_declaration with vault.* source_query_ref is rejected at the source-query gate', async () => {
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointPreviewDraft(
        env.deps,
        {
          kind: 'status_link',
          packet_declaration: {
            packet_kind: 'status_link_packet',
            source_query_ref: { kind: 'vault.secret', secret_id: 's' } as unknown,
          } as PacketDeclaration,
          metadata: goodStatusLinkConfig() as unknown as Record<string, unknown>,
          expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
        },
        callerCtx,
      );
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('source_query_unknown_kind');
  });

  it('packet_declaration with a source_query_ref kind not permitted for status_link_packet is rejected', async () => {
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointPreviewDraft(
        env.deps,
        {
          kind: 'status_link',
          packet_declaration: {
            packet_kind: 'status_link_packet',
            source_query_ref: {
              kind: 'reception_approval_intent',
              intent_id: 'x',
            },
          } as PacketDeclaration,
          metadata: goodStatusLinkConfig() as unknown as Record<string, unknown>,
          expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
        },
        callerCtx,
      );
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('source_query_disallowed_for_packet');
  });

  it('create rejects invalid status_link metadata on rebind', async () => {
    const valid = goodStatusLinkConfig();
    const preview = await handleReceptionEndpointPreviewDraft(
      env.deps,
      {
        kind: 'status_link',
        packet_declaration: statusLinkPacketDecl(),
        metadata: valid as unknown as Record<string, unknown>,
        expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
      },
      callerCtx,
    );
    const bad: ReceptionEndpointCreateInput = {
      kind: 'status_link',
      packet_declaration: statusLinkPacketDecl(),
      metadata: { not_a_config: true } as unknown as Record<string, unknown>,
      preview_hash: preview.preview_hash,
      expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
    };
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointCreate(env.deps, bad, callerCtx);
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('status_link_config_invalid');
  });

  it('create accepts a valid status_link config + seeds the projection row', async () => {
    const cfg = goodStatusLinkConfig();
    const preview = await handleReceptionEndpointPreviewDraft(
      env.deps,
      {
        kind: 'status_link',
        packet_declaration: statusLinkPacketDecl(),
        metadata: cfg as unknown as Record<string, unknown>,
        expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
      },
      callerCtx,
    );
    const created = await handleReceptionEndpointCreate(
      env.deps,
      {
        kind: 'status_link',
        packet_declaration: statusLinkPacketDecl(),
        metadata: cfg as unknown as Record<string, unknown>,
        preview_hash: preview.preview_hash,
        expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
      },
      callerCtx,
    );
    expect(created.endpoint_id.length).toBeGreaterThan(0);
    expect(created.bearer_secret_once.length).toBeGreaterThan(0);

    // Projection row mirrors the projection_kind + source_entity_kind +
    // source_entity_id from the config.
    const projection = env.projectionStore.findByEndpoint(created.endpoint_id);
    expect(projection).not.toBeNull();
    expect(projection!.projection_id).toBe(created.endpoint_id);
    expect(projection!.projection_kind).toBe('project');
    expect(projection!.source_entity_kind).toBe('data.project');
    expect(projection!.source_entity_id).toBe('proj-42');
    expect(projection!.refresh_policy.auto_refresh_enabled).toBe(true);
    expect(projection!.refresh_policy.refresh_interval_seconds).toBe(60);
    expect(projection!.comments_enabled).toBe(false);
    expect(projection!.shows_update_history).toBe(true);
  });

  it('create seeds projection with the correct source_entity_id for every projection kind', async () => {
    const matrix: Array<{
      projection_kind: StatusLinkConfig['projection_kind'];
      source_ref: StatusLinkConfig['source_ref'];
      decl: PacketDeclaration;
      expected_id: string;
    }> = [
      {
        projection_kind: 'event_plan',
        source_ref: { kind: 'data.event', event_id: 'evt-A' },
        decl: {
          packet_kind: 'status_link_packet',
          source_query_ref: { kind: 'data.event', event_id: 'evt-A' },
        },
        expected_id: 'evt-A',
      },
      {
        projection_kind: 'itinerary',
        source_ref: { kind: 'data.itinerary', itinerary_id: 'it-B' },
        decl: {
          packet_kind: 'status_link_packet',
          source_query_ref: { kind: 'data.itinerary', itinerary_id: 'it-B' },
        },
        expected_id: 'it-B',
      },
      {
        projection_kind: 'packing_list',
        source_ref: { kind: 'data.packing_list', list_id: 'lst-C' },
        decl: {
          packet_kind: 'status_link_packet',
          source_query_ref: { kind: 'data.packing_list', list_id: 'lst-C' },
        },
        expected_id: 'lst-C',
      },
      {
        projection_kind: 'commitment_summary',
        source_ref: { kind: 'data.commitment', commitment_id: 'cm-D' },
        decl: {
          packet_kind: 'status_link_packet',
          source_query_ref: { kind: 'data.commitment', commitment_id: 'cm-D' },
        },
        expected_id: 'cm-D',
      },
      {
        projection_kind: 'custom',
        source_ref: { kind: 'data.note', note_id: 'nt-E' },
        decl: {
          packet_kind: 'status_link_packet',
          source_query_ref: { kind: 'data.note', note_id: 'nt-E' },
        },
        expected_id: 'nt-E',
      },
    ];
    for (const row of matrix) {
      const env2 = buildDeps();
      const cfg = goodStatusLinkConfig({
        projection_kind: row.projection_kind,
        source_ref: row.source_ref,
      });
      const preview = await handleReceptionEndpointPreviewDraft(
        env2.deps,
        {
          kind: 'status_link',
          packet_declaration: row.decl,
          metadata: cfg as unknown as Record<string, unknown>,
          expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
        },
        callerCtx,
      );
      const created = await handleReceptionEndpointCreate(
        env2.deps,
        {
          kind: 'status_link',
          packet_declaration: row.decl,
          metadata: cfg as unknown as Record<string, unknown>,
          preview_hash: preview.preview_hash,
          expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
        },
        callerCtx,
      );
      const projection = env2.projectionStore.findByEndpoint(created.endpoint_id);
      expect(projection!.projection_kind).toBe(row.projection_kind);
      expect(projection!.source_entity_id).toBe(row.expected_id);
      expect(projection!.source_entity_kind).toBe(row.source_ref.kind);
    }
  });

  it('endpoint.create without getStatusProjectionStore still accepts the config (deferred wiring)', async () => {
    const cfg = goodStatusLinkConfig();
    const env2 = buildDeps();
    // Strip the optional dep — mimics the boot state where the store
    // isn't yet wired (bin.ts cold path).
    const depsNoStore: ReceptionRpcDeps = { ...env2.deps };
    delete (depsNoStore as { getStatusProjectionStore?: unknown }).getStatusProjectionStore;
    const preview = await handleReceptionEndpointPreviewDraft(
      depsNoStore,
      {
        kind: 'status_link',
        packet_declaration: statusLinkPacketDecl(),
        metadata: cfg as unknown as Record<string, unknown>,
        expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
      },
      callerCtx,
    );
    const created = await handleReceptionEndpointCreate(
      depsNoStore,
      {
        kind: 'status_link',
        packet_declaration: statusLinkPacketDecl(),
        metadata: cfg as unknown as Record<string, unknown>,
        preview_hash: preview.preview_hash,
        expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
      },
      callerCtx,
    );
    // Endpoint exists, but no projection was seeded because the store
    // wasn't wired. Visitor flow degrades to placeholder.
    expect(created.endpoint_id.length).toBeGreaterThan(0);
    expect(env2.projectionStore.findByEndpoint(created.endpoint_id)).toBeNull();
  });

  // ────────────────────────────────────────────────────────────────
  // Codex review P2 fold (2026-05-13) — cross-check between
  // packet_declaration.source_query_ref + metadata.source_ref
  // ────────────────────────────────────────────────────────────────

  it('rejects mismatched source kind between packet_declaration + metadata.source_ref (preview_draft)', async () => {
    // packet_declaration says data.project; metadata says data.note.
    // Both validators pass independently; the cross-check rejects.
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointPreviewDraft(
        env.deps,
        {
          kind: 'status_link',
          packet_declaration: {
            packet_kind: 'status_link_packet',
            source_query_ref: { kind: 'data.project', project_id: 'proj-42' },
          },
          metadata: goodStatusLinkConfig({
            projection_kind: 'custom',
            source_ref: { kind: 'data.note', note_id: 'note-99' },
          }) as unknown as Record<string, unknown>,
          expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
        },
        callerCtx,
      );
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('status_link_config_invalid');
    expect(caught!.message).toContain('must match packet_declaration.source_query_ref.kind');
  });

  it('rejects mismatched source id between packet_declaration + metadata.source_ref (preview_draft)', async () => {
    // Same kind, different id.
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointPreviewDraft(
        env.deps,
        {
          kind: 'status_link',
          packet_declaration: {
            packet_kind: 'status_link_packet',
            source_query_ref: { kind: 'data.project', project_id: 'proj-42' },
          },
          metadata: goodStatusLinkConfig({
            source_ref: { kind: 'data.project', project_id: 'proj-DIFFERENT' },
          }) as unknown as Record<string, unknown>,
          expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
        },
        callerCtx,
      );
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('status_link_config_invalid');
    expect(caught!.message).toContain('project_id');
  });

  it('rejects mismatch at create as well (not only at preview_draft)', async () => {
    // Reach create with a valid preview, then rebind a mismatched
    // metadata at create time — the cross-check should fire again.
    const valid = goodStatusLinkConfig();
    const preview = await handleReceptionEndpointPreviewDraft(
      env.deps,
      {
        kind: 'status_link',
        packet_declaration: statusLinkPacketDecl(),
        metadata: valid as unknown as Record<string, unknown>,
        expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
      },
      callerCtx,
    );
    let caught: RpcError | null = null;
    try {
      await handleReceptionEndpointCreate(
        env.deps,
        {
          kind: 'status_link',
          packet_declaration: statusLinkPacketDecl(),
          metadata: goodStatusLinkConfig({
            source_ref: { kind: 'data.note', note_id: 'note-XXX' },
            projection_kind: 'custom',
          }) as unknown as Record<string, unknown>,
          preview_hash: preview.preview_hash,
          expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
        },
        callerCtx,
      );
    } catch (e) {
      if (e instanceof RpcError) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('status_link_config_invalid');
  });

  it('create derives the projection row source from packet_declaration (Codex P2 fold)', async () => {
    // When config + packet_declaration agree (the cross-check enforces
    // this), the projection row carries `decl.source_query_ref`'s
    // entity_kind + entity_id — the canonical declared source. This
    // test exercises the projection-seed path's switch from
    // `metadata.source_ref` to `decl.source_query_ref`.
    const cfg = goodStatusLinkConfig({
      projection_kind: 'event_plan',
      source_ref: { kind: 'data.event', event_id: 'evt-Z' },
    });
    const decl: PacketDeclaration = {
      packet_kind: 'status_link_packet',
      source_query_ref: { kind: 'data.event', event_id: 'evt-Z' },
    };
    const preview = await handleReceptionEndpointPreviewDraft(
      env.deps,
      {
        kind: 'status_link',
        packet_declaration: decl,
        metadata: cfg as unknown as Record<string, unknown>,
        expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
      },
      callerCtx,
    );
    const created = await handleReceptionEndpointCreate(
      env.deps,
      {
        kind: 'status_link',
        packet_declaration: decl,
        metadata: cfg as unknown as Record<string, unknown>,
        preview_hash: preview.preview_hash,
        expires_at: NOW_BASE + STATUS_LINK_EXPIRES_AT_OFFSET,
      },
      callerCtx,
    );
    const projection = env.projectionStore.findByEndpoint(created.endpoint_id);
    expect(projection?.source_entity_kind).toBe('data.event');
    expect(projection?.source_entity_id).toBe('evt-Z');
  });

  it('non-status_link kinds do not seed a projection row', async () => {
    // Verify by creating a different kind (reception_page — singleton)
    // and asserting no projection row exists. reception_page doesn't
    // require metadata config; the smaller surface keeps this assertion
    // cheap.
    const env2 = buildDeps();
    // Page singleton (kind: 'reception_page' has its own metadata blob).
    // Create one and confirm no projection_status row.
    const cfg = {
      display_name: 'Mary',
      tagline: 'tagline',
      tz_label: 'UTC',
      preferred_contact_methods: ['mail'],
    };
    const decl: PacketDeclaration = {
      packet_kind: 'reception_page_packet',
      source_query_ref: { kind: 'reception_page_config' },
    };
    // `reception_page` is a Settings-managed singleton kind — long-lived
    // (no expiry) is permitted, so `expires_at` is omitted entirely.
    // Omitting (not `null`) keeps the preview + create inputs canonically
    // identical so the `preview_hash` gate matches; `null` is type-valid
    // only on the create input, not the preview input.
    const preview = await handleReceptionEndpointPreviewDraft(
      env2.deps,
      {
        kind: 'reception_page',
        packet_declaration: decl,
        metadata: cfg as unknown as Record<string, unknown>,
      },
      callerCtx,
    );
    const created = await handleReceptionEndpointCreate(
      env2.deps,
      {
        kind: 'reception_page',
        packet_declaration: decl,
        metadata: cfg as unknown as Record<string, unknown>,
        preview_hash: preview.preview_hash,
      },
      callerCtx,
    );
    expect(env2.projectionStore.findByEndpoint(created.endpoint_id)).toBeNull();
  });
});
