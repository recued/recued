/**
 * D-167 P4 — recipe-mode `pii-protect` / `pii-restore` transforms.
 *
 * The recipe-callable unified path for the reversible PII alias comfort layer.
 * They wrap the SAME alias substrate (`aliasFields` / `scanContent` /
 * `restoreArgs`) the chat-mode Gateway egress aliaser uses (D-167 P1), but the
 * ledger lives in a pure-RAM run-local store (`PiiLedgerStore`) keyed by an
 * opaque `ledger_handle` rather than a session. A recipe opts in explicitly by
 * tagging fields on the `pii-protect` step — `MetaField.privacy` is never
 * inspected here; the recipe author chooses which fields are PII.
 *
 *   pii-protect: { data, fields? }        → { aliased, ledger_handle }
 *   pii-restore: { data, ledger_handle }  → { restored }
 *
 * A recipe replaces a `hash_replace` / `hash_restore` pair with `pii-protect` /
 * `pii-restore` to hand the LLM typed aliases (`pii.Person1`, `m1@d1.invalid`,
 * `pii.Phone1.gb`) it can reason over, instead of opaque hash tokens.
 * `hash_replace` / `hash_restore` stay as the escape hatch for non-aliasable
 * PII (signing keys, free-form blobs with no kind that fits the 9-kind enum).
 * See D-167 §Transform exports.
 *
 * Hard invariant — restoration must not fail. An unknown / dropped handle, an
 * unknown alias, or a non-aliasable value all pass through unchanged; the
 * transforms never throw on the restore path. Aliasing is allowed to miss
 * (comfort tradeoff); restore must round-trip every alias the substrate emits.
 */
import { isEntityFieldPrivacy } from '@recued/contracts';
import type { PiiAliasableData, PiiFieldTag } from '@recued/contracts';

import {
  aliasFields,
  aliasFieldsBatch,
  scanContent,
  preScanReservePii,
  restoreArgs,
  getFallbackPiiLedgerStore,
  type Ledger,
  type PiiLedgerStore,
} from './pii-alias.js';
import type { TransformContext, TransformFn } from './types.js';

/** The engine threads a per-run store; standalone callers (unit tests, any
 *  non-engine host) fall back to the process singleton so the protect→restore
 *  round-trip still works. */
const resolveStore = (ctx: TransformContext): PiiLedgerStore =>
  ctx.piiLedgerStore ?? getFallbackPiiLedgerStore();

/** Validate the `pii-protect` field tags, FAILING CLOSED (D-167 safe-feature
 *  rule: "if we can't protect what was asked, don't pretend to"). Absent /
 *  empty `fields` is a valid no-op (nothing to alias). But a *present* tag that
 *  the alias substrate could not honor — a non-`{ path, kind }` entry, a
 *  missing / empty / non-string `path`, or a `kind` outside the 9-kind
 *  `EntityFieldPrivacy` enum — THROWS rather than being silently dropped. The
 *  engine surfaces the throw as `TRANSFORM_ERROR` and halts the run on the
 *  `pii-protect` step, BEFORE the downstream AI step, so a typo'd tag can never
 *  let raw PII reach the LLM under the illusion of protection. The recipe
 *  validator's `pii_protect_bad_field_tag` error catches this statically too;
 *  this is the runtime backstop for a tag that only resolves at run time. */
const requireFieldTags = (raw: unknown): PiiFieldTag[] => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('pii-protect `fields` must be an array of { path, kind } tags');
  }
  return raw.map((f, i) => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      throw new Error(`pii-protect fields[${i}] must be a { path, kind } object`);
    }
    const path = (f as { path?: unknown }).path;
    const kind = (f as { kind?: unknown }).kind;
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error(`pii-protect fields[${i}] needs a non-empty 'path' string`);
    }
    if (!isEntityFieldPrivacy(kind)) {
      // Do NOT echo the kind VALUE: transform params are resolved before the
      // transform runs, so a `{{ref}}`-derived kind could carry real data into
      // StepLog.error / the UI. The index localizes the bad tag; the recipe
      // validator (which sees the static literal, not resolved data) is free to
      // name the value.
      throw new Error(
        `pii-protect fields[${i}] has a kind outside the 9 privacy kinds `
        + '(email/name/org/phone/address/url/external_id/account_id/content)',
      );
    }
    return { path, kind };
  });
};

/**
 * Alias one non-array unit of `data` against the run-local ledger:
 *   - object  → `aliasFields` two-pass over the tagged dot-paths
 *   - string  → `scanContent` against the ledger (a no-op until the ledger has
 *               entries — a bare string carries no taggable path of its own)
 *   - other   → passed through unchanged (numbers, booleans, null)
 * Top-level arrays do NOT come here — they go through `aliasFieldsBatch`, which
 * runs a list-wide two-pass so element order can't leave PII raw.
 */
const protectUnit = (
  ledger: Ledger,
  unit: unknown,
  fields: readonly PiiFieldTag[],
  knownValues: TransformContext['piiKnownValues'],
): unknown => {
  if (typeof unit === 'string') return scanContent(ledger, unit).text;
  if (unit !== null && typeof unit === 'object' && !Array.isArray(unit)) {
    return aliasFields(ledger, unit as PiiAliasableData, fields, undefined, knownValues);
  }
  return unit;
};

export const piiProtect: TransformFn = (p, ctx) => {
  const data = p.data as PiiAliasableData;
  const fields = requireFieldTags(p.fields);
  const { handle, ledger } = resolveStore(ctx).create();

  // D-167 Slice 3 — reserve/escape any user-typed `pii.*` literal in the data
  // BEFORE the alias pass (whole value, ONCE), so a literal that happens to equal
  // an alias this run mints round-trips through `pii-restore` instead of
  // un-aliasing into a real value. Run here, not inside `aliasFields` /
  // `aliasFieldsBatch` (a batch invokes the per-element aliasers repeatedly).
  const scanned = preScanReservePii(ledger, data).value;

  // A top-level array is a D-162 batch — one shared ledger across items, so
  // identical real values across items collapse to one alias number; `fields`
  // paths are relative to EACH element. `aliasFieldsBatch` runs a list-wide
  // two-pass (all identifier fields, THEN all content) so the shared ledger is
  // fully populated before any content scan — no element-order PII leak. A
  // single value is aliased directly. A `content` tag is also matched against
  // the host's known values (`ctx.piiKnownValues`, D-316 amendment); if that
  // match cannot complete, this throws before anything is emitted.
  const aliased = Array.isArray(scanned)
    ? aliasFieldsBatch(ledger, scanned, fields, undefined, ctx.piiKnownValues)
    : protectUnit(ledger, scanned, fields, ctx.piiKnownValues);

  return { aliased, ledger_handle: handle };
};

export const piiRestore: TransformFn = (p, ctx) => {
  const handle = typeof p.ledger_handle === 'string' ? p.ledger_handle : '';
  const ledger = handle ? resolveStore(ctx).get(handle) : undefined;
  // Unknown / dropped handle → pass the data through verbatim. The ledger is
  // gone once the originating run ended; restoring is then a no-op, never an
  // error (hard invariant — restore must not fail).
  if (!ledger) return { restored: p.data };
  // `restoreArgs` walks strings / objects / arrays uniformly, so one call
  // covers the single-value AND the D-162 batch-list shapes.
  return { restored: restoreArgs(ledger, p.data as PiiAliasableData) };
};
