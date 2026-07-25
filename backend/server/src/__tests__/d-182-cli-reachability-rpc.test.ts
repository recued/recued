/** D-182 §7.2 — the owner-only `cli.reachability.*` grid rpc.
 *
 *  Proves the surface that AUTHORS the per-contract cli reachability allowlist on
 *  a booted server: `set` grants/revokes one (principal × cli-ingredient ×
 *  OPERATION) row (default owner `user_self`); the row lands in the SAME
 *  `contract.cli_reachability` store the gateway's resolver reads; a revoke drops
 *  it; `list` projects the rows; grant/revoke is audited reserve-class; validation
 *  rejects a missing ingredient / missing operation / non-boolean allowed, and (when
 *  the manifest snapshot is wired) a grant for an op the ingredient doesn't declare;
 *  granting one op never grants another (cross-op isolation); and every method
 *  rejects an unregistered (raw) client. This is the writer that makes the cli
 *  track dispatchable under the enforced reachability gate. cli is connection-less
 *  + pack-only, so this is the (contract × pack-op) grant shape; risk tier is
 *  orthogonal (owner-notification only) and is NOT a key.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditLogStore } from '@recued/storage';
import type { IngredientManifest, ProviderSurfaces, RiskTier } from '@recued/contracts';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import { createCliReachabilityStore } from '../storage/cli-reachability-store.js';
import {
  makeCliReachabilityHandlers,
  type CliReachabilityRpcDeps,
} from '../cli-reachability-handler.js';

/** Minimal cli catalog manifest invoking `tool` with per-op risk tiers — enough
 *  for `enumerateCliToolGrid` to derive the universe + for the `set` op-declared
 *  guard to validate (it reads the connector runtime + the ops' risk tiers). */
const cliManifest = (
  slug: string,
  tool: string,
  ops: Array<[string, string]>,
): IngredientManifest => ({
  slug,
  name: slug,
  description: '',
  author: 'recued-core',
  kind: 'connection',
  category: 'data',
  risk_tier: 'write',
  input: {},
  output: {},
  operations: Object.fromEntries(
    ops.map(([op, risk]) => [op, { operation_id: `${slug}.${op}`, risk_tier: risk as RiskTier, groups: [] }]),
  ),
  surfaces: {
    connector: {
      runtime: {
        transport: 'stdio',
        wire_protocol: 'cli_invocation',
        package_ref: `system_binary:${tool}`,
        entry_point: tool,
        expected_protocol_version: 1,
      },
      lifecycle: {
        auth: { method: 'none' },
        connect: { idempotent: true, startup_timeout_ms: 30_000 },
        invoke: { default_method_timeout_ms: 30_000 },
        disconnect: { graceful_shutdown_timeout_ms: 30_000 },
        reconnect_policy: 'manual_only',
        persistent_connection: false,
        idle_disconnect_ms: 0,
      },
      executes: Object.fromEntries(ops.map(([op]) => [op, { kind: 'cli_invocation' }])),
    },
  } as ProviderSurfaces,
});

const NOW = 1_700_000_000_000;

let db: Database.Database;
let store: ContractStore;
let auditRows: Array<{ action: string; target: string; detail?: string }>;
let auditLog: AuditLogStore;

const makeDeps = (over: Partial<CliReachabilityRpcDeps> = {}): CliReachabilityRpcDeps => ({
  store,
  now: () => NOW,
  auditLog,
  ...over,
});

type Slice = NonNullable<ReturnType<typeof makeCliReachabilityHandlers>>;
const call = <M extends keyof Slice['handlers']>(slice: Slice, method: M, args: unknown, client: unknown) =>
  (slice.handlers[method] as (a: unknown, c: unknown) => Promise<unknown>)(args, client);

const REG = { instance_id: 'web-1' };

const sliceOf = (over: Partial<CliReachabilityRpcDeps> = {}): Slice => {
  const slice = makeCliReachabilityHandlers(makeDeps(over));
  if (!slice) throw new Error('expected slice');
  return slice;
};

beforeEach(() => {
  db = new Database(':memory:');
  store = createContractStore(db, { now: () => NOW });
  auditRows = [];
  auditLog = {
    logActivity: vi.fn(async (entry: { action: string; target: string; detail?: string }) => {
      auditRows.push({ action: entry.action, target: entry.target, ...(entry.detail !== undefined ? { detail: entry.detail } : {}) });
    }),
  } as unknown as AuditLogStore;
});

afterEach(() => {
  db.close();
});

describe('makeCliReachabilityHandlers — slice presence + owner gate', () => {
  it('drops (undefined) when deps are absent → not_configured at the dispatcher', () => {
    expect(makeCliReachabilityHandlers(undefined)).toBeUndefined();
  });

  it('rejects an unregistered client (no instance_id) on every method', async () => {
    const slice = sliceOf();
    const raw = { instance_id: null };
    await expect(call(slice, 'cli.reachability.list', undefined, raw)).rejects.toThrow(/registered paired client/);
    await expect(
      call(slice, 'cli.reachability.set', { ingredient_id: 'whisper', operation_id: 'transcribe', allowed: true }, raw),
    ).rejects.toThrow(/registered paired client/);
  });
});

describe('cli.reachability.set — grant an op', () => {
  it('grants the owner op by default, persists it in the store the resolver reads, and audits it', async () => {
    const slice = sliceOf();
    const res = (await call(slice, 'cli.reachability.set', { ingredient_id: 'whisper', operation_id: 'transcribe', allowed: true }, REG)) as {
      principal: string; ingredient_id: string; operation_id: string; allowed: boolean; set_at?: number;
    };
    expect(res).toEqual({ principal: 'user_self', ingredient_id: 'whisper', operation_id: 'transcribe', allowed: true, set_at: NOW });
    // Lands in the SAME store the gateway resolver reads.
    expect(createCliReachabilityStore(store).isAllowed('user_self', 'whisper', 'transcribe')).toBe(true);
    expect(auditRows).toEqual([
      { action: 'cli_reachability_granted', target: 'whisper', detail: JSON.stringify({ principal: 'user_self', operation_id: 'transcribe' }) },
    ]);
  });

  it('grants an op for an explicit (contract) principal', async () => {
    const slice = sliceOf();
    const res = (await call(slice, 'cli.reachability.set', { principal: 'contract-7', ingredient_id: 'ffmpeg', operation_id: 'convert', allowed: true }, REG)) as { principal: string };
    expect(res.principal).toBe('contract-7');
    expect(createCliReachabilityStore(store).isAllowed('contract-7', 'ffmpeg', 'convert')).toBe(true);
    // The owner op stays untouched (per-principal independence).
    expect(createCliReachabilityStore(store).isAllowed('user_self', 'ffmpeg', 'convert')).toBe(false);
  });

  it('granting one op never grants another op of the same ingredient (cross-op isolation)', async () => {
    const slice = sliceOf();
    await call(slice, 'cli.reachability.set', { ingredient_id: 'ffmpeg', operation_id: 'convert', allowed: true }, REG);
    const reach = createCliReachabilityStore(store);
    expect(reach.isAllowed('user_self', 'ffmpeg', 'convert')).toBe(true);
    // a different op of the SAME ingredient stays denied (fail-closed).
    expect(reach.isAllowed('user_self', 'ffmpeg', 'probe')).toBe(false);
  });

  it('is idempotent for a redundant re-grant (preserves the stamp, no duplicate audit)', async () => {
    let t = NOW;
    const slice = sliceOf({ now: () => t });
    const first = (await call(slice, 'cli.reachability.set', { ingredient_id: 'whisper', operation_id: 'transcribe', allowed: true }, REG)) as { set_at?: number };
    expect(first.set_at).toBe(NOW);
    t = NOW + 5_000;
    const again = (await call(slice, 'cli.reachability.set', { ingredient_id: 'whisper', operation_id: 'transcribe', allowed: true }, REG)) as { set_at?: number };
    expect(again.set_at).toBe(NOW);
    expect(createCliReachabilityStore(store).get('user_self', 'whisper', 'transcribe')?.set_at).toBe(NOW);
    expect(auditRows.filter((r) => r.action === 'cli_reachability_granted')).toHaveLength(1);
  });

  it('rejects a missing ingredient_id, a missing operation_id, and a non-boolean allowed', async () => {
    const slice = sliceOf();
    await expect(call(slice, 'cli.reachability.set', { operation_id: 'transcribe', allowed: true }, REG)).rejects.toThrow(/ingredient_id is required/);
    await expect(call(slice, 'cli.reachability.set', { ingredient_id: 'whisper', allowed: true }, REG)).rejects.toThrow(/operation_id is required/);
    await expect(call(slice, 'cli.reachability.set', { ingredient_id: 'whisper', operation_id: 'transcribe', allowed: 'yes' }, REG)).rejects.toThrow(/allowed \(boolean\) is required/);
    expect(auditRows).toEqual([]);
  });
});

describe('cli.reachability.set — op-declared guard (manifest snapshot wired)', () => {
  const withManifests = (): Slice =>
    sliceOf({
      getManifests: () => [cliManifest('whisper', 'whisper', [['transcribe', 'write']])],
    });

  it('grants a declared op of the ingredient', async () => {
    const slice = withManifests();
    const res = (await call(slice, 'cli.reachability.set', { ingredient_id: 'whisper', operation_id: 'transcribe', allowed: true }, REG)) as { allowed: boolean };
    expect(res.allowed).toBe(true);
    expect(createCliReachabilityStore(store).isAllowed('user_self', 'whisper', 'transcribe')).toBe(true);
  });

  it('rejects a grant for an op the ingredient does NOT declare (fail-closed hygiene, no row, no audit)', async () => {
    const slice = withManifests();
    await expect(
      call(slice, 'cli.reachability.set', { ingredient_id: 'whisper', operation_id: 'phantom', allowed: true }, REG),
    ).rejects.toThrow(/not a declared op of cli ingredient/);
    expect(createCliReachabilityStore(store).isAllowed('user_self', 'whisper', 'phantom')).toBe(false);
    expect(auditRows).toEqual([]);
  });

  it('rejects a grant for an ingredient that is not installed', async () => {
    const slice = withManifests();
    await expect(
      call(slice, 'cli.reachability.set', { ingredient_id: 'ghost', operation_id: 'transcribe', allowed: true }, REG),
    ).rejects.toThrow(/not a declared op of cli ingredient/);
  });

  it('a REVOKE skips the op-declared guard so a now-undeclared op can still be cleared', async () => {
    // Seed a row directly (as if the ingredient was updated and the op removed),
    // then revoke it through the rpc — the guard must not block the cleanup.
    createCliReachabilityStore(store).allow('user_self', 'whisper', 'gone', NOW);
    const slice = withManifests();
    const res = (await call(slice, 'cli.reachability.set', { ingredient_id: 'whisper', operation_id: 'gone', allowed: false }, REG)) as { allowed: boolean };
    expect(res.allowed).toBe(false);
    expect(createCliReachabilityStore(store).isAllowed('user_self', 'whisper', 'gone')).toBe(false);
  });
});

describe('cli.reachability.set — revoke an op', () => {
  it('revokes a granted op, drops the row, audits the revoke, and reports off', async () => {
    const slice = sliceOf();
    await call(slice, 'cli.reachability.set', { ingredient_id: 'whisper', operation_id: 'transcribe', allowed: true }, REG);
    auditRows = [];
    const res = (await call(slice, 'cli.reachability.set', { ingredient_id: 'whisper', operation_id: 'transcribe', allowed: false }, REG)) as { allowed: boolean; set_at?: number };
    expect(res).toEqual({ principal: 'user_self', ingredient_id: 'whisper', operation_id: 'transcribe', allowed: false });
    expect(createCliReachabilityStore(store).isAllowed('user_self', 'whisper', 'transcribe')).toBe(false);
    expect(auditRows).toEqual([
      { action: 'cli_reachability_revoked', target: 'whisper', detail: JSON.stringify({ principal: 'user_self', operation_id: 'transcribe' }) },
    ]);
  });

  it('is an un-audited no-op revoking an already-absent op (idempotent)', async () => {
    const slice = sliceOf();
    const res = (await call(slice, 'cli.reachability.set', { ingredient_id: 'whisper', operation_id: 'transcribe', allowed: false }, REG)) as { allowed: boolean };
    expect(res.allowed).toBe(false);
    expect(auditRows).toEqual([]);
  });
});

describe('cli.reachability.list — the grid read', () => {
  it('returns every reachability row', async () => {
    const slice = sliceOf();
    await call(slice, 'cli.reachability.set', { ingredient_id: 'whisper', operation_id: 'transcribe', allowed: true }, REG);
    await call(slice, 'cli.reachability.set', { principal: 'contract-7', ingredient_id: 'ffmpeg', operation_id: 'probe', allowed: true }, REG);
    const res = (await call(slice, 'cli.reachability.list', undefined, REG)) as {
      rows: Array<{ principal: string; ingredient_id: string; operation_id: string; allowed: boolean; set_at?: number }>;
    };
    const sorted = [...res.rows].sort((a, b) => a.ingredient_id.localeCompare(b.ingredient_id));
    expect(sorted).toEqual([
      { principal: 'contract-7', ingredient_id: 'ffmpeg', operation_id: 'probe', allowed: true, set_at: NOW },
      { principal: 'user_self', ingredient_id: 'whisper', operation_id: 'transcribe', allowed: true, set_at: NOW },
    ]);
  });
});

describe('cli.reachability.universe — the grid universe read', () => {
  it('derives the installed cli-tool per-op universe from getManifests', async () => {
    const slice = sliceOf({
      getManifests: () => [
        cliManifest('whisper', 'whisper', [['audio.transcribe', 'write']]),
        cliManifest('magick-a', 'magick', [['image.identify', 'read'], ['image.convert', 'write']]),
        cliManifest('magick-b', 'magick', [['image.mogrify', 'write']]),
      ],
    });
    const res = (await call(slice, 'cli.reachability.universe', undefined, REG)) as {
      tools: Array<{ tool: string; catalog_slugs: string[]; operations: Array<{ operation_id: string; catalog_slug: string; risk_tier: string }> }>;
    };
    const byTool = Object.fromEntries(res.tools.map((t) => [t.tool, t]));
    expect(byTool.whisper.operations).toEqual([
      { operation_id: 'audio.transcribe', catalog_slug: 'whisper', risk_tier: 'write' },
    ]);
    expect(byTool.magick.catalog_slugs).toEqual(['magick-a', 'magick-b']);
    expect(byTool.magick.operations).toEqual([
      { operation_id: 'image.identify', catalog_slug: 'magick-a', risk_tier: 'read' },
      { operation_id: 'image.convert', catalog_slug: 'magick-a', risk_tier: 'write' },
      { operation_id: 'image.mogrify', catalog_slug: 'magick-b', risk_tier: 'write' },
    ]);
  });

  it('returns an empty tool list when getManifests is absent (db-less harness, never throws)', async () => {
    const slice = sliceOf({ getManifests: undefined });
    const res = (await call(slice, 'cli.reachability.universe', undefined, REG)) as { tools: unknown[] };
    expect(res.tools).toEqual([]);
  });

  it('enriches each tool row with proactive readiness (probed once per tool)', async () => {
    const probed: string[] = [];
    const slice = sliceOf({
      getManifests: () => [
        cliManifest('whisper', 'whisper', [['audio.transcribe', 'write']]),
        cliManifest('magick-a', 'magick', [['image.convert', 'write']]),
        cliManifest('magick-b', 'magick', [['image.mogrify', 'write']]),
      ],
      probeCliToolReachable: (tool) => {
        probed.push(tool);
        return tool === 'whisper';
      },
    });
    const res = (await call(slice, 'cli.reachability.universe', undefined, REG)) as {
      tools: Array<{ tool: string; reachable?: boolean }>;
    };
    const byTool = Object.fromEntries(res.tools.map((t) => [t.tool, t.reachable]));
    expect(byTool.whisper).toBe(true);
    expect(byTool.magick).toBe(false);
    // Probed once per TOOL — not per catalog slug (magick has two) nor per op.
    expect(probed.sort()).toEqual(['magick', 'whisper']);
  });

  it('omits reachable when no probe is wired (unknown, never throws)', async () => {
    const slice = sliceOf({
      getManifests: () => [cliManifest('whisper', 'whisper', [['audio.transcribe', 'write']])],
    });
    const res = (await call(slice, 'cli.reachability.universe', undefined, REG)) as {
      tools: Array<{ tool: string; reachable?: boolean }>;
    };
    expect(res.tools[0]?.reachable).toBeUndefined();
  });

  it('rejects an unregistered (raw) client', async () => {
    const slice = sliceOf({ getManifests: () => [] });
    await expect(call(slice, 'cli.reachability.universe', undefined, { instance_id: null })).rejects.toThrow(
      /registered paired client/,
    );
  });
});

describe('no-audit-log harness still writes', () => {
  it('grant/revoke land even when auditLog is absent (only the breadcrumb is skipped)', async () => {
    const slice = sliceOf({ auditLog: undefined });
    await call(slice, 'cli.reachability.set', { ingredient_id: 'whisper', operation_id: 'transcribe', allowed: true }, REG);
    expect(createCliReachabilityStore(store).isAllowed('user_self', 'whisper', 'transcribe')).toBe(true);
    await call(slice, 'cli.reachability.set', { ingredient_id: 'whisper', operation_id: 'transcribe', allowed: false }, REG);
    expect(createCliReachabilityStore(store).isAllowed('user_self', 'whisper', 'transcribe')).toBe(false);
  });
});
