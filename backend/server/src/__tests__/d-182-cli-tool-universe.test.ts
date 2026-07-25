/** D-182 §7 — the pure cli-tool universe derivers (`deriveCliToolGrant` /
 *  `cliCatalogSlugsForTool` / `enumerateCliToolUniverse`).
 *
 *  These are the vocabulary the "Local tools" reachability surface (D-182 §7.2)
 *  renders from — every tool an installed cli catalog invokes, grouped by the
 *  SHARED tool key (`entry_point`, with the `system_binary:` package_ref
 *  fallback). They are NOT an authorization key: the gateway authorizes a
 *  dispatched cli op by per-(principal × cli-INGREDIENT × OPERATION)
 *  reachability, keyed on the catalog slug + op id, not the tool (D-182 §7.2).
 *  Pure over the manifest snapshot.
 */

import { describe, expect, it } from 'vitest';

import type { IngredientManifest, ProviderSurfaces, RiskTier } from '@recued/contracts';
import {
  cliCatalogSlugsForTool,
  deriveCliToolGrant,
  enumerateCliToolGrid,
  enumerateCliToolUniverse,
} from '../storage/cli-tool-universe.js';

/** A cli catalog manifest invoking `tool` whose ops carry the GIVEN per-op risk
 *  tiers — `[opKey, riskTier]` pairs. (`cliManifest` above hardcodes `write`;
 *  the per-op surface needs varied tiers to exercise the badge + drop-unrecognized
 *  derivation.) */
const cliManifestWithRisks = (
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
  // `risk as RiskTier` — a malformed tier (e.g. 'sideways') is passed
  // deliberately at runtime to exercise the deriver's drop-unrecognized path.
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

/** A minimal cli catalog manifest invoking `tool`, declaring `ops`.
 *  `entryPoint` defaults to `tool`; pass `''` to exercise the gateway-shared
 *  `system_binary:` package_ref fallback. */
const cliManifest = (
  slug: string,
  tool: string,
  ops: string[],
  entryPoint: string = tool,
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
    ops.map((op) => [op, { operation_id: `${slug}.${op}`, risk_tier: 'write', groups: [] }]),
  ),
  surfaces: {
    connector: {
      runtime: {
        transport: 'stdio',
        wire_protocol: 'cli_invocation',
        package_ref: `system_binary:${tool}`,
        entry_point: entryPoint,
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
      executes: Object.fromEntries(ops.map((op) => [op, { kind: 'cli_invocation' }])),
    },
  } as ProviderSurfaces,
});

describe('D-182 deriveCliToolGrant — live ops via the shared tool key', () => {
  it('unions the ops of every installed cli catalog invoking the tool', () => {
    const manifests = [
      cliManifest('whisper', 'whisper', ['audio.transcribe']),
      cliManifest('whisper-extra', 'whisper', ['audio.translate']),
      cliManifest('ffmpeg', 'ffmpeg', ['media.convert']),
    ];
    const grant = deriveCliToolGrant(manifests, 'whisper');
    expect(grant.allowed_operations.sort()).toEqual(['audio.transcribe', 'audio.translate']);
  });

  it('matches a manifest via the system_binary: package_ref fallback when entry_point is empty (gateway-shared key)', () => {
    const manifests = [cliManifest('whisper', 'whisper', ['audio.transcribe'], '')];
    expect(deriveCliToolGrant(manifests, 'whisper'))
      .toEqual({ allowed_operations: ['audio.transcribe'] });
  });

  it('is empty when no installed cli catalog invokes the tool (uninstalled)', () => {
    expect(deriveCliToolGrant([cliManifest('ffmpeg', 'ffmpeg', ['media.convert'])], 'whisper'))
      .toEqual({ allowed_operations: [] });
    expect(deriveCliToolGrant([], 'whisper')).toEqual({ allowed_operations: [] });
  });

  it('ignores a non-cli (api) manifest even if its slug matches the tool name', () => {
    const apiManifest: IngredientManifest = {
      ...cliManifest('whisper', 'whisper', ['audio.transcribe']),
      surfaces: { api: { transport: 'rest', default_base_url: 'https://x', auth: { kind: 'none' }, executes: {} } } as ProviderSurfaces,
    };
    expect(deriveCliToolGrant([apiManifest], 'whisper')).toEqual({ allowed_operations: [] });
  });
});

describe('D-182 cliCatalogSlugsForTool — installed catalogs invoking a tool', () => {
  it('returns every installed cli catalog slug that invokes the tool, in manifest order', () => {
    const manifests = [
      cliManifest('whisper', 'whisper', ['audio.transcribe']),
      cliManifest('whisper-extra', 'whisper', ['audio.translate']),
      cliManifest('ffmpeg', 'ffmpeg', ['media.convert']),
    ];
    expect(cliCatalogSlugsForTool(manifests, 'whisper')).toEqual(['whisper', 'whisper-extra']);
    expect(cliCatalogSlugsForTool(manifests, 'ffmpeg')).toEqual(['ffmpeg']);
    expect(cliCatalogSlugsForTool(manifests, 'ghost')).toEqual([]);
  });
});

describe('D-182 enumerateCliToolUniverse — the grid universe', () => {
  it('groups installed cli catalogs by tool with backing slugs + the union of ops', () => {
    const manifests = [
      cliManifest('whisper', 'whisper', ['audio.transcribe']),
      cliManifest('whisper-extra', 'whisper', ['audio.translate']),
      cliManifest('ffmpeg', 'ffmpeg', ['media.extract_audio']),
    ];
    const universe = enumerateCliToolUniverse(manifests)
      .sort((a, b) => a.tool.localeCompare(b.tool));
    expect(universe).toEqual([
      { tool: 'ffmpeg', catalog_slugs: ['ffmpeg'], operations: ['media.extract_audio'] },
      {
        tool: 'whisper',
        catalog_slugs: ['whisper', 'whisper-extra'],
        operations: ['audio.transcribe', 'audio.translate'],
      },
    ]);
  });

  it('skips non-cli manifests (no resolvable tool key)', () => {
    const apiManifest: IngredientManifest = {
      ...cliManifest('hubspot', 'hubspot', ['deal.read']),
      surfaces: { api: { transport: 'rest', default_base_url: 'https://x', auth: { kind: 'none' }, executes: {} } } as ProviderSurfaces,
    };
    expect(enumerateCliToolUniverse([apiManifest])).toEqual([]);
  });
});

describe('D-182 §7.2 enumerateCliToolGrid — per-op toggles (operation_id × catalog_slug × risk badge)', () => {
  it('derives a single-slug single-op tool (whisper = one Write op)', () => {
    const grid = enumerateCliToolGrid([
      cliManifestWithRisks('whisper', 'whisper', [['audio.transcribe', 'write']]),
    ]);
    expect(grid).toEqual([
      {
        tool: 'whisper',
        catalog_slugs: ['whisper'],
        operations: [
          { operation_id: 'audio.transcribe', catalog_slug: 'whisper', risk_tier: 'write' },
        ],
      },
    ]);
  });

  it('lists every op across a tool’s slugs, each carrying its declaring slug + risk badge', () => {
    // magick-a has a read op + a write op; magick-b has one write op. Each op is a
    // distinct per-op toggle (one reachability row), keyed by its OWN slug.
    const grid = enumerateCliToolGrid([
      cliManifestWithRisks('magick-a', 'magick', [
        ['image.identify', 'read'],
        ['image.convert', 'write'],
      ]),
      cliManifestWithRisks('magick-b', 'magick', [['image.mogrify', 'write']]),
    ]);
    expect(grid).toHaveLength(1);
    const entry = grid[0]!;
    expect(entry.tool).toBe('magick');
    expect(entry.catalog_slugs).toEqual(['magick-a', 'magick-b']);
    // Per-op entries in manifest-iteration order (magick-a's ops, then magick-b's).
    expect(entry.operations).toEqual([
      { operation_id: 'image.identify', catalog_slug: 'magick-a', risk_tier: 'read' },
      { operation_id: 'image.convert', catalog_slug: 'magick-a', risk_tier: 'write' },
      { operation_id: 'image.mogrify', catalog_slug: 'magick-b', risk_tier: 'write' },
    ]);
  });

  it('keeps ops in manifest order, each carrying its own declared risk badge', () => {
    const grid = enumerateCliToolGrid([
      cliManifestWithRisks('tool', 'tool', [
        ['d', 'destructive'],
        ['a', 'admin'],
        ['r', 'read'],
        ['w', 'write'],
      ]),
    ]);
    expect(grid[0]!.operations).toEqual([
      { operation_id: 'd', catalog_slug: 'tool', risk_tier: 'destructive' },
      { operation_id: 'a', catalog_slug: 'tool', risk_tier: 'admin' },
      { operation_id: 'r', catalog_slug: 'tool', risk_tier: 'read' },
      { operation_id: 'w', catalog_slug: 'tool', risk_tier: 'write' },
    ]);
  });

  it('drops an op with a malformed / unrecognized risk tier (it can never be granted, so no toggle)', () => {
    const grid = enumerateCliToolGrid([
      cliManifestWithRisks('tool', 'tool', [
        ['ok', 'write'],
        ['bad', 'sideways'],
      ]),
    ]);
    // Only the recognized-tier op survives as a grantable toggle — the gateway
    // would short-circuit the malformed-tier op to `operation_not_declared`.
    expect(grid[0]!.operations).toEqual([
      { operation_id: 'ok', catalog_slug: 'tool', risk_tier: 'write' },
    ]);
  });

  it('skips non-cli manifests + returns empty when nothing is installed', () => {
    const apiManifest: IngredientManifest = {
      ...cliManifestWithRisks('hubspot', 'hubspot', [['deal.read', 'read']]),
      surfaces: { api: { transport: 'rest', default_base_url: 'https://x', auth: { kind: 'none' }, executes: {} } } as ProviderSurfaces,
    };
    expect(enumerateCliToolGrid([apiManifest])).toEqual([]);
    expect(enumerateCliToolGrid([])).toEqual([]);
  });
});
