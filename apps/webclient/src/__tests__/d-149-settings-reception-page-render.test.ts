/** D-149 follow-on § A.9 — Reception page renderer + mount acceptance.
 *
 *  `renderReceptionPage` is a PURE projection of `ReceptionPageShellState`
 *  to an HTML string — these tests assert it draws each view (unloaded /
 *  list / detail / view-as-visitor), routes by the documented
 *  precedence, emits the right `data-action` + `data-*` markup, and
 *  escapes every server-/user-supplied string.
 *
 *  `mountReceptionPage` is the `mountServerPill`-shape mount — these
 *  tests drive it through a DOM-free fake host (the established
 *  `action-dispatcher.test.ts` pattern; the repo ships no jsdom) +
 *  a fake shell, and assert: it renders on mount, re-renders on every
 *  shell state change, the mount-native `data-action` clicks drive the
 *  shell, the host-forwarded ones reach `onUnhandledAction`, and
 *  `dispose()` tears everything down.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  AbuseInboxSummary,
  AccessLogEntry,
  EndpointSummary,
  ReceptionIpBlockEntry,
} from '@recued/contracts';
import {
  INTAKE_FORM_TEMPLATE_REFS,
  RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
} from '@recued/contracts';

import {
  renderReceptionPage,
  mountReceptionPage,
  resolveReceptionActiveView,
  RECEPTION_PAGE_ACTIONS,
  RECEPTION_PAGE_NATIVE_ACTIONS,
  RECEPTION_PAGE_STYLES,
} from '../settings/reception-page-render.js';
import {
  buildReceptionPageModel,
  buildReceptionEndpointDetailModel,
  type ReceptionStatusInput,
} from '../settings/reception.js';
import { buildAbuseInboxSubviewModel } from '../settings/reception-abuse-inbox.js';
import type { ViewAsVisitorModel } from '../settings/reception-view-as-visitor.js';
import type {
  ReceptionPageShell,
  ReceptionPageShellState,
} from '../settings/reception-page-shell.js';

const NOW = 1_700_000_000_000;

// ── Fixtures ──────────────────────────────────────────────────────

const buildEndpointSummary = (
  overrides: Partial<EndpointSummary> = {},
): EndpointSummary => ({
  endpoint_id: 'ep-1',
  kind: 'scheduling_link',
  enabled: true,
  packet_declaration: {
    packet_kind: 'scheduling_link_packet',
    source_query_ref: { kind: 'data.calendar.combined' },
  },
  created_at: NOW - 60_000,
  created_by_client_id: 'client-A',
  expires_at: null,
  long_lived_acknowledged_at: NOW - 60_000,
  revoked_at: null,
  revocation_reason: null,
  audit_count: 0,
  last_accessed_at: null,
  metadata: {},
  ...overrides,
});

const buildAccessLogEntry = (
  overrides: Partial<AccessLogEntry> = {},
): AccessLogEntry => ({
  id: 'log-1',
  endpoint_id: 'ep-1',
  accessed_at: NOW - 30_000,
  source_ip_hash: 'abc12345def67890',
  user_agent_hash: 'ua-hash',
  action_taken: 'view',
  outcome: 'ok',
  url_path_redacted: '/reception/sched',
  metadata: {},
  ...overrides,
});

const abuseSummary = (
  overrides: Partial<AbuseInboxSummary> = {},
): AbuseInboxSummary => ({
  rows: [],
  total_signals: 0,
  window_start_at: NOW - 7 * 24 * 60 * 60 * 1000,
  window_end_at: NOW,
  cluster_threshold: 3,
  ...overrides,
});

const blockEntry = (
  overrides: Partial<ReceptionIpBlockEntry> = {},
): ReceptionIpBlockEntry => ({
  endpoint_id: 'ep-1',
  source_ip_hash: 'abc12345def67890',
  blocked_at: NOW - 120_000,
  blocked_by_client_id: 'client-A',
  reason: 'persistent abuse',
  ...overrides,
});

const status = (
  overrides: Partial<ReceptionStatusInput> = {},
): ReceptionStatusInput => ({
  emergency_disabled: false,
  reception_public: true,
  base_url: 'https://alice.recued.cloud',
  ...overrides,
});

const emptyState = (
  overrides: Partial<ReceptionPageShellState> = {},
): ReceptionPageShellState => ({
  page: null,
  detail: null,
  abuse_inbox: null,
  view_as_visitor: null,
  status: status(),
  last_error: null,
  loading: false,
  ...overrides,
});

/** A loaded list-view state with one active scheduling-link endpoint. */
const loadedState = (
  endpoints: ReadonlyArray<EndpointSummary> = [buildEndpointSummary()],
  overrides: Partial<ReceptionPageShellState> = {},
): ReceptionPageShellState =>
  emptyState({
    page: buildReceptionPageModel({ endpoints, status: status(), now: NOW }),
    ...overrides,
  });

const viewAsVisitorModel = (
  overrides: Partial<ViewAsVisitorModel> = {},
): ViewAsVisitorModel => ({
  rendered_html: '<h1>Book a call</h1>',
  panel: {
    synthetic: true,
    endpoint_kind: 'scheduling_link',
    packet_kind: 'scheduling_link_packet',
    visible_fields: ['free_windows'],
    visible_field_rows: [
      { field: 'free_windows', visible: true, rationale: 'exposed per the packet kind' },
    ],
    stripped_field_rows: [
      { field: 'event_title', visible: false, rationale: 'private calendar detail' },
    ],
    visible_field_count: 1,
    stripped_field_count: 1,
    expiry_policy: {
      default_label: '7 days',
      max_label: 'no hard ceiling',
      expires_at: null,
      expires_at_label: 'Never expires',
      is_long_lived: true,
    },
    token_mode: 'bearer_query_param',
    token_mode_label: 'Bearer token in the link',
    token_mode_description: 'The share link carries an HMAC-keyed bearer secret.',
    audit_mode: 'signed_on_booking',
    audit_mode_label: 'Operational log, plus a signed event on every booking',
    audit_mode_description: 'Every visitor view writes an operational access-log row.',
    invariant_summary: {
      rows: [
        { invariant: 'Endpoint is default-off until explicitly enabled', detail: 'why-1', satisfied: true },
        { invariant: 'Bearer token is HMAC-keyed and never re-readable', detail: 'why-2', satisfied: false },
      ],
      all_satisfied: false,
      satisfied_count: 1,
      total_count: 2,
      compliance_label: '1 of 2 privacy invariants satisfied — review the flagged 1 before enabling',
    },
  },
  preview_hash: 'hash-abc',
  preview_hash_expires_at: NOW + 600_000,
  preview_is_fresh: true,
  preview_freshness_label: 'Preview valid for 10 more minutes',
  ...overrides,
});

// ── DOM-free fake host (the action-dispatcher.test.ts pattern) ────

const makeFakeHost = () => {
  let html = '';
  let listener: ((event: Event) => void) | null = null;
  const host = {
    get innerHTML() {
      return html;
    },
    set innerHTML(v: string) {
      html = v;
    },
    addEventListener: (evt: string, fn: (event: Event) => void) => {
      if (evt === 'click') listener = fn;
    },
    removeEventListener: (evt: string, fn: (event: Event) => void) => {
      if (evt === 'click' && listener === fn) listener = null;
    },
    contains: () => true,
  } as unknown as HTMLElement;
  return {
    host,
    getHtml: () => html,
    hasListener: () => listener !== null,
    /** Simulate a delegated click on an element carrying `data-action` +
     *  the given extra `data-*` attributes (already camelCased, as a real
     *  `dataset` would expose them). */
    click: (dataset: Record<string, string>) => {
      if (!listener) return;
      const el = { dataset, closest: () => el } as unknown as HTMLElement;
      listener({ target: el, preventDefault: () => {} } as unknown as Event);
    },
  };
};

// ── Fake shell ────────────────────────────────────────────────────

const makeFakeShell = (initial: ReceptionPageShellState) => {
  let current = initial;
  const listeners = new Set<(s: ReceptionPageShellState) => void>();
  const method = () => vi.fn(() => Promise.resolve(undefined as never));
  const sync = () => vi.fn();
  const fns = {
    loadPage: method(),
    enableEndpoint: method(),
    disableEndpoint: method(),
    revokeEndpoint: method(),
    extendEndpoint: method(),
    rotateToken: method(),
    emergencyDisableAll: method(),
    openDetail: method(),
    previewEndpointAsVisitor: method(),
    loadAbuseInbox: method(),
    banIp: method(),
    unbanIp: method(),
    runPreview: method(),
    createEndpoint: method(),
    upsertReceptionPage: method(),
    runLaunchWizard: method(),
    closeDetail: sync(),
    closeViewAsVisitor: sync(),
    setStatus: sync(),
    setEndpointShare: sync(),
    dispose: sync(),
  };
  const shell = {
    getState: () => current,
    subscribe: (l: (s: ReceptionPageShellState) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    ...fns,
  } as unknown as ReceptionPageShell;
  return {
    shell,
    fns,
    listenerCount: () => listeners.size,
    pushState: (next: ReceptionPageShellState) => {
      current = next;
      for (const l of [...listeners]) l(current);
    },
  };
};

// ══════════════════════════════════════════════════════════════════
// renderReceptionPage — top-level views
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderReceptionPage: top-level views', () => {
  it('unloaded state renders the "Load Reception" prompt', () => {
    const html = renderReceptionPage(emptyState(), NOW);
    expect(html).toContain('Load Reception');
    expect(html).toContain('data-action="reception-refresh"');
    expect(html).toContain('data-view="unloaded"');
  });

  it('loading state renders the loading bar', () => {
    expect(renderReceptionPage(emptyState({ loading: true }), NOW)).toContain(
      'reception-loading-bar',
    );
    expect(renderReceptionPage(emptyState({ loading: false }), NOW)).not.toContain(
      'reception-loading-bar',
    );
  });

  it('status header reflects the loaded page status_header', () => {
    const html = renderReceptionPage(loadedState(), NOW);
    expect(html).toContain('Reception');
    expect(html).toContain('alice.recued.cloud');
    expect(html).toContain('1 active · 1 total');
  });

  it('status header before load falls back to the out-of-band status context', () => {
    const html = renderReceptionPage(
      emptyState({ status: status({ reception_public: false }) }),
      NOW,
    );
    expect(html).toContain('Not publicly exposed');
  });
});

// ══════════════════════════════════════════════════════════════════
// renderReceptionPage — list view
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderReceptionPage: list view', () => {
  it('renders all six per-kind sections', () => {
    const html = renderReceptionPage(loadedState(), NOW);
    expect(html).toContain('Reception page');
    expect(html).toContain('Scheduling links');
    expect(html).toContain('Intake forms');
    expect(html).toContain('Drop links');
    expect(html).toContain('Approval links');
    expect(html).toContain('Status pages');
  });

  it('renders an endpoint row with status badge, expiry label, and audit count', () => {
    const html = renderReceptionPage(loadedState(), NOW);
    expect(html).toContain('ep-1');
    expect(html).toContain('Active');
    expect(html).toContain('Never expires');
    expect(html).toContain('0 accesses');
  });

  it('an active available non-singleton row offers disable / rotate / extend / revoke', () => {
    const html = renderReceptionPage(
      loadedState([buildEndpointSummary({ enabled: true, kind: 'intake_form' })]),
      NOW,
    );
    expect(html).toContain('data-action="reception-disable"');
    expect(html).toContain('data-action="reception-rotate-token"');
    expect(html).toContain('data-action="reception-extend"');
    expect(html).toContain('data-action="reception-revoke"');
    expect(html).not.toContain('data-action="reception-enable"');
  });

  it('every PAIRABLE kind exposes the recipe selector; a kind with no consumer does not', () => {
    // D-210 R-2 slice 4 — the gate is no longer "is this an intake form" but "is there
    // anything that would RUN this pair" (`RECEPTION_PAIR_CONSUMER`, read by BOTH this
    // render and the rpc that refuses the bind — a second list here would eventually offer
    // a button that 409s).
    const intake = renderReceptionPage(
      loadedState([buildEndpointSummary({ kind: 'intake_form' })]),
      NOW,
    );
    expect(intake).toContain('data-action="reception-pair-intake-recipe"');
    expect(intake).toContain('data-endpoint-id="ep-1"');
    // The label was 'Checkout recipe' — D-200's vocabulary, already stale for intake since
    // D-207 generalized the pair to any recipe, and plainly wrong for a booking.
    expect(intake).toContain('Recipe');

    // A booking page is pairable since slice 3b: the drain runs its pair.
    const scheduling = renderReceptionPage(
      loadedState([buildEndpointSummary({ kind: 'scheduling_link' })]),
      NOW,
    );
    expect(scheduling).toContain('data-action="reception-pair-intake-recipe"');

    // A drop link has NO consumer — nothing would run a pair bound to it, so offering the
    // button would promise something the substrate refuses.
    const drop = renderReceptionPage(
      loadedState([buildEndpointSummary({ kind: 'drop_link' })]),
      NOW,
    );
    expect(drop).not.toContain('data-action="reception-pair-intake-recipe"');
  });

  it('a revoked intake form still exposes its pair so the owner can inspect or clear it', () => {
    const html = renderReceptionPage(
      loadedState([
        buildEndpointSummary({
          kind: 'intake_form',
          revoked_at: NOW - 1000,
          revocation_reason: 'retired',
        }),
      ]),
      NOW,
    );
    expect(html).toContain('data-action="reception-pair-intake-recipe"');
    expect(html).toContain('data-action="reception-open-detail"');
    expect(html).not.toContain('data-action="reception-revoke"');
  });

  it('a disabled row offers enable, not disable', () => {
    const html = renderReceptionPage(loadedState([buildEndpointSummary({ enabled: false })]), NOW);
    expect(html).toContain('data-action="reception-enable"');
    expect(html).not.toContain('data-action="reception-disable"');
  });

  it('a revoked row offers detail only — no revoke, no enable', () => {
    const html = renderReceptionPage(
      loadedState([
        buildEndpointSummary({ revoked_at: NOW - 1000, revocation_reason: 'leak' }),
      ]),
      NOW,
    );
    expect(html).toContain('Revoked');
    expect(html).toContain('Revoked: leak');
    expect(html).toContain('data-action="reception-open-detail"');
    expect(html).not.toContain('data-action="reception-revoke"');
    expect(html).not.toContain('data-action="reception-enable"');
  });

  it('the reception_page singleton offers "Edit page", never rotate / revoke', () => {
    const singleton = buildEndpointSummary({
      endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
      kind: 'reception_page',
      packet_declaration: {
        packet_kind: 'reception_page_packet',
        source_query_ref: { kind: 'reception_page_config' },
      },
    });
    const html = renderReceptionPage(loadedState([singleton]), NOW);
    expect(html).toContain('Reception page');
    expect(html).toContain('data-action="reception-edit-page"');
    expect(html).not.toContain('data-action="reception-rotate-token"');
  });

  it('renders the first-run Launch Wizard CTA when is_first_run', () => {
    const html = renderReceptionPage(loadedState([]), NOW);
    expect(html).toContain('Start the Launch Wizard');
    expect(html).toContain('data-action="reception-launch-wizard"');
  });

  it('R19 — the spine no longer renders the inline Abuse / Templates subviews', () => {
    // Both the Abuse Inbox + Templates panels graduated OUT of the spine
    // (Abuse → the first-class #reception/abuse section; the inline
    // Templates panel was dead and deleted). Even with both state fields
    // populated, the spine list view ignores them.
    const inbox = buildAbuseInboxSubviewModel({
      summary: abuseSummary({
        rows: [
          {
            signal_kind: 'spam_burst',
            endpoint_id: 'ep-1',
            source_ip_hash: 'abc12345def67890',
            event_count: 12,
            first_seen_at: NOW - 600_000,
            last_seen_at: NOW - 60_000,
            ip_blocked: false,
          },
        ],
        total_signals: 1,
      }),
      blocked: [blockEntry()],
      now: NOW,
    });
    const html = renderReceptionPage(
      loadedState([buildEndpointSummary()], {
        abuse_inbox: inbox,
      }),
      NOW,
    );
    // The endpoint spine still renders.
    expect(html).toContain('reception-sections');
    // The inline Abuse panel + its actions are gone from the spine.
    expect(html).not.toContain('data-action="reception-open-abuse-inbox"');
    expect(html).not.toContain('Abuse Inbox');
    expect(html).not.toContain('data-action="reception-ban-ip"');
    // The inline Templates panel is deleted.
    expect(html).not.toContain('Intake form templates');
    expect(html).not.toContain('data-action="reception-use-template"');
    expect(html).not.toContain(`data-template-ref="${INTAKE_FORM_TEMPLATE_REFS[0]}"`);
  });
});

// ══════════════════════════════════════════════════════════════════
// renderReceptionPage — gateEditPage (DD#7)
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderReceptionPage: editPageGated (DD#7)', () => {
  const singleton = (): EndpointSummary =>
    buildEndpointSummary({
      endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
      kind: 'reception_page',
      packet_declaration: {
        packet_kind: 'reception_page_packet',
        source_query_ref: { kind: 'reception_page_config' },
      },
    });

  it('disables the singleton row "Edit page" button when editPageGated is true', () => {
    const html = renderReceptionPage(loadedState([singleton()]), NOW, {
      editPageGated: true,
    });
    // The button still carries the action attribute (markup is unchanged
    // structurally) but is rendered with `disabled` + the gated tooltip.
    expect(html).toContain('data-action="reception-edit-page"');
    expect(html).toMatch(/<button [^>]*data-action="reception-edit-page"[^>]*disabled/);
    expect(html).toContain('Loading reception page settings…');
  });

  it('leaves the singleton row "Edit page" button enabled when editPageGated is false (default)', () => {
    const html = renderReceptionPage(loadedState([singleton()]), NOW);
    expect(html).toContain('data-action="reception-edit-page"');
    expect(html).not.toMatch(/<button [^>]*data-action="reception-edit-page"[^>]*disabled/);
    expect(html).not.toContain('Loading reception page settings…');
  });

  it('disables the reception_page section create button when editPageGated is true (fresh-install gate)', () => {
    // No singleton row — the section renders the create button (same
    // action: reception-edit-page). The create button must be gated too.
    const html = renderReceptionPage(loadedState([]), NOW, { editPageGated: true });
    expect(html).toMatch(/<button [^>]*data-action="reception-edit-page"[^>]*disabled/);
    expect(html).toContain('Loading reception page settings…');
  });

  it('does NOT disable the singleton row "Detail" button when editPageGated is true', () => {
    const html = renderReceptionPage(loadedState([singleton()]), NOW, {
      editPageGated: true,
    });
    // Detail is unaffected — only Edit page is gated by this seam.
    expect(html).toContain('data-action="reception-open-detail"');
    expect(html).not.toMatch(/<button [^>]*data-action="reception-open-detail"[^>]*disabled/);
  });

  it('hides unavailable non-singleton create buttons while leaving available kinds creatable', () => {
    const html = renderReceptionPage(loadedState([]), NOW, { editPageGated: true });
    // status_link stays hidden (visitor reader unwired); scheduling_link
    // is creatable since D-173 P4.2 (cold-start slot picker is served).
    expect(html).not.toMatch(
      /<button [^>]*data-action="reception-new-endpoint"[^>]*data-kind="status_link"/,
    );
    expect(html).toMatch(/<button [^>]*data-action="reception-new-endpoint"[^>]*data-kind="scheduling_link"/);
    expect(html).toMatch(/<button [^>]*data-action="reception-new-endpoint"[^>]*data-kind="intake_form"/);
    expect(html).toMatch(/<button [^>]*data-action="reception-new-endpoint"[^>]*data-kind="drop_link"/);
    expect(html).not.toMatch(
      /<button [^>]*data-action="reception-new-endpoint"[^>]*disabled/,
    );
  });
});

// ══════════════════════════════════════════════════════════════════
// renderReceptionPage — detail view
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderReceptionPage: detail view', () => {
  it('renders the per-endpoint detail with a back button and the packet declaration', () => {
    const detail = buildReceptionEndpointDetailModel({
      summary: buildEndpointSummary({ endpoint_id: 'ep-7' }),
      access_log: [buildAccessLogEntry({ endpoint_id: 'ep-7' })],
      now: NOW,
    });
    const html = renderReceptionPage(loadedState([buildEndpointSummary()], { detail }), NOW);
    expect(html).toContain('data-view="detail"');
    expect(html).toContain('data-action="reception-close-detail"');
    expect(html).toContain('ep-7');
    expect(html).toContain('scheduling_link_packet');
    expect(html).toContain('data.calendar.combined');
  });

  it('renders the access-log table rows', () => {
    const detail = buildReceptionEndpointDetailModel({
      summary: buildEndpointSummary(),
      access_log: [buildAccessLogEntry({ source_ip_hash: 'abc12345def67890' })],
      now: NOW,
    });
    const html = renderReceptionPage(loadedState([buildEndpointSummary()], { detail }), NOW);
    expect(html).toContain('Viewed');
    // § A.16.7 — the source-IP hash is shown truncated to its 8-char prefix.
    expect(html).toContain('abc12345…');
    expect(html).not.toContain('abc12345def67890');
  });

  it('shows the "rotate to mint a share URL" hint when no share URL is held', () => {
    const detail = buildReceptionEndpointDetailModel({
      summary: buildEndpointSummary({ kind: 'intake_form' }),
      access_log: [],
      now: NOW,
    });
    const html = renderReceptionPage(loadedState([buildEndpointSummary()], { detail }), NOW);
    expect(html).toContain('Rotate the token to mint a fresh one');
    expect(html).toContain('data-action="reception-rotate-token"');
  });

  it('Codex fold — the tokenless singleton detail gets no rotate CTA', () => {
    const detail = buildReceptionEndpointDetailModel({
      summary: buildEndpointSummary({
        endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
        kind: 'reception_page',
        packet_declaration: {
          packet_kind: 'reception_page_packet',
          source_query_ref: { kind: 'reception_page_config' },
        },
      }),
      access_log: [],
      now: NOW,
    });
    const html = renderReceptionPage(loadedState([buildEndpointSummary()], { detail }), NOW);
    expect(html).toContain('tokenless public front door');
    expect(html).not.toContain('data-action="reception-rotate-token"');
  });

  it('Codex fold — a revoked endpoint detail gets no rotate CTA', () => {
    const detail = buildReceptionEndpointDetailModel({
      summary: buildEndpointSummary({
        kind: 'intake_form',
        revoked_at: NOW - 1000,
        revocation_reason: 'leak',
      }),
      access_log: [],
      now: NOW,
    });
    const html = renderReceptionPage(loadedState([buildEndpointSummary()], { detail }), NOW);
    expect(html).toContain('its token cannot be rotated');
    expect(html).not.toContain('data-action="reception-rotate-token"');
  });

  it('renders Share Cards when a share URL is held', () => {
    const detail = buildReceptionEndpointDetailModel({
      summary: buildEndpointSummary({ kind: 'intake_form' }),
      access_log: [],
      share: {
        share_url: 'https://alice.recued.cloud/reception/ep-1?t=sec',
        title: 'Book a call',
        description: 'Pick a slot on my calendar.',
      },
      now: NOW,
    });
    const html = renderReceptionPage(loadedState([buildEndpointSummary()], { detail }), NOW);
    expect(html).toContain('reception-share-card');
    expect(html).toContain('reception-share-snippet');
  });

  it('suppresses share and visitor actions for existing status_link endpoints (reader unwired)', () => {
    for (const kind of ['status_link'] as const) {
      const summary = buildEndpointSummary({ kind, enabled: true });
      const detail = buildReceptionEndpointDetailModel({
        summary,
        access_log: [],
        share: {
          share_url: `https://alice.recued.cloud/reception/${kind}/ep-1?t=sec`,
          title: 'Unavailable endpoint',
          description: 'Should not render share snippets.',
        },
        now: NOW,
      });
      const html = renderReceptionPage(loadedState([summary], { detail }), NOW);
      expect(html).not.toContain('data-action="reception-preview-as-visitor"');
      expect(html).not.toContain('data-action="reception-rotate-token"');
      expect(html).not.toContain('reception-share-snippet');
      expect(html).toContain('not yet available');
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// renderReceptionPage — view-as-visitor view
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderReceptionPage: view-as-visitor view', () => {
  it('renders the panel: visible vs stripped fields + the invariant summary', () => {
    const html = renderReceptionPage(
      loadedState([buildEndpointSummary()], { view_as_visitor: viewAsVisitorModel() }),
      NOW,
    );
    expect(html).toContain('data-view="view_as_visitor"');
    expect(html).toContain('data-action="reception-close-view-as-visitor"');
    expect(html).toContain('Visitor sees (1)');
    expect(html).toContain('Stripped at the boundary (1)');
    expect(html).toContain('free_windows');
    expect(html).toContain('event_title');
    expect(html).toContain('1 of 2 privacy invariants satisfied');
    expect(html).toContain('Preview valid for 10 more minutes');
  });

  it('sandboxes the server-rendered visitor HTML in a locked iframe', () => {
    const html = renderReceptionPage(
      loadedState([buildEndpointSummary()], {
        view_as_visitor: viewAsVisitorModel({ rendered_html: '<h1>Hi "you"</h1>' }),
      }),
      NOW,
    );
    expect(html).toContain('<iframe');
    expect(html).toContain('sandbox=""');
    // The visitor markup goes into `srcdoc`, escaped — never the live DOM.
    expect(html).toContain('srcdoc="&lt;h1&gt;Hi &quot;you&quot;&lt;/h1&gt;"');
    expect(html).not.toContain('<h1>Hi "you"</h1>');
  });

  it('falls back to a hint when the preview carried no field-visibility panel', () => {
    const html = renderReceptionPage(
      loadedState([buildEndpointSummary()], {
        view_as_visitor: viewAsVisitorModel({ panel: null }),
      }),
      NOW,
    );
    expect(html).toContain('did not carry a field-visibility panel');
  });
});

// ══════════════════════════════════════════════════════════════════
// renderReceptionPage — routing, errors, escaping
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderReceptionPage: routing + errors + escaping', () => {
  it('resolveReceptionActiveView precedence: view_as_visitor > detail > list > unloaded', () => {
    expect(resolveReceptionActiveView(emptyState())).toBe('unloaded');
    expect(resolveReceptionActiveView(loadedState())).toBe('list');
    const detail = buildReceptionEndpointDetailModel({
      summary: buildEndpointSummary(),
      access_log: [],
      now: NOW,
    });
    expect(resolveReceptionActiveView(loadedState([buildEndpointSummary()], { detail }))).toBe(
      'detail',
    );
    expect(
      resolveReceptionActiveView(
        loadedState([buildEndpointSummary()], { detail, view_as_visitor: viewAsVisitorModel() }),
      ),
    ).toBe('view_as_visitor');
  });

  it('view_as_visitor wins over an open detail in the rendered output', () => {
    const detail = buildReceptionEndpointDetailModel({
      summary: buildEndpointSummary({ endpoint_id: 'ep-detail' }),
      access_log: [],
      now: NOW,
    });
    const html = renderReceptionPage(
      loadedState([buildEndpointSummary()], { detail, view_as_visitor: viewAsVisitorModel() }),
      NOW,
    );
    expect(html).toContain('data-view="view_as_visitor"');
    expect(html).not.toContain('data-view="detail"');
  });

  it('renders a captured rpc failure, resolving the code to spine remediation copy', () => {
    const html = renderReceptionPage(
      emptyState({ last_error: { code: 'endpoint_already_enabled', message: 'already on' } }),
      NOW,
    );
    expect(html).toContain('Reception action failed');
    // Resolved through the spine's RECEPTION_ERROR_COPY, not the raw message.
    expect(html).toContain('already enabled');
    expect(html).toContain('endpoint_already_enabled');
  });

  it('humanizes a transport-level connection failure (no raw rpc string leaks)', () => {
    const html = renderReceptionPage(
      emptyState({ last_error: { code: 'transport', message: 'socket dropped' } }),
      NOW,
    );
    expect(html).not.toContain('socket dropped'); // the raw rpc message no longer leaks
    expect(html).toContain('reach your server'); // humanized connection copy
  });

  it('falls back to the rpc message for an unknown (non-connection) failure', () => {
    const html = renderReceptionPage(
      emptyState({
        last_error: { code: 'some_server_error', message: 'a specific server complaint' },
      }),
      NOW,
    );
    expect(html).toContain('a specific server complaint');
  });

  it('escapes a malicious endpoint id — no raw markup reaches the output', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = renderReceptionPage(
      loadedState([buildEndpointSummary({ endpoint_id: evil })]),
      NOW,
    );
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes a malicious rpc error message', () => {
    // A real (non-connection) error keeps its server message, so escaping must
    // still neutralize markup in it. (A connection code is replaced by fixed
    // copy, so the raw message — malicious or not — never reaches the output.)
    const html = renderReceptionPage(
      emptyState({
        last_error: { code: 'some_server_error', message: '<script>alert(1)</script>' },
      }),
      NOW,
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('Codex fold — a non-http(s) base_url is never emitted into an href', () => {
    const html = renderReceptionPage(
      emptyState({ status: status({ base_url: 'javascript:alert(1)' }) }),
      NOW,
    );
    // The unsafe scheme reaches escaped plain text, never a clickable link.
    expect(html).not.toContain('href="javascript:alert(1)"');
    expect(html).not.toMatch(/<a [^>]*javascript:/);
    expect(html).toContain('javascript:alert(1)');
  });

  it('a real http(s) base_url still renders as a link', () => {
    const html = renderReceptionPage(
      emptyState({ status: status({ base_url: 'https://alice.recued.cloud' }) }),
      NOW,
    );
    expect(html).toContain('href="https://alice.recued.cloud"');
  });

  it('RECEPTION_PAGE_STYLES is a non-empty, self-scoped stylesheet', () => {
    expect(RECEPTION_PAGE_STYLES.length).toBeGreaterThan(0);
    expect(RECEPTION_PAGE_STYLES).toContain('.reception-page');
    expect(RECEPTION_PAGE_STYLES).toContain('.reception-status-header::before');
    expect(RECEPTION_PAGE_STYLES).toContain('.reception-compose-fab::after');
    expect(RECEPTION_PAGE_STYLES).not.toContain('position: fixed');
  });
});

// ══════════════════════════════════════════════════════════════════
// Action surface
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — renderReceptionPage: action surface', () => {
  it('the native-action list is a subset of the full action list', () => {
    for (const action of RECEPTION_PAGE_NATIVE_ACTIONS) {
      expect(RECEPTION_PAGE_ACTIONS).toContain(action);
    }
  });

  it('every emitted data-action is a declared RECEPTION_PAGE_ACTION', () => {
    // Render every view so each branch's `data-action` markup is exercised.
    const detail = buildReceptionEndpointDetailModel({
      summary: buildEndpointSummary(),
      access_log: [buildAccessLogEntry()],
      now: NOW,
    });
    const inbox = buildAbuseInboxSubviewModel({
      summary: abuseSummary({
        rows: [
          {
            signal_kind: 'spam_burst',
            endpoint_id: 'ep-1',
            source_ip_hash: 'abc12345def67890',
            event_count: 12,
            first_seen_at: NOW - 600_000,
            last_seen_at: NOW - 60_000,
            ip_blocked: true,
          },
        ],
        total_signals: 1,
      }),
      blocked: [blockEntry()],
      now: NOW,
    });
    const htmls = [
      renderReceptionPage(emptyState(), NOW),
      renderReceptionPage(loadedState([]), NOW),
      renderReceptionPage(
        loadedState([buildEndpointSummary({ enabled: true })], {
          abuse_inbox: inbox,
        }),
        NOW,
      ),
      renderReceptionPage(loadedState([buildEndpointSummary()], { detail }), NOW),
      renderReceptionPage(
        loadedState([buildEndpointSummary()], { view_as_visitor: viewAsVisitorModel() }),
        NOW,
      ),
    ];
    const declared = new Set<string>(RECEPTION_PAGE_ACTIONS);
    for (const html of htmls) {
      for (const m of html.matchAll(/data-action="([^"]+)"/g)) {
        expect(declared).toContain(m[1]);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// mountReceptionPage
// ══════════════════════════════════════════════════════════════════

describe('D-149 follow-on — mountReceptionPage: lifecycle', () => {
  it('renders into the host on mount + subscribes to the shell', () => {
    const { host, getHtml } = makeFakeHost();
    const fake = makeFakeShell(loadedState());
    const view = mountReceptionPage({ host, shell: fake.shell, now: () => NOW });
    expect(getHtml()).toContain('Reception');
    expect(fake.listenerCount()).toBe(1);
    view.dispose();
  });

  it('re-renders on every shell state change', () => {
    const { host, getHtml } = makeFakeHost();
    const fake = makeFakeShell(emptyState());
    const view = mountReceptionPage({ host, shell: fake.shell, now: () => NOW });
    expect(getHtml()).toContain('Load Reception');
    fake.pushState(loadedState());
    expect(getHtml()).toContain('1 active · 1 total');
    view.dispose();
  });

  it('dispose() unsubscribes, detaches the dispatcher, and clears the host', () => {
    const { host, getHtml, hasListener } = makeFakeHost();
    const fake = makeFakeShell(loadedState());
    const view = mountReceptionPage({ host, shell: fake.shell, now: () => NOW });
    expect(hasListener()).toBe(true);
    view.dispose();
    expect(fake.listenerCount()).toBe(0);
    expect(hasListener()).toBe(false);
    expect(getHtml()).toBe('');
  });

  it('dispose() is idempotent', () => {
    const { host } = makeFakeHost();
    const fake = makeFakeShell(loadedState());
    const view = mountReceptionPage({ host, shell: fake.shell, now: () => NOW });
    view.dispose();
    expect(() => view.dispose()).not.toThrow();
  });
});

describe('D-149 follow-on — mountReceptionPage: native action dispatch', () => {
  it('reception-refresh drives shell.loadPage()', () => {
    const { host, click } = makeFakeHost();
    const fake = makeFakeShell(emptyState());
    const view = mountReceptionPage({ host, shell: fake.shell, now: () => NOW });
    click({ action: 'reception-refresh' });
    expect(fake.fns.loadPage).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it('reception-open-detail reads data-endpoint-id and drives shell.openDetail(id)', () => {
    const { host, click } = makeFakeHost();
    const fake = makeFakeShell(loadedState());
    const view = mountReceptionPage({ host, shell: fake.shell, now: () => NOW });
    click({ action: 'reception-open-detail', endpointId: 'ep-9' });
    expect(fake.fns.openDetail).toHaveBeenCalledWith('ep-9');
    view.dispose();
  });

  it('reception-enable / reception-disable drive the lifecycle methods with the id', () => {
    const { host, click } = makeFakeHost();
    const fake = makeFakeShell(loadedState());
    const view = mountReceptionPage({ host, shell: fake.shell, now: () => NOW });
    click({ action: 'reception-enable', endpointId: 'ep-3' });
    click({ action: 'reception-disable', endpointId: 'ep-4' });
    expect(fake.fns.enableEndpoint).toHaveBeenCalledWith('ep-3');
    expect(fake.fns.disableEndpoint).toHaveBeenCalledWith('ep-4');
    view.dispose();
  });

  it('reception-ban-ip reads both data-endpoint-id and data-source-ip-hash', () => {
    const { host, click } = makeFakeHost();
    const fake = makeFakeShell(loadedState());
    const view = mountReceptionPage({ host, shell: fake.shell, now: () => NOW });
    click({ action: 'reception-ban-ip', endpointId: 'ep-1', sourceIpHash: 'abc12345def' });
    expect(fake.fns.banIp).toHaveBeenCalledWith('ep-1', 'abc12345def');
    view.dispose();
  });

  it('reception-close-detail / reception-close-view-as-visitor drive the sync closes', () => {
    const { host, click } = makeFakeHost();
    const fake = makeFakeShell(loadedState());
    const view = mountReceptionPage({ host, shell: fake.shell, now: () => NOW });
    click({ action: 'reception-close-detail' });
    click({ action: 'reception-close-view-as-visitor' });
    expect(fake.fns.closeDetail).toHaveBeenCalledTimes(1);
    expect(fake.fns.closeViewAsVisitor).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it('R19 Slice 4 — reception-open-detail navigates via onEnterDetail when wired (NOT the in-place shell open)', () => {
    const { host, click } = makeFakeHost();
    const fake = makeFakeShell(loadedState());
    const onEnterDetail = vi.fn();
    const view = mountReceptionPage({
      host,
      shell: fake.shell,
      onEnterDetail,
      now: () => NOW,
    });
    click({ action: 'reception-open-detail', endpointId: 'ep-9' });
    expect(onEnterDetail).toHaveBeenCalledWith('ep-9');
    expect(fake.fns.openDetail).not.toHaveBeenCalled();
    view.dispose();
  });

  it('R19 Slice 4 — reception-close-detail navigates via onExitDetail when wired (NOT the in-place shell close)', () => {
    const { host, click } = makeFakeHost();
    const fake = makeFakeShell(loadedState());
    const onExitDetail = vi.fn();
    const view = mountReceptionPage({
      host,
      shell: fake.shell,
      onExitDetail,
      now: () => NOW,
    });
    click({ action: 'reception-close-detail' });
    expect(onExitDetail).toHaveBeenCalledTimes(1);
    expect(fake.fns.closeDetail).not.toHaveBeenCalled();
    view.dispose();
  });

  it('R19 Slice 4 — an open-detail click missing the endpoint id is a safe no-op even with onEnterDetail wired', () => {
    const { host, click } = makeFakeHost();
    const fake = makeFakeShell(loadedState());
    const onEnterDetail = vi.fn();
    const view = mountReceptionPage({
      host,
      shell: fake.shell,
      onEnterDetail,
      now: () => NOW,
    });
    expect(() => click({ action: 'reception-open-detail' })).not.toThrow();
    expect(onEnterDetail).not.toHaveBeenCalled();
    expect(fake.fns.openDetail).not.toHaveBeenCalled();
    view.dispose();
  });

  it('reception-open-abuse-inbox drives the subview load natively', () => {
    const { host, click } = makeFakeHost();
    const fake = makeFakeShell(loadedState());
    const view = mountReceptionPage({ host, shell: fake.shell, now: () => NOW });
    click({ action: 'reception-open-abuse-inbox' });
    expect(fake.fns.loadAbuseInbox).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it('reception-open-templates is host-forwarded (opens the standalone gallery, not a native load)', () => {
    const { host, click } = makeFakeHost();
    const fake = makeFakeShell(loadedState());
    const onUnhandledAction = vi.fn();
    const view = mountReceptionPage({
      host,
      shell: fake.shell,
      onUnhandledAction,
      now: () => NOW,
    });
    click({ action: 'reception-open-templates' });
    // The open-templates click forwards to the host (which opens
    // `mountTemplatesBrowser`); it is not a native shell action.
    expect(onUnhandledAction).toHaveBeenCalledWith(
      'reception-open-templates',
      expect.any(Object),
    );
    view.dispose();
  });

  it('an id-only native action with no data-endpoint-id is a safe no-op', () => {
    const { host, click } = makeFakeHost();
    const fake = makeFakeShell(loadedState());
    const view = mountReceptionPage({ host, shell: fake.shell, now: () => NOW });
    expect(() => click({ action: 'reception-open-detail' })).not.toThrow();
    expect(fake.fns.openDetail).not.toHaveBeenCalled();
    view.dispose();
  });
});

describe('D-149 follow-on — mountReceptionPage: host-forwarded actions', () => {
  it('host-forwarded actions reach onUnhandledAction with the action + dataset', () => {
    const { host, click } = makeFakeHost();
    const fake = makeFakeShell(loadedState());
    const onUnhandledAction = vi.fn();
    const view = mountReceptionPage({
      host,
      shell: fake.shell,
      onUnhandledAction,
      now: () => NOW,
    });
    click({ action: 'reception-rotate-token', endpointId: 'ep-1' });
    expect(onUnhandledAction).toHaveBeenCalledWith(
      'reception-rotate-token',
      expect.objectContaining({ endpointId: 'ep-1' }),
    );
    view.dispose();
  });

  it('a host-forwarded action never touches the shell', () => {
    const { host, click } = makeFakeHost();
    const fake = makeFakeShell(loadedState());
    const view = mountReceptionPage({ host, shell: fake.shell, now: () => NOW });
    click({ action: 'reception-revoke', endpointId: 'ep-1' });
    click({ action: 'reception-emergency-disable-all' });
    click({ action: 'reception-launch-wizard' });
    expect(fake.fns.revokeEndpoint).not.toHaveBeenCalled();
    expect(fake.fns.emergencyDisableAll).not.toHaveBeenCalled();
    expect(fake.fns.runLaunchWizard).not.toHaveBeenCalled();
    view.dispose();
  });

  it('host-forwarded actions are inert when no onUnhandledAction is supplied', () => {
    const { host, click } = makeFakeHost();
    const fake = makeFakeShell(loadedState());
    const view = mountReceptionPage({ host, shell: fake.shell, now: () => NOW });
    expect(() => click({ action: 'reception-rotate-token', endpointId: 'ep-1' })).not.toThrow();
    view.dispose();
  });

  it('clicks after dispose() are inert', () => {
    const { host, click } = makeFakeHost();
    const fake = makeFakeShell(loadedState());
    const view = mountReceptionPage({ host, shell: fake.shell, now: () => NOW });
    view.dispose();
    click({ action: 'reception-refresh' });
    expect(fake.fns.loadPage).not.toHaveBeenCalled();
  });
});

describe('D-149 follow-on — mountReceptionPage: gateEditPage seam (DD#7)', () => {
  const singleton = (): EndpointSummary =>
    buildEndpointSummary({
      endpoint_id: RECEPTION_PAGE_SINGLETON_ENDPOINT_ID,
      kind: 'reception_page',
      packet_declaration: {
        packet_kind: 'reception_page_packet',
        source_query_ref: { kind: 'reception_page_config' },
      },
    });

  it('renders the singleton "Edit page" button disabled when gateEditPage returns true', () => {
    const { host, getHtml } = makeFakeHost();
    const fake = makeFakeShell(loadedState([singleton()]));
    const view = mountReceptionPage({
      host,
      shell: fake.shell,
      now: () => NOW,
      gateEditPage: () => true,
    });
    expect(getHtml()).toMatch(/data-action="reception-edit-page"[^>]*disabled/);
    view.dispose();
  });

  it('renders enabled when gateEditPage is absent (default no-op)', () => {
    const { host, getHtml } = makeFakeHost();
    const fake = makeFakeShell(loadedState([singleton()]));
    const view = mountReceptionPage({ host, shell: fake.shell, now: () => NOW });
    expect(getHtml()).not.toMatch(/data-action="reception-edit-page"[^>]*disabled/);
    view.dispose();
  });

  it('re-reads gateEditPage on every render (state-change picks up a flipped gate)', () => {
    const { host, getHtml } = makeFakeHost();
    const fake = makeFakeShell(loadedState([singleton()]));
    let gated = true;
    const view = mountReceptionPage({
      host,
      shell: fake.shell,
      now: () => NOW,
      gateEditPage: () => gated,
    });
    expect(getHtml()).toMatch(/data-action="reception-edit-page"[^>]*disabled/);
    // Flip the gate; a shell-state change triggers re-render.
    gated = false;
    fake.pushState(loadedState([singleton()], { loading: true }));
    expect(getHtml()).not.toMatch(/data-action="reception-edit-page"[^>]*disabled/);
    view.dispose();
  });
});
