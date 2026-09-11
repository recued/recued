/** D-220 Slice B — persisted pack-shipped `intake_form` templates.
 *
 *  A pack manifest may carry `contents[]` entries of `type: 'reception_template'`
 *  (validated in full by `parseBulkPackManifest`). This module is the server
 *  half of their lifecycle:
 *
 *    - `recordPackReceptionTemplates` — the install handler's success-path
 *      write. REPLACE-CLEAN per pack: a re-install (version bump) first drops
 *      every row the previous manifest wrote, so a template the new manifest
 *      no longer ships does not linger as a ghost card.
 *    - `removePackReceptionTemplates` — the uninstall handler's sweep, on every
 *      uninstall path (generic and Records) — keyed by the AUTHORED pack slug,
 *      which is the identity the ref carries and the uninstall rpc receives.
 *    - `listInstalledPackReceptionTemplates` — what `reception.template.list`
 *      hands the gallery. Every row is RE-VALIDATED at read time against the
 *      current safety matrix and its own owner; a row that no longer admits is
 *      reported under `unavailable` rather than dropped, so a matrix tightened
 *      after an install is visible as "this pack's template is held", never
 *      as a card that silently vanished.
 *
 *  Why the store and not the filesystem: packs are single-file manifests fetched
 *  from the marketplace and a deployed server ships no `community/` tree, so
 *  the only place a marketplace-installed pack's template can exist is a row
 *  the install wrote. The Foundation loaders keep their directory scan; the two
 *  are listed side by side, never merged (different provenance, different trust).
 *
 *  Spec: D-220 § Slice B. */

import {
  parsePackIntakeFormTemplate,
  parsePackIntakeFormTemplateRef,
  validatePackIntakeFormTemplate,
  type PackContentRef,
  type PackIntakeFormTemplate,
  type PackReceptionTemplateContentRef,
  type PackReceptionTemplateListing,
  type PackReceptionTemplateUnavailable,
} from '@recued/contracts';

import type { ContractStore } from './storage/contract-store.js';

/** The `contract-schema.ts` composite key: segments
 *  `[pack_slug, publisher, template_name]`. The publisher sits in the key
 *  because two Records packs may share a slug under different publishers; a
 *  `[pack_slug]` prefix sweeps every publisher's rows, `[pack_slug, publisher]`
 *  exactly one pack's. */
export const INSTALLED_RECEPTION_TEMPLATE_SCOPE = 'installed_reception_template';

export const isReceptionTemplateContent = (
  content: PackContentRef,
): content is PackReceptionTemplateContentRef => content.type === 'reception_template';

export interface RecordPackReceptionTemplatesInput {
  /** The AUTHORED slug (`manifest.slug`) — for every pack kind, including a
   *  Records pack whose `installed_pack` row is keyed by its catalog id. */
  readonly pack_slug: string;
  readonly publisher: string;
  /** `manifest.name` — the card's "From <pack>" provenance line. */
  readonly pack_name: string;
  readonly pack_version: number;
  readonly templates: ReadonlyArray<PackIntakeFormTemplate>;
  /** Epoch ms of the install transaction (the same `now` the recipes used). */
  readonly installed_at: number;
}

export interface RecordPackReceptionTemplatesResult {
  /** Refs written, in manifest order. */
  readonly written: ReadonlyArray<string>;
  /** Rows the previous manifest had written for this pack, dropped first. */
  readonly removed: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const readString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/** Mirrors `pack-inventory.ts`'s stored-version rule: the writer emits
 *  `String(n)` for n ≥ 1, so only that exact form reads back as a version. */
const readVersion = (v: unknown): number => {
  if (typeof v !== 'string' || !/^[1-9]\d*$/.test(v)) return 0;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : 0;
};

/** Persist a pack's shipped intake templates, replace-clean. Every template
 *  is re-validated against the shipping pack before the write — the manifest
 *  validator already did this, so a failure here is a caller bypassing it, and
 *  the throw (inside the transaction, so nothing partial lands) is the loud
 *  answer. The install handler's best-effort bookkeeping wrapper turns it into
 *  a logged warning; the recipes stay installed. */
export const recordPackReceptionTemplates = (
  store: ContractStore,
  input: RecordPackReceptionTemplatesInput,
): RecordPackReceptionTemplatesResult => {
  const owner = { publisher: input.publisher, slug: input.pack_slug };
  const written: string[] = [];
  let removed = 0;
  store.transaction(() => {
    // Replace-clean for THIS pack only: a same-slug pack from another publisher
    // keeps its rows.
    removed = store.deleteByPrefix(INSTALLED_RECEPTION_TEMPLATE_SCOPE, [input.pack_slug, input.publisher]);
    for (const template of input.templates) {
      const failures = validatePackIntakeFormTemplate(template, owner);
      if (failures.length > 0) {
        throw new Error(
          `reception template ${JSON.stringify(template.template_ref)} refused for ${owner.publisher}/${owner.slug}: ${failures.map((f) => f.code).join(', ')}`,
        );
      }
      // Non-null after validation: the ref grammar is what validation checked.
      const parsed = parsePackIntakeFormTemplateRef(template.template_ref)!;
      store.put(INSTALLED_RECEPTION_TEMPLATE_SCOPE, [input.pack_slug, input.publisher, parsed.name], {
        pack_slug: input.pack_slug,
        publisher: input.publisher,
        pack_name: input.pack_name,
        pack_version: String(input.pack_version),
        template_ref: template.template_ref,
        template,
        installed_at: input.installed_at,
      });
      written.push(template.template_ref);
    }
  });
  return { written, removed };
};

/** Drop the template rows a pack wrote. With `publisher`, exactly that pack's
 *  (the Records uninstall, which knows the namespace owner); without it, every
 *  publisher's rows under the slug (the generic uninstall, where a slug names
 *  one pack). Idempotent; returns the row count. */
export const removePackReceptionTemplates = (
  store: ContractStore,
  pack_slug: string,
  publisher?: string,
): number =>
  store.deleteByPrefix(
    INSTALLED_RECEPTION_TEMPLATE_SCOPE,
    publisher === undefined ? [pack_slug] : [pack_slug, publisher],
  );

export interface InstalledPackReceptionTemplates {
  readonly listings: ReadonlyArray<PackReceptionTemplateListing>;
  readonly unavailable: ReadonlyArray<PackReceptionTemplateUnavailable>;
}

const byPackThenRef = (a: { pack_slug: string; ref: string }, b: { pack_slug: string; ref: string }): number =>
  a.pack_slug === b.pack_slug ? a.ref.localeCompare(b.ref) : a.pack_slug.localeCompare(b.pack_slug);

/** Read every persisted pack template for `reception.template.list`,
 *  re-validated against the CURRENT rules and the row's own pack. Deterministic
 *  order (pack slug, then ref) so the wire shape is stable across scans. */
export const listInstalledPackReceptionTemplates = (
  store: ContractStore,
): InstalledPackReceptionTemplates => {
  const listings: Array<PackReceptionTemplateListing & { ref: string }> = [];
  const unavailable: Array<PackReceptionTemplateUnavailable & { ref: string }> = [];
  for (const row of store.scan(INSTALLED_RECEPTION_TEMPLATE_SCOPE)) {
    // The row's KEY is its recoverable identity — `[pack_slug, publisher,
    // template_name]` — so even a row whose value is malformed is reported,
    // never silently skipped (an audit found the value-only reading dropped
    // an envelope with `publisher: ""` from BOTH arrays).
    const [keySlug, keyPublisher, keyName] = row.segments;
    const value = isRecord(row.value) ? row.value : {};
    const pack_slug = readString(value.pack_slug) ?? readString(keySlug) ?? '(unknown pack)';
    const publisher = readString(value.publisher) ?? readString(keyPublisher) ?? '(unknown publisher)';
    const template_ref = readString(value.template_ref)
      ?? `pack:${publisher}/${pack_slug}/intake/${readString(keyName) ?? '(unknown)'}`;
    const identityIntact = isRecord(row.value)
      && readString(value.pack_slug) === keySlug
      && readString(value.publisher) === keyPublisher;
    if (!identityIntact) {
      unavailable.push({ ref: template_ref, template_ref, pack_slug, reason: 'template_shape_invalid' });
      continue;
    }
    const parsed = parsePackIntakeFormTemplate(value.template, { publisher, slug: pack_slug });
    // The envelope's ref must be the template's own ref — the listing is
    // ordered and resolved by it, so a disagreeing envelope is not admitted.
    if (parsed.ok && parsed.template.template_ref !== template_ref) {
      unavailable.push({ ref: template_ref, template_ref, pack_slug, reason: 'pack_template_ref_invalid' });
      continue;
    }
    if (parsed.ok) {
      listings.push({
        ref: template_ref,
        template: parsed.template,
        pack_slug,
        publisher,
        pack_name: readString(value.pack_name) ?? pack_slug,
        pack_version: readVersion(value.pack_version),
      });
    } else {
      unavailable.push({
        ref: template_ref,
        template_ref,
        pack_slug,
        reason: parsed.failures[0]!.code,
      });
    }
  }
  listings.sort(byPackThenRef);
  unavailable.sort(byPackThenRef);
  return {
    listings: listings.map(({ ref: _ref, ...listing }) => listing),
    unavailable: unavailable.map(({ ref: _ref, ...entry }) => entry),
  };
};
