/** D-138 Phase 2 — `<MergeReviewDialog>` + enrollment focus page.
 *
 *  Pure render tests; the host wires the data-action clicks to rpcs.
 *  We pin the spec acceptance items (§ P2 acceptance):
 *    - Pair layout: 2-card side-by-side; primary-color winning
 *      highlight per field.
 *    - Multi-way layout: scrollable card row + per-card survivor
 *      radio + fixed bottom action bar.
 *    - No cluster-size cap — 50-card cluster renders without
 *      truncation.
 *    - "Mark as different" carries only the surfaced candidate ids
 *      (Reviewer #5 — pairwise edges only, never the transitive
 *      closure).
 *    - "Also merge upstream" hidden when the item carries no
 *      vendor-mergeable platform_ids.
 *    - "Review later" affordance present on the enrollment surface.
 *    - Survivor selection via per-card affordance / radio.
 *
 *  Focus-page sub-stage acceptance:
 *    - Three sub-stages render the right counter shape.
 *    - ETA suppressed until enough samples accumulated.
 *    - ETA appears once the threshold is crossed.
 *    - Review stage opens the dialog with the batch.
 */

import { describe, expect, it } from 'vitest';
import {
  renderMergeReviewDialog,
  type MergeReviewItem,
  type MergeReviewDialogProps,
} from '../contacts/merge-review-dialog.js';
import {
  renderEnrollmentFocusPage,
  isEtaEligible,
  remainingMillis,
  formatRemaining,
  DEFAULT_ETA_CONFIG,
  type EnrollmentFocusPageProps,
  type ScanProgress,
} from '../contacts/enrollment-focus-page.js';
import type {
  ContactContributionSource,
  ContactFieldProvenance,
  ContactMergeCandidate,
  PlatformIdEntry,
} from '@recued/contracts';

/** One card's winning contribution for one field, as the materializer stamps it.
 *  `confidence` defaults to 1 — the resolver only consults it below `as_of`. */
const prov = (
  source: ContactContributionSource,
  as_of: number,
  extra: { source_id?: string; confidence?: number } = {},
): ContactFieldProvenance => ({
  source,
  as_of,
  confidence: extra.confidence ?? 1,
  ...(extra.source_id !== undefined ? { source_id: extra.source_id } : {}),
});

/** Emails of the cards whose `field` cell carries the winner highlight, sorted.
 *  `[]` means the dialog declined to name a winner. */
const winnersFor = (html: string, field: string): string[] => {
  const out: string[] = [];
  const cards = html.matchAll(
    /<article class="merge-review-card[^"]*"[^>]*data-email="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g,
  );
  for (const match of cards) {
    const email = match[1]!;
    const body = match[2]!;
    const winner = new RegExp(
      `<div class="merge-review-field merge-review-field--winner"[^>]*data-field="${field}"`,
    );
    if (winner.test(body)) out.push(email);
  }
  return out.sort();
};

const candidate = (
  id: string,
  email_a: string,
  email_b: string,
): ContactMergeCandidate => ({
  id,
  email_a: email_a < email_b ? email_a : email_b,
  email_b: email_a < email_b ? email_b : email_a,
  pair_key: [email_a, email_b].sort().join('|'),
  matched_fields: ['name', 'company'],
  detected_at: 1_700_000_000_000,
  detected_by: 'enrollment:hubspot-prod',
  status: 'pending',
});

const hubspotPlatform: PlatformIdEntry = {
  vendor: 'hubspot',
  platform_id: '47291',
  state: 'auto',
  linked_at: 1_700_000_000_000,
  linked_by: 'reconciler:hubspot',
};

const pairItem: MergeReviewItem = {
  cards: [
    {
      email: 'bob@acme.com',
      name: 'Bob Smith',
      company: 'Acme',
      phone: '+15551234567',
      mailing_address: {
        address1: '100 main street',
        city: 'springfield',
        state: 'IL',
        zip: '62701',
        country: 'US',
      },
      last_interaction: 1_700_000_010_000,
      source: 'mail',
      platform_ids: [hubspotPlatform],
    },
    {
      email: 'b.smith@acme.com',
      name: 'Bob Smith',
      company: 'Acme',
      phone: '+15551234567',
      mailing_address: {
        address1: '100 main street',
        city: 'springfield',
        state: 'IL',
        zip: '62701',
        country: 'US',
      },
      last_interaction: 1_700_000_005_000,
      source: 'reconciler',
      platform_ids: [
        {
          vendor: 'salesforce',
          platform_id: '003ABC',
          state: 'auto',
          linked_at: 1_700_000_005_000,
          linked_by: 'reconciler:salesforce',
        },
      ],
    },
  ],
  candidates: [candidate('cand_pair_1', 'bob@acme.com', 'b.smith@acme.com')],
  default_survivor: 'bob@acme.com',
};

const baseProps = (item: MergeReviewItem): MergeReviewDialogProps => ({
  items: [item],
  cursor: 0,
  survivor_overrides: {},
  saving: false,
  error: null,
  surface: 'enrollment',
  allow_defer: true,
});

describe('D-138 P2 — renderMergeReviewDialog (pair layout)', () => {
  it('renders two side-by-side cards (pair layout)', () => {
    const html = renderMergeReviewDialog(baseProps(pairItem));
    expect(html).toContain('merge-review-cards--pair');
    expect(html).toContain('data-layout="pair"');
    // Both emails should render.
    expect(html).toContain('bob@acme.com');
    expect(html).toContain('b.smith@acme.com');
  });

  it('marks the most-recent-last_interaction card as the default survivor', () => {
    const html = renderMergeReviewDialog(baseProps(pairItem));
    // The bob@ card has the higher last_interaction so it should
    // carry the survivor class + the disabled "Survivor" toggle.
    const bobCardMatch = html.match(
      /<article class="merge-review-card[^"]*"[^>]*data-email="bob@acme\.com"[^>]*>[\s\S]*?<\/article>/,
    );
    expect(bobCardMatch).not.toBeNull();
    expect(bobCardMatch![0]).toContain('merge-review-card--survivor');
    expect(bobCardMatch![0]).toContain('aria-pressed="true"');
  });

  // ⛔ The test that used to live here — "highlights the latest-write-wins value
  //    per field" — PINNED THE BUG. It asserted the highlight followed
  //    `last_interaction`, which is not a write time at all but when the user last
  //    emailed the person. The projection decides by the C-2a LADDER. The two
  //    disagree on exactly the case below, and the old test locked in the wrong
  //    answer. Inverted, not deleted: the behaviour it described is the regression.
  it('D-205: highlights what the LADDER keeps — a staler CRM beats a fresher contact book', () => {
    // THE regression case, and D-205 #4 (Google Contacts) made it common:
    //   Google (contact_book) asserted "Acme Corp"  — recently.
    //   HubSpot (vendor_meta)  asserted "Acme Inc." — a year ago.
    // A CRM outranks a contact book; recency only breaks a WITHIN-rung tie. So the
    // merge projects HubSpot's "Acme Inc." — even though Google's card is the one
    // with the newer interaction AND the newer assertion.
    const item: MergeReviewItem = {
      ...pairItem,
      cards: [
        {
          ...pairItem.cards[0],
          email: 'bob@acme.com',
          company: 'Acme Corp',
          // Freshest on BOTH axes the old comparator looked at — it crowned this card.
          last_interaction: 1_700_000_010_000,
          updated_at: 1_700_000_900_000,
          provenance: {
            org: prov('contact_book', 1_700_000_000_000, { source_id: 'google.personal.contact' }),
          },
        },
        {
          ...pairItem.cards[1],
          email: 'b.smith@acme.com',
          company: 'Acme Inc.',
          last_interaction: 1_700_000_005_000,
          updated_at: 1_700_000_100_000,
          provenance: {
            org: prov('vendor_meta', 1_600_000_000_000, { source_id: 'hubspot.work.contact' }),
          },
        },
      ],
    };
    const html = renderMergeReviewDialog(baseProps(item));
    // The higher RUNG wins, not the fresher card.
    expect(winnersFor(html, 'company')).toEqual(['b.smith@acme.com']);
  });

  it('D-205: highlights every card sharing the winning value', () => {
    const item: MergeReviewItem = {
      ...pairItem,
      cards: [
        {
          ...pairItem.cards[0],
          email: 'bob@acme.com',
          company: 'Acme Inc.',
          provenance: { org: prov('vendor_meta', 1_600_000_000_000) },
        },
        {
          ...pairItem.cards[1],
          email: 'b.smith@acme.com',
          company: 'Acme Inc.',
          provenance: { org: prov('derived', 1_700_000_000_000) },
        },
      ],
    };
    const html = renderMergeReviewDialog(baseProps(item));
    expect(winnersFor(html, 'company')).toEqual(['b.smith@acme.com', 'bob@acme.com']);
  });

  it('shows "Set as survivor" affordance on the non-survivor card', () => {
    const html = renderMergeReviewDialog(baseProps(pairItem));
    expect(html).toContain('contact-merge-set-survivor');
    expect(html).toContain('Set as survivor');
  });

  it('renders Merge / Mark as different / Also merge upstream when vendor records present AND the host allows it', () => {
    const html = renderMergeReviewDialog({
      ...baseProps(pairItem),
      allow_upstream_merge: true,
    });
    expect(html).toContain('contact-merge-confirm');
    expect(html).toContain('contact-merge-reject');
    expect(html).toContain('contact-merge-confirm-upstream');
    expect(html).toContain('Also merge upstream');
  });

  it('D-205 #2b: FAIL-CLOSED — no "Also merge upstream" unless the host declares it can service it', () => {
    // Having vendor links is a DISPLAY fact; being able to mutate the vendor is
    // a HOST capability. Conflating them rendered a destructive button that
    // silently did nothing on any host that had not wired `upstream_merge.*`
    // — and after D-192 slice 7, CRM-sourced duplicates almost always carry
    // platform_ids, so that was the normal case, not the edge case.
    const html = renderMergeReviewDialog(baseProps(pairItem));
    expect(html).toContain('contact-merge-confirm');
    expect(html).toContain('contact-merge-reject');
    expect(html).not.toContain('contact-merge-confirm-upstream');
    expect(html).not.toContain('Also merge upstream');
    // …and the links are STILL shown. Suppressing the action must not suppress
    // the fact — the badges are how the user knows the CRM records exist.
    expect(html).toContain('merge-review-platform-badge');
  });

  it('hides "Also merge upstream" when no card has a platform_id, even if the host allows it', () => {
    const noVendor: MergeReviewItem = {
      ...pairItem,
      cards: pairItem.cards.map((c) => ({ ...c, platform_ids: [] })),
    };
    const html = renderMergeReviewDialog({
      ...baseProps(noVendor),
      allow_upstream_merge: true,
    });
    expect(html).toContain('contact-merge-confirm');
    expect(html).toContain('contact-merge-reject');
    expect(html).not.toContain('contact-merge-confirm-upstream');
    expect(html).not.toContain('Also merge upstream');
  });

  it('renders the Review later affordance when allow_defer is true', () => {
    const html = renderMergeReviewDialog(baseProps(pairItem));
    expect(html).toContain('contact-merge-defer');
    expect(html).toContain('Review later');
  });

  it('omits the Review later affordance on notification surface (allow_defer false)', () => {
    const html = renderMergeReviewDialog({
      ...baseProps(pairItem),
      surface: 'notification',
      allow_defer: false,
    });
    expect(html).not.toContain('contact-merge-defer');
  });

  it('reject button data-candidate-ids carries every surfaced edge id', () => {
    const item: MergeReviewItem = {
      ...pairItem,
      candidates: [
        candidate('cand_a', 'bob@acme.com', 'b.smith@acme.com'),
      ],
    };
    const html = renderMergeReviewDialog(baseProps(item));
    const rejectButtonMatch = html.match(
      /data-action="contact-merge-reject"[^>]*data-candidate-ids="([^"]*)"/,
    );
    expect(rejectButtonMatch).not.toBeNull();
    expect(rejectButtonMatch![1]).toBe('cand_a');
  });

  it('shows the confirmed badge styling when platform link state is confirmed', () => {
    const confirmed: MergeReviewItem = {
      ...pairItem,
      cards: [
        {
          ...pairItem.cards[0],
          platform_ids: [{ ...hubspotPlatform, state: 'confirmed' }],
        },
        pairItem.cards[1],
      ],
    };
    const html = renderMergeReviewDialog(baseProps(confirmed));
    expect(html).toContain('merge-review-platform-badge--confirmed');
  });
});

describe('D-138 P2 — renderMergeReviewDialog (multi-way layout)', () => {
  const buildCluster = (n: number, edgeCount: number): MergeReviewItem => {
    const cards = Array.from({ length: n }, (_, i) => ({
      email: `user${i}@example.com`,
      name: `User ${i}`,
      company: 'Example',
      phone: '+15550000000',
      last_interaction: 1_700_000_000_000 + i * 1_000,
      source: 'reconciler',
      platform_ids: [
        {
          vendor: 'hubspot',
          platform_id: `hs_${i}`,
          state: 'auto' as const,
          linked_at: 1_700_000_000_000 + i,
          linked_by: 'reconciler:hubspot',
        },
      ],
    }));
    const candidates: ContactMergeCandidate[] = [];
    for (let i = 0; i < edgeCount && i + 1 < n; i += 1) {
      candidates.push(
        candidate(
          `cand_cluster_${i}`,
          `user${i}@example.com`,
          `user${i + 1}@example.com`,
        ),
      );
    }
    return {
      cards,
      candidates,
      default_survivor: cards[cards.length - 1].email,
    };
  };

  it('renders multi-way layout for 3+ cards', () => {
    const cluster = buildCluster(4, 3);
    const html = renderMergeReviewDialog(baseProps(cluster));
    expect(html).toContain('merge-review-cards--multi-way');
    expect(html).toContain('data-layout="multi-way"');
    // Per-card radio selector (multi-way) replaces the link-style toggle.
    expect(html).toContain('merge-review-survivor-radio');
    expect(html).toContain('contact-merge-pick-survivor');
  });

  it('renders no cluster-size cap (50-card cluster renders 50 cards)', () => {
    const cluster = buildCluster(50, 49);
    const html = renderMergeReviewDialog(baseProps(cluster));
    const cardCount = (html.match(/<article class="merge-review-card/g) ?? []).length;
    expect(cardCount).toBe(50);
  });

  it('keeps the bottom action bar fixed (sticky positioning class)', () => {
    const cluster = buildCluster(20, 19);
    const html = renderMergeReviewDialog(baseProps(cluster));
    expect(html).toContain('merge-review-action-bar');
  });

  it('reject for a multi-way cluster carries only the surfaced edge ids (not the transitive closure)', () => {
    // 6 cards, 5 surfaced edges (chain). Transitive closure would be C(6,2) = 15.
    const cluster = buildCluster(6, 5);
    const html = renderMergeReviewDialog(baseProps(cluster));
    const rejectButtonMatch = html.match(
      /data-action="contact-merge-reject"[^>]*data-candidate-ids="([^"]*)"/,
    );
    expect(rejectButtonMatch).not.toBeNull();
    const ids = rejectButtonMatch![1].split(',');
    expect(ids).toHaveLength(5);
    expect(ids.every((id) => id.startsWith('cand_cluster_'))).toBe(true);
  });

  it('per-card radio defaults to the item.default_survivor', () => {
    const cluster = buildCluster(4, 3);
    const html = renderMergeReviewDialog(baseProps(cluster));
    const checkedRadioMatch = html.match(
      /name="merge-review-survivor"[^>]*value="([^"]*)"[^>]*checked/,
    );
    expect(checkedRadioMatch).not.toBeNull();
    expect(checkedRadioMatch![1]).toBe(cluster.default_survivor);
  });

  it('survivor_overrides patches the active survivor', () => {
    const cluster = buildCluster(3, 2);
    const html = renderMergeReviewDialog({
      ...baseProps(cluster),
      survivor_overrides: { 0: cluster.cards[0].email },
    });
    const checkedRadioMatch = html.match(
      /name="merge-review-survivor"[^>]*value="([^"]*)"[^>]*checked/,
    );
    expect(checkedRadioMatch).not.toBeNull();
    expect(checkedRadioMatch![1]).toBe(cluster.cards[0].email);
  });
});

describe('D-138 P2 — renderMergeReviewDialog (sequencing + empty / error states)', () => {
  it('renders 1 of N progress when multiple items are pending', () => {
    const items: MergeReviewItem[] = [pairItem, pairItem, pairItem];
    const html = renderMergeReviewDialog({
      items,
      cursor: 1,
      survivor_overrides: {},
      saving: false,
      error: null,
      surface: 'notification',
    });
    expect(html).toContain('2 of 3');
  });

  it('renders an empty-state message when no candidates pending', () => {
    const html = renderMergeReviewDialog({
      items: [],
      cursor: 0,
      survivor_overrides: {},
      saving: false,
      error: null,
    });
    expect(html).toContain('No pending merge candidates');
  });

  it('renders the action error inside a danger panel', () => {
    const html = renderMergeReviewDialog({
      ...baseProps(pairItem),
      error: 'rpc rejected: bad_request',
    });
    expect(html).toContain('Action failed');
    expect(html).toContain('rpc rejected: bad_request');
  });

  it('disables every action while saving', () => {
    const html = renderMergeReviewDialog({
      ...baseProps(pairItem),
      saving: true,
    });
    const confirmButtons = html.match(
      /data-action="contact-merge-confirm"[^>]*disabled/g,
    );
    expect(confirmButtons).not.toBeNull();
    const rejectButtons = html.match(
      /data-action="contact-merge-reject"[^>]*disabled/g,
    );
    expect(rejectButtons).not.toBeNull();
  });

  it('disables the survivor toggle / radio while saving (Codex finding)', () => {
    // Pair layout — the non-survivor "Set as survivor" toggle must
    // disable while a merge / reject rpc is in flight; otherwise the
    // user can race the request and end up showing a different
    // survivor than the one being committed.
    const pairHtml = renderMergeReviewDialog({
      ...baseProps(pairItem),
      saving: true,
    });
    // Every survivor toggle inside the cards should carry `disabled`
    // while saving — we have one survivor (already disabled) and one
    // non-survivor (newly disabled because of saving).
    const toggleButtons = pairHtml.match(
      /data-action="contact-merge-set-survivor"[^>]*disabled[^>]*>/g,
    );
    expect(toggleButtons).not.toBeNull();
    expect(toggleButtons!.length).toBe(2);
    // Multi-way layout — every radio input should carry `disabled`.
    const cluster: MergeReviewItem = {
      cards: [
        { ...pairItem.cards[0] },
        { ...pairItem.cards[1] },
        {
          email: 'b.s@acme.com',
          name: 'Bob Smith',
          last_interaction: 1_700_000_000_000,
          source: 'manual',
          platform_ids: [],
        },
      ],
      candidates: [
        candidate('cand_m_1', 'bob@acme.com', 'b.smith@acme.com'),
        candidate('cand_m_2', 'b.smith@acme.com', 'b.s@acme.com'),
      ],
      default_survivor: 'bob@acme.com',
    };
    const multiHtml = renderMergeReviewDialog({
      items: [cluster],
      cursor: 0,
      survivor_overrides: {},
      saving: true,
      error: null,
      surface: 'enrollment',
      allow_defer: true,
    });
    const radios = multiHtml.match(
      /name="merge-review-survivor"[^>]*disabled/g,
    );
    expect(radios).not.toBeNull();
    expect(radios!.length).toBe(3);
  });

  // ⛔ This replaces "breaks per-field winner ties on updated_at (Codex finding)",
  //    which also pinned the bug: row `updated_at` is engine bookkeeping and the
  //    ladder never consults it. A rung tie breaks on the contribution's `as_of` —
  //    the SOURCE's assertion time. Keeping the old test would have locked the
  //    dialog to a quantity the projection cannot see.
  it('D-205: breaks a RUNG TIE on as_of — the two mail-derived duplicates case', () => {
    // The commonest merge there is: one person, two mail-derived rows. Both are
    // `derived`, so the rung ties and the ladder falls through to `as_of`. Note
    // `updated_at` points the OTHER way — if it were still the tiebreak, bob@ would
    // win and the test would catch it.
    const tied: MergeReviewItem = {
      ...pairItem,
      cards: [
        {
          ...pairItem.cards[0],
          email: 'bob@acme.com',
          company: 'Acme Old',
          last_interaction: 1_700_000_000_000,
          updated_at: 1_700_000_500_000,
          provenance: { org: prov('derived', 1_600_000_000_000) },
        },
        {
          ...pairItem.cards[1],
          email: 'b.smith@acme.com',
          company: 'Acme New',
          last_interaction: 1_700_000_000_000,
          updated_at: 1_700_000_100_000,
          provenance: { org: prov('derived', 1_700_000_000_000) },
        },
      ],
      default_survivor: 'bob@acme.com',
    };
    const html = renderMergeReviewDialog(baseProps(tied));
    expect(winnersFor(html, 'company')).toEqual(['b.smith@acme.com']);
  });

  it('D-205: a card with NO rankable provenance suppresses the highlight — never a guess', () => {
    // A value we cannot rank must not silently lose to one we can: that would crown
    // a "winner" chosen from a subset of the candidates and render it as fact.
    // Absent beats wrong.
    const item: MergeReviewItem = {
      ...pairItem,
      cards: [
        {
          ...pairItem.cards[0],
          email: 'bob@acme.com',
          company: 'Acme Corp',
          provenance: { org: prov('vendor_meta', 1_700_000_000_000) },
        },
        // No provenance at all (e.g. a row materialized before it carried `as_of`).
        { ...pairItem.cards[1], email: 'b.smith@acme.com', company: 'Acme Inc.' },
      ],
    };
    expect(winnersFor(renderMergeReviewDialog(baseProps(item)), 'company')).toEqual([]);
  });

  it('D-205: a full rung/as_of/confidence tie on DIFFERENT values suppresses the highlight', () => {
    // The engine settles this by row order, which the dialog cannot see. Picking one
    // would be a coin-flip presented to the user as the answer.
    const item: MergeReviewItem = {
      ...pairItem,
      cards: [
        {
          ...pairItem.cards[0],
          email: 'bob@acme.com',
          company: 'Acme Corp',
          provenance: { org: prov('derived', 1_700_000_000_000) },
        },
        {
          ...pairItem.cards[1],
          email: 'b.smith@acme.com',
          company: 'Acme Inc.',
          provenance: { org: prov('derived', 1_700_000_000_000) },
        },
      ],
    };
    expect(winnersFor(renderMergeReviewDialog(baseProps(item)), 'company')).toEqual([]);
  });

  // 🔑 The #2a trap, and it lands on HALF this field set. The provenance map is
  //    keyed by CONTRIBUTION KIND, not by the card's column: `company` is asserted
  //    as `org`, `mailing_address` as `address`. A by-column lookup returns
  //    `undefined` for exactly those two — and they are precisely the fields sources
  //    disagree about. The miss is silent: the highlight just quietly disappears.
  it('D-205: reads provenance by CONTRIBUTION KIND — company→org, mailing_address→address', () => {
    const addrA = { address1: '1 First St', city: 'Springfield', state: 'IL', zip: '62701', country: 'US' };
    const addrB = { address1: '2 Second Ave', city: 'Springfield', state: 'IL', zip: '62701', country: 'US' };
    const item: MergeReviewItem = {
      ...pairItem,
      cards: [
        {
          ...pairItem.cards[0],
          email: 'bob@acme.com',
          company: 'Acme Corp',
          mailing_address: addrA,
          provenance: {
            // Keyed `org` / `address` — NOT `company` / `mailing_address`.
            org: prov('contact_book', 1_700_000_000_000),
            address: prov('contact_book', 1_700_000_000_000),
          },
        },
        {
          ...pairItem.cards[1],
          email: 'b.smith@acme.com',
          company: 'Acme Inc.',
          mailing_address: addrB,
          provenance: {
            org: prov('vendor_meta', 1_600_000_000_000),
            address: prov('vendor_meta', 1_600_000_000_000),
          },
        },
      ],
    };
    const html = renderMergeReviewDialog(baseProps(item));
    // Both resolve to the higher rung. Look the map up by column name instead and
    // BOTH of these become `[]` — the silent miss this test exists to catch.
    expect(winnersFor(html, 'company')).toEqual(['b.smith@acme.com']);
    expect(winnersFor(html, 'mailing_address')).toEqual(['b.smith@acme.com']);
  });

  it('omits the Prev button on the first item and the Skip button on the last item', () => {
    const items = [pairItem];
    const html = renderMergeReviewDialog({
      items,
      cursor: 0,
      survivor_overrides: {},
      saving: false,
      error: null,
      surface: 'enrollment',
    });
    expect(html).not.toContain('contact-merge-prev');
    expect(html).not.toContain('contact-merge-next');
  });

  it('surface flips the subtitle copy', () => {
    const enrollment = renderMergeReviewDialog(baseProps(pairItem));
    expect(enrollment).toContain('while syncing this connection');
    const notification = renderMergeReviewDialog({
      ...baseProps(pairItem),
      surface: 'notification',
    });
    expect(notification).toContain('inline detection');
  });
});

describe('D-138 P2 — enrollment focus page sub-stages', () => {
  const baseFocusProps = (
    overrides: Partial<EnrollmentFocusPageProps> = {},
  ): EnrollmentFocusPageProps => ({
    connection_label: 'HubSpot',
    stage: 'syncing-contacts',
    sync_progress: { synced: 12, total: 100 },
    scan_progress: {
      compared: 0,
      total_iterations: 0,
      samples: 0,
      ms_per_iteration: null,
    },
    dialog: {
      items: [],
      cursor: 0,
      survivor_overrides: {},
      saving: false,
      error: null,
      surface: 'enrollment',
    },
    error: null,
    ...overrides,
  });

  it('renders sync counter "Syncing contacts X/Y" during syncing-contacts stage', () => {
    const html = renderEnrollmentFocusPage(baseFocusProps());
    expect(html).toContain('Syncing contacts 12/100');
    expect(html).toContain('data-stage="syncing-contacts"');
  });

  it('renders an indeterminate progress bar while total is unknown', () => {
    const html = renderEnrollmentFocusPage(
      baseFocusProps({ sync_progress: { synced: 5, total: null } }),
    );
    expect(html).toContain('focus-page-progress-bar--indeterminate');
    expect(html).toContain('Syncing contacts 5');
  });

  it('renders Comparing X/N during resolving-duplicates stage', () => {
    const html = renderEnrollmentFocusPage(
      baseFocusProps({
        stage: 'resolving-duplicates',
        scan_progress: {
          compared: 4,
          total_iterations: 200,
          samples: 1,
          ms_per_iteration: 12,
        },
      }),
    );
    expect(html).toContain('Comparing 4/200');
  });

  it('suppresses the ETA before sample threshold is met', () => {
    const html = renderEnrollmentFocusPage(
      baseFocusProps({
        stage: 'resolving-duplicates',
        scan_progress: {
          compared: 2,
          total_iterations: 200,
          samples: 2,
          ms_per_iteration: 5,
        },
      }),
    );
    expect(html).toContain('ETA arriving once we have enough samples');
  });

  it('renders the ETA after samples cross the threshold', () => {
    // 200 iterations × 0.05 = 10 samples needed; provide 12.
    const html = renderEnrollmentFocusPage(
      baseFocusProps({
        stage: 'resolving-duplicates',
        scan_progress: {
          compared: 12,
          total_iterations: 200,
          samples: 12,
          ms_per_iteration: 50,
        },
      }),
    );
    expect(html).toContain('ETA:');
    expect(html).not.toContain('ETA arriving once we have enough samples');
  });

  it('opens the merge review dialog at the review stage', () => {
    const html = renderEnrollmentFocusPage(
      baseFocusProps({
        stage: 'review',
        dialog: {
          items: [pairItem],
          cursor: 0,
          survivor_overrides: {},
          saving: false,
          error: null,
          surface: 'enrollment',
        },
      }),
    );
    expect(html).toContain('merge-review-dialog');
    expect(html).toContain('contact-merge-confirm');
    // Review later button surfaces from inside the dialog.
    expect(html).toContain('contact-merge-defer');
  });

  it('renders the Cancel-defer affordance during sync stage', () => {
    const html = renderEnrollmentFocusPage(baseFocusProps());
    expect(html).toContain('enrollment-focus-defer');
    expect(html).toContain('Cancel — leave duplicates for later');
  });

  it('renders Done button on the complete stage', () => {
    const html = renderEnrollmentFocusPage(
      baseFocusProps({ stage: 'complete' }),
    );
    expect(html).toContain('enrollment-focus-complete');
    expect(html).toContain('Enrollment complete');
  });

  it('omits the cancel control on the complete stage', () => {
    const html = renderEnrollmentFocusPage(
      baseFocusProps({ stage: 'complete' }),
    );
    expect(html).not.toContain('enrollment-focus-defer');
  });

  it('marker progression — done stages render ✓, active renders ●', () => {
    const html = renderEnrollmentFocusPage(
      baseFocusProps({ stage: 'review' }),
    );
    // Two stages before review should be flagged done.
    const doneRows = html.match(/focus-page-stage-row--done/g) ?? [];
    expect(doneRows.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('focus-page-stage-row--active');
  });

  it('inline error renders when error is set', () => {
    const html = renderEnrollmentFocusPage(
      baseFocusProps({ error: 'Reconciler crashed mid-cycle' }),
    );
    expect(html).toContain('Reconciler crashed mid-cycle');
  });
});

describe('D-138 P2 — ETA helpers (pure)', () => {
  const baseScan: ScanProgress = {
    compared: 50,
    total_iterations: 200,
    samples: 0,
    ms_per_iteration: null,
  };

  it('isEtaEligible returns false without samples', () => {
    expect(isEtaEligible(baseScan)).toBe(false);
  });

  it('isEtaEligible enforces the absolute minimum sample count', () => {
    const ineligible = {
      ...baseScan,
      samples: DEFAULT_ETA_CONFIG.eta_min_samples - 1,
      ms_per_iteration: 10,
    };
    expect(isEtaEligible(ineligible)).toBe(false);
  });

  it('isEtaEligible enforces the 5% fraction threshold', () => {
    // 1000 iterations × 5% = 50 samples needed.
    const tooFew = {
      compared: 30,
      total_iterations: 1_000,
      samples: 30,
      ms_per_iteration: 5,
    };
    expect(isEtaEligible(tooFew)).toBe(false);
    const enough = {
      compared: 60,
      total_iterations: 1_000,
      samples: 60,
      ms_per_iteration: 5,
    };
    expect(isEtaEligible(enough)).toBe(true);
  });

  it('remainingMillis returns null when ETA is ineligible', () => {
    expect(remainingMillis(baseScan)).toBeNull();
  });

  it('remainingMillis projects linearly across remaining iterations', () => {
    const scan = {
      compared: 100,
      total_iterations: 200,
      samples: 50,
      ms_per_iteration: 4,
    };
    expect(remainingMillis(scan)).toBe(400);
  });

  it('formatRemaining buckets into <1s / ~Ns / ~Nm', () => {
    expect(formatRemaining(500)).toBe('<1s');
    expect(formatRemaining(3_400)).toBe('~3s');
    expect(formatRemaining(45_000)).toBe('~45s');
    expect(formatRemaining(120_000)).toBe('~2m');
  });
});
