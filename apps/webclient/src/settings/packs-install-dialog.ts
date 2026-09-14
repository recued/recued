/** Packs R22 R2 — the pack install/consent dialog RENDER, extracted from
 *  `packs-panel.ts` (the 3.4K-line panel keeps growing surfaces; R3 adds the
 *  by-PACK Access panel next).
 *
 *  ── The extraction boundary (deliberate — read before widening) ─────
 *  This module owns the dialog's PRESENTATION: the render, its attribute
 *  constants, its copy, the install failure-code copy map, and the
 *  Access-tier clamp. The dialog STATE MACHINE stays in `packs-panel.ts` —
 *  `dialogOpenFor` / `installing` / the permission + grant-tier maps and
 *  their SIX manipulation sites (open · Cancel-close · select-pack collapse
 *  · delete-strip collapse · Add-a-pack collapse-then-open · refresh
 *  reconciliation) are each subtly DIFFERENT (which maps clear, whether the
 *  pending Add entry drops, whether the in-flight promise resets), and they
 *  interlock with panel-owned state (delete strip, Add-a-pack entry, Slice K
 *  disclosure, DD#10 single-rpc-at-a-time). Unifying them behind a controller
 *  interface would relocate — not reduce — that complexity, and asymmetric
 *  gates are exactly where an extraction silently regresses. So: render out,
 *  state stays. Mirrors the folder's established sibling shape
 *  (`install-grant-picker.ts` — pure model + render, host owns state).
 *
 *  The panel re-exports the attribute constants so existing consumers
 *  (tests, hosts) keep importing them from `packs-panel.ts`. */

import type {
  BulkPackInstallResultLike,
  BulkPackManifest,
  ConnectionRequirement,
  EndpointCandidate,
  InstallAccessTier,
  InstallAudienceSelection,
  InstallScopeWho,
  PackListEntry,
} from '@recued/contracts';
// Same byte formatter the Records explorer uses — these are the same quota
// ceilings, shown one screen earlier.
import { formatPressureBytes } from '@recued/contracts';
import {
  installGrantModelFromManifest,
  renderInstallGrantPicker,
  resolveInstallAudienceSelection,
  type InstallAudienceOption,
  type InstallGrantPickerModel,
} from './install-grant-picker.js';
import { renderInstallConnectPicker } from './install-connect-picker.js';
import {
  groupCollisionsByOtherPack,
  type PackRecipeCollision,
} from './packs-collisions.js';
import type { PackGrantOverlap } from './packs-grant-overlap.js';

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for DOM tests + host introspection
// (moved from packs-panel.ts with the render; the panel re-exports them)
// ════════════════════════════════════════════════════════════════

export const PACKS_DIALOG_ATTR = 'data-recued-packs-dialog';
export const PACKS_DIALOG_SLUG_ATTR = 'data-recued-packs-dialog-slug';
export const PACKS_DIALOG_PERMISSION_ATTR = 'data-recued-packs-dialog-permission';
/** D-247 D15 — the "installing makes N recipes reachable" disclosure. Carries
 *  `data-count`, and each row carries `data-recipe` + `data-class`, so a test can
 *  assert the NAMES and the D10 class rather than a rendered sentence. */
export const INSTALL_RECIPE_DISCLOSURE_ATTR = 'data-recued-install-recipe-disclosure';
export const PACKS_DIALOG_BODY_GRANT_ATTR = 'data-recued-packs-dialog-body-grant';
export const PACKS_DIALOG_INSTALL_BTN_ATTR = 'data-recued-packs-dialog-install';
export const PACKS_DIALOG_CANCEL_BTN_ATTR = 'data-recued-packs-dialog-cancel';
export const PACKS_DIALOG_ERROR_ATTR = 'data-recued-packs-dialog-error';
/** D-223 — marks the hint-only pack's connection disclosure, carrying the
 *  connection slug as its value. */
export const PACKS_DIALOG_CONNECT_HINT_ATTR = 'data-pack-connect-hint';
// D-145 PA10 follow-on Slice C — dialog-level callout listing per-other-pack
// collision groups; per-group value = the OTHER pack's slug; per-recipe
// inline marker value = the colliding recipe slug.
export const PACKS_DIALOG_COLLISION_ATTR = 'data-recued-packs-dialog-collision';
export const PACKS_DIALOG_COLLISION_GROUP_ATTR =
  'data-recued-packs-dialog-collision-group';
export const PACKS_DIALOG_RECIPE_COLLISION_ATTR =
  'data-recued-packs-dialog-recipe-collision';
// D-145 PA10 follow-on Slice J — install-side cross-pack body-grant overlap
// callout ("already accessible via X"); each `<li>` carries the grant key.
export const PACKS_DIALOG_GRANT_OVERLAP_ATTR =
  'data-recued-packs-dialog-grant-overlap';
export const PACKS_DIALOG_GRANT_OVERLAP_ITEM_ATTR =
  'data-recued-packs-dialog-grant-overlap-item';
// D-211 Slice 5 — update merge-card for global owner rulings whose stamped
// operation changed or disappeared in the incoming pack.
export const PACKS_DIALOG_OWNER_OPERATION_REVIEW_ATTR =
  'data-recued-packs-dialog-owner-operation-review';
export const PACKS_DIALOG_OWNER_OPERATION_REVIEW_ITEM_ATTR =
  'data-recued-packs-dialog-owner-operation-review-item';
export const PACKS_DIALOG_RECORDS_REVIEW_ATTR =
  'data-recued-packs-dialog-records-review';
export const PACKS_DIALOG_RECORDS_REVIEW_CHANGE_ATTR =
  'data-recued-packs-dialog-records-review-change';
export const PACKS_DIALOG_RECORDS_REVIEW_DESTRUCTIVE_ATTR =
  'data-recued-packs-dialog-records-review-destructive';

/** Permission slug that is always required for any bulk-pack install.
 *  Mirrors `BULK_PACK_INSTALL_PERMISSION` in `@recued/contracts`; inlined so
 *  the dialog renders a never-uncheckable checkbox row without a runtime dep
 *  on the contracts symbol. The panel imports it to SEED the default-checked
 *  permission set (DD#3) and to refuse un-toggling it. */
export const ALWAYS_REQUIRED_PERMISSION = 'install_bulk_pack';

/** Slice J — the " — also via pack-a, pack-b" suffix shared by the INSTALL
 *  overlap callout (here) and the panel's DELETE-strip overlap callout, so
 *  the two surfaces read parallel and cannot drift. */
export const GRANT_OVERLAP_ALSO_VIA_PREFIX = ' — also via ';

// ════════════════════════════════════════════════════════════════
// Copy
// ════════════════════════════════════════════════════════════════

const DIALOG_COPY = {
  eyebrow: 'Setting up this Pack',
  update_eyebrow: 'Pack update',
  heading_prefix: 'Install ',
  update_heading_prefix: 'Update ',
  intro:
    'Look at what this Pack adds, then choose what it may connect to and what it may do.',
  update_intro:
    'Look at what this update changes, then say what it may connect to and what it may do.',
  permissions_label: 'This Pack needs:',
  body_grants_label: 'This Pack will be able to read:',
  recipes_label_prefix: 'Will install ',
  recipes_label_suffix: ' recipes:',
  no_recipes: 'No Recipes to install.',
  required_permission_note: '(always required)',
  install_label: 'Install',
  installing_label: 'Installing…',
  update_label: 'Update',
  updating_label: 'Updating…',
  cancel_label: 'Cancel',
  // Slice C — cross-pack collision copy.
  collision_heading: '⚠ Recipe slug overlap with other packs:',
  collision_followup:
    'Installing this Pack replaces anything with the same name. Removing either Pack takes those away for good.',
  recipe_collision_prefix: ' — also in ',
  // Slice J — install-side overlap copy (additive framing).
  grant_overlap_heading:
    'Other Packs you have installed can already read this:',
  owner_operation_review_heading: 'Rules that apply everywhere',
  owner_operation_review_intro:
    'This update changes things you have already set rules for. Your rules still apply everywhere afterwards.',
  owner_operation_review_removed:
    'If something is removed, your rule for it is kept but does nothing, unless it comes back.',
  records_review_heading: 'What happens to your records',
} as const;

/** Failure-code → copy mapping for the engine's `BulkPackInstallResult.
 *  failure.code`. The exhaustive Record forces a copy decision when the
 *  engine grows a new failure code. */
const INSTALL_FAILURE_COPY: Record<
  NonNullable<BulkPackInstallResultLike['failure']>['code'],
  string
> = {
  permission_denied:
    'Recued did not install it: you did not allow something it needs.',
  version_mismatch:
    'Recued did not install it: your server expects a different version.',
  review_stale:
    'This Pack changed after you looked at it. Load the page again and look at the new one.',
  validator_rejected:
    'Recued did not install it: the Pack did not pass its checks.',
  unresolved:
    'Recued did not install it: it could not find one or more of the Recipes.',
  unexpected:
    'Recued did not install it: something went wrong.',
};

/** User-facing copy for an `ok: false` install outcome. Defensive on both
 *  edges (Codex MINOR 4 fold): an unknown code (server/webclient version
 *  skew) surfaces the raw code in a generic message instead of rendering
 *  `undefined`; a missing code surfaces the generic unknown-failure line. */
export const installFailureCopy = (code: string | undefined, detail?: string): string => {
  const head = code === undefined
    ? 'Recued did not install it, and does not know why.'
    : INSTALL_FAILURE_COPY[code as keyof typeof INSTALL_FAILURE_COPY]
      ?? `Recued did not install it: ${code}.`;
  // ⛔ The engine ships a SPECIFIC reason next to the code and this dropped it.
  // "the manifest failed substrate validation" is unactionable; the message
  // behind it was `recipe 'delete-billable-item': Tier-P op
  // 'recued-core.billable-hours.entry.get' … has no resolved catalog binding`,
  // which names the pack, the recipe, the step and the op. Recovering that took
  // a server-side probe — a self-hoster has no such option, and the code alone
  // told them nothing at all.
  const extra = (detail ?? '').trim().replace(/^packs\.install:\s*/, '');
  return extra === '' ? head : `${head} ${extra}`;
};

/** D-182 §7.1 (inc 5b.2) — the Access tier the install rpc will send for a
 *  connection-backed pack: the owner's raw pick, clamped to a tier the model
 *  actually offers, else the model default (`read`). The panel's
 *  `setGrantAccessInternal` already rejects an unoffered pick; this keeps the
 *  invariant explicit at every read site (render, submit, the
 *  `getDialogAccessTier` seam) — belt-and-suspenders symmetric with the
 *  kitchen path's clamp. */
export const resolveInstallDialogAccess = (
  picked: InstallAccessTier | undefined,
  model: InstallGrantPickerModel,
): InstallAccessTier =>
  picked !== undefined && model.accessOptions.includes(picked)
    ? picked
    : model.defaultAccess;

/** D-182 §7.2 — the effective scope: the owner's pick, or `owner` (the safe
 *  default) when none was made yet. The scope options are fixed by
 *  `InstallScopeWho`, so — unlike access — there is no model-derived clamp. */
export const resolveInstallDialogScope = (
  picked: InstallScopeWho | undefined,
): InstallScopeWho => picked ?? 'owner';

export const resolveInstallDialogAudience = (
  picked: InstallAudienceSelection | undefined,
): InstallAudienceSelection => resolveInstallAudienceSelection(picked);

// ════════════════════════════════════════════════════════════════
// Render
// ════════════════════════════════════════════════════════════════

/** D-247 D15 — one row of the server-resolved install preview. */
export interface InstallPreviewRecipe {
  readonly publisher_id: string;
  readonly recipe_id: string;
  readonly name: string;
  readonly grant_class: 'constraining' | 'read_adapter' | 'open_adapter' | 'unknown';
  readonly top_risk: 'read' | 'write' | 'admin' | 'destructive' | null;
  readonly operation_ids: readonly string[];
}

/** D-247 D15 — the disclosure list, and D15.1's per-recipe tier.
 *
 *  ⛔ `resolved: false` ⇒ the dialog renders NOTHING rather than a count it
 *  cannot verify, and the picker falls back to the flat read tier. */
export interface InstallPreview {
  readonly resolved: boolean;
  readonly will_enable: readonly InstallPreviewRecipe[];
  readonly hidden_count: number;
}

/** D-247 D10 — the consent line for one recipe the install will enable.
 *
 *  ⛔⛔ THE VERB GOES BEFORE THE TIER, and the "still asks" clause is not
 *  optional. `key-identity-brief-honeycomb` wraps `auth.read` at ADMIN tier and
 *  is a read-only brief — "grants auth.read (admin)" is TRUE and reads far
 *  scarier than the act. And every sentence in this class describes what the AI
 *  can now SEE AND CALL, never what the owner has approved: a contract grant is
 *  ACCESS, and the refund still asks. Without the trailing clause, "grants
 *  destructive" is read as consent to the act by exactly the owner this copy
 *  exists for. */
export const recipeConsentLine = (r: InstallPreviewRecipe): string => {
  if (r.grant_class === 'constraining') {
    return `${r.name} — a narrower capability than the operations it uses`;
  }
  if (r.grant_class === 'unknown') {
    // ⚠ Honest blank over a confident wrong label: what this reaches could not
    // be derived, and guessing would be a sentence the owner acts on.
    return `${r.name} — what this can reach could not be determined`;
  }
  const op = r.operation_ids[0] ?? 'its operation';
  const tier = r.top_risk ?? 'read';
  const verb = tier === 'read' ? 'read' : tier === 'write' ? 'write' : tier === 'admin' ? 'administer' : 'destroy';
  return r.grant_class === 'read_adapter'
    ? `${r.name} — lets the AI ${verb} via \`${op}\` (${tier}) with no added constraint`
    : `${r.name} — lets the AI ${verb} via \`${op}\` (${tier}) with no added constraint; each call still asks`;
};

/** D-247 D15 — name the recipes, never just a number. "3 recipes will be
 *  enabled" tells the owner nothing they can act on; the names are what let them
 *  cancel or go tighten one afterwards. */
const renderInstallRecipeDisclosure = (
  doc: Document,
  recipes: readonly InstallPreviewRecipe[],
): HTMLElement => {
  const box = doc.createElement('div');
  box.setAttribute(INSTALL_RECIPE_DISCLOSURE_ATTR, '');
  box.setAttribute('data-count', String(recipes.length));
  box.className = 'pid-recipe-disclosure';
  const head = doc.createElement('p');
  head.className = 'pid-recipe-disclosure-head';
  // ⚠ "reachable", not "approved" — the grant is ACCESS and nothing else.
  head.textContent = recipes.length === 1
    ? 'Installing lets the AI use 1 Recipe:'
    : `Installing lets the AI use ${recipes.length} Recipes:`;
  box.appendChild(head);
  const list = doc.createElement('ul');
  list.className = 'pid-recipe-disclosure-list';
  for (const r of recipes) {
    const li = doc.createElement('li');
    li.setAttribute('data-recipe', r.recipe_id);
    li.setAttribute('data-class', r.grant_class);
    li.textContent = recipeConsentLine(r);
    list.appendChild(li);
  }
  box.appendChild(list);
  return box;
};

export interface PacksInstallDialogProps {
  /** D-247 D15 — the server-resolved preview. Absent ⇒ no disclosure and the
   *  flat read tier, which is exactly the pre-D-247 behaviour. */
  installPreview?: InstallPreview;
  /** DOM document seam (mirrors the panel's). */
  document: Document;
  /** ⛔ Must carry a `manifest`. The consent surface renders the pack's recipes,
   *  grant model and body grants — none of which exist without one, and
   *  `packs.list` now forwards it for INSTALLED packs only. The panel resolves an
   *  uninstalled pack through `ensureDetailResolved` (→ `packs.resolveBySlug`,
   *  bundled-first) before opening, so the requirement is stated here rather than
   *  re-checked at three render sites. */
  pack: PackListEntry & { manifest: BulkPackManifest };
  /** Slice C — this pack's recipe collisions (undefined / empty ⇒ no
   *  callout, no per-recipe markers). */
  collision: PackRecipeCollision | undefined;
  /** Slice J — this pack's body-grant overlap with other INSTALLED packs. */
  grantOverlap: PackGrantOverlap | undefined;
  /** The active dialog's permission selection (host-seeded default-checked
   *  per DD#3; the render only reads it). */
  selection: ReadonlySet<string>;
  /** The owner's RAW Access-tier pick for this pack (undefined = none yet);
   *  clamped internally via {@link resolveInstallDialogAccess}. */
  accessPick: InstallAccessTier | undefined;
  /** The owner's independent audience checklist (undefined ⇒ owner-only). */
  audiencePick: InstallAudienceSelection | undefined;
  customerTierOptions?: readonly InstallAudienceOption[];
  contractOptions?: readonly InstallAudienceOption[];
  /** D-194 2b-2 — the (single, v1) connection this pack needs, or undefined when
   *  the pack declares none (then no Connect section renders). */
  connectionRequirement: ConnectionRequirement | undefined;
  /** D-223 — the connection slug this pack pre-fills, when it declares
   *  `connection_hints` but NO descriptor. Drives a one-line disclosure so the
   *  owner learns which connection the pack wants before granting anything.
   *
   *  ⚠ DISCLOSURE ONLY — not a route. An earlier revision claimed this prop was
   *  what made a third-party pack's hints reachable "at all"; that premise was
   *  wrong. The pack detail's Connections row already deep-links to the same
   *  enroll form, and unlike a link from here it fires when the pack is
   *  installed, which is the condition the pre-fill actually depends on. */
  connectionHintSetup: string | undefined;
  /** Endpoint-match candidates for the requirement (empty ⇒ enroll-only). */
  connectionCandidates: readonly EndpointCandidate[];
  /** The owner's picked connection name, or undefined = install without
   *  connecting (connect is optional — Model A). */
  chosenConnection: string | undefined;
  /** Whether the Connect section's "Use a different account" list is expanded. */
  connectExpanded: boolean;
  /** True while the install rpc is in flight (disables everything). */
  installing: boolean;
  /** DD#10 — true while a Delete rpc is mid-flight on any row (disables the
   *  Install button; Cancel stays enabled). */
  deleting: boolean;
  /** Inline error from the most recent failed submit, or null. */
  error: string | null;
  onTogglePermission(permission: string): void;
  onPickAccess(tier: InstallAccessTier): void;
  onPickAudience(audience: InstallAudienceSelection): void;
  /** D-194 2b-2 — pick a reuse candidate by name, or undefined to install
   *  without connecting. */
  onPickConnection(name: string | undefined): void;
  /** D-194 2b-2 — toggle the Connect section's collapsed/expanded reuse list. */
  onToggleConnectExpanded(): void;
  onSubmit(): void;
  onCancel(): void;
}

/** D-223 — the one-line disclosure a pack gets when it HINTS but declares no
 *  `connection_requirements`: it names the connection the pack wants, so the
 *  owner learns that before granting anything. Never the picker above — the
 *  picker offers adoption of an EXISTING connection, which is a capability a
 *  hint deliberately does not carry: filling a box the owner confirms is not the
 *  same act as proposing they reuse a credential enrolled for something else.
 *
 *  ⛔ AND NO SET-UP LINK FROM HERE — the reason this is its own function rather
 *  than four lines inline. An earlier revision put a link in, worded "setting it
 *  up now fills in what the publisher told us". Live-server run 2026-07-30: it
 *  does not, and cannot. `connections-enroll-panel` sources hints from INSTALLED
 *  packs (`ensurePacksLoaded` keeps only `p.installed`), and while THIS dialog
 *  is open the pack is by definition not installed yet — the linked form came up
 *  blank with no attribution, so the copy promised the one thing that route
 *  could not deliver. The pack DETAIL's "Set up →" row
 *  (`connections-readiness-controls`, which pre-dates D-223 and renders for a
 *  hint-only pack too) is the route that works, because by then the pack IS
 *  installed. So this discloses the connection and names that order instead of
 *  racing it. `d-223-connection-hint-disclosure.test.ts` pins both halves. */
export const renderConnectionHintDisclosure = (
  doc: Document,
  connection: string,
): HTMLElement => {
  const section = doc.createElement('section');
  section.className = 'packs-dialog-connect';
  section.setAttribute(PACKS_DIALOG_CONNECT_HINT_ATTR, connection);
  const line = doc.createElement('p');
  line.className = 'packs-dialog-summary';
  line.textContent =
    `This Pack connects to ${connection}. Install it first — the pack's Connections `
    + 'row opens a form already filled in with what the publisher suggested, '
    + 'and you can change anything before you save.';
  section.appendChild(line);
  return section;
};

/** Build the inline install/consent dialog for one pack. Pure DOM
 *  construction over the props — all state reads and every mutation flow
 *  through the host callbacks, so the panel's state machine stays the single
 *  writer. */
export const renderPacksInstallDialog = (
  props: PacksInstallDialogProps,
): HTMLElement => {
  const doc = props.document;
  const { pack, collision, grantOverlap, installing } = props;
  const isUpdate = pack.installed_any_version === true && !pack.installed;
  const container = doc.createElement('section');
  container.setAttribute(PACKS_DIALOG_ATTR, '');
  container.setAttribute(PACKS_DIALOG_SLUG_ATTR, pack.slug);
  container.className = 'packs-dialog';
  // Slice C — index colliding recipe slugs for the per-recipe inline
  // marker. Built once per render so the recipe loop is O(1) per row.
  // Map value carries the other-pack slugs the user sees in the
  // marker ("also in pack-x, pack-y"). Empty when no collisions.
  const collidingRecipeMarkers = new Map<string, ReadonlyArray<string>>();
  if (collision !== undefined) {
    for (const entry of collision.recipes) {
      collidingRecipeMarkers.set(entry.slug, entry.otherPackSlugs);
    }
  }
  // Codex review fold (MINOR 6) — ARIA dialog semantics. The
  // surface is an inline expansion (not a modal), but it IS a
  // disclosure region the user can interact with separately from
  // the surrounding pack list, so `role='region'` + an
  // `aria-labelledby` pointing at the heading lets screen readers
  // announce it as a discrete section. The heading carries an id
  // (`packs-dialog-heading-<slug>`) so re-renders for the same pack
  // keep the labelledby reference stable; collision across packs is
  // impossible because the DD#2 single-row invariant means only one
  // dialog renders at a time.
  container.setAttribute('role', 'region');
  container.tabIndex = -1;
  const headingId = `packs-dialog-heading-${pack.slug}`;
  container.setAttribute('aria-labelledby', headingId);

  const eyebrow = doc.createElement('p');
  eyebrow.className = 'packs-dialog-eyebrow';
  eyebrow.textContent = isUpdate
    ? DIALOG_COPY.update_eyebrow
    : DIALOG_COPY.eyebrow;
  container.appendChild(eyebrow);

  const heading = doc.createElement('h4');
  heading.className = 'packs-dialog-heading';
  heading.id = headingId;
  heading.textContent = `${isUpdate
    ? DIALOG_COPY.update_heading_prefix
    : DIALOG_COPY.heading_prefix}${pack.name}?`;
  container.appendChild(heading);

  const intro = doc.createElement('p');
  intro.className = 'packs-dialog-intro';
  intro.textContent = isUpdate ? DIALOG_COPY.update_intro : DIALOG_COPY.intro;
  container.appendChild(intro);

  // D-211 Slice 5 — the D-166-style merge card for the small subset of global
  // owner rulings whose reviewed operation changed or vanished. It is read-only:
  // confirming Update accepts the incoming pack while preserving the ruling;
  // edits remain in Pack > Permissions, never in per-contract Access.
  const ownerReview = pack.owner_operation_review ?? [];
  if (ownerReview.length > 0) {
    const review = doc.createElement('section');
    review.setAttribute(PACKS_DIALOG_OWNER_OPERATION_REVIEW_ATTR, '');
    review.className = 'packs-dialog-owner-operation-review';
    review.setAttribute('role', 'region');
    const reviewHeadingId = `packs-dialog-owner-operation-review-${pack.slug}`;
    review.setAttribute('aria-labelledby', reviewHeadingId);
    const reviewHeading = doc.createElement('p');
    reviewHeading.id = reviewHeadingId;
    reviewHeading.className =
      'packs-dialog-summary packs-dialog-owner-operation-review-heading';
    reviewHeading.textContent = DIALOG_COPY.owner_operation_review_heading;
    review.appendChild(reviewHeading);
    const reviewIntro = doc.createElement('p');
    reviewIntro.className = 'packs-dialog-owner-operation-review-intro';
    reviewIntro.textContent = DIALOG_COPY.owner_operation_review_intro;
    review.appendChild(reviewIntro);
    const list = doc.createElement('ul');
    list.className = 'packs-dialog-owner-operation-review-list';
    let hasRemoved = false;
    for (const item of ownerReview) {
      const row = doc.createElement('li');
      row.setAttribute(
        PACKS_DIALOG_OWNER_OPERATION_REVIEW_ITEM_ATTR,
        item.operation_id,
      );
      row.setAttribute('data-change', item.change);
      row.setAttribute('data-ingredient-id', item.ingredient_id);
      row.className = 'packs-dialog-owner-operation-review-item';
      const ownerParts = [
        ...(item.owner_policy.risk !== undefined
          ? [`Owner risk: ${item.owner_policy.risk}`]
          : []),
        ...(item.owner_policy.approval !== undefined
          ? [`Owner approval: ${item.owner_policy.approval}`]
          : []),
      ];
      const incomingParts = item.incoming === undefined
        ? []
        : [
            `Pack risk: ${item.incoming.risk}`,
            `Pack approval: ${item.incoming.approval ?? 'automatic'}`,
          ];
      row.textContent = `${item.operation_id} — ${item.change === 'changed'
        ? 'Changed'
        : 'Removed'} · ${[...ownerParts, ...incomingParts].join(' · ')}`;
      if (item.change === 'removed') hasRemoved = true;
      list.appendChild(row);
    }
    review.appendChild(list);
    if (hasRemoved) {
      const removed = doc.createElement('p');
      removed.className = 'packs-dialog-owner-operation-review-removed';
      removed.textContent = DIALOG_COPY.owner_operation_review_removed;
      review.appendChild(removed);
    }
    container.appendChild(review);
  }

  const recordsReview = pack.records_review;
  if (recordsReview !== undefined) {
    const review = doc.createElement('section');
    review.setAttribute(PACKS_DIALOG_RECORDS_REVIEW_ATTR, '');
    review.className = 'packs-dialog-records-review';
    review.setAttribute('role', 'region');
    const reviewHeadingId = `packs-dialog-records-review-${pack.slug}`;
    review.setAttribute('aria-labelledby', reviewHeadingId);
    const reviewHeading = doc.createElement('p');
    reviewHeading.id = reviewHeadingId;
    reviewHeading.className = 'packs-dialog-summary packs-dialog-records-review-heading';
    reviewHeading.textContent = DIALOG_COPY.records_review_heading;
    review.appendChild(reviewHeading);

    const transition = doc.createElement('p');
    transition.className = 'packs-dialog-records-review-summary';
    transition.textContent =
      `Version ${recordsReview.current_version} → ${recordsReview.target_version} · `
      + `${recordsReview.estimated_rows} rows · `
      + `${recordsReview.current_storage_schema_hash === recordsReview.target_storage_schema_hash
        ? 'storage schema unchanged'
        : 'storage schema changes'}`;
    review.appendChild(transition);

    const kinds = doc.createElement('ul');
    kinds.className = 'packs-dialog-records-review-kinds';
    for (const kind of recordsReview.row_counts) {
      const row = doc.createElement('li');
      row.textContent =
        `${kind.kind}: ${kind.rows} rows, ${formatPressureBytes(kind.payload_bytes)} logical`;
      kinds.appendChild(row);
    }
    review.appendChild(kinds);

    if (recordsReview.schema_changes.length > 0) {
      const changes = doc.createElement('ul');
      changes.className = 'packs-dialog-records-review-changes';
      for (const change of recordsReview.schema_changes) {
        const row = doc.createElement('li');
        row.setAttribute(
          PACKS_DIALOG_RECORDS_REVIEW_CHANGE_ATTR,
          `${change.entity}${change.field === undefined ? '' : `.${change.field}`}`,
        );
        row.setAttribute('data-change', change.change);
        row.setAttribute('data-destructive', String(change.destructive));
        row.textContent = `${change.entity}${change.field === undefined ? '' : `.${change.field}`} — `
          + `${change.change.replaceAll('_', ' ')}`
          + `${change.current === undefined ? '' : ` · from ${change.current}`}`
          + `${change.target === undefined ? '' : ` · to ${change.target}`}`;
        changes.appendChild(row);
      }
      review.appendChild(changes);
    }

    if (recordsReview.destructive_changes.length > 0) {
      const destructiveHeading = doc.createElement('p');
      destructiveHeading.className = 'packs-dialog-records-review-destructive-heading';
      destructiveHeading.textContent = 'These changes could lose things:';
      review.appendChild(destructiveHeading);
      const destructive = doc.createElement('ul');
      for (const mapping of recordsReview.destructive_changes) {
        const row = doc.createElement('li');
        row.setAttribute(PACKS_DIALOG_RECORDS_REVIEW_DESTRUCTIVE_ATTR, mapping.step_id);
        row.textContent = `${mapping.edge} · ${mapping.kind} · ${mapping.operation} ${mapping.from}`
          + `${mapping.to === undefined ? '' : ` → ${mapping.to}`}`;
        destructive.appendChild(row);
      }
      review.appendChild(destructive);
    }

    const policy = doc.createElement('p');
    policy.className = 'packs-dialog-records-review-policy';
    const retention = Object.entries(recordsReview.retention)
      .map(([kind, value]) => `${kind}: ${value.legal_hold ? 'legal hold' : value.mode === 'keep'
        ? 'keep'
        : `expire after ${value.days} days`}`)
      .join(', ') || 'keep (default)';
    policy.textContent =
      `Usage ${recordsReview.quota.row_count}/${recordsReview.quota.row_limit} rows, `
      + `${formatPressureBytes(recordsReview.quota.payload_bytes)}`
      + `/${formatPressureBytes(recordsReview.quota.byte_limit)} · `
      + `Global ${recordsReview.global_quota.row_count}/${recordsReview.global_quota.row_limit} rows, `
      + `${formatPressureBytes(recordsReview.global_quota.payload_bytes)}`
      + `/${formatPressureBytes(recordsReview.global_quota.byte_limit)}`
      + `${recordsReview.global_quota.reserved_payload_bytes === 0
        ? ''
        : ` (+${formatPressureBytes(recordsReview.global_quota.reserved_payload_bytes)} reserved)`} · `
      + `Retention: ${retention}`;
    review.appendChild(policy);

    const lifecycle = doc.createElement('p');
    lifecycle.className = 'packs-dialog-records-review-lifecycle';
    lifecycle.textContent =
      `${recordsReview.active_executions} active executions; `
      + `${recordsReview.unacknowledged_events} unacknowledged events will be drained or explicitly retired. `
      + `${recordsReview.export_checkpoint_available ? 'Export is available' : 'Cannot export'}${recordsReview.export_recommended ? ' and recommended' : ''}. `
      + `The Pack stops working while this happens, and picks up again afterwards. `
      + `Reverse route: ${recordsReview.reverse_route_exists ? 'available' : 'not available'}.`;
    review.appendChild(lifecycle);
    container.appendChild(review);
  }

  // Recipe count summary
  const recipesP = doc.createElement('p');
  recipesP.className = 'packs-dialog-summary';
  recipesP.textContent =
    pack.recipe_count === 0
      ? DIALOG_COPY.no_recipes
      : `${DIALOG_COPY.recipes_label_prefix}${pack.recipe_count}${DIALOG_COPY.recipes_label_suffix}`;
  container.appendChild(recipesP);
  // Recipe slug list (compact one-liner per slug). Bounded by
  // BULK_PACK_MAX_RECIPES = 50, so a vertical list is acceptable
  // without virtualization.
  if (pack.recipe_count > 0) {
    const recipeList = doc.createElement('ul');
    recipeList.className = 'packs-dialog-list';
    for (const ref of pack.manifest.recipes) {
      const li = doc.createElement('li');
      // Slice C — recipes that collide with at least one other pack
      // get an inline marker after the version pin ("also in pack-x").
      // The marker is rendered as a sibling `<span>` child so the
      // attribute selector hits cleanly + screen-readers announce
      // both nodes in order. Two-child shape mirrors the SI scope
      // line already used elsewhere in the dialog — keeps the render
      // free of `createTextNode` so the Fake DOM harness only needs
      // `createElement` coverage.
      const others = collidingRecipeMarkers.get(ref.slug);
      if (others !== undefined && others.length > 0) {
        const baseSpan = doc.createElement('span');
        baseSpan.className = 'packs-dialog-recipe-base';
        baseSpan.textContent = `${ref.slug} (v${ref.version})`;
        li.appendChild(baseSpan);
        const marker = doc.createElement('span');
        marker.setAttribute(PACKS_DIALOG_RECIPE_COLLISION_ATTR, ref.slug);
        marker.className = 'packs-dialog-recipe-collision';
        marker.textContent =
          `${DIALOG_COPY.recipe_collision_prefix}${others.join(', ')}`;
        li.appendChild(marker);
      } else {
        li.textContent = `${ref.slug} (v${ref.version})`;
      }
      recipeList.appendChild(li);
    }
    container.appendChild(recipeList);
  }

  // Permissions checkbox section
  const permsHeading = doc.createElement('p');
  permsHeading.className = 'packs-dialog-summary packs-dialog-perms-heading';
  permsHeading.textContent = DIALOG_COPY.permissions_label;
  container.appendChild(permsHeading);

  const permList = doc.createElement('ul');
  permList.className = 'packs-dialog-perm-list';
  // Always render the always-required permission first + disabled.
  // Subsequent permissions in manifest order, dedup-aware so a
  // manifest that lists `install_bulk_pack` explicitly doesn't paint
  // two rows for the same slug.
  const seen = new Set<string>();
  const rows: Array<{ slug: string; required: boolean }> = [
    { slug: ALWAYS_REQUIRED_PERMISSION, required: true },
  ];
  seen.add(ALWAYS_REQUIRED_PERMISSION);
  for (const perm of pack.requires) {
    if (seen.has(perm)) continue;
    seen.add(perm);
    rows.push({ slug: perm, required: false });
  }
  for (const row of rows) {
    const item = doc.createElement('li');
    item.className = 'packs-dialog-perm-row';
    const label = doc.createElement('label');
    const checkbox = doc.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute(PACKS_DIALOG_PERMISSION_ATTR, row.slug);
    checkbox.checked = props.selection.has(row.slug);
    if (row.required || installing) {
      checkbox.disabled = true;
    }
    // Defensive: if the host ever reaches a state where the always-
    // required entry was un-selected (shouldn't happen given seed +
    // the toggle guard), force the checkbox state to checked so the
    // visible UI matches what the rpc will receive.
    if (row.required && !checkbox.checked) {
      checkbox.checked = true;
    }
    checkbox.addEventListener('change', () => {
      props.onTogglePermission(row.slug);
    });
    const text = doc.createElement('span');
    text.className = 'packs-dialog-perm-label';
    text.textContent = row.slug;
    label.appendChild(checkbox);
    label.appendChild(text);
    if (row.required) {
      const note = doc.createElement('span');
      note.className = 'packs-dialog-perm-note';
      note.textContent = ` ${DIALOG_COPY.required_permission_note}`;
      label.appendChild(note);
    }
    item.appendChild(label);
    permList.appendChild(item);
  }
  container.appendChild(permList);

  // D-194 2b-2 — the "Connect account" section for a pack that declares a
  // connection requirement (the interim seed — onedrive today). Sits just above
  // the {Access × Audience} grant picker: pick WHICH connection, then WHAT access it
  // gets. Connect is OPTIONAL (Model A) — this NEVER gates the Install button;
  // absent a requirement, nothing renders.
  if (props.connectionRequirement !== undefined) {
    container.appendChild(
      renderInstallConnectPicker({
        document: doc,
        requirement: props.connectionRequirement,
        candidates: props.connectionCandidates,
        chosen: props.chosenConnection,
        expanded: props.connectExpanded,
        disabled: installing,
        onPick: (name) => props.onPickConnection(name),
        onToggleExpanded: () => props.onToggleConnectExpanded(),
      }),
    );
  }

  if (props.connectionRequirement === undefined && props.connectionHintSetup !== undefined) {
    container.appendChild(
      renderConnectionHintDisclosure(doc, props.connectionHintSetup),
    );
  }

  // D-182 §7.1 / D-196 — the {Access × Audience} picker for every pack with
  // grantable connection ops or recipe tools. A pure-cli/no-recipe pack has no
  // model and keeps its post-install cli-grant flow.
  // ── D-247 D15 + D15.1 — WHAT THIS INSTALL WILL MAKE THE AI ABLE TO REACH ──
  //
  // The preview is SERVER-resolved (`packs.install_preview`) because
  // `chat_exposed` lives on the recipe BODY and the manifest does not carry one
  // — measured: 0 of 2,310 refs across 340 shipped packs. A client derivation
  // would be a second copy of a rule the install owns.
  //
  // ⛔ Absent or `resolved: false` ⇒ render NOTHING here and fall back to the
  // flat read tier. A count the picker cannot verify is assurance-shaped
  // non-assurance; the install then proceeds under the existing pack-level
  // consent, unchanged.
  const preview = props.installPreview;
  const recipeRisk = preview?.resolved === true
    ? new Map(preview.will_enable.map((r) => [r.recipe_id, r.top_risk ?? 'read' as const]))
    : undefined;
  const grantModel = installGrantModelFromManifest(pack.manifest, recipeRisk);
  if (preview?.resolved === true && preview.will_enable.length > 0) {
    container.appendChild(renderInstallRecipeDisclosure(doc, preview.will_enable));
  }
  if (grantModel !== null) {
    container.appendChild(
      renderInstallGrantPicker({
        document: doc,
        model: grantModel,
        access: resolveInstallDialogAccess(props.accessPick, grantModel),
        audience: resolveInstallDialogAudience(props.audiencePick),
        ...(props.customerTierOptions !== undefined
          ? { customerTierOptions: props.customerTierOptions }
          : {}),
        ...(props.contractOptions !== undefined
          ? { contractOptions: props.contractOptions }
          : {}),
        disabled: installing,
        onAccess: (tier) => props.onPickAccess(tier),
        onAudience: (audience) => props.onPickAudience(audience),
      }),
    );
  }

  // Body-content grants callout (DD#4 — read-only, no checkboxes).
  // Slice I — defensive symmetry with Slice G's Angle-2 MINOR fold:
  // gate on the actual array content (`grants.length > 0`) instead of
  // `body_visibility_grant_count > 0`, so a future field drift between
  // manifest + PackListEntry derivation can never surface an empty
  // heading + empty list.
  const grants = pack.manifest.mcp_body_visibility_grants ?? [];
  if (grants.length > 0) {
    const grantsHeading = doc.createElement('p');
    grantsHeading.className = 'packs-dialog-summary packs-dialog-body-heading';
    grantsHeading.textContent = DIALOG_COPY.body_grants_label;
    container.appendChild(grantsHeading);
    const grantsList = doc.createElement('ul');
    grantsList.className = 'packs-dialog-body-list';
    for (const key of grants) {
      const li = doc.createElement('li');
      li.setAttribute(PACKS_DIALOG_BODY_GRANT_ATTR, key);
      li.textContent = key;
      grantsList.appendChild(li);
    }
    container.appendChild(grantsList);
  }

  // Slice J — cross-pack body-grant overlap callout (install side).
  // Renders only when this pack's `mcp_body_visibility_grants[]`
  // overlaps with the grant set of at least one OTHER INSTALLED
  // pack. Sits below the body-grants list + above the collision
  // callout so the user reads body-content disclosures together
  // (grant list → overlap clarification → recipe collisions). The
  // copy frames this as additive ("already accessible via X") so
  // the user understands the install is not widening exposure
  // beyond what they've already approved. Gate on the actual
  // `overlapGrants.length` (same Slice I/G defensive pattern).
  const overlapGrants = grantOverlap?.grants ?? [];
  if (overlapGrants.length > 0) {
    const overlapSection = doc.createElement('section');
    overlapSection.setAttribute(PACKS_DIALOG_GRANT_OVERLAP_ATTR, '');
    overlapSection.className = 'packs-dialog-grant-overlap';
    const overlapHeading = doc.createElement('p');
    overlapHeading.className =
      'packs-dialog-summary packs-dialog-grant-overlap-heading';
    overlapHeading.textContent = DIALOG_COPY.grant_overlap_heading;
    overlapSection.appendChild(overlapHeading);
    const overlapList = doc.createElement('ul');
    overlapList.className = 'packs-dialog-grant-overlap-list';
    for (const entry of overlapGrants) {
      const li = doc.createElement('li');
      li.setAttribute(PACKS_DIALOG_GRANT_OVERLAP_ITEM_ATTR, entry.grantKey);
      li.textContent =
        `${entry.grantKey}${GRANT_OVERLAP_ALSO_VIA_PREFIX}${entry.otherPackSlugs.join(', ')}`;
      overlapList.appendChild(li);
    }
    overlapSection.appendChild(overlapList);
    container.appendChild(overlapSection);
  }

  // Slice C — cross-pack collision callout. Renders only when this
  // pack overlaps any recipe slug with at least one other pack in the
  // list. Sits below the body-grants block + above the action row so
  // the user reads it as the final disclosure before the Install
  // button. Per-other-pack grouping makes the impact concrete: the
  // user sees "crm-augmentation: bar, baz" instead of a flat slug
  // list, which is the question they'll ask first ("which pack am I
  // overwriting?").
  if (collision !== undefined && collision.recipes.length > 0) {
    const calloutSection = doc.createElement('section');
    calloutSection.setAttribute(PACKS_DIALOG_COLLISION_ATTR, '');
    calloutSection.className = 'packs-dialog-collision';
    // Codex review fold (MINOR — Angle 5 a11y) — give the callout an
    // accessible name so screen-reader region/heading navigation
    // surfaces it as a discrete disclosure before the install
    // actions. The heading id namespaces on
    // `packs-dialog-collision-heading-<slug>` so the single-row
    // dialog invariant keeps it unique across renders.
    calloutSection.setAttribute('role', 'region');
    const collisionHeadingId = `packs-dialog-collision-heading-${pack.slug}`;
    calloutSection.setAttribute('aria-labelledby', collisionHeadingId);
    const collisionHeading = doc.createElement('p');
    collisionHeading.id = collisionHeadingId;
    collisionHeading.className =
      'packs-dialog-summary packs-dialog-collision-heading';
    collisionHeading.textContent = DIALOG_COPY.collision_heading;
    calloutSection.appendChild(collisionHeading);
    const groupList = doc.createElement('ul');
    groupList.className = 'packs-dialog-collision-list';
    for (const group of groupCollisionsByOtherPack(collision.recipes)) {
      const li = doc.createElement('li');
      li.setAttribute(PACKS_DIALOG_COLLISION_GROUP_ATTR, group.otherPackSlug);
      li.className = 'packs-dialog-collision-group';
      // Per-other-pack one-liner: "pack-x: recipe-a, recipe-b". Pack
      // slugs are bounded short identifiers; comma-join keeps the
      // line compact + readable. Slug list inherits manifest order.
      li.textContent =
        `${group.otherPackSlug}: ${group.recipeSlugs.join(', ')}`;
      groupList.appendChild(li);
    }
    calloutSection.appendChild(groupList);
    const followup = doc.createElement('p');
    followup.className = 'packs-dialog-collision-followup';
    followup.textContent = DIALOG_COPY.collision_followup;
    calloutSection.appendChild(followup);
    container.appendChild(calloutSection);
  }

  if (props.error !== null) {
    const errBox = doc.createElement('p');
    errBox.setAttribute(PACKS_DIALOG_ERROR_ATTR, '');
    errBox.setAttribute('role', 'alert');
    errBox.className = 'packs-dialog-error';
    errBox.textContent = props.error;
    container.appendChild(errBox);
  }

  const actions = doc.createElement('div');
  actions.className = 'packs-dialog-actions';

  const installBtn = doc.createElement('button');
  installBtn.type = 'button';
  installBtn.setAttribute(PACKS_DIALOG_INSTALL_BTN_ATTR, '');
  installBtn.className = 'rx-btn rx-btn-primary rx-btn-sm packs-dialog-install';
  installBtn.textContent = installing
    ? isUpdate
      ? DIALOG_COPY.updating_label
      : DIALOG_COPY.installing_label
    : isUpdate
      ? DIALOG_COPY.update_label
      : DIALOG_COPY.install_label;
  // Slice B — also disable while a Delete rpc is mid-flight on
  // another row. Single-rpc-at-a-time per DD#10; without this gate
  // a user could submit a parallel install while a delete is
  // committing.
  if (installing) {
    // The panel restores this semantic action after every repaint. Keep it
    // focusable while the guarded submit is in flight so keyboard ownership
    // does not fall back to the document body.
    installBtn.setAttribute('aria-disabled', 'true');
    installBtn.setAttribute('aria-busy', 'true');
  } else if (props.deleting) {
    installBtn.disabled = true;
  }
  installBtn.addEventListener('click', () => {
    props.onSubmit();
  });
  actions.appendChild(installBtn);

  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.setAttribute(PACKS_DIALOG_CANCEL_BTN_ATTR, '');
  cancelBtn.className = 'rx-btn rx-btn-secondary rx-btn-sm packs-dialog-cancel';
  cancelBtn.textContent = DIALOG_COPY.cancel_label;
  if (installing) cancelBtn.setAttribute('aria-disabled', 'true');
  cancelBtn.addEventListener('click', () => {
    props.onCancel();
  });
  actions.appendChild(cancelBtn);

  container.appendChild(actions);
  return container;
};
