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
  MailFactSourcesPreview,
  MailTemplateCondition,
  MailTemplateInstallPreview,
  PackListEntry,
  PackWebhookPlanEntry,
} from '@recued/contracts';
// Same byte formatter the Records explorer uses — these are the same quota
// ceilings, shown one screen earlier.
import { formatPressureBytes, installRecipeRiskFromPreview } from '@recued/contracts';
import {
  ACCESS_LABEL,
  OWN_NEEDS_WHAT,
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
// The run surfaces' "Get <pack>" offer: the dialog names and links a missing pack
// the same way, so both send the owner to the same place.
import {
  PACK_INSTALL_OFFER_ATTR,
  PACK_INSTALL_OFFER_REF_ATTR,
  packInstallOfferHref,
  packInstallOfferName,
} from '../shell/pack-install-offer.js';

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for DOM tests + host introspection
// (moved from packs-panel.ts with the render; the panel re-exports them)
// ════════════════════════════════════════════════════════════════

export const PACKS_DIALOG_ATTR = 'data-recued-packs-dialog';
export const PACKS_DIALOG_SLUG_ATTR = 'data-recued-packs-dialog-slug';
export const PACKS_DIALOG_PERMISSION_ATTR = 'data-recued-packs-dialog-permission';
/** D-305 — on a permission row the pack's dependencies need: which packs need it. */
export const PACKS_DIALOG_PERMISSION_NEEDED_BY_ATTR = 'data-recued-packs-dialog-permission-needed-by';
/** D-310 — the list of the packs an install brings in with it. */
export const PACKS_DIALOG_DEPENDENCIES_ATTR = 'data-recued-packs-dialog-dependencies';
/** D-310 — one pack in that list; value = its slug. */
export const PACKS_DIALOG_DEPENDENCY_ATTR = 'data-recued-packs-dialog-dependency';
/** D-310 — one Access radio for a pack in that list; value = its slug,
 *  `data-access` = the tier. */
export const PACKS_DIALOG_DEPENDENCY_ACCESS_ATTR = 'data-recued-packs-dialog-dependency-access';
/** D-310 — what the other packs of the install do with it; value = its slug. */
export const PACKS_DIALOG_DEPENDENCY_NEEDS_ATTR = 'data-recued-packs-dialog-dependency-needs';
/** The packs this install needs and does not bring in, offered with a "Get
 *  <pack>" link each. Value: `preview` (said before the owner chooses anything,
 *  with Install held) or `refusal` (under a refusal the preview did not foresee).
 *  Each link carries `data-pack-install-ref` = its `<publisher>.<pack>` ref. */
export const PACKS_DIALOG_MISSING_PACKS_ATTR = 'data-recued-packs-dialog-missing-packs';
/** D-311 § 5 — what the install would refuse with before writing anything, as
 *  the preview names it (`install_refusal`); Install is held and points here.
 *  Value: the refusal's code (`version_mismatch` when it needs a newer Recued). */
export const PACKS_DIALOG_INSTALL_REFUSAL_ATTR = 'data-recued-packs-dialog-install-refusal';
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
// The whole-pack operation diff an update shows: every removed, changed and
// added operation, the owner's rules first.
export const PACKS_DIALOG_OPERATION_DIFF_ATTR =
  'data-recued-packs-dialog-operation-diff';
export const PACKS_DIALOG_OPERATION_DIFF_ITEM_ATTR =
  'data-recued-packs-dialog-operation-diff-item';
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

/** D-305 — "(needed by Personal CRM Foundation, which installs with it)". */
export const neededByNote = (packs: readonly string[]): string => {
  if (packs.length === 0) return '(needed by a pack that installs with it)';
  const names = packs.length === 1
    ? packs[0]
    : `${packs.slice(0, -1).join(', ')} and ${packs[packs.length - 1]}`;
  return `(needed by ${names}, which ${packs.length === 1 ? 'installs' : 'install'} with it)`;
};

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
  operation_diff_heading: 'What this update changes in what the Pack can do',
  operation_diff_renames:
    'A renamed operation shows as removed and added. Nothing ties the two names together, so a rule you set stays with the old name.',
  operation_diff_your_rules: 'Operations you set rules for',
  operation_diff_nothing: 'No operation changes.',
} as const;

const capitalized = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/** "Write · Ask" — the same words the Permissions tab uses. */
const operationFacts = (facts: { risk: string; approval?: string } | undefined): string =>
  facts === undefined ? '' : [capitalized(facts.risk), capitalized(facts.approval ?? 'automatic')].join(' · ');

const ruleText = (policy: { risk?: string; approval?: string }): string =>
  [
    ...(policy.risk !== undefined ? [`risk ${capitalized(policy.risk)}`] : []),
    ...(policy.approval !== undefined ? [`approval ${capitalized(policy.approval)}`] : []),
  ].join(', ');

type OperationDiffItem = NonNullable<PackListEntry['operation_diff']>['items'][number];

/** One line of the diff, in words. */
const operationDiffLine = (item: OperationDiffItem): string => {
  const rule = item.owner_policy === undefined ? null : ruleText(item.owner_policy);
  if (item.change === 'removed') {
    return rule === null
      ? `${item.operation_id} — was ${operationFacts(item.installed)}`
      : `${item.operation_id} — removed. Your rule (${rule}) is kept but does nothing, unless it comes back.`;
  }
  if (item.change === 'added') {
    return rule === null
      ? `${item.operation_id} — ${operationFacts(item.incoming)}`
      : `${item.operation_id} — back. Your rule (${rule}) applies to it again.`;
  }
  const was = operationFacts(item.installed);
  const now = operationFacts(item.incoming);
  const moved = was === now ? 'definition changed, same risk and approval' : `${was} → ${now}`;
  return rule === null
    ? `${item.operation_id} — ${moved}`
    : `${item.operation_id} — changed (${moved}). Your rule (${rule}) still applies.`;
};

/** Render the update's operation diff; false when the server sent none. */
const renderOperationDiff = (
  doc: Document,
  container: HTMLElement,
  pack: Pick<PackListEntry, 'slug' | 'operation_diff'>,
): boolean => {
  const diff = pack.operation_diff;
  if (diff === undefined) return false;
  const section = doc.createElement('section');
  section.setAttribute(PACKS_DIALOG_OPERATION_DIFF_ATTR, '');
  section.className = 'packs-dialog-operation-diff';
  section.setAttribute('role', 'region');
  const headingId = `packs-dialog-operation-diff-${pack.slug}`;
  section.setAttribute('aria-labelledby', headingId);
  const heading = doc.createElement('p');
  heading.id = headingId;
  heading.className = 'packs-dialog-summary packs-dialog-operation-diff-heading';
  heading.textContent = DIALOG_COPY.operation_diff_heading;
  section.appendChild(heading);

  const itemRow = (item: OperationDiffItem): HTMLElement => {
    const row = doc.createElement('li');
    row.setAttribute(PACKS_DIALOG_OPERATION_DIFF_ITEM_ATTR, item.operation_id);
    row.setAttribute('data-change', item.change);
    if (item.owner_policy !== undefined) row.setAttribute('data-owner-rule', 'true');
    row.textContent = operationDiffLine(item);
    return row;
  };

  const ruled = diff.items.filter((item) => item.owner_policy !== undefined);
  if (ruled.length > 0) {
    const sub = doc.createElement('p');
    sub.className = 'packs-dialog-operation-diff-subheading';
    sub.textContent = DIALOG_COPY.operation_diff_your_rules;
    section.appendChild(sub);
    const list = doc.createElement('ul');
    list.className = 'packs-dialog-operation-diff-list';
    for (const item of ruled) list.appendChild(itemRow(item));
    section.appendChild(list);
  }

  const rest = diff.items.filter((item) => item.owner_policy === undefined);
  for (const [change, label] of [['added', 'Added'], ['changed', 'Changed'], ['removed', 'Removed']] as const) {
    const group = rest.filter((item) => item.change === change);
    if (group.length === 0) continue;
    const details = doc.createElement('details');
    details.className = 'packs-dialog-operation-diff-group';
    details.setAttribute('data-change', change);
    const summary = doc.createElement('summary');
    summary.textContent = `${label} (${group.length})`;
    details.appendChild(summary);
    const list = doc.createElement('ul');
    list.className = 'packs-dialog-operation-diff-list';
    for (const item of group) list.appendChild(itemRow(item));
    details.appendChild(list);
    section.appendChild(details);
  }

  const tail = doc.createElement('p');
  tail.className = 'packs-dialog-operation-diff-unchanged';
  tail.textContent = diff.items.length === 0
    ? `${DIALOG_COPY.operation_diff_nothing} ${diff.unchanged} unchanged.`
    : `${diff.unchanged} unchanged.`;
  section.appendChild(tail);
  if (diff.items.some((item) => item.change !== 'changed')) {
    const renames = doc.createElement('p');
    renames.className = 'packs-dialog-operation-diff-renames';
    renames.textContent = DIALOG_COPY.operation_diff_renames;
    section.appendChild(renames);
  }
  container.appendChild(section);
  return true;
};

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

/** The Access model the dialog offers for `manifest`: its operations, plus its
 *  recipes at the per-recipe risk `packs.install_preview` resolved (absent or
 *  unresolved ⇒ each recipe `read`, as before D-247). A resolved preview that
 *  does not list a recipe means the install writes it closed, so no tier lists
 *  it (`installRecipeRiskFromPreview`).
 *
 *  ⛔ ONE model for the dialog AND the panel that validates the owner's pick and
 *  builds the install's `install_scope`. The panel built its own WITHOUT the
 *  recipe risks, so a pack whose recipe destroys OFFERED "Full access", the
 *  click was rejected (the radio stayed checked, nothing re-rendered), and the
 *  install sent `read` — the owner's choice silently lost. */
export const installDialogGrantModel = (
  manifest: BulkPackManifest,
  preview: InstallPreview | undefined,
): InstallGrantPickerModel | null => {
  return installGrantModelFromManifest(manifest, installRecipeRiskFromPreview(preview));
};

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
  /** D-295 — the webhooks this install needs chosen. Absent from a server that
   *  cannot say; empty when none are needed. */
  readonly webhook_plan?: readonly PackWebhookPlanEntry[];
  /** D-296 — automations the owner has on that this update switches off. */
  readonly triggers_switched_off?: ReadonlyArray<{
    readonly recipe_id: string;
    readonly name: string;
    readonly reason: 'changed' | 'removed';
  }>;
  /** D-299 — Reception forms and links this update stops taking submissions. */
  readonly receptions_switched_off?: ReadonlyArray<{
    readonly endpoint_id: string;
    readonly name: string;
    readonly reason: 'params_changed' | 'needs_owner';
  }>;
  /** D-305 — permissions the packs this install brings in with it need beyond the
   *  pack's own, with the names of the packs that need each. */
  readonly dependency_requires?: ReadonlyArray<{
    readonly permission: string;
    readonly needed_by: readonly string[];
  }>;
  /** D-310 — the packs this install brings in with it. Its presence is what says
   *  the server takes an Access choice for each: one that predates D-310 sends
   *  none, and the dialog then asks for none. */
  readonly dependency_packs?: readonly InstallDependencyPack[];
  /** D-310 REV 2 — the tier this Pack's own workflows need, when above Read.
   *  Advisory: shown beside the picker, never sent back; absent from an older server. */
  readonly own_needs?: 'write' | 'all';
  /** The packs this install needs and does not bring in, with the packs of the
   *  install that need each. The install refuses while one is missing, so the
   *  dialog offers them first and holds Install. Absent from an older server. */
  readonly missing_packs?: ReadonlyArray<InstallMissingPack>;
  /** D-311 § 5 — what the install would refuse with before writing anything: a
   *  pack it writes needs a newer Recued (`version_mismatch`), or does not pass
   *  its checks. The dialog says it and holds Install. Absent from an older
   *  server, and when nothing would be refused. */
  readonly install_refusal?: { readonly code: string; readonly message: string };
  /** D-315 §5.2 — the templates the recipes bring, and where one reads the
   *  same mail as a template already on. Absent from an older server. */
  readonly mail_templates?: readonly MailTemplateInstallPreview[];
  /** D-315 §5.2 — for each recipe that starts on facts, where they would come
   *  from here. Absent from an older server, or when none does. */
  readonly mail_fact_sources?: readonly MailFactSourcesPreview[];
  /** D-303 — settings the owner saved that this update stops using. */
  readonly settings_no_longer_used?: ReadonlyArray<{
    readonly recipe_id: string;
    readonly recipe: string;
    readonly setting: string;
  }>;
}

/** One pack an install needs and does not bring in (`packs.install_preview`
 *  `missing_packs`). */
export interface InstallMissingPack {
  /** `<publisher>.<pack>`, as the recipes' operations name it. */
  readonly pack_ref: string;
  /** The packs of this install whose recipes need it, by name. Absent for the
   *  refusal's list, which carries refs only. */
  readonly needed_by?: readonly string[];
  /** What the pack is called, where the server could tell; else its slug is shown. */
  readonly name?: string;
}

/** D-310 — one pack an install brings in with it (`packs.install_preview`
 *  `dependency_packs`). */
export interface InstallDependencyPack {
  readonly pack_slug: string;
  readonly name: string;
  /** The packs of this install that declare it, by name. */
  readonly needed_by: readonly string[];
  /** Installed at an older version; the install updates it, and asks nothing. */
  readonly updates?: true;
  /** The tiers its own install dialog offers, `read` first; empty ⇒ none. */
  readonly access_options: readonly InstallAccessTier[];
  /** What the other packs of the install do with it, when more than Read. */
  readonly needs?: { readonly access: 'write' | 'all'; readonly by: readonly string[] };
  /** D-310 REV 2 — what its OWN workflows need from its own Access, when more than Read. */
  readonly own_needs?: 'write' | 'all';
}

/** D-310 — the packs in the list the owner gives an Access choice: not one the
 *  install only updates, and not one with nothing to grant. */
export const dependencyPacksToChoose = (
  preview: InstallPreview | undefined,
): readonly InstallDependencyPack[] =>
  (preview?.dependency_packs ?? []).filter((pack) => pack.updates !== true && pack.access_options.length > 0);

/** D-310 — the tier a pack in the list installs at: the owner's pick when it is
 *  one the pack offers, else Read only, the same start as any pack's own dialog. */
export const resolveDependencyAccess = (
  picked: InstallAccessTier | undefined,
  pack: InstallDependencyPack,
): InstallAccessTier =>
  picked !== undefined && pack.access_options.includes(picked) ? picked : 'read';

const TIER_ORDER: readonly InstallAccessTier[] = ['read', 'write', 'all'];

const joinNames = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? 'A pack it installs with')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** The higher of two tiers above Read, or undefined when neither is set. */
const highestNeed = (
  a: 'write' | 'all' | undefined,
  b: 'write' | 'all' | undefined,
): 'write' | 'all' | undefined => (a === 'all' || b === 'all' ? 'all' : a ?? b);

/** A `<publisher>.<pack>` ref from the wire, or null. The offer renders it as a
 *  name and a link, so a malformed entry is dropped rather than drawn. */
const packRefOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/** The packs the preview says to install first. Entries that are not well formed
 *  are dropped: a server's malformed answer must not take the dialog down. */
export const missingPacksToInstallFirst = (
  preview: InstallPreview | undefined,
): InstallMissingPack[] => {
  const listed: unknown = preview?.missing_packs;
  if (!Array.isArray(listed)) return [];
  const out: InstallMissingPack[] = [];
  for (const entry of listed as unknown[]) {
    const packRef = packRefOrNull((entry as { pack_ref?: unknown } | null)?.pack_ref);
    if (packRef === null) continue;
    const neededBy: unknown = (entry as { needed_by?: unknown }).needed_by;
    const name: unknown = (entry as { name?: unknown }).name;
    out.push({
      pack_ref: packRef,
      needed_by: Array.isArray(neededBy)
        ? neededBy.filter((needer): needer is string => typeof needer === 'string' && needer.length > 0)
        : [],
      ...(typeof name === 'string' && name.trim().length > 0 ? { name: name.trim() } : {}),
    });
  }
  return out;
};

/** The refusal the preview foresees, or null. A malformed answer is dropped, as
 *  the other parts of the preview are: it must not take the dialog down. */
export const installRefusalFromPreview = (
  preview: InstallPreview | undefined,
): { code: string; message: string } | null => {
  const refusal: unknown = preview?.install_refusal;
  if (refusal === null || typeof refusal !== 'object') return null;
  const { code, message } = refusal as { code?: unknown; message?: unknown };
  return typeof code === 'string' && code.length > 0 && typeof message === 'string' && message.trim().length > 0
    ? { code, message: message.trim() }
    : null;
};

/** What the owner reads for it: the server's own words, which name the pack and
 *  say what to do. A "needs a newer version of Recued" refusal reads as it is;
 *  a failed check gets a lead, since its words are the validator's. */
export const installRefusalText = (refusal: { code: string; message: string }): string => {
  const detail = refusal.message.replace(/^packs\.install:\s*/, '');
  return refusal.code === 'version_mismatch' ? detail : `This Pack cannot be installed. ${detail}`;
};

/** The packs a refused install says to install first (`failure.missing_packs`).
 *  ⛔ Read from the typed field, never from the message: the message names only
 *  the first, and its wording is the owner's to read, not a contract. */
export const missingPacksFromFailure = (
  failure: { readonly missing_packs?: unknown } | undefined,
): string[] => {
  const listed = failure?.missing_packs;
  if (!Array.isArray(listed)) return [];
  return listed.map(packRefOrNull).filter((ref): ref is string => ref !== null);
};

/** What a missing pack is called: its name where the server could tell, else the
 *  slug the run offer shows (`federated-projects`). */
const missingPackName = (pack: InstallMissingPack): string =>
  pack.name ?? packInstallOfferName(pack.pack_ref);

/** "This Pack needs Federated Projects. It is not installed, and this Pack does
 *  not bring it in. Install it first, then come back to install this one." Names
 *  the packs of the install that need them, when they are not only this one. */
export const missingPacksText = (
  packName: string,
  missing: readonly InstallMissingPack[],
  isUpdate = false,
): string => {
  const names = joinNames(missing.map(missingPackName));
  const needers = [...new Set(missing.flatMap((pack) => pack.needed_by ?? []))];
  const others = needers.filter((name) => name !== packName);
  const subject = others.length === 0
    ? 'This Pack needs'
    : needers.includes(packName)
      ? `This Pack and ${joinNames(others)} need`
      : `${joinNames(others)}, which this Pack brings in, ${others.length === 1 ? 'needs' : 'need'}`;
  const one = missing.length === 1;
  return `${subject} ${names}. ${one ? 'It is' : 'They are'} not installed, and this Pack does not `
    + `bring ${one ? 'it' : 'them'} in. Install ${one ? 'it' : 'them'} first, then come back to `
    + `${isUpdate ? 'update' : 'install'} this one.`;
};

/** The id the held Install button points at (`aria-describedby`). */
const MISSING_PACKS_NOTICE_ID = 'packs-dialog-missing-packs';
const INSTALL_REFUSAL_NOTICE_ID = 'packs-dialog-install-refusal';

/** The packs to install first, each with a "Get <pack>" link to its own page,
 *  where its own dialog asks what it may do.
 *
 *  ⛔ A LINK, NOT AN INSTALL — for the reason the run surfaces' offer gives
 *  (`shell/pack-install-offer.ts`): an Install here would have to invent that
 *  pack's consent. And a pack an install does not bring in is left out on
 *  purpose: Federated Projects is installed deliberately, as the entry point of
 *  the meeting packs that call it. */
const renderMissingPacks = (
  doc: Document,
  packName: string,
  missing: readonly InstallMissingPack[],
  where: 'preview' | 'refusal',
  isUpdate: boolean,
): HTMLElement => {
  const section = doc.createElement('section');
  section.setAttribute(PACKS_DIALOG_MISSING_PACKS_ATTR, where);
  section.setAttribute(PACK_INSTALL_OFFER_ATTR, '');
  section.setAttribute('role', 'group');
  section.setAttribute('aria-label', 'Packs to install first');
  section.className = 'packs-dialog-missing';
  const lead = doc.createElement('p');
  lead.className = 'packs-dialog-missing-lead';
  if (where === 'preview') {
    // Install points here while it is held.
    lead.id = MISSING_PACKS_NOTICE_ID;
    lead.setAttribute('role', 'alert');
  }
  lead.textContent = `${where === 'preview' ? '⚠ ' : ''}${missingPacksText(packName, missing, isUpdate)}`;
  section.appendChild(lead);
  const links = doc.createElement('div');
  links.className = 'packs-dialog-missing-links';
  for (const pack of missing) {
    const link = doc.createElement('a');
    link.className = 'rx-btn rx-btn-secondary rx-btn-sm packs-dialog-missing-link';
    link.setAttribute('href', packInstallOfferHref(pack.pack_ref));
    link.setAttribute(PACK_INSTALL_OFFER_REF_ATTR, pack.pack_ref);
    link.textContent = `Get ${missingPackName(pack)}`;
    links.appendChild(link);
  }
  section.appendChild(links);
  return section;
};

/** D-310 — "Month-end closer adds and changes things in it." and, while the pick
 *  is below what that needs, what happens then. D-310 REV 2 — and what the pack's
 *  OWN workflows need: "Some of its own workflows add and change things." A pack
 *  brought in had them refused at Read with no word on screen. */
export const dependencyNeedsText = (
  needs: InstallDependencyPack['needs'],
  access: InstallAccessTier,
  ownNeeds?: InstallDependencyPack['own_needs'],
): string => {
  const said: string[] = [];
  if (needs !== undefined) {
    const what = needs.access === 'write'
      ? 'adds and changes things in it'
      : 'deletes things in it or changes its settings';
    said.push(`${joinNames(needs.by)} ${what}.`);
  }
  if (ownNeeds !== undefined) said.push(`Some of its own workflows ${OWN_NEEDS_WHAT[ownNeeds]}.`);
  const required = highestNeed(needs?.access, ownNeeds);
  const short = required !== undefined && TIER_ORDER.indexOf(access) < TIER_ORDER.indexOf(required);
  return short
    ? `${said.join(' ')} Choose ${ACCESS_LABEL[required!]}, or those steps will be refused.`
    : said.join(' ');
};

/** D-310 — the packs an install brings in with it, each with its own Access
 *  choice. They were installed at their authored read defaults, whatever the
 *  owner chose for this pack, and nothing on screen said they came with it. */
const renderDependencyPacks = (
  doc: Document,
  props: PacksInstallDialogProps,
  packs: readonly InstallDependencyPack[],
  audienceChosenAbove: boolean,
  installing: boolean,
): HTMLElement => {
  const section = doc.createElement('section');
  section.setAttribute(PACKS_DIALOG_DEPENDENCIES_ATTR, '');
  section.className = 'packs-dialog-deps';
  const heading = doc.createElement('p');
  heading.className = 'packs-dialog-summary';
  heading.textContent = packs.length === 1 ? 'Also installs 1 Pack' : `Also installs ${packs.length} Packs`;
  section.appendChild(heading);
  const intro = doc.createElement('p');
  intro.className = 'packs-dialog-deps-intro';
  intro.textContent = audienceChosenAbove
    ? 'This Pack needs these to work. Choose what each may do. Who may use them is what you chose in step 2.'
    : 'This Pack needs these to work. Choose what each may do.';
  section.appendChild(intro);
  const list = doc.createElement('ul');
  list.className = 'packs-dialog-dep-list';
  for (const pack of packs) {
    const item = doc.createElement('li');
    item.className = 'packs-dialog-dep';
    item.setAttribute(PACKS_DIALOG_DEPENDENCY_ATTR, pack.pack_slug);
    const name = doc.createElement('p');
    name.className = 'packs-dialog-dep-name';
    name.textContent = pack.name;
    item.appendChild(name);
    const why = doc.createElement('p');
    why.className = 'packs-dialog-dep-note';
    why.textContent = pack.updates === true
      ? `Installed already. This updates it for ${joinNames(pack.needed_by)}.`
      : `Needed by ${joinNames(pack.needed_by)}.`;
    item.appendChild(why);
    const choosing = pack.updates !== true && pack.access_options.length > 0;
    const access = resolveDependencyAccess(props.dependencyAccessPicks?.get(pack.pack_slug), pack);
    if (choosing) {
      const options = doc.createElement('div');
      options.className = 'packs-dialog-dep-access';
      options.setAttribute('role', 'radiogroup');
      options.setAttribute('aria-label', `What ${pack.name} may do`);
      for (const tier of pack.access_options) {
        const label = doc.createElement('label');
        label.className = 'packs-dialog-dep-option';
        const radio = doc.createElement('input');
        radio.setAttribute('type', 'radio');
        radio.setAttribute('name', `packs-dialog-dep-${pack.pack_slug}`);
        radio.setAttribute(PACKS_DIALOG_DEPENDENCY_ACCESS_ATTR, pack.pack_slug);
        radio.setAttribute('data-access', tier);
        radio.checked = tier === access;
        if (installing) radio.setAttribute('disabled', '');
        else radio.addEventListener('change', () => props.onPickDependencyAccess?.(pack.pack_slug, tier));
        label.appendChild(radio);
        const text = doc.createElement('span');
        text.textContent = ACCESS_LABEL[tier];
        label.appendChild(text);
        options.appendChild(label);
      }
      item.appendChild(options);
    } else if (pack.updates !== true) {
      const none = doc.createElement('p');
      none.className = 'packs-dialog-dep-note';
      none.textContent = 'Nothing to choose for it here.';
      item.appendChild(none);
    }
    const required = highestNeed(pack.needs?.access, pack.own_needs);
    if (required !== undefined && choosing) {
      const needs = doc.createElement('p');
      const short = TIER_ORDER.indexOf(access) < TIER_ORDER.indexOf(required);
      needs.className = short ? 'packs-dialog-dep-needs packs-dialog-dep-needs-short' : 'packs-dialog-dep-needs';
      needs.setAttribute(PACKS_DIALOG_DEPENDENCY_NEEDS_ATTR, pack.pack_slug);
      needs.textContent = dependencyNeedsText(pack.needs, access, pack.own_needs);
      item.appendChild(needs);
    }
    list.appendChild(item);
  }
  section.appendChild(list);
  return section;
};

/** D-295 — one webhook choice as the dialog renders it: the plan entry and the
 *  pick the install will send (`undefined` = not chosen yet). */
export interface InstallWebhookChoice {
  /** `<pack_slug>\u0000<binding>` — unique across the install. */
  readonly key: string;
  readonly entry: PackWebhookPlanEntry;
  readonly pick: string | undefined;
}

/** D-296 — one warning line per automation an update switches off. */
export const PACKS_DIALOG_TRIGGER_OFF_ATTR = 'data-recued-packs-dialog-trigger-off';
/** D-299 — one warning line per Reception form or link an update stops. */
export const PACKS_DIALOG_RECEPTION_OFF_ATTR = 'data-recued-packs-dialog-reception-off';
/** D-303 — one line per recipe whose saved settings an update stops using. */
export const PACKS_DIALOG_SETTINGS_OFF_ATTR = 'data-recued-packs-dialog-settings-off';

/** The webhooks section of the install dialog. */
export const PACKS_DIALOG_WEBHOOKS_ATTR = 'data-recued-packs-dialog-webhooks';
/** D-315 §5.2 — the "Mail templates" section, and a keep choice (`recipe` /
 *  `existing`) on its radios. */
export const PACKS_DIALOG_MAIL_TEMPLATES_ATTR = 'data-recued-packs-dialog-mail-templates';
export const PACKS_DIALOG_MAIL_TEMPLATE_KEEP_ATTR = 'data-recued-packs-dialog-mail-template-keep';
/** D-315 §5.2 — the "Where its facts come from" section. */
export const PACKS_DIALOG_FACT_SOURCES_ATTR = 'data-recued-packs-dialog-fact-sources';

/** What the standards pass reads of each kind, in the owner's words. */
const STANDARDS_READS: Readonly<Record<string, string>> = {
  shipment: 'the markup shops and carriers put in their mail, and UPS, USPS, FedEx and DHL tracking numbers',
  purchase: 'the markup shops put in their order mail',
  bill: 'the markup on bills',
  reservation: 'the markup booking sites put in their mail',
  owner_request: 'the requests you mail to your own +tag address',
};

/** One kind a recipe starts on, and where its facts would come from. */
export const describeMailFactSource = (
  recipe: string,
  kind: MailFactSourcesPreview['kinds'][number],
): { readonly line: string; readonly none: boolean } => {
  const what = kind.variables.length > 0 ? kind.variables.map(words).join(', ') : 'any change';
  const from = [
    ...(kind.standards ? [`${STANDARDS_READS[kind.type] ?? 'standard markup'}, read without a template`] : []),
    ...(kind.templates > 0 ? [`${kind.templates === 1 ? 'one template' : `${kind.templates} templates`} of yours`] : []),
    ...(kind.brought ? ['the template this install adds'] : []),
  ];
  return from.length > 0
    ? { line: `${recipe} starts on ${what} in ${kind.name.toLowerCase()} facts, which come from ${from.join('; ')}.`, none: false }
    : { line: `${recipe} starts on ${what} in ${kind.name.toLowerCase()} facts, and nothing reads those from your mail yet.`, none: true };
};

const renderMailFactSources = (doc: Document, props: PacksInstallDialogProps): HTMLElement => {
  const section = doc.createElement('section');
  section.setAttribute(PACKS_DIALOG_FACT_SOURCES_ATTR, '');
  section.className = 'packs-dialog-webhooks';
  const heading = doc.createElement('p');
  heading.className = 'packs-dialog-summary';
  heading.textContent = 'Where its facts come from';
  section.appendChild(heading);
  for (const recipe of props.mailFactSources ?? []) {
    for (const kind of recipe.kinds) {
      const { line, none } = describeMailFactSource(recipe.recipe_name, kind);
      const block = doc.createElement('div');
      block.className = 'packs-dialog-webhook';
      const text = doc.createElement('p');
      text.className = 'packs-dialog-webhook-what';
      text.textContent = line;
      block.appendChild(text);
      if (none) {
        const make = doc.createElement('p');
        make.className = 'packs-dialog-webhooks-hint';
        const link = doc.createElement('a');
        link.setAttribute('href', '#data/mail_fact/templates/new');
        link.className = 'rx-link';
        link.textContent = 'Make one now';
        make.appendChild(link);
        const rest = doc.createElement('span');
        rest.textContent = ' — a template reads them from an email you choose.';
        make.appendChild(rest);
        block.appendChild(make);
      }
      section.appendChild(block);
    }
  }
  return section;
};

/** D-315 §5.2 — one template a recipe brings, as the dialog asks about it. */
export interface InstallMailTemplateChoice {
  /** `<recipe_id>\u0000<variable>` — unique across the install. */
  readonly key: string;
  readonly entry: MailTemplateInstallPreview;
  readonly keep: 'recipe' | 'existing';
}

const words = (name: string): string => name.replace(/^data\./, '').replace(/[_.]/g, ' ');

/** What a starter's entrance asks of an email, in words: "from ship@shop.example,
 *  subject has “shipped”". */
export const describeMailTemplateConditions = (conditions: readonly MailTemplateCondition[]): string =>
  conditions.map((condition) => {
    const not = condition.negate === true ? 'not ' : '';
    const value = condition.value;
    switch (`${condition.field}:${condition.op}`) {
      case 'from:is': return `${not}from ${value}`;
      case 'from:domain_is': return `${not}from anyone at ${value.replace(/^@/, '')}`;
      case 'from:contains': return `sender ${not === '' ? 'has' : 'lacks'} “${value}”`;
      case 'subject:is': return `subject ${not === '' ? 'is' : 'is not'} “${value}”`;
      case 'subject:contains': return `subject ${not === '' ? 'has' : 'lacks'} “${value}”`;
      case 'body:contains': return `text ${not === '' ? 'has' : 'lacks'} “${value}”`;
      case 'label:is': return `${not}labelled ${value}`;
      case 'attachment:type_is': return `${not === '' ? 'with' : 'without'} a ${value} attachment`;
      default: return `${condition.field} ${not}matching ${value}`;
    }
  }).join(', ');

const renderMailTemplateChoices = (
  doc: Document,
  props: PacksInstallDialogProps,
  installing: boolean,
): HTMLElement => {
  const section = doc.createElement('section');
  section.setAttribute(PACKS_DIALOG_MAIL_TEMPLATES_ATTR, '');
  section.className = 'packs-dialog-webhooks';
  const heading = doc.createElement('p');
  heading.className = 'packs-dialog-summary';
  heading.textContent = 'Mail templates';
  section.appendChild(heading);
  const intro = doc.createElement('p');
  intro.className = 'packs-dialog-webhooks-intro';
  intro.textContent = 'These Recipes read your mail with the templates they bring. A template’s AI starts off.';
  section.appendChild(intro);
  for (const choice of props.mailTemplates ?? []) {
    const { entry } = choice;
    const block = doc.createElement('div');
    block.className = 'packs-dialog-webhook';
    block.setAttribute('data-mail-template-key', choice.key);
    const what = doc.createElement('p');
    what.className = 'packs-dialog-webhook-what';
    const reads = entry.reads.map(words).join(', ');
    what.textContent = `${entry.action === 'add' ? 'Adds' : 'Updates'} “${entry.name}” for ${entry.recipe_name}: reads ${reads} from mail ${describeMailTemplateConditions(entry.conditions)}.`;
    block.appendChild(what);
    if (entry.action === 'update') {
      const kept = doc.createElement('p');
      kept.className = 'packs-dialog-webhooks-hint';
      kept.textContent = 'Its rules update; whether it is on, and its AI, stay as you set them.';
      block.appendChild(kept);
    }
    if (entry.twin !== undefined) {
      const ask = doc.createElement('p');
      ask.className = 'packs-dialog-webhooks-hint';
      ask.textContent = `“${entry.twin.name}” already reads this mail. Only one can: which stays on?`;
      block.appendChild(ask);
      const options: Array<['recipe' | 'existing', string]> = [
        ['recipe', `The Recipe’s “${entry.name}” — it updates with the Recipe`],
        ['existing', `“${entry.twin.name}”, which you have now`],
      ];
      for (const [keep, text] of options) {
        const label = doc.createElement('label');
        label.className = 'packs-dialog-webhook-option';
        const radio = doc.createElement('input');
        radio.setAttribute('type', 'radio');
        radio.setAttribute('name', `packs-dialog-mail-template-${choice.key}`);
        radio.setAttribute(PACKS_DIALOG_MAIL_TEMPLATE_KEEP_ATTR, keep);
        radio.setAttribute('data-mail-template-key', choice.key);
        radio.checked = choice.keep === keep;
        if (installing) radio.setAttribute('disabled', '');
        else radio.addEventListener('change', () => props.onPickMailTemplate?.(choice.key, keep));
        label.appendChild(radio);
        const span = doc.createElement('span');
        span.textContent = text;
        label.appendChild(span);
        block.appendChild(label);
      }
    }
    if (entry.trigger) {
      const off = doc.createElement('p');
      off.className = 'packs-dialog-webhooks-hint';
      off.textContent = `${entry.recipe_name} starts on what this template reads. Its trigger stays off until you switch it on in Automation.`;
      block.appendChild(off);
    }
    section.appendChild(block);
  }
  return section;
};
/** One webhook radio; value = the ingress id, `data-webhook-key` = its choice. */
export const PACKS_DIALOG_WEBHOOK_OPTION_ATTR = 'data-recued-packs-dialog-webhook-option';

/** D-295 — the webhooks section: per binding, the owner's webhooks that fit
 *  (radios), the one in use now marked, and — when none fit — where to set one
 *  up. The Install button stays disabled until every binding has a pick. */
const renderWebhookChoices = (
  doc: Document,
  props: PacksInstallDialogProps,
  installing: boolean,
): HTMLElement => {
  const section = doc.createElement('section');
  section.setAttribute(PACKS_DIALOG_WEBHOOKS_ATTR, '');
  section.className = 'packs-dialog-webhooks';
  const heading = doc.createElement('p');
  heading.className = 'packs-dialog-summary';
  heading.textContent = 'Webhooks';
  section.appendChild(heading);
  if (props.webhooksLoading === true) {
    const loading = doc.createElement('p');
    loading.id = 'packs-dialog-webhooks-needed';
    loading.className = 'packs-dialog-webhooks-hint';
    loading.textContent = 'Checking your webhooks…';
    section.appendChild(loading);
    return section;
  }
  const intro = doc.createElement('p');
  intro.className = 'packs-dialog-webhooks-intro';
  intro.textContent = 'This Pack acts on events another service sends it. Choose which of your webhooks delivers them.';
  section.appendChild(intro);
  for (const choice of props.webhookChoices ?? []) {
    const { entry } = choice;
    const block = doc.createElement('div');
    block.className = 'packs-dialog-webhook';
    block.setAttribute('data-webhook-key', choice.key);
    const what = doc.createElement('p');
    what.className = 'packs-dialog-webhook-what';
    what.textContent = `${capitalized(entry.vendor)} events for ${entry.pack_name}: ${entry.event_types.join(', ')}`;
    block.appendChild(what);
    if (entry.current !== undefined && !entry.current.fits) {
      const gone = doc.createElement('p');
      gone.className = 'packs-dialog-webhooks-hint';
      gone.textContent = `It used “${entry.current.display_name}”, which cannot deliver these events now. Pick another.`;
      block.appendChild(gone);
    }
    if (entry.candidates.length === 0) {
      const none = doc.createElement('p');
      none.className = 'packs-dialog-webhooks-hint';
      none.textContent = `None of your webhooks can deliver these yet. `;
      const link = doc.createElement('a');
      link.setAttribute('href', '#connections/webhooks');
      link.className = 'rx-link';
      link.textContent = 'Set one up in Connections → Webhooks';
      none.appendChild(link);
      block.appendChild(none);
    }
    for (const candidate of entry.candidates) {
      const label = doc.createElement('label');
      label.className = 'packs-dialog-webhook-option';
      const radio = doc.createElement('input');
      radio.setAttribute('type', 'radio');
      radio.setAttribute('name', `packs-dialog-webhook-${choice.key}`);
      radio.setAttribute(PACKS_DIALOG_WEBHOOK_OPTION_ATTR, candidate.ingress_id);
      radio.setAttribute('data-webhook-key', choice.key);
      radio.checked = choice.pick === candidate.ingress_id;
      if (installing) radio.setAttribute('disabled', '');
      else radio.addEventListener('change', () => props.onPickWebhook?.(choice.key, candidate.ingress_id));
      label.appendChild(radio);
      const text = doc.createElement('span');
      text.textContent = entry.current?.ingress_id === candidate.ingress_id && entry.current.fits
        ? `${candidate.display_name} — in use now`
        : candidate.display_name;
      label.appendChild(text);
      block.appendChild(label);
    }
    section.appendChild(block);
  }
  if ((props.webhookChoices ?? []).some((choice) => choice.pick === undefined)) {
    const needed = doc.createElement('p');
    needed.id = 'packs-dialog-webhooks-needed';
    needed.className = 'packs-dialog-webhooks-hint';
    needed.textContent = 'Choose a webhook for each of these to install.';
    section.appendChild(needed);
  }
  return section;
};

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
  /** D-294 — customers an update's carried-over audience names one by one. */
  customerContractOptions?: readonly InstallAudienceOption[];
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
  /** The packs that refusal said to install first (`failure.missing_packs`),
   *  offered under the error. Absent or empty ⇒ none. */
  errorMissingPacks?: readonly string[];
  onTogglePermission(permission: string): void;
  onPickAccess(tier: InstallAccessTier): void;
  onPickAudience(audience: InstallAudienceSelection): void;
  /** D-194 2b-2 — pick a reuse candidate by name, or undefined to install
   *  without connecting. */
  onPickConnection(name: string | undefined): void;
  /** D-194 2b-2 — toggle the Connect section's collapsed/expanded reuse list. */
  onToggleConnectExpanded(): void;
  /** D-295 — the webhooks this install needs chosen (from the install preview).
   *  Absent ⇒ none to ask (or a server that cannot say). */
  webhookChoices?: readonly InstallWebhookChoice[];
  /** D-295 — the pack declares webhooks and the preview has not answered yet. */
  webhooksLoading?: boolean;
  /** D-305 — the pack brings other packs in with it, and the preview has not yet
   *  said what they need. Install waits, since the install would refuse them. */
  permissionsLoading?: boolean;
  /** D-310 — the owner's Access pick for each pack the install brings in, by
   *  slug (absent ⇒ Read only). */
  dependencyAccessPicks?: ReadonlyMap<string, InstallAccessTier>;
  /** D-310 — pick an Access tier for one pack the install brings in. */
  onPickDependencyAccess?(packSlug: string, tier: InstallAccessTier): void;
  /** D-295 — pick a webhook for one choice. */
  onPickWebhook?(key: string, ingressId: string): void;
  /** D-315 §5.2 — the templates the recipes bring, each with which template
   *  stays on where one already reads that mail. */
  mailTemplates?: readonly InstallMailTemplateChoice[];
  /** D-315 §5.2 — keep the recipe's template on, or the one already there. */
  onPickMailTemplate?(key: string, keep: 'recipe' | 'existing'): void;
  /** D-315 §5.2 — where the facts the recipes start on would come from. */
  mailFactSources?: readonly MailFactSourcesPreview[];
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

  // ⛔ D-296 — an automation the owner has ON that this update switches off:
  // said before Update, one line each — the one thing here that stops work.
  if (isUpdate) {
    for (const off of props.installPreview?.triggers_switched_off ?? []) {
      const line = doc.createElement('p');
      line.className = 'packs-dialog-warning';
      line.setAttribute('role', 'alert');
      line.setAttribute(PACKS_DIALOG_TRIGGER_OFF_ATTR, off.recipe_id);
      line.textContent = off.reason === 'removed'
        ? `⚠ This update switches off “${off.name}”, which you have on: it no longer starts by itself.`
        : `⚠ This update switches off “${off.name}”, which you have on: what starts it changes. `
          + 'Switch it back on in Automation after updating.';
      container.appendChild(line);
    }
    // D-299 — a public form or link that stops taking submissions until the owner acts.
    for (const off of props.installPreview?.receptions_switched_off ?? []) {
      const line = doc.createElement('p');
      line.className = 'packs-dialog-warning';
      line.setAttribute('role', 'alert');
      line.setAttribute(PACKS_DIALOG_RECEPTION_OFF_ATTR, off.endpoint_id);
      line.textContent = off.reason === 'params_changed'
        ? `⚠ This update changes the answers “${off.name}” uses: it stops taking submissions `
          + 'until you re-enable it in Reception.'
        : `⚠ This update needs your OK for “${off.name}” to keep taking submissions: `
          + 'confirm it in Reception after updating.';
      container.appendChild(line);
    }
    // D-303 — settings the owner saved that the new version no longer has. Kept, not
    // applied; one line per recipe.
    const dropped = new Map<string, { recipe: string; settings: string[] }>();
    for (const entry of props.installPreview?.settings_no_longer_used ?? []) {
      const seen = dropped.get(entry.recipe_id) ?? { recipe: entry.recipe, settings: [] };
      seen.settings.push(entry.setting);
      dropped.set(entry.recipe_id, seen);
    }
    for (const [recipeId, { recipe, settings }] of dropped) {
      const line = doc.createElement('p');
      line.className = 'packs-dialog-warning';
      line.setAttribute('role', 'alert');
      line.setAttribute(PACKS_DIALOG_SETTINGS_OFF_ATTR, recipeId);
      line.textContent = `⚠ This update drops ${settings.length === 1 ? 'a setting' : 'settings'} you saved `
        + `in “${recipe}”: ${settings.map((setting) => `“${setting}”`).join(', ')} `
        + `${settings.length === 1 ? 'no longer applies' : 'no longer apply'}.`;
      container.appendChild(line);
    }
  }
  // D-311 § 5 — what the install would refuse with before writing anything (a
  // pack it needs a newer Recued for, or one that does not pass its checks):
  // said before the owner chooses anything, and first, since nothing else here
  // can get past it. Install is held.
  const refusal = installRefusalFromPreview(props.installPreview);
  if (refusal !== null) {
    const notice = doc.createElement('p');
    notice.id = INSTALL_REFUSAL_NOTICE_ID;
    notice.className = 'packs-dialog-warning';
    notice.setAttribute('role', 'alert');
    notice.setAttribute(PACKS_DIALOG_INSTALL_REFUSAL_ATTR, refusal.code);
    notice.textContent = `⚠ ${installRefusalText(refusal)}`;
    container.appendChild(notice);
  }
  // The packs this install needs and does not bring in: said before the owner
  // chooses anything, since the install refuses without them. Install is held.
  const missingFirst = missingPacksToInstallFirst(props.installPreview);
  if (missingFirst.length > 0) {
    container.appendChild(renderMissingPacks(doc, pack.name, missingFirst, 'preview', isUpdate));
  }

  // The whole-pack operation diff, when the server sent one. It covers every
  // operation — the owner's rules first — so the D-211 card below, which lists
  // only ruled operations, is the fallback for a server that sends no diff.
  const diffShown = isUpdate && renderOperationDiff(doc, container, pack);

  // D-211 Slice 5 — the D-166-style merge card for the small subset of global
  // owner rulings whose reviewed operation changed or vanished. It is read-only:
  // confirming Update accepts the incoming pack while preserving the ruling;
  // edits remain in Pack > Permissions, never in per-contract Access.
  const ownerReview = pack.owner_operation_review ?? [];
  if (!diffShown && ownerReview.length > 0) {
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
  const rows: Array<{ slug: string; required: boolean; neededBy?: readonly string[] }> = [
    { slug: ALWAYS_REQUIRED_PERMISSION, required: true },
  ];
  seen.add(ALWAYS_REQUIRED_PERMISSION);
  for (const perm of pack.requires) {
    if (seen.has(perm)) continue;
    seen.add(perm);
    rows.push({ slug: perm, required: false });
  }
  // D-305 — then what the packs it brings in need. The install refuses without them,
  // so a dialog that listed only the pack's own could never succeed for such a pack.
  for (const dependency of props.installPreview?.dependency_requires ?? []) {
    if (seen.has(dependency.permission)) continue;
    seen.add(dependency.permission);
    rows.push({ slug: dependency.permission, required: false, neededBy: dependency.needed_by });
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
    if (row.neededBy !== undefined) {
      const note = doc.createElement('span');
      note.className = 'packs-dialog-perm-note';
      note.setAttribute(PACKS_DIALOG_PERMISSION_NEEDED_BY_ATTR, row.slug);
      note.textContent = ` ${neededByNote(row.neededBy)}`;
      label.appendChild(note);
    }
    item.appendChild(label);
    permList.appendChild(item);
  }
  if (props.permissionsLoading === true) {
    const item = doc.createElement('li');
    item.className = 'packs-dialog-perm-row';
    const checking = doc.createElement('span');
    checking.id = 'packs-dialog-permissions-checking';
    checking.className = 'packs-dialog-perm-note';
    checking.textContent = 'Checking what the packs it brings in need…';
    item.appendChild(checking);
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
        ...(isUpdate && pack.current_connection !== undefined ? { current: pack.current_connection } : {}),
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
  // D-295 — the webhooks the pack acts on, before what it may do with them.
  const webhooksUnchosen = props.webhooksLoading === true
    || (props.webhookChoices ?? []).some((choice) => choice.pick === undefined);
  if (props.webhooksLoading === true || (props.webhookChoices?.length ?? 0) > 0) {
    container.appendChild(renderWebhookChoices(doc, props, installing));
  }
  // D-315 §5.2 — the templates the recipes bring, and which stays on where one
  // already reads that mail.
  if ((props.mailTemplates?.length ?? 0) > 0) {
    container.appendChild(renderMailTemplateChoices(doc, props, installing));
  }
  if ((props.mailFactSources?.length ?? 0) > 0) {
    container.appendChild(renderMailFactSources(doc, props));
  }

  // ⛔ Absent or `resolved: false` ⇒ render NOTHING here and fall back to the
  // flat read tier. A count the picker cannot verify is assurance-shaped
  // non-assurance; the install then proceeds under the existing pack-level
  // consent, unchanged.
  const preview = props.installPreview;
  const grantModel = installDialogGrantModel(pack.manifest, preview);
  if (preview?.resolved === true && preview.will_enable.length > 0) {
    container.appendChild(renderInstallRecipeDisclosure(doc, preview.will_enable));
  }
  if (grantModel !== null) {
    container.appendChild(
      renderInstallGrantPicker({
        document: doc,
        model: grantModel,
        access: resolveInstallDialogAccess(props.accessPick, grantModel),
        ...(isUpdate && pack.current_access !== undefined
          && grantModel.accessOptions.includes(pack.current_access)
          ? { carriedOver: pack.current_access }
          : {}),
        audience: resolveInstallDialogAudience(props.audiencePick),
        ...(props.customerTierOptions !== undefined
          ? { customerTierOptions: props.customerTierOptions }
          : {}),
        ...(props.contractOptions !== undefined
          ? { contractOptions: props.contractOptions }
          : {}),
        ...(props.customerContractOptions !== undefined
          ? { customerContractOptions: props.customerContractOptions }
          : {}),
        ...(isUpdate && pack.current_audience !== undefined ? { audienceCarriedOver: true } : {}),
        // D-310 REV 2 — what this Pack's own workflows need, from the server's walk.
        ...(preview?.own_needs !== undefined ? { ownNeeds: preview.own_needs } : {}),
        disabled: installing,
        onAccess: (tier) => props.onPickAccess(tier),
        onAudience: (audience) => props.onPickAudience(audience),
      }),
    );
  }

  // D-310 — the packs it brings in with it, each with its own Access choice.
  // Listed from the server's own walk; an older server sends no list, and then
  // none is shown and none is sent.
  if ((preview?.dependency_packs?.length ?? 0) > 0) {
    container.appendChild(
      renderDependencyPacks(doc, props, preview!.dependency_packs!, grantModel !== null, installing),
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
    // A refusal for packs the preview did not name (it had not landed, or the
    // server sends none): offer them under it. Named above already ⇒ not twice.
    const refused = props.errorMissingPacks ?? [];
    if (refused.length > 0 && missingFirst.length === 0) {
      container.appendChild(renderMissingPacks(
        doc, pack.name, refused.map((packRef) => ({ pack_ref: packRef })), 'refusal', isUpdate,
      ));
    }
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
  } else if (refusal !== null) {
    // ⛔ D-311 § 5 — the install would refuse this before writing anything,
    // whatever the owner chooses here; the notice at the top says why.
    installBtn.disabled = true;
    installBtn.setAttribute('aria-describedby', INSTALL_REFUSAL_NOTICE_ID);
  } else if (missingFirst.length > 0) {
    // ⛔ The install refuses while a pack it needs is missing, whatever else the
    // owner chooses here; the notice at the top says which, with a link to each.
    installBtn.disabled = true;
    installBtn.setAttribute('aria-describedby', MISSING_PACKS_NOTICE_ID);
  } else if (webhooksUnchosen) {
    // ⛔ D-295 — the install refuses without one webhook per binding; say what
    // is missing here rather than after a round trip.
    installBtn.disabled = true;
    installBtn.setAttribute('aria-describedby', 'packs-dialog-webhooks-needed');
  } else if (props.permissionsLoading === true) {
    // ⛔ D-305 — nor without what the packs it brings in need, which the preview
    // has not named yet.
    installBtn.disabled = true;
    installBtn.setAttribute('aria-describedby', 'packs-dialog-permissions-checking');
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
