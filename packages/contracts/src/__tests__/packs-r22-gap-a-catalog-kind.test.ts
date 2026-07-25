/** Packs R22 GAP-A — `catalogIngredientViews` must carry each ingredient's
 *  `kind` so grant surfaces can ROUTE a cli op's toggle to the cli_reachability
 *  allowlist (its real authority), not the contract_grant op axis the cli gate
 *  ignores. A regression that drops `kind` from the projection silently reverts
 *  the by-CONTRACT / by-PACK cli-routing fix, so this locks it. */

import { describe, expect, it } from 'vitest';

import { catalogIngredientViews } from '../contract-override.js';
import type { IngredientManifest } from '../ingredient.js';

/** Minimal catalog-form manifest (non-empty `operations` map) with a kind. */
const manifest = (over: Partial<IngredientManifest>): IngredientManifest =>
  ({
    slug: 'x',
    name: 'X',
    version: 1,
    kind: 'http',
    operations: { op: { operation_id: 'x.op', risk_tier: 'read' } },
    ...over,
  }) as unknown as IngredientManifest;

describe('Packs R22 GAP-A — catalogIngredientViews carries ingredient kind', () => {
  it('projects a cli ingredient with kind:"cli"', () => {
    const views = catalogIngredientViews([
      manifest({ slug: 'zstd', name: 'zstd', kind: 'cli' }),
    ]);
    expect(views[0]?.kind).toBe('cli');
  });

  it('projects a non-cli (http) ingredient kind too', () => {
    const views = catalogIngredientViews([
      manifest({ slug: 'hs', name: 'HS', kind: 'http' }),
    ]);
    expect(views[0]?.kind).toBe('http');
  });

  it('omits kind when the manifest declares none (undefined, not a crash)', () => {
    const m = manifest({ slug: 'nok', name: 'NoK' });
    delete (m as { kind?: unknown }).kind;
    const views = catalogIngredientViews([m]);
    expect(views[0]?.kind).toBeUndefined();
  });

  it('projects the operations MAP KEY as operation_key (distinct from the qualified operation_id)', () => {
    // The cli_reachability allowlist + gateway key on the map key, so it must be
    // carried alongside the qualified operation_id (Codex GAP-B fold).
    const m = manifest({
      slug: 'whisper',
      name: 'whisper',
      kind: 'cli',
      operations: {
        'audio.transcribe': { operation_id: 'recued-core/whisper.audio.transcribe', risk_tier: 'write' },
      },
    } as Partial<IngredientManifest>);
    const op = catalogIngredientViews([m])[0]?.operations[0];
    expect(op?.operation_key).toBe('audio.transcribe');
    expect(op?.operation_id).toBe('recued-core/whisper.audio.transcribe');
  });
});
