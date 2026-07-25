/** Phase 7 (D-110) — collection.file.* enroll rpc handlers.
 *
 *  Five methods wire into `collection-handler.ts`:
 *    - enroll       → run probe, write row, return caps.
 *    - update       → patch config, optional reprobe.
 *    - delete       → remove the row (adapter lifecycle owned by the
 *                     composition root).
 *    - resync       → run probe again, refresh caps + auth_state.
 *    - reauth       → return oauth_url for oauth adapters, ok otherwise.
 *
 *  Cross-type `collection.listInstances` lives next to these for
 *  import proximity even though it returns instances across every
 *  platform — it's the one shape the parseRecipe validator consumes.
 *
 *  The handlers deliberately do NOT spin up / tear down adapters on
 *  the CollectionRegistry. That's the composition root's concern
 *  (bin.ts) — it reads the instance store at boot and builds a
 *  Collection per row. Enroll writes a row + returns — the UI's next
 *  action (or a background task) asks the server to create the
 *  live adapter. Keeps the handler module free of gate / DB / bus
 *  dependencies.
 */

import { RpcError } from '@recued/contracts';
import type {
  CollectionAuthState,
  CollectionInstanceRow,
  CollectionPlatform,
  FileAdapterType,
  FileCollectionCaps,
} from '@recued/contracts';
import type { CollectionInstanceStore } from '../instance-store.js';
import type { FileAdapterRegistry } from './adapter-registry.js';
import { probeAdapter } from './adapter-registry.js';

const ADAPTER_TYPES: readonly FileAdapterType[] = [
  'fs',
  's3',
  'ext-downloads',
];

const SLUG_RE = /^[a-z0-9][a-z0-9\-_]{0,63}$/;

export interface EnrollDeps {
  instances: CollectionInstanceStore;
  adapters: FileAdapterRegistry;
  /** Called after a successful enroll — gives the composition root
   *  a chance to start the adapter on the live Collection registry.
   *  Optional so unit tests don't need live wiring. */
  onEnrolled?: (row: CollectionInstanceRow) => Promise<void> | void;
  /** Called before a row is deleted so the composition root can stop
   *  the adapter cleanly. Optional; missing → adapter-lifecycle is
   *  the caller's concern. */
  onDeleted?: (slug: string) => Promise<void> | void;
  now?: () => number;
}

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError('bad_request', `${field} must be a non-empty string`, 400);
  }
  return value;
};

const requireSlug = (value: unknown): string => {
  const slug = requireString(value, 'slug');
  if (!SLUG_RE.test(slug)) {
    throw new RpcError(
      'bad_request',
      `slug must match ${SLUG_RE.source} — lowercase letters, digits, - and _`,
      400,
    );
  }
  return slug;
};

const requireAdapterType = (value: unknown): FileAdapterType => {
  if (typeof value !== 'string' || !(ADAPTER_TYPES as readonly string[]).includes(value)) {
    throw new RpcError(
      'bad_request',
      `adapter_type must be one of: ${ADAPTER_TYPES.join(', ')}`,
      400,
    );
  }
  return value as FileAdapterType;
};

const requireConfig = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError('bad_request', 'config must be an object', 400);
  }
  return value as Record<string, unknown>;
};

const toRow = (
  platform: CollectionPlatform,
  adapter_type: string,
  caps: FileCollectionCaps,
  auth_state: CollectionAuthState,
  slug: string,
  last_synced_at: number | null,
): CollectionInstanceRow => ({
  slug,
  platform,
  adapter_type,
  caps,
  auth_state,
  last_synced_at,
});

/** Map adapter probe failures to a 422 so the caller can render a
 *  specific error rather than a generic 500. Config-shape errors
 *  (from the asConfig call inside the factory) surface as 400. */
const classifyProbeError = (err: unknown): RpcError => {
  const msg = err instanceof Error ? err.message : String(err);
  // Adapter-specific probe guards throw with "adapter: field required".
  if (/required|must be/i.test(msg)) {
    return new RpcError('bad_request', msg, 400);
  }
  return new RpcError('probe_failed', msg, 422);
};

export const handleFileEnroll = async (
  deps: EnrollDeps,
  args: { slug?: unknown; adapter_type?: unknown; config?: unknown },
): Promise<{
  instance: CollectionInstanceRow;
  probe_result: FileCollectionCaps;
}> => {
  const slug = requireSlug(args.slug);
  const adapter_type = requireAdapterType(args.adapter_type);
  const config = requireConfig(args.config);

  const existing = deps.instances.get('file', slug);
  if (existing) {
    throw new RpcError(
      'conflict',
      `collection.file.enroll: instance '${slug}' already exists — use collection.file.update`,
      409,
    );
  }

  const factory = deps.adapters.get(adapter_type);
  if (!factory) {
    throw new RpcError(
      'bad_request',
      `unknown adapter_type '${adapter_type}'`,
      400,
    );
  }

  let caps: FileCollectionCaps;
  try {
    caps = await probeAdapter(factory, config);
  } catch (err) {
    throw classifyProbeError(err);
  }

  const stored = deps.instances.upsert({
    platform: 'file',
    slug,
    adapter_type,
    config,
    caps,
    auth_state: 'healthy',
    last_synced_at: null,
  });

  const row = toRow(
    'file',
    stored.adapter_type,
    stored.caps as FileCollectionCaps,
    stored.auth_state,
    stored.slug,
    stored.last_synced_at,
  );

  try {
    await deps.onEnrolled?.(row);
  } catch (err) {
    // Composition root failed to start the adapter. The row is
    // committed — caller can retry start via resync. Surface the
    // failure so the UI knows.
    throw new RpcError(
      'adapter_start_failed',
      (err as Error).message ?? 'adapter failed to start',
      500,
    );
  }

  return { instance: row, probe_result: caps };
};

export const handleFileUpdate = async (
  deps: EnrollDeps,
  args: {
    slug?: unknown;
    config_patch?: unknown;
    reprobe?: unknown;
  },
): Promise<{ instance: CollectionInstanceRow; re_probed: boolean }> => {
  const slug = requireSlug(args.slug);
  const patch = requireConfig(args.config_patch);
  const reprobe = Boolean(args.reprobe);

  const existing = deps.instances.get('file', slug);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `collection.file.update: instance '${slug}' not found`,
      404,
    );
  }

  const nextConfig = { ...existing.config, ...patch };
  let caps: FileCollectionCaps = existing.caps as FileCollectionCaps;
  let re_probed = false;

  if (reprobe) {
    const factory = deps.adapters.get(existing.adapter_type);
    if (!factory) {
      throw new RpcError(
        'bad_request',
        `unknown adapter_type '${existing.adapter_type}'`,
        400,
      );
    }
    try {
      caps = await probeAdapter(factory, nextConfig);
      re_probed = true;
    } catch (err) {
      throw classifyProbeError(err);
    }
  }

  const stored = deps.instances.upsert({
    platform: 'file',
    slug,
    adapter_type: existing.adapter_type,
    config: nextConfig,
    caps,
    auth_state: existing.auth_state,
    last_synced_at: existing.last_synced_at,
  });

  return {
    instance: toRow(
      'file',
      stored.adapter_type,
      stored.caps as FileCollectionCaps,
      stored.auth_state,
      stored.slug,
      stored.last_synced_at,
    ),
    re_probed,
  };
};

export const handleFileDelete = async (
  deps: EnrollDeps,
  args: { slug?: unknown },
): Promise<{ ok: true }> => {
  const slug = requireSlug(args.slug);
  const existing = deps.instances.get('file', slug);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `collection.file.delete: instance '${slug}' not found`,
      404,
    );
  }
  await deps.onDeleted?.(slug);
  deps.instances.delete('file', slug);
  return { ok: true };
};

export const handleFileResync = async (
  deps: EnrollDeps,
  args: { slug?: unknown },
): Promise<{
  ok: true;
  probe_result: FileCollectionCaps;
  auth_state: CollectionAuthState;
}> => {
  const slug = requireSlug(args.slug);
  const existing = deps.instances.get('file', slug);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `collection.file.resync: instance '${slug}' not found`,
      404,
    );
  }
  const factory = deps.adapters.get(existing.adapter_type);
  if (!factory) {
    throw new RpcError(
      'bad_request',
      `unknown adapter_type '${existing.adapter_type}'`,
      400,
    );
  }

  let caps: FileCollectionCaps;
  let auth_state: CollectionAuthState = existing.auth_state;
  try {
    caps = await probeAdapter(factory, existing.config);
    auth_state = 'healthy';
  } catch (err) {
    // Probe failure on resync flips auth_state rather than 422'ing —
    // the instance still exists; the UI reads the new auth_state.
    const msg = err instanceof Error ? err.message : String(err);
    if (/auth|credential|token/i.test(msg)) {
      auth_state = 'expired';
    } else {
      auth_state = 'degraded';
    }
    caps = existing.caps as FileCollectionCaps;
  }

  deps.instances.upsert({
    platform: 'file',
    slug,
    adapter_type: existing.adapter_type,
    config: existing.config,
    caps,
    auth_state,
    last_synced_at: (deps.now ?? Date.now)(),
  });
  return { ok: true, probe_result: caps, auth_state };
};

export const handleFileReauth = async (
  deps: EnrollDeps,
  args: { slug?: unknown },
): Promise<{ oauth_url: string } | { ok: true }> => {
  const slug = requireSlug(args.slug);
  const existing = deps.instances.get('file', slug);
  if (!existing) {
    throw new RpcError(
      'not_found',
      `collection.file.reauth: instance '${slug}' not found`,
      404,
    );
  }
  if ((existing.caps as FileCollectionCaps).auth === 'oauth') {
    // OAuth URL construction happens per-adapter — the v1 adapter set
    // (fs / s3 / ext-downloads) doesn't include any OAuth adapters.
    // Preserving the surface so Dropbox / Google Drive can slot in
    // later without a contract change.
    throw new RpcError(
      'not_implemented',
      `oauth reauth not supported for adapter '${existing.adapter_type}' — no oauth adapters in v1`,
      501,
    );
  }
  return { ok: true };
};

export const handleListInstances = async (
  deps: EnrollDeps,
  args: { type?: unknown },
): Promise<{ instances: CollectionInstanceRow[] }> => {
  const platform =
    typeof args.type === 'string'
      ? (args.type as CollectionPlatform)
      : undefined;
  const records = deps.instances.list(platform);
  return {
    instances: records.map((r) => ({
      slug: r.slug,
      platform: r.platform,
      adapter_type: r.adapter_type,
      caps: r.caps,
      auth_state: r.auth_state,
      last_synced_at: r.last_synced_at,
    })),
  };
};
