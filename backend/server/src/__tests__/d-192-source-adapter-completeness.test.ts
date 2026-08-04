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
  WORK_ENTITY_SOURCE_DECLARABLE_KINDS,
  getWorkEntitySourceLandingContract,
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
import type { GraphPeopleLeafDeps } from '../contact-source-adapters/graph-people-leaf.js';
import {
  WORK_ENTITY_SOURCE_RUNTIME_ADAPTER_KINDS,
  workEntitySourceRuntimeAdapter,
} from '../work-entity-source-runtime-adapters.js';

describe('D-192 — per-vendor adapter maps are complete vs their declaration registry', () => {
  it('work-entity Source: every pack-declarable kind has one executable landing adapter', () => {
    expect(WORK_ENTITY_SOURCE_RUNTIME_ADAPTER_KINDS).toEqual(
      WORK_ENTITY_SOURCE_DECLARABLE_KINDS,
    );
    for (const kind of WORK_ENTITY_SOURCE_DECLARABLE_KINDS) {
      const contract = getWorkEntitySourceLandingContract(kind);
      const runtime = workEntitySourceRuntimeAdapter(kind);
      expect(contract, `missing landing contract for '${kind}'`).not.toBeNull();
      expect(runtime.kind).toBe(kind);
      expect(runtime.table).toBe(`data_${kind}`);
      expect(contract?.canonical_collection).toBe(`data.${kind}`);
      expect(contract?.qualified_id_namespace).toBe('we1');
      expect(contract?.postures).toEqual(['records', 'read_through']);
      for (const operation of ['project', 'read', 'upsert', 'tombstone'] as const) {
        expect(
          runtime[operation],
          `landing adapter '${kind}' has no executable ${operation} operation`,
        ).toBeTypeOf('function');
      }
    }
  });

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

  it('contact-source: every CONTACT_SOURCE_DECLARATIONS vendor resolves to a leaf (all families wired)', () => {
    // Provide EVERY dep family so every declared vendor's leaf is buildable —
    // the map is conditional on which deps the server wired, but a DECLARED
    // vendor must have a leaf reachable when its deps are present.
    //
    // ⛔ TYPED `Required<>` ON PURPOSE. This listed two families by hand and
    // silently stopped covering `microsoft` the moment a third was added — the
    // resolver was right, the test simply never asked it for that vendor, so a
    // completeness ratchet reported a completeness it had not checked. Required<>
    // makes the next family a COMPILE error here instead of a silent gap.
    const deps: Required<ContactSourceAdapterDeps> = {
      crm: {} as CrmMirrorLeafDeps,
      google: {} as GooglePeopleLeafDeps,
      microsoft: {} as GraphPeopleLeafDeps,
    };
    const resolve = buildContactSourceAdapterResolver(deps);
    expect(CONTACT_SOURCE_DECLARATIONS.length).toBeGreaterThan(0);
    for (const d of CONTACT_SOURCE_DECLARATIONS) {
      expect(
        resolve(d.vendor),
        `no contact-source leaf for declared vendor '${d.vendor}' — it would register a Source that never syncs`,
      ).toBeDefined();
    }
  });
});
