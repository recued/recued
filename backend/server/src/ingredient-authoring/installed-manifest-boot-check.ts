/** D-259 § 0.1.1 — the boot check that tells the owner an installed pack no
 *  longer runs.
 *
 *  ⛔ THE FAILURE THIS EXISTS FOR HAS NO SYMPTOM UNTIL SOMEBODY USES IT.
 *  Deleting the legacy CLI decoders made three declaration shapes rejected
 *  rather than tolerated — unsupervised detach, supervision without readiness,
 *  and progress with no `stall_ms`. A pack installed BEFORE that release keeps
 *  its old manifest on disk, so the op does not break at update time; it breaks
 *  the next time a recipe calls it, as an error about a binding the owner never
 *  wrote and cannot see.
 *
 *  The launch-safe boot reconciler repairs the closed, hash-pinned D-259
 *  transition set before this check runs. This is the fallback for everything
 *  it cannot prove safe: a malformed/tampered body, a non-ledger version, or a
 *  future update that still needs owner review.
 *
 *  ⛔ THIS CHECK STILL DOES NOT FIX. A general reinstall can change the
 *  operation set a grant was scoped for, which is the owner's decision. The
 *  reconciler is allowed to act only after its separate transition ledger,
 *  target hash, body class, and authority-equivalence checks all pass. Anything
 *  else reaches this reporter and stops here.
 *
 *  🔑 IT CALLS THE VALIDATOR RATHER THAN RE-STATING ITS RULES. A second copy of
 *  "what counts as legacy" would drift from the first, and the drift would show
 *  up as a boot check that stays quiet about the exact shape publication now
 *  refuses. `validateIngredient` is the one definition; this only decides WHEN
 *  to ask it and WHO to tell.
 */

import { validateIngredient } from '@recued/ingredients';
import type { IngredientManifest } from '@recued/contracts';

/** One installed manifest the current runtime would refuse to publish. */
export interface UnrunnableInstalledManifest {
  slug: string;
  version?: number;
  /** Stable validator codes, deduped — e.g. `CLI_LEGACY_UNSUPERVISED_DETACH`. */
  codes: string[];
  /** The first message, for a log line a human can act on. */
  detail: string;
}

export interface InstalledManifestBootCheckPorts {
  /** Every current-version installed manifest (`LocalManifestStore`). */
  listManifests: () => IngredientManifest[];
  /** Best-effort operator notify. Never throws, never blocks boot. */
  notify?: (message: string) => void;
  /** Durable record, so the finding survives a log rotation. */
  audit?: (entry: { slug: string; codes: string[]; detail: string }) => void;
  log?: (message: string) => void;
}

/** Pure judgement: which installed manifests would the CURRENT validator
 *  reject? Separated from the reporting so the decision is testable without a
 *  store, a clock or an audit sink. */
export const findUnrunnableInstalledManifests = (
  manifests: ReadonlyArray<IngredientManifest>,
): UnrunnableInstalledManifest[] => {
  const out: UnrunnableInstalledManifest[] = [];
  for (const manifest of manifests) {
    // ⚠ Guard the SHAPE before the judgement. A non-object row cannot be
    // reported ("which pack?") and must not crash the sweep of the packs that
    // can — one unreadable row should never hide every other finding.
    if (manifest === null || typeof manifest !== 'object') continue;
    const slug = (manifest as { slug?: unknown }).slug;
    if (typeof slug !== 'string' || slug.length === 0) continue;
    let result;
    try {
      result = validateIngredient(manifest);
    } catch {
      // ⚠ A validator throw is NOT a finding. It means we could not judge this
      // manifest, which is a different fact from "this manifest is broken", and
      // reporting it as the latter would send the owner to reinstall a pack
      // that is fine. Skip it; a real problem still surfaces at dispatch.
      continue;
    }
    const errors = (result.issues ?? []).filter((issue) => issue.severity === 'error');
    if (errors.length === 0) continue;
    const codes = [...new Set(errors.map((issue) => String(issue.code)))].sort();
    out.push({
      slug,
      ...(typeof manifest.version === 'number' ? { version: manifest.version } : {}),
      codes,
      detail: String(errors[0]?.message ?? ''),
    });
  }
  return out;
};

/** Run the check and report. Returns what it found so a caller can assert on
 *  it; never throws, because a boot check that can fail boot is worse than the
 *  drift it looks for. */
export const checkInstalledManifestsOnBoot = (
  ports: InstalledManifestBootCheckPorts,
): UnrunnableInstalledManifest[] => {
  const log = (message: string): void => {
    try {
      ports.log?.(message);
    } catch { /* reporting is evidence, never authority over boot */ }
  };
  let found: UnrunnableInstalledManifest[] = [];
  try {
    found = findUnrunnableInstalledManifests(ports.listManifests());
  } catch (err) {
    log(
      '[packs] installed-manifest boot check could not run: '
        + (err instanceof Error ? err.message : String(err)),
    );
    return [];
  }
  if (found.length === 0) return [];

  // The log line names the FIX, not just the fault: the owner cannot infer
  // "reinstall from Discover" from a validator code.
  log(
    `[packs] ⛔ ${found.length} installed pack(s) declare shapes this server no `
      + 'longer runs. Their operations will fail when called. Update them in '
      + 'Discover (Settings → Packs) to the current version:',
  );
  for (const row of found) {
    const at = row.version === undefined ? '' : ` v${row.version}`;
    log(`[packs]    ${row.slug}${at} — ${row.codes.join(', ')}: ${row.detail}`);
    try {
      ports.audit?.({ slug: row.slug, codes: row.codes, detail: row.detail });
    } catch { /* audit is evidence, never authority over boot */ }
  }
  try {
    ports.notify?.(
      `${found.length} installed pack(s) need updating: `
        + `${found.map((r) => r.slug).join(', ')}. Their operations fail until you `
        + 'update them in Settings → Packs.',
    );
  } catch { /* best-effort */ }
  return found;
};

// ────────────────────────────────────────────────────────────────
// Reaching the owner
// ────────────────────────────────────────────────────────────────

/** Deliver one owner-facing notification. Fire-and-forget by contract — the
 *  block's `notify`, not its `ask`. */
export type NotifyUnrunnablePacks = (
  message: { title?: string; text: string; link_url?: string },
) => Promise<void>;

/** ⛔ A CONSOLE LINE IS NOT REACHING ANYONE. The check above writes to the
 *  server log, which is exactly the wrong channel for the case it exists to
 *  serve: an UNATTENDED server whose owner is not tailing logs. The reconciler
 *  now repairs everything it can prove safe, so what survives to here is
 *  precisely the set a machine declined to fix — the set a human must see.
 *
 *  🔑🔑 A NOTIFICATION, NOT AN ASK — AND THE DIFFERENCE IS NOT COSMETIC.
 *  Nothing here is being approved. This shipped as an `ask` for ONE reason,
 *  and it was the wrong reason: `ask` is the only DURABLE delivery on the
 *  block (`notify` is fire-and-forget), so an ask was used to buy persistence
 *  for a finding nobody may be connected to receive. That put an error report
 *  in the owner's queue of pending DECISIONS, and it showed:
 *    - open asks accumulate, so a restart-dedup had to be written to stop the
 *      same finding minting a new row every boot;
 *    - a one-option ask needed a no-op answer handler registered purely so a
 *      dismissal could complete;
 *    - and answering it CLEARED the finding while the packs stayed broken —
 *      an ask is done when answered, but this condition is true until fixed.
 *
 *  🔑 THE DURABILITY BELONGS TO THE CONDITION, NOT THE MESSAGE. "These packs
 *  will not run" is a STANDING STATE, re-derivable at any moment from
 *  `findUnrunnableInstalledManifests` — so it is carried by the Packs surface
 *  (`packs.unrunnable` rpc + the list's broken state), where it cannot drift,
 *  cannot pile up, and cannot be dismissed while still true. This function is
 *  then free to be what it always was: the heads-up.
 *
 *  Consent still happens later and better — at the moment the owner actually
 *  updates, where `packs.install_preview` renders `owner_operation_review` and
 *  the dialog asks them to re-rule any operation whose identity moved (D-211
 *  slice 5). Asking here would be asking about a change they have not chosen.
 *
 *  ⚠ Returns false when nothing is wrong, so a healthy boot says NOTHING. */
export const notifyUnrunnablePacks = async (
  found: ReadonlyArray<UnrunnableInstalledManifest>,
  notify: NotifyUnrunnablePacks,
  /** ⚠ OPTIONAL BECAUSE THE BASE URL IS, NOT BECAUSE THE ROUTE IS.
   *
   *  🔑 An earlier revision of this comment claimed no URL could be built here
   *  at all, reasoning from ONE helper (`buildOwnerSurfaceLink` is per-RECIPE)
   *  instead of asking whether the server knows its own address. It does:
   *  `#packs/<slug>` is a real parsed webclient address
   *  (`serializeShellRoute('packs', slug)` → `parsePacksAddress`), and
   *  `buildPacksSurfaceLink` mints it absolute from the same
   *  `RECUED_PUBLIC_BASE_URL` its sibling uses — a boot-time fact available
   *  well before this call site. The composition root passes one whenever the
   *  server HAS a public base.
   *
   *  ⛔ Still absent on a non-public server, and that absence is deliberate, not
   *  a gap: `execute-handler.ts:3014` — "a dead link in the only notification
   *  the owner gets reads as 'nothing here' and as 'couldn't find it' at the
   *  same time — no link at all is the honest version." The named packs still
   *  say where to go. */
  packs_link_url?: string,
): Promise<boolean> => {
  if (found.length === 0) return false;
  const slugs = found.map((row) => row.slug);
  // Name them. "Some packs need attention" sends the owner hunting through a
  // list; naming them is the difference between a notice and an instruction.
  const named = slugs.slice(0, 3).join(', ');
  const rest = slugs.length > 3 ? ` and ${slugs.length - 3} more` : '';
  try {
    await notify({
      title: 'Packs need updating',
      text:
        found.length === 1
          ? `${named} no longer runs on this server. Its actions will fail until you update it.`
          : `${named}${rest} no longer run on this server. Their actions will fail until you update them.`,
      ...(packs_link_url !== undefined ? { link_url: packs_link_url } : {}),
    });
    return true;
  } catch {
    // ⚠ Best-effort, like every other boot-time notify. A notification stack
    // that is not up yet must not turn a startup into a failed startup — the
    // log line from the check above still stands, and the Packs surface holds
    // the same finding durably.
    return false;
  }
};
