/** D-138 Phase 2 — `<MergeReviewDialog>` shared component.
 *
 *  Renders a sequenced (1 of N) review of contact merge candidates.
 *  Same component, two entry points: enrollment-time focus page +
 *  notification-driven post-enrollment review (P4). The host wires
 *  data-action clicks to `contact.merge.{confirm, reject}` rpcs and
 *  patches the dialog state back through.
 *
 *  Spec § A.6 + § P2 acceptance:
 *    - Pair layout    — side-by-side cards; primary-color winning
 *                       highlight per field.
 *    - Multi-way      — horizontally + vertically scrollable card row,
 *                       fixed action bar at the bottom; per-card radio
 *                       picks survivor; no cluster-size cap.
 *    - Three actions  — Merge / Mark as different / Also merge upstream
 *                       (last hidden when no candidate has a vendor-
 *                       mergeable platform_id).
 *    - "Review later" — leaves candidates `pending`; dialog closes; the
 *                       focus page exits and the connection completes.
 *    - Mark as different writes only the surfaced candidate edges
 *                       (Reviewer #5) — the rpc call carries the
 *                       cluster's `candidate_ids[]`; the substrate
 *                       writes one rejection row per surfaced edge,
 *                       not the transitive O(N²) closure.
 *
 *  Pure render module — no IO, no rpc. The host hydrates `items` via
 *  `contact.merge.list` + the per-candidate contact lookups, picks
 *  default survivors, runs the layout discriminator, and fills in
 *  `vendor_merge_capable_count` per item from each candidate's
 *  `platform_ids`. */

import { e } from '../template.js';
import { button } from '../primitives/button.js';
import { actionBar } from '../primitives/action-bar.js';
import { inlineHint } from '../primitives/message.js';
import { panel } from '../primitives/panel.js';
import {
  CONTACT_MATCH_FIELD_CONTRIBUTION_KIND,
  contactContributionRank,
  resolveContribution,
} from '@recued/contracts';
import type {
  ContactContribution,
  ContactMatchField,
  ContactMergeCandidate,
  ContactProjectionProvenance,
  PlatformIdEntry,
  MailingAddress,
} from '@recued/contracts';

/** One contact card inside a review item. The host hydrates fields
 *  from the canonical `data.contact.<email>` row + `platform_ids`
 *  from the server-internal lookup table. The dialog never reaches
 *  for storage itself — every field is pre-projected. */
export interface MergeReviewContactCard {
  /** Canonical email — also the card's stable key inside an item. */
  email: string;
  /** Display name. */
  name?: string;
  /** Workplace name (`vendor_meta` / `manual` / `domain_inferred`). */
  company?: string;
  /** E.164-canonicalized phone. */
  phone?: string;
  /** Structured mailing address. */
  mailing_address?: MailingAddress;
  /** Most recent activity timestamp (ms) — when the user last exchanged mail
   *  with / met this person. Drives DEFAULT-SURVIVOR selection only
   *  ("most-recent `last_interaction` wins": which ROW should absorb the other).
   *
   *  ⛔ **NOT the per-field winner.** It used to decide that too, and it was
   *  simply the wrong quantity: which value a merged record ends up holding is
   *  decided by the C-2a LADDER over contributions, and how recently you emailed
   *  someone says nothing about which source asserted their company name. See
   *  `winningCardsForField`. */
  last_interaction: number;
  /** Row-level engine-bookkeeping timestamp (ms). Tie-breaks the DEFAULT SURVIVOR
   *  when two cards share `last_interaction` (spec § A.6). Optional so test
   *  fixtures + ad-hoc projections stay terse; absent rows treat the tie-break as
   *  `0` and fall through to the `cards` order for stable rendering.
   *
   *  ⛔ Not the per-field winner either — same reason as `last_interaction`. */
  updated_at?: number;
  /** Per-field ladder provenance for THIS card's projected values — the
   *  `projection_provenance` map materialized onto the `data.contact` row, keyed
   *  by CONTRIBUTION KIND (`org`, `address`, …; use
   *  `CONTACT_MATCH_FIELD_CONTRIBUTION_KIND`, never the column name).
   *
   *  This is what lets the dialog predict the post-merge value with the REAL
   *  ladder rather than guessing. Optional: a card whose field carries no
   *  rankable provenance is not guessed at — the field simply renders with no
   *  highlight (`winningCardsForField`). */
  provenance?: ContactProjectionProvenance;
  /** First-seen source (`'mail' | 'calendar' | 'manual' | 'reconciler'`).
   *  Surfaced inline as a small caption. */
  source?: string;
  /** Confirmed-linked platform records — `[]` when the contact has
   *  no vendor links. The dialog hides "Also merge upstream" for
   *  the whole item when ALL cards have zero vendor-mergeable
   *  entries (purely-mail / purely-calendar candidates). */
  platform_ids?: readonly PlatformIdEntry[];
}

/** One review item — pair or multi-way cluster. The host walks the
 *  candidate-graph connected component to assemble cards + the
 *  surfaced candidate-edge ids; the substrate's rejection rpc takes
 *  the same candidate_ids[] verbatim so cluster-reject writes one
 *  row per surfaced edge (not the transitive closure). */
export interface MergeReviewItem {
  /** Canonical emails of the cards in this item. Ordered for stable
   *  rendering (lex). For pair layout, length === 2; multi-way is
   *  ≥ 3 with no upper cap. */
  cards: readonly MergeReviewContactCard[];
  /** Surfaced candidate rows for this item — the substrate-issued
   *  edges connecting the cards. The dialog passes these verbatim
   *  to `contact.merge.confirm` + `contact.merge.reject`. A 6-card
   *  cluster with 8 surfaced edges yields 8 candidate ids here, NOT
   *  the C(6,2)=15 transitive closure. */
  candidates: readonly ContactMergeCandidate[];
  /** Default survivor — the card whose email this matches gets the
   *  primary highlight + the default radio selection. The host picks
   *  this from "most recent `last_interaction`" with row `updated_at`
   *  as tiebreaker (spec § A.6). User can override via the per-card
   *  affordance (pair) / radio (multi-way). */
  default_survivor: string;
}

/** Closed list of fields the dialog renders per card. Order matches
 *  the visual stack in each card. Kept narrow so a future schema
 *  add (e.g. timezone) is a one-line widening. */
export const MERGE_REVIEW_FIELDS: readonly ContactMatchField[] = [
  'name',
  'company',
  'phone',
  'mailing_address',
];

export interface MergeReviewDialogState {
  /** Loaded review batch. Empty array suppresses the dialog body
   *  with an `inlineOk` "no pending candidates" notice. */
  items: readonly MergeReviewItem[];
  /** Zero-based pointer into `items`. Bounded `[0, items.length)`.
   *  Out-of-range cursors render an empty-batch message (the host
   *  resets to 0 on next batch load). */
  cursor: number;
  /** Per-item user-picked survivor email. Keyed by item cursor.
   *  Falls back to the item's `default_survivor` when absent. */
  survivor_overrides: Record<number, string>;
  /** True while `contact.merge.{confirm, reject}` rpc is in-flight.
   *  Disables every action button so the user can't double-fire. */
  saving: boolean;
  /** Inline error from the most recent submit (rpc rejection text).
   *  Cleared on successful action / next-prev navigation. */
  error: string | null;
  /** Optional surface label so the dialog body can disambiguate
   *  "enrollment vs. notification". Pure cosmetic — the rpc payload
   *  is identical across surfaces. */
  surface?: 'enrollment' | 'notification';
}

export interface MergeReviewDialogProps extends MergeReviewDialogState {
  /** When true, the dialog renders a "Review later" affordance that
   *  closes the focus page without resolving anything. P2 surfaces
   *  this on enrollment; P4's notification surface omits it because
   *  the queue is the home for "review later" by default. Defaults
   *  to false. */
  allow_defer?: boolean;
  /** D-205 #2b — whether the HOST can service "Also merge upstream", the
   *  DESTRUCTIVE vendor-side merge (`upstream_merge.*` + the arm/fire
   *  preview dialog, D-138 P5). **Defaults to FALSE — fail closed.**
   *
   *  Until this existed, the button rendered whenever any card carried a
   *  `platform_id`, which conflated two different things: whether the
   *  contact HAS vendor links (a display fact, and after D-192 slice 7 the
   *  normal case for CRM-sourced duplicates) and whether this host has
   *  wired the machinery to mutate the vendor (a host capability). A host
   *  with the former and not the latter rendered a button that silently did
   *  nothing — and the only way to hide it was to omit `platform_ids` from
   *  the cards, i.e. to lie about the links and lose the badges too.
   *
   *  A host must now say it can perform the destructive action before the
   *  dialog offers it. Vendor links still render as badges either way. */
  allow_upstream_merge?: boolean;
}

export const initialMergeReviewDialogState = (): MergeReviewDialogState => ({
  items: [],
  cursor: 0,
  survivor_overrides: {},
  saving: false,
  error: null,
});

const FIELD_LABELS: Record<ContactMatchField, string> = {
  name: 'Name',
  company: 'Company',
  phone: 'Phone',
  mailing_address: 'Address',
};

/** Stringify `MailingAddress` into one short line so cards stay
 *  comparable side-by-side. Mirrors the canonicalizer's output
 *  ordering — addr1 / city / state / zip / country. */
const renderMailingAddress = (addr: MailingAddress | undefined): string => {
  if (!addr) return '';
  const parts: string[] = [];
  if (addr.address1) parts.push(addr.address1);
  if (addr.address2) parts.push(addr.address2);
  if (addr.city) parts.push(addr.city);
  const stateZip = [addr.state, addr.zip].filter(Boolean).join(' ');
  if (stateZip) parts.push(stateZip);
  if (addr.country) parts.push(addr.country);
  return parts.join(', ');
};

/** Pull the displayable string for one field on one card. Returns
 *  `''` when the field is absent (rendered as the muted "—" stub
 *  so winning-side highlight reads cleanly across cards). */
const fieldValue = (card: MergeReviewContactCard, field: ContactMatchField): string => {
  switch (field) {
    case 'name':            return card.name ?? '';
    case 'company':         return card.company ?? '';
    case 'phone':           return card.phone ?? '';
    case 'mailing_address': return renderMailingAddress(card.mailing_address);
  }
};

/** One card's winning contribution for one field, tagged with the card it came
 *  from so the resolver hands the card straight back. */
interface CardFieldContribution extends ContactContribution<string> {
  email: string;
}

/** Which value each field will hold AFTER the merge — computed with the REAL
 *  C-2a ladder.
 *
 *  🔑 **The dialog does not decide this; it CONSUMES the decision.**
 *  `contact-contribution.ts` exists so the projection has exactly ONE conflict
 *  policy, and its header says so outright: *"a second implementation of 'which
 *  value wins' is the bug this module exists to prevent."* This function was that
 *  second implementation. It now calls `resolveContribution` — the same pure,
 *  storage-free resolver the server materializer runs — so the two cannot drift.
 *
 *  **Why one contribution per card is sufficient.**
 *  `materializeContactProjection` re-resolves the survivor over the UNION of the
 *  merge group's contributions, and `resolveContribution` is a max under a total
 *  preorder — so `max(A ∪ B) = max(max A, max B)`. A card's DISPLAYED value already
 *  IS its own contact's winner, and `projection_provenance` describes the
 *  contribution that won it. Ranking the cards' winners against each other
 *  therefore yields exactly the value the merge will project. No need to ship every
 *  contribution to the client.
 *
 *  ⚠ **What this replaced, and why it misinformed.** It ranked by
 *  `last_interaction`, calling itself "latest-write-wins" — but `last_interaction`
 *  is not a write time at all: it is WHEN YOU LAST EMAILED THE PERSON, which says
 *  nothing about which source asserted their company. It disagreed with the ladder
 *  on exactly the case D-205 #4 made common — a fresher `contact_book` (Google)
 *  against a staler `vendor_meta` (HubSpot): the card highlighted Google's `Acme
 *  Corp` while the projection kept HubSpot's `Acme Inc.` **The user confirmed a
 *  merge looking at a value they would not get.** Never submitted (the merge is
 *  identity-only — `contact.merge.confirm` sends `{candidate_ids, survivor_email}`
 *  and no field values), so it damaged no data; it simply lied at the moment of
 *  decision.
 *
 *  Returns the emails of the cards showing the winning VALUE — usually one, several
 *  when cards share it verbatim. Returns **EMPTY (no highlight)** rather than a
 *  guess in the two cases where the winner is genuinely unknowable here:
 *
 *    1. a card holds a value but no RANKABLE provenance (a row materialized before
 *       provenance carried `as_of`/`confidence`) — ranking the others without it
 *       would crown a winner chosen from a subset of the candidates;
 *    2. a full tie (rung + `as_of` + `confidence`) between DIFFERENT values, which
 *       the engine settles by row order — an order the dialog cannot see, so any
 *       pick is a coin-flip rendered as fact.
 *
 *  A highlight is read as FACT at the moment of decision. Absent beats wrong.
 *  [[feedback_provenance_that_lies_is_worse_than_absent]] */
const winningCardsForField = (
  item: MergeReviewItem,
  field: ContactMatchField,
): ReadonlySet<string> => {
  // ⚠ NEVER index provenance by the field name: `company` is asserted as the kind
  // `org` and `mailing_address` as `address` — half this field set — so a
  // by-column lookup silently misses exactly the fields that conflict most.
  const kind = CONTACT_MATCH_FIELD_CONTRIBUTION_KIND[field];

  const ranked: CardFieldContribution[] = [];
  for (const card of item.cards) {
    // `fieldValue` is the RENDERED string (an address is flattened for display).
    // Safe as the contribution's `value`: the resolver ranks on provenance alone
    // and never inspects it — it is carried only to identify the winning cards.
    const value = fieldValue(card, field).trim();
    if (value === '') continue; // nothing to win with
    const p = card.provenance?.[kind];
    if (p === undefined || p.as_of === undefined || p.confidence === undefined) {
      return new Set(); // case 1 — unrankable. Refuse the field; do not guess.
    }
    ranked.push({
      email: card.email,
      kind,
      value,
      source: p.source,
      confidence: p.confidence,
      as_of: p.as_of,
    });
  }

  const winner = resolveContribution(ranked);
  if (winner === null) return new Set();

  const ambiguous = ranked.some(
    (c) =>
      c.value !== winner.value
      && contactContributionRank(c.source) === contactContributionRank(winner.source)
      && c.as_of === winner.as_of
      && c.confidence === winner.confidence,
  );
  if (ambiguous) return new Set(); // case 2 — the engine's row order decides, not us.

  const winners = new Set<string>();
  for (const card of item.cards) {
    if (fieldValue(card, field).trim() === winner.value) winners.add(card.email);
  }
  return winners;
};

/** Count of vendor-mergeable platform_ids across all cards in an
 *  item. > 0 ⇒ "Also merge upstream" is shown; 0 ⇒ hidden (purely-
 *  mail / purely-calendar candidates per spec § A.6). */
const vendorMergeCapableCount = (item: MergeReviewItem): number => {
  let total = 0;
  for (const card of item.cards) {
    if (!card.platform_ids) continue;
    total += card.platform_ids.length;
  }
  return total;
};

/** Render one platform-link badge inside a card's footer. */
const renderPlatformBadge = (entry: PlatformIdEntry): string => {
  const label = `${entry.vendor}:${entry.platform_id}`;
  const stateClass =
    entry.state === 'confirmed'
      ? 'merge-review-platform-badge--confirmed'
      : 'merge-review-platform-badge--auto';
  return `
    <span class="merge-review-platform-badge ${stateClass}"
      data-vendor="${e(entry.vendor)}"
      data-platform-id="${e(entry.platform_id)}">
      ${e(label)}
    </span>
  `;
};

const renderCardField = (
  card: MergeReviewContactCard,
  field: ContactMatchField,
  isWinner: boolean,
): string => {
  const value = fieldValue(card, field).trim();
  const display = value === '' ? '—' : value;
  const wonClass = isWinner ? ' merge-review-field--winner' : '';
  const valueClass = value === '' ? ' merge-review-field-value--muted' : '';
  return `
    <div class="merge-review-field${wonClass}" data-field="${e(field)}">
      <span class="merge-review-field-label">${e(FIELD_LABELS[field])}</span>
      <span class="merge-review-field-value${valueClass}">${e(display)}</span>
    </div>
  `;
};

/** True when the item has 2 cards (pair layout); false otherwise
 *  (multi-way layout). Single-card items aren't valid (no pair to
 *  resolve); the substrate-issued candidates always carry ≥ 2 cards. */
const isPairLayout = (item: MergeReviewItem): boolean => item.cards.length === 2;

/** The winning cards per field, resolved ONCE for the whole item.
 *
 *  ⚠ Hoisted deliberately. The winner of a field is a property of the ITEM, not of
 *  the card being drawn — but it used to be recomputed inside `renderCard`, i.e.
 *  once per card per field. That is O(N²) over a cluster the dialog explicitly
 *  refuses to cap (a 50-card cluster ran the resolver 200 times to produce 4
 *  distinct answers), and each call now does real work: it builds a contribution
 *  per card and runs the ladder over them. Compute it once, read it N times. */
const winnersByField = (
  item: MergeReviewItem,
): ReadonlyMap<ContactMatchField, ReadonlySet<string>> => {
  const byField = new Map<ContactMatchField, ReadonlySet<string>>();
  for (const f of MERGE_REVIEW_FIELDS) byField.set(f, winningCardsForField(item, f));
  return byField;
};

const renderCard = (
  card: MergeReviewContactCard,
  winners: ReadonlyMap<ContactMatchField, ReadonlySet<string>>,
  index: number,
  survivor: string,
  layout: 'pair' | 'multi-way',
  saving: boolean,
): string => {
  const isSurvivor = card.email === survivor;
  const surviveClass = isSurvivor ? ' merge-review-card--survivor' : '';
  const fields = MERGE_REVIEW_FIELDS.map((f) =>
    renderCardField(card, f, winners.get(f)?.has(card.email) === true),
  ).join('');
  const platformBadges = (card.platform_ids ?? []).map(renderPlatformBadge).join('');
  const sourceCaption = card.source
    ? `<span class="merge-review-card-source">via ${e(card.source)}</span>`
    : '';
  // Codex review fold-back: `saving` must gate every state-changing
  // control, not just the action-bar buttons. The survivor selector
  // can otherwise race the in-flight rpc and end up showing a different
  // survivor than the one the request committed.
  const togglePressed = isSurvivor;
  const toggleDisabled = isSurvivor || saving;
  const radioDisabled = saving;
  const survivorControl = layout === 'pair'
    ? `<button type="button"
         class="rx-btn rx-btn-link rx-btn-xs btn btn-link btn-xs merge-review-survivor-toggle"
         data-action="contact-merge-set-survivor"
         data-card-index="${index}"
         data-email="${e(card.email)}"
         aria-pressed="${togglePressed ? 'true' : 'false'}"
         ${toggleDisabled ? 'disabled' : ''}>
         ${isSurvivor ? 'Survivor' : 'Set as survivor'}
       </button>`
    : `<label class="merge-review-survivor-radio">
         <input type="radio"
           name="merge-review-survivor"
           value="${e(card.email)}"
           data-action="contact-merge-pick-survivor"
           data-email="${e(card.email)}"
           ${isSurvivor ? 'checked' : ''}
           ${radioDisabled ? 'disabled' : ''} />
         ${isSurvivor ? '<strong>Survivor</strong>' : 'Set as survivor'}
       </label>`;
  return `
    <article class="merge-review-card${surviveClass}"
      data-card-index="${index}"
      data-email="${e(card.email)}">
      <header class="merge-review-card-header">
        <strong class="merge-review-card-name">${e(card.name ?? card.email)}</strong>
        <span class="merge-review-card-email">${e(card.email)}</span>
        ${sourceCaption}
      </header>
      <div class="merge-review-card-fields">${fields}</div>
      ${platformBadges
        ? `<footer class="merge-review-card-platform">${platformBadges}</footer>`
        : ''}
      <div class="merge-review-card-survivor">${survivorControl}</div>
    </article>
  `;
};

const renderItemHeader = (
  cursor: number,
  total: number,
  layout: 'pair' | 'multi-way',
  cardCount: number,
): string => {
  const layoutLabel = layout === 'pair' ? 'pair' : `cluster of ${cardCount}`;
  return `
    <header class="merge-review-item-header">
      <span class="merge-review-progress">${cursor + 1} of ${total}</span>
      <span class="merge-review-layout-label">${e(layoutLabel)}</span>
    </header>
  `;
};

const renderActionBar = (
  item: MergeReviewItem,
  cursor: number,
  total: number,
  saving: boolean,
  vendorMergeable: boolean,
  allowDefer: boolean,
): string => {
  const candidateIdsAttr = e(item.candidates.map((c) => c.id).join(','));
  const buttons: string[] = [];
  buttons.push(
    button({
      label: 'Mark as different',
      variant: 'danger-text',
      size: 'sm',
      action: 'contact-merge-reject',
      data: { 'candidate-ids': item.candidates.map((c) => c.id).join(',') },
      disabled: saving,
    }),
  );
  buttons.push(
    button({
      label: 'Merge',
      variant: 'primary',
      size: 'sm',
      action: 'contact-merge-confirm',
      data: { 'candidate-ids': item.candidates.map((c) => c.id).join(',') },
      disabled: saving,
    }),
  );
  if (vendorMergeable) {
    buttons.push(
      button({
        label: 'Also merge upstream',
        variant: 'secondary',
        size: 'sm',
        action: 'contact-merge-confirm-upstream',
        data: { 'candidate-ids': item.candidates.map((c) => c.id).join(',') },
        disabled: saving,
      }),
    );
  }
  const navButtons: string[] = [];
  if (cursor > 0) {
    navButtons.push(
      button({
        label: '← Prev',
        size: 'sm',
        action: 'contact-merge-prev',
        disabled: saving,
      }),
    );
  }
  if (cursor < total - 1) {
    navButtons.push(
      button({
        label: 'Skip →',
        size: 'sm',
        action: 'contact-merge-next',
        disabled: saving,
      }),
    );
  }
  if (allowDefer) {
    navButtons.push(
      button({
        label: 'Review later',
        size: 'sm',
        action: 'contact-merge-defer',
        disabled: saving,
      }),
    );
  }
  // Carry the candidate id list on the bar itself so generic
  // delegation handlers can read it without walking the children
  // (host runtime patterns vary — extension's action-dispatcher and
  // webapp's event delegation both prefer `currentTarget.dataset`).
  return `
    <div class="merge-review-action-bar"
      data-candidate-ids="${candidateIdsAttr}">
      ${actionBar({
        children: navButtons,
        align: 'start',
        gap: 6,
      })}
      ${actionBar({
        children: buttons,
        align: 'end',
        gap: 8,
      })}
    </div>
  `;
};

const renderItem = (
  item: MergeReviewItem,
  cursor: number,
  total: number,
  survivor: string,
  saving: boolean,
  allowDefer: boolean,
  allowUpstreamMerge: boolean,
): string => {
  const layout: 'pair' | 'multi-way' = isPairLayout(item) ? 'pair' : 'multi-way';
  // BOTH must hold: the host can service the destructive vendor merge, AND
  // this item actually has vendor records to merge. Having links is not
  // permission to mutate them.
  const vendorMergeable = allowUpstreamMerge && vendorMergeCapableCount(item) > 0;
  const winners = winnersByField(item);
  const cards = item.cards.map((card, idx) =>
    renderCard(card, winners, idx, survivor, layout, saving),
  ).join('');
  const cardsContainer = `
    <div class="merge-review-cards merge-review-cards--${layout}"
      data-layout="${layout}">
      ${cards}
    </div>
  `;
  return `
    <article class="merge-review-item"
      data-cursor="${cursor}"
      data-card-count="${item.cards.length}">
      ${renderItemHeader(cursor, total, layout, item.cards.length)}
      ${cardsContainer}
      ${renderActionBar(item, cursor, total, saving, vendorMergeable, allowDefer)}
    </article>
  `;
};

const renderEmpty = (): string => `
  <div class="merge-review-empty">
    ${panel({
      tone: 'info',
      title: 'No pending merge candidates',
      body: 'When duplicate contacts surface, they’ll appear here for review. You can scan now from Settings → Contacts.',
    })}
  </div>
`;

const renderHeader = (
  total: number,
  surface: MergeReviewDialogState['surface'],
): string => {
  const subtitle =
    surface === 'enrollment'
      ? 'Review duplicates we found while syncing this connection. Merge keeps every linked record on a single canonical contact.'
      : 'Pending merge candidates from inline detection + housekeeping scans. Each item resolves on its own; nothing happens until you confirm.';
  return `
    <header class="merge-review-header">
      <h2 class="merge-review-title">Merge candidates</h2>
      <p class="merge-review-subtitle">${e(subtitle)}</p>
      ${total > 0
        ? `<p class="merge-review-pending-count">${total} item${total === 1 ? '' : 's'} pending</p>`
        : ''}
    </header>
  `;
};

export const renderMergeReviewDialog = (props: MergeReviewDialogProps): string => {
  const total = props.items.length;
  const cursor = total === 0 ? 0 : Math.min(Math.max(0, props.cursor), total - 1);
  const item = total === 0 ? null : props.items[cursor];
  const surface = props.surface;
  const allowDefer = props.allow_defer ?? false;
  const errorBlock = props.error
    ? panel({ tone: 'danger', title: 'Action failed', body: e(props.error) })
    : '';
  const reviewLaterHint =
    surface === 'enrollment' && allowDefer && total > 0
      ? inlineHint('Use "Review later" to finish enrollment now and review these from the badge afterwards.')
      : '';
  const itemBody = item == null
    ? renderEmpty()
    : renderItem(
        item,
        cursor,
        total,
        props.survivor_overrides[cursor] ?? item.default_survivor,
        props.saving,
        allowDefer,
        // Fail closed: a host that has not declared it can perform the
        // destructive vendor merge is not offered the button.
        props.allow_upstream_merge ?? false,
      );
  return `
    <section class="merge-review-dialog"
      role="dialog"
      aria-label="Contact merge review"
      data-surface="${e(surface ?? 'notification')}"
      data-total="${total}">
      ${renderHeader(total, surface)}
      ${errorBlock}
      ${reviewLaterHint}
      ${itemBody}
    </section>
  `;
};

export const MERGE_REVIEW_DIALOG_STYLES = `
.merge-review-dialog {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.merge-review-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.merge-review-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}
.merge-review-subtitle {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0;
}
.merge-review-pending-count {
  font-size: 12px;
  font-weight: 500;
  color: var(--fg-muted);
  margin: 0;
}
.merge-review-empty {
  padding: 8px 0;
}
.merge-review-item {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.merge-review-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: var(--fg-muted);
}
.merge-review-progress {
  font-weight: 600;
  color: var(--fg);
}
.merge-review-layout-label {
  text-transform: lowercase;
}
.merge-review-cards {
  display: grid;
  gap: 12px;
}
.merge-review-cards--pair {
  grid-template-columns: 1fr 1fr;
}
.merge-review-cards--multi-way {
  /* Horizontal scroll for ≥3 cards; flex row keeps cards a fixed
     min-width so even a 50-card cluster is browsable. */
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: visible;
  max-height: 60vh;
  padding-bottom: 8px;
}
.merge-review-cards--multi-way > .merge-review-card {
  flex: 0 0 280px;
}
.merge-review-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  min-width: 0;
}
.merge-review-card--survivor {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent-weak) inset;
}
.merge-review-card-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.merge-review-card-name {
  font-size: 13px;
  color: var(--fg);
}
.merge-review-card-email {
  font-size: 11px;
  color: var(--fg-muted);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  word-break: break-all;
}
.merge-review-card-source {
  font-size: 11px;
  color: var(--fg-muted);
}
.merge-review-card-fields {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.merge-review-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 6px;
  border-radius: 4px;
  background: transparent;
}
.merge-review-field--winner {
  background: var(--accent-weak);
  color: var(--accent);
}
.merge-review-field--winner .merge-review-field-value {
  color: var(--accent);
  font-weight: 600;
}
.merge-review-field-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-muted);
}
.merge-review-field-value {
  font-size: 12px;
  color: var(--fg);
  word-break: break-word;
}
.merge-review-field-value--muted {
  color: var(--fg-muted);
  font-style: italic;
}
.merge-review-card-platform {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.merge-review-platform-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--surface-sunk);
  border: 1px solid var(--border);
  color: var(--fg-muted);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.merge-review-platform-badge--confirmed {
  border-color: var(--accent);
  color: var(--accent);
}
.merge-review-card-survivor {
  display: flex;
  justify-content: flex-start;
  border-top: 1px solid var(--border);
  padding-top: 6px;
}
.merge-review-survivor-radio {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--fg-muted);
  cursor: pointer;
}
.merge-review-survivor-toggle {
  font-size: 11px;
}
.merge-review-action-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  background: var(--bg);
  z-index: 1;
}
`;
