/** D-192 review (LOW #2) — per-vendor adapter maps must be COMPLETE vs their
 *  declaration registry.
 *
 *  The green-but-mute guard: a vendor DECLARED in the registry but MISSING from
 *  its dispatch map resolves to `undefined`, so the Source registers, validates,
 *  and probes healthy — then silently never syncs (or its bytes never fetch).
 *  The messenger + notification maps are floored by exactly this kind of
 *  live-registry ratchet; the file / byte-fetch / contact maps were not (the file
 *  and byte tests hand-spelled the same 7 vendors — proving nothing about
 *  completeness — and the contact map had no test at all). These bind each map to
 *  its registry so a newly declared vendor with no leaf is a RED TEST. */

import { describe, expect, it } from 'vitest';
import {
  CONTACT_SOURCE_DECLARATIONS,
  FILE_VENDOR_DECLARATIONS,
} from '@recued/contracts';

import {
  buildFileSourceAdapterResolver,
  type FileSourceAdapterDeps,
} from '../file-source-adapters/index.js';
import { buildRemoteFileByteResolvers } from '../collections/file/remote-byte-resolvers/index.js';
import {
  buildContactSourceAdapterResolver,
  type ContactSourceAdapterDeps,
} from '../contact-source-adapters/index.js';
import type { CrmMirrorLeafDeps } from '../contact-source-adapters/crm-mirror-leaf.js';
import type { GooglePeopleLeafDeps } from '../contact-source-adapters/google-people-leaf.js';

describe('D-192 — per-vendor adapter maps are complete vs their declaration registry', () => {
  it('file-source: every FILE_VENDOR_DECLARATIONS vendor resolves to a list leaf', () => {
    const resolve = buildFileSourceAdapterResolver({
      resolveConnection: (async () => null) as never,
    } as FileSourceAdapterDeps);
    expect(FILE_VENDOR_DECLARATIONS.length).toBeGreaterThan(0);
    for (const d of FILE_VENDOR_DECLARATIONS) {
      expect(
        resolve(d.vendor),
        `no file-source list leaf for declared vendor '${d.vendor}' — it would register a Source that never syncs`,
      ).toBeDefined();
    }
  });

  it('remote byte-fetch: every FILE_VENDOR_DECLARATIONS vendor resolves to a byte resolver', () => {
    const resolvers = buildRemoteFileByteResolvers();
    for (const d of FILE_VENDOR_DECLARATIONS) {
      expect(
        resolvers[d.vendor],
        `no remote byte resolver for declared file vendor '${d.vendor}' — its files would list but never open`,
      ).toBeDefined();
    }
  });

  it('contact-source: every CONTACT_SOURCE_DECLARATIONS vendor resolves to a leaf (crm + google wired)', () => {
    // Provide BOTH dep families so every declared vendor's leaf is buildable —
    // the map is conditional on which deps the server wired, but a DECLARED
    // vendor must have a leaf reachable when its deps are present.
    const resolve = buildContactSourceAdapterResolver({
      crm: {} as CrmMirrorLeafDeps,
      google: {} as GooglePeopleLeafDeps,
    } as ContactSourceAdapterDeps);
    expect(CONTACT_SOURCE_DECLARATIONS.length).toBeGreaterThan(0);
    for (const d of CONTACT_SOURCE_DECLARATIONS) {
      expect(
        resolve(d.vendor),
        `no contact-source leaf for declared vendor '${d.vendor}' — it would register a Source that never syncs`,
      ).toBeDefined();
    }
  });
});
