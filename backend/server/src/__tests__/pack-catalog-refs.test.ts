/** `packCatalogRefs` — which pack each catalog belongs to, so the read-only
 *  proof can read a recipe body install LOWERED onto that catalog.
 *
 *  It must name a catalog exactly as install does (`pack-install-handler.ts`):
 *  a Records composition by `recordsCatalogSlug(owner)`, any other by its own
 *  `slug`. A slug computed any other way resolves nothing, and every read on
 *  that pack fails closed again, silently. */
import { describe, expect, it } from 'vitest';
import type { RecordsUsagePack } from '@recued/contracts';
import { recordsCatalogSlug } from '@recued/ingredient-authoring';

import { packCatalogRefs } from '../pack-catalog-refs.js';

const pack = (publisher: string, slug: string, composition: Record<string, unknown>): RecordsUsagePack => ({
  publisher,
  slug,
  name: slug,
  manifest: { contents: [{ type: 'composition', composition }] } as never,
});

const records = (slug: string): Record<string, unknown> => ({
  schema_version: 1,
  slug,
  operations: [{ op: 'thing.search', risk: 'read', bind: { kind: 'core.records', action: 'search', entity: 'thing' } }],
});

const vendor = (slug: string): Record<string, unknown> => ({
  schema_version: 1,
  slug,
  operations: [{ op: 'deal.read', risk: 'read' }],
});

describe('packCatalogRefs', () => {
  it('⛔ names a Records catalog by the owner digest install stamps, not by its authored slug', async () => {
    const catalogs = await packCatalogRefs([pack('acme', 'ledger', records('ledger'))]);
    const installed = await recordsCatalogSlug({ publisher: 'acme', pack_slug: 'ledger' });
    expect([...catalogs]).toEqual([[installed, 'acme.ledger']]);
    expect(catalogs.has('ledger')).toBe(false);
  });

  it('names any other composition by its own slug', async () => {
    const catalogs = await packCatalogRefs([pack('acme', 'crm-pack', vendor('crm-catalog'))]);
    expect([...catalogs]).toEqual([['crm-catalog', 'acme.crm-pack']]);
  });

  it('⛔ maps a catalog two packs claim to NEITHER — the proof must not pick one', async () => {
    const catalogs = await packCatalogRefs([
      pack('acme', 'first', vendor('shared-catalog')),
      pack('other', 'second', vendor('shared-catalog')),
      pack('acme', 'third', vendor('own-catalog')),
    ]);
    expect([...catalogs]).toEqual([['own-catalog', 'acme.third']]);
  });

  it('an uninstalled pack, which carries no manifest, contributes nothing', async () => {
    const catalogs = await packCatalogRefs([{ publisher: 'acme', slug: 'absent', name: 'absent' }]);
    expect(catalogs.size).toBe(0);
  });
});
