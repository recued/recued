import { describe, expect, it } from 'vitest';
import { DEFAULT_DIAGNOSTIC_FRAME } from '../store/local-store.js';
import type { BridgeConfirmedOutcome } from '../../idempotency/cache.js';

import type {
  SidePanelListFrame,
  SidePanelPairState,
  SidePanelStatusFrame,
} from '../store/local-store.js';
import {
  SIDE_PANEL_HEADER_SUBTITLE_ID,
  SIDE_PANEL_HEADER_TITLE_ID,
  SIDE_PANEL_PAIR_HOST_ATTR,
  SIDE_PANEL_PAIR_SECTION_ATTR,
  SIDE_PANEL_SECTION_ATTR,
  SIDE_PANEL_LIST_ITEM_ATTR,
  SIDE_PANEL_STATUS_VALUE_ATTR,
  DESKTOP_NOTIFICATIONS_BLOCKED_COPY,
  SIDE_PANEL_DISCONNECT_ATTR,
  SIDE_PANEL_DISCONNECT_MESSAGE_ATTR,
  SIDE_PANEL_WATCH_BUTTON_ATTR,
  SIDE_PANEL_WATCH_CTA_ATTR,
  SIDE_PANEL_WATCH_STATUS_ATTR,
  SIDE_PANEL_DIAGNOSTIC_REFRESH_ATTR,
  SIDE_PANEL_DIAGNOSTIC_COPY_ATTR,
  SIDE_PANEL_DIAGNOSTIC_SUMMARY_ATTR,
  renderApprovalsSection,
  renderBridgeDiagnosticSection,
  renderElementWatchCta,
  renderNotificationsSection,
  renderPairSection,
  renderRecipeResultsSection,
  renderServerStatusSection,
  BRIDGE_STATUS_CONNECTING,
  updateHeader,
} from '../views.js';

interface FakeElement {
  tagName: string;
  textContent: string;
  className: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
}

interface FakeDocument {
  createElement(tag: string): FakeElement;
  getElementById(id: string): FakeElement | null;
}

const makeFakeDocument = (): FakeDocument => {
  const byId = new Map<string, FakeElement>();
  const make = (tagName: string): FakeElement => {
    const el: FakeElement = {
      tagName: tagName.toUpperCase(),
      textContent: '',
      className: '',
      children: [],
      parent: null,
      attrs: new Map(),
      setAttribute(k, v) {
        el.attrs.set(k, v);
        if (k === 'id') byId.set(v, el);
      },
      getAttribute(k) {
        return el.attrs.get(k) ?? null;
      },
      hasAttribute(k) {
        return el.attrs.has(k);
      },
      appendChild(child) {
        el.children.push(child);
        child.parent = el;
        return child;
      },
      removeChild(child) {
        const idx = el.children.indexOf(child);
        if (idx < 0) throw new Error('removeChild: not a child');
        el.children.splice(idx, 1);
        child.parent = null;
        return child;
      },
      get firstChild() {
        return el.children[0] ?? null;
      },
    };
    return el;
  };
  return {
    createElement: make,
    getElementById(id) {
      return byId.get(id) ?? null;
    },
  };
};

const textOf = (el: FakeElement): string =>
  `${el.textContent}${el.children.map(textOf).join('')}`;

const findByAttr = (
  root: FakeElement,
  attr: string,
  value?: string,
): FakeElement | null => {
  if (
    root.hasAttribute(attr)
    && (value === undefined || root.getAttribute(attr) === value)
  ) {
    return root;
  }
  for (const child of root.children) {
    const hit = findByAttr(child, attr, value);
    if (hit) return hit;
  }
  return null;
};

const findAllByAttr = (
  root: FakeElement,
  attr: string,
  out: FakeElement[] = [],
): FakeElement[] => {
  if (root.hasAttribute(attr)) out.push(root);
  for (const child of root.children) findAllByAttr(child, attr, out);
  return out;
};

const findByTag = (root: FakeElement, tag: string): FakeElement | null => {
  if (root.tagName === tag.toUpperCase()) return root;
  for (const child of root.children) {
    const hit = findByTag(child, tag);
    if (hit) return hit;
  }
  return null;
};

const findAllByClassToken = (
  root: FakeElement,
  token: string,
  out: FakeElement[] = [],
): FakeElement[] => {
  if (root.className.split(/\s+/).includes(token)) out.push(root);
  for (const child of root.children) findAllByClassToken(child, token, out);
  return out;
};

const statusFrame = (patch: Partial<SidePanelStatusFrame> = {}): SidePanelStatusFrame => ({
  fetched_at: 1_800_000_000_000,
  error: null,
  status: {
    name: 'Recued Local',
    version: '1.2.3',
    uptime_seconds: 3_700,
    paired_client_count: 3,
    paired_client_connected: 2,
    ws_state: 'serving',
    last_sync_at: 1_799_999_980_000,
    executions_last_hour: 7,
    executions_last_24h: 31,
    pending_asks: 4,
    ask_load: {
      window_ms: 604_800_000,
      raised: 12,
      answered_sample: 9,
      median_answer_ms: 2_520_000,
      load: 0.05,
    },
    schedule_queue_depth: 6,
    recent_error_count: 1,
    keyfile_sealing: null,
    snapshot_at: 1_800_000_000_000,
  },
  ...patch,
});

// `SidePanelListFrame<never>` (empty items) is assignable to every
// concrete list frame the renderers now accept (recipe_results /
// notifications / approvals), so the empty/error-branch tests stay
// type-agnostic.
const emptyFrame = (
  error: string | null = null,
  fetchedAt: number | null = 1_800_000_000_000,
): SidePanelListFrame<never> => ({
  items: [],
  fetched_at: fetchedAt,
  error,
});

// D-169 P2 Slice 1 — list renderers now take a `now` clock for relative
// timestamps. The empty/error branches ignore it; a fixed value keeps
// these assertions deterministic.
const NOW = 1_800_000_000_000;

describe('D-169 P1 side-panel views', () => {
  it('renderPairSection gives the single purpose, then an empty slot for the pair form', () => {
    const doc = makeFakeDocument();
    const { section, slot } = renderPairSection(doc as unknown as Document) as unknown as {
      section: FakeElement;
      slot: FakeElement;
    };

    expect(section.hasAttribute(SIDE_PANEL_PAIR_SECTION_ATTR)).toBe(true);
    // P3.4 — single-purpose statement + thin/stateless framing, the first
    // thing a CWS reviewer reads.
    expect(textOf(section)).toContain('browser companion for a Recued server');
    expect(textOf(section)).toContain('keeping no data of its own');
    expect(textOf(section)).toContain('Once paired');
    // The form mounts into the slot (`pair-code-input-host.ts`). The old
    // hint pointed at the toolbar icon's popup and told the user to type
    // a recovery key; both are gone.
    expect(slot.hasAttribute(SIDE_PANEL_PAIR_HOST_ATTR)).toBe(true);
    expect(section.children).toContain(slot);
    expect(slot.children).toHaveLength(0);
    expect(textOf(section)).not.toContain('action icon');
    expect(textOf(section)).not.toContain('24-word recovery key');
  });

  it('renderServerStatusSection renders the loading empty path', () => {
    const doc = makeFakeDocument();
    const el = renderServerStatusSection(
      doc as unknown as Document,
      { status: null, fetched_at: null, error: null },
      1,
    ) as unknown as FakeElement;

    expect(findByAttr(el, SIDE_PANEL_SECTION_ATTR, 'server-status')).not.toBeNull();
    expect(textOf(el)).toContain('Loading server status');
  });

  it('renderServerStatusSection renders an inline error path', () => {
    const doc = makeFakeDocument();
    const el = renderServerStatusSection(
      doc as unknown as Document,
      { status: null, fetched_at: null, error: 'bridge_not_paired' },
      1,
    ) as unknown as FakeElement;

    expect(textOf(el)).toContain('Could not load status: bridge_not_paired');
  });

  it('renderServerStatusSection shows a socket still coming up as connecting, not as an error', () => {
    // The worker answers `bridge_connecting` when the panel asks before the
    // paired socket is up. Shown raw, in red, it read as a broken bridge on
    // every first open after pairing.
    const doc = makeFakeDocument();
    const el = renderServerStatusSection(
      doc as unknown as Document,
      { status: null, fetched_at: null, error: BRIDGE_STATUS_CONNECTING },
      1,
    ) as unknown as FakeElement;

    expect(textOf(el)).toContain('Connecting to your server…');
    expect(textOf(el)).not.toContain('Could not load status');
    expect(findAllByClassToken(el, 'card-empty-danger')).toHaveLength(0);

    const failed = renderServerStatusSection(
      doc as unknown as Document,
      { status: null, fetched_at: null, error: 'rpc timed out' },
      1,
    ) as unknown as FakeElement;
    expect(findAllByClassToken(failed, 'card-empty-danger')).toHaveLength(1);
  });

  /** D-212 §7.10 — the keyfile posture row IS the floor.
   *
   *  §7.9 used to refuse enrollment over an unsealed keyfile; that was retracted
   *  (it fired on essentially every headless Linux install, and its own
   *  prescribed remedy bricked the server) and replaced with visibility — an
   *  operator may run unsealed, but not without knowing. This renderer is where
   *  that replacement either exists or does not. */
  describe('keyfile sealing posture (D-212 §7.10)', () => {
    const render = (keyfile_sealing: 'machine' | 'passphrase' | 'none' | null) => {
      const doc = makeFakeDocument();
      const base = statusFrame();
      return renderServerStatusSection(
        doc as unknown as Document,
        { ...base, status: { ...base.status!, keyfile_sealing } },
        1_800_000_000_000,
      ) as unknown as FakeElement;
    };

    it('names the factor when the keyfile is sealed', () => {
      for (const [posture, expected] of [
        ['machine', 'sealed (machine)'],
        ['passphrase', 'sealed (passphrase)'],
      ] as const) {
        const row = findByAttr(render(posture), SIDE_PANEL_STATUS_VALUE_ATTR, 'keyfile-sealing');
        expect(row).not.toBeNull();
        expect(textOf(row!)).toContain(expected);
      }
    });

    /** ⛔ THE assertion this row exists for. `'none'` and `null` are the same
     *  width on screen and opposite in meaning — `null` is "we do not know"
     *  (an older server, or a snapshot from before the identity booted),
     *  `'none'` is "we know, and the key that opens this realm is readable
     *  beside its database". Rendering them alike deletes the control. */
    it('renders UNSEALED as a warning — never as the not-wired dash', () => {
      const unsealed = render('none');
      const row = findByAttr(unsealed, SIDE_PANEL_STATUS_VALUE_ATTR, 'keyfile-sealing')!;
      expect(textOf(row)).toContain('UNSEALED');
      expect(textOf(row)).not.toContain('—');

      const unknown = render(null);
      const unknownRow = findByAttr(unknown, SIDE_PANEL_STATUS_VALUE_ATTR, 'keyfile-sealing')!;
      expect(textOf(unknownRow)).toContain('—');
      expect(textOf(unknownRow)).not.toContain('UNSEALED');
    });

    it('states the CONSEQUENCE when unsealed, not just the state', () => {
      // A label alone tells an operator their keyfile is "unsealed" without
      // telling them what it costs them.
      const warning = findByAttr(
        render('none'), SIDE_PANEL_STATUS_VALUE_ATTR, 'keyfile-sealing-warning',
      );
      expect(warning).not.toBeNull();
      expect(textOf(warning!)).toContain('copies this server');
      expect(textOf(warning!)).toContain('recover-keyfile');
    });

    it('states the FULL price of the remedy, not just the two commands', () => {
      // D-212 §7.11 says to name the parts, and this row used to stop at
      // "set RECUED_IDENTITY_PASSPHRASE and run recover-keyfile" — which
      // reads far cheaper than it is. Regenerating mints a NEW server
      // identity (the keyfile also holds `server_identity`,
      // `publisher_identity` and the D-175 account binding), so it re-pairs
      // every device — including the bridge showing this warning. Pinned
      // part by part so a later shortening reds here.
      const warning = findByAttr(
        render('none'), SIDE_PANEL_STATUS_VALUE_ATTR, 'keyfile-sealing-warning',
      );
      const copy = textOf(warning!);
      expect(copy).toContain('RECUED_IDENTITY_PASSPHRASE');
      expect(copy).toMatch(/24-word recovery key/i);
      expect(copy).toMatch(/pair again/i);
      expect(copy).toMatch(/publisher identity/i);
      expect(copy).toMatch(/account binding/i);
      // …and that the data survives, or the warning reads like a threat to
      // the warehouse and nobody acts on it.
      expect(copy).toMatch(/data is untouched/i);
    });

    it('shows no warning when sealed or unknown — it must not cry wolf', () => {
      for (const posture of ['machine', 'passphrase', null] as const) {
        expect(
          findByAttr(render(posture), SIDE_PANEL_STATUS_VALUE_ATTR, 'keyfile-sealing-warning'),
        ).toBeNull();
      }
    });
  });

  it('renderServerStatusSection renders the populated status rows', () => {
    const doc = makeFakeDocument();
    const el = renderServerStatusSection(
      doc as unknown as Document,
      statusFrame(),
      1_800_000_000_000,
    ) as unknown as FakeElement;

    expect(el.getAttribute(SIDE_PANEL_SECTION_ATTR)).toBe('server-status');
    expect(textOf(el)).toContain('Recued Local');
    expect(textOf(el)).toContain('Serving 2/3');
    expect(findByAttr(el, SIDE_PANEL_STATUS_VALUE_ATTR, 'version')).not.toBeNull();
    expect(textOf(findByAttr(el, SIDE_PANEL_STATUS_VALUE_ATTR, 'version')!)).toContain(
      '1.2.3',
    );
    expect(textOf(findByAttr(el, SIDE_PANEL_STATUS_VALUE_ATTR, 'uptime')!)).toContain(
      '1h',
    );
    expect(textOf(findByAttr(el, SIDE_PANEL_STATUS_VALUE_ATTR, 'last-sync')!)).toContain(
      '20s ago',
    );
    expect(textOf(findByAttr(el, SIDE_PANEL_STATUS_VALUE_ATTR, 'executions')!)).toContain(
      '7 / 31',
    );
    expect(textOf(findByAttr(el, SIDE_PANEL_STATUS_VALUE_ATTR, 'pending-asks')!)).toContain(
      '4',
    );
    // λ×W row: percentage + median + the sample count (a bare percentage
    // would over-claim a 9-answer median).
    expect(textOf(findByAttr(el, SIDE_PANEL_STATUS_VALUE_ATTR, 'ask-load')!)).toContain(
      '5.0% (12 asks / 7d · median 42m · n=9)',
    );
    expect(textOf(findByAttr(el, SIDE_PANEL_STATUS_VALUE_ATTR, 'schedule-queue')!)).toContain(
      '6',
    );
    expect(textOf(findByAttr(el, SIDE_PANEL_STATUS_VALUE_ATTR, 'recent-errors')!)).toContain(
      '1',
    );
  });

  it('renders list-section empty and error copy for recipes, notifications, and approvals', () => {
    const doc = makeFakeDocument();

    expect(
      textOf(renderRecipeResultsSection(doc as unknown as Document, emptyFrame(), NOW) as unknown as FakeElement),
    ).toContain('No recent recipe runs yet');
    expect(
      textOf(renderNotificationsSection(doc as unknown as Document, emptyFrame(), NOW) as unknown as FakeElement),
    ).toContain('Nothing to show yet');
    expect(
      textOf(renderApprovalsSection(doc as unknown as Document, emptyFrame(), NOW) as unknown as FakeElement),
    ).toContain('No pending approvals');

    expect(
      textOf(
        renderRecipeResultsSection(
          doc as unknown as Document,
          emptyFrame('rpc down'),
          NOW,
        ) as unknown as FakeElement,
      ),
    ).toContain('Could not load: rpc down');
    expect(
      textOf(
        renderNotificationsSection(
          doc as unknown as Document,
          emptyFrame('rpc down'),
          NOW,
        ) as unknown as FakeElement,
      ),
    ).not.toContain('Nothing to show yet');
    expect(
      textOf(
        renderApprovalsSection(
          doc as unknown as Document,
          emptyFrame('rpc down'),
          NOW,
        ) as unknown as FakeElement,
      ),
    ).not.toContain('No pending approvals');
  });

  it('distinguishes an unfetched list from a fetched empty list', () => {
    const doc = makeFakeDocument();
    const unfetched = emptyFrame(null, null);

    expect(
      textOf(renderRecipeResultsSection(doc as unknown as Document, unfetched, NOW) as unknown as FakeElement),
    ).toContain('Loading recent runs');
    expect(
      textOf(renderNotificationsSection(doc as unknown as Document, unfetched, NOW) as unknown as FakeElement),
    ).toContain('Loading notifications');
    expect(
      textOf(renderApprovalsSection(doc as unknown as Document, unfetched, NOW) as unknown as FakeElement),
    ).toContain('Loading approvals');
  });

  it.each([null, { count: 0, entries: [] }])('distinguishes unavailable and empty unresolved diagnostics (%j)', unresolved => {
    const doc = makeFakeDocument();
    const el = renderBridgeDiagnosticSection(doc as unknown as Document, {
      ...DEFAULT_DIAGNOSTIC_FRAME,
      idempotency_entry_count: 0, unresolved, recent_confirmed: null, pending_command_count: 0, grant_count: 0,
    }) as unknown as FakeElement;
    expect(textOf(el)).toContain(unresolved === null ? 'could not be loaded' : 'No commands are awaiting confirmation');
    if (unresolved === null) expect(textOf(el)).toContain('Unavailable');
  });

  it('renders a bounded, read-only list with command IDs and start times', () => {
    const doc = makeFakeDocument();
    const entries = Array.from({ length: 50 }, (_, i) => ({ command_id: i === 0 ? '<img src=x onerror=alert(1)>' : `command-${i}`, started_at: 1_700_000_000_000 }));
    const el = renderBridgeDiagnosticSection(doc as unknown as Document, {
      ...DEFAULT_DIAGNOSTIC_FRAME,
      idempotency_entry_count: 3, unresolved: { count: 70, entries }, recent_confirmed: null, pending_command_count: 0, grant_count: 0,
    }) as unknown as FakeElement;
    expect(textOf(findByTag(el, 'summary')!)).toContain('70 awaiting confirmation');
    expect(findByTag(el, 'code')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(findByTag(el, 'time')?.getAttribute('datetime')).toBe('2023-11-14T22:13:20.000Z');
    expect(textOf(el)).toContain('Check the page before starting them again');
    expect(textOf(el)).toContain('Showing 50 of 70 commands');
    expect(findByTag(el, 'button')?.getAttribute(SIDE_PANEL_DIAGNOSTIC_REFRESH_ATTR)).toBe('');
    expect(findAllByClassToken(el, 'unresolved-commands').some(card => findByTag(card, 'button'))).toBe(false);
    expect(findByTag(el, 'img')).toBeNull();
  });

  it('renderBridgeDiagnosticSection is a collapsible details section', () => {
    const doc = makeFakeDocument();
    const el = renderBridgeDiagnosticSection(doc as unknown as Document, {
      ...DEFAULT_DIAGNOSTIC_FRAME,
      idempotency_entry_count: 1,
      unresolved: null,
      recent_confirmed: null,
      pending_command_count: 2,
      grant_count: 3,
    }) as unknown as FakeElement;

    expect(el.getAttribute(SIDE_PANEL_SECTION_ATTR)).toBe('bridge-diagnostic');
    expect(findByTag(el, 'details')).not.toBeNull();
    expect(textOf(findByTag(el, 'summary')!)).toBe('Bridge diagnostic');
    expect(textOf(el)).toContain('Saved command results');
    expect(textOf(el)).toContain('Ingredient grants');
    expect(textOf(el)).toContain('Queued commands');
    expect(textOf(el)).not.toContain('Outbox depth');
    expect(textOf(el)).not.toContain('Granted origins');
  });

  it.each([null, { count: 0, entries: [] }])('distinguishes unavailable and empty confirmed outcomes (%j)', recent_confirmed => {
    const doc = makeFakeDocument();
    const el = renderBridgeDiagnosticSection(doc as unknown as Document, {
      ...DEFAULT_DIAGNOSTIC_FRAME,
      idempotency_entry_count: 0, unresolved: { count: 0, entries: [] }, recent_confirmed, pending_command_count: 0, grant_count: 0,
    }) as unknown as FakeElement;
    expect(textOf(el)).toContain('Recent confirmed outcomes');
    expect(textOf(el)).toContain(recent_confirmed === null ? 'Recent confirmed outcomes could not be loaded.'
      : 'No confirmed outcomes are saved.');
    expect(findAllByClassToken(el, 'confirmed-outcomes').some(card => findByTag(card, 'button'))).toBe(false);
  });

  it('renders read-only confirmed outcomes with safe IDs, clear statuses and recorded times', () => {
    const doc = makeFakeDocument();
    const entries = (['ok', 'error', 'rejected'] as const).map((status, i) => ({
      command_id: i === 0 ? '<img src=x onerror=alert(1)>' : `finished-${i}`, status, stored_at: 1_700_000_000_000,
    }));
    const el = renderBridgeDiagnosticSection(doc as unknown as Document, {
      ...DEFAULT_DIAGNOSTIC_FRAME,
      idempotency_entry_count: 70, unresolved: { count: 0, entries: [] }, recent_confirmed: { count: 70, entries },
      pending_command_count: 0, grant_count: 0,
    }) as unknown as FakeElement;
    expect(findAllByAttr(el, 'data-recued-confirmed-command')).toHaveLength(3);
    expect(findByTag(el, 'code')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(findByTag(el, 'time')?.getAttribute('datetime')).toBe('2023-11-14T22:13:20.000Z');
    for (const label of ['Completed', 'Failed', 'Rejected', 'Recorded', 'Showing 3 of 70 confirmed outcomes, newest recorded first.']) {
      expect(textOf(el)).toContain(label);
    }
    expect(textOf(el)).toContain('Times show when results were recorded');
    expect(findAllByClassToken(el, 'confirmed-outcomes').some(card => findByTag(card, 'button'))).toBe(false);
    expect(findByTag(el, 'img')).toBeNull();
  });

  it.each([
    { status: 'error', error_code: 'selector_not_found', cause: 'The expected page element could not be found.',
      next: 'the recipe still targets the correct element' },
    { status: 'rejected', error_code: 'authority_invalid_grant_scope', cause: 'The action is not covered by the ingredient’s site permissions.',
      next: 'your Bridge site grants' },
    { status: 'rejected', error_code: 'queue_full', cause: 'The bridge’s command queue was full.',
      next: 'check the recipe run for its retry status' },
  ] as const)('explains $error_code with a readable cause and next step', ({ status, error_code, cause, next }) => {
    const doc = makeFakeDocument();
    const el = renderBridgeDiagnosticSection(doc as unknown as Document, { ...DEFAULT_DIAGNOSTIC_FRAME,
      recent_confirmed: { count: 1, entries: [{ command_id: 'failed', status, stored_at: 500, error_code }] },
    }) as unknown as FakeElement;
    expect(textOf(findByAttr(el, 'data-recued-confirmed-error-cause')!)).toBe(cause);
    expect(textOf(findByAttr(el, 'data-recued-confirmed-next-step')!)).toContain(next);
    expect(textOf(findByAttr(el, 'data-recued-confirmed-error-code')!)).toBe(`Error code: ${error_code}`);
    expect(findAllByClassToken(el, 'confirmed-outcomes').some(card => findByTag(card, 'button'))).toBe(false);
  });

  it.each([undefined, '<img src=x onerror=alert(1)>', '__proto__'])('uses generic guidance for a missing or unknown code (%j)', error_code => {
    const doc = makeFakeDocument();
    const entry = { command_id: 'legacy', status: 'error', stored_at: 500, error_code,
      error: { message: 'private-message' }, outputs: { secret: 'private-output' } } as unknown as BridgeConfirmedOutcome;
    const el = renderBridgeDiagnosticSection(doc as unknown as Document, { ...DEFAULT_DIAGNOSTIC_FRAME,
      recent_confirmed: { count: 1, entries: [entry] },
    }) as unknown as FakeElement;
    expect(textOf(el)).toContain('No recognized error code was saved for this outcome.');
    expect(textOf(el)).toContain('check the page before starting another action');
    expect(findByAttr(el, 'data-recued-confirmed-error-code')).toBeNull();
    expect(findByTag(el, 'img')).toBeNull();
    expect(textOf(el)).not.toContain('private');
    if (error_code !== undefined) expect(textOf(el)).not.toContain(error_code);
  });

  it('does not attach failure guidance to a completed outcome with stray error metadata', () => {
    const doc = makeFakeDocument();
    const el = renderBridgeDiagnosticSection(doc as unknown as Document, { ...DEFAULT_DIAGNOSTIC_FRAME,
      recent_confirmed: { count: 1, entries: [{ command_id: 'complete', status: 'ok', stored_at: 500, error_code: 'selector_not_found' }] },
    }) as unknown as FakeElement;
    expect(textOf(el)).toContain('Completed');
    expect(findByAttr(el, 'data-recued-confirmed-error-cause')).toBeNull();
    expect(findByAttr(el, 'data-recued-confirmed-next-step')).toBeNull();
    expect(findByAttr(el, 'data-recued-confirmed-error-code')).toBeNull();
  });

  it('shows never-refreshed, refreshing and failed states independently of the last successful time', () => {
    const doc = makeFakeDocument();
    const initial = renderBridgeDiagnosticSection(doc as unknown as Document, DEFAULT_DIAGNOSTIC_FRAME) as unknown as FakeElement;
    expect(textOf(initial)).toContain('Last successful refresh: Never');
    expect(textOf(initial)).toContain('Diagnostics have not been refreshed yet.');
    const frame = { ...DEFAULT_DIAGNOSTIC_FRAME, last_successful_refresh_at: 1_700_000_000_000,
      refresh_error: 'Could not refresh diagnostics. Try Refresh again.' };
    const failed = renderBridgeDiagnosticSection(doc as unknown as Document, frame) as unknown as FakeElement;
    expect(findByTag(failed, 'time')?.getAttribute('datetime')).toBe('2023-11-14T22:13:20.000Z');
    expect(textOf(failed)).toContain('Could not refresh diagnostics.');
    const refreshing = renderBridgeDiagnosticSection(doc as unknown as Document, { ...frame, refreshing: true }) as unknown as FakeElement;
    expect(refreshing.getAttribute('aria-busy')).toBe('true');
    expect(findByTag(refreshing, 'button')?.textContent).toBe('Refreshing…');
    expect(findByTag(refreshing, 'button')?.getAttribute('aria-disabled')).toBe('true');
    expect(textOf(refreshing)).toContain('Refreshing diagnostics…');
    expect(textOf(refreshing)).not.toContain('Could not refresh diagnostics.');
  });

  it.each(['idle', 'copying', 'copied', 'manual'] as const)('renders accessible diagnostic copy feedback (%s)', phase => {
    const doc = makeFakeDocument();
    const el = renderBridgeDiagnosticSection(doc as unknown as Document, DEFAULT_DIAGNOSTIC_FRAME, {
      copyState: { phase, summary: '<img src=x onerror=alert(1)>' },
    }) as unknown as FakeElement;
    const copy = findByAttr(el, SIDE_PANEL_DIAGNOSTIC_COPY_ATTR)!;
    expect(copy.textContent).toBe(phase === 'copying' ? 'Copying…' : 'Copy diagnostic summary');
    expect(copy.getAttribute('aria-disabled')).toBe('true');
    if (phase === 'copied') expect(textOf(el)).toContain('Diagnostic summary copied.');
    const fallback = findByAttr(el, SIDE_PANEL_DIAGNOSTIC_SUMMARY_ATTR);
    expect(fallback !== null).toBe(phase === 'manual');
    if (fallback) {
      expect(textOf(el)).toContain('Select and copy the summary below.');
      expect(fallback.tagName).toBe('TEXTAREA');
      expect(fallback.getAttribute('readonly')).toBe('');
      expect(fallback.getAttribute('aria-label')).toBe('Diagnostic summary');
      expect(fallback.textContent).toBe('<img src=x onerror=alert(1)>');
    }
    expect(findByTag(el, 'img')).toBeNull();
  });

  it.each([false, true])('shows a running command, queued work and pause state (%s)', queue_paused => {
    const doc = makeFakeDocument();
    const el = renderBridgeDiagnosticSection(doc as unknown as Document, { ...DEFAULT_DIAGNOSTIC_FRAME,
      pending_command_count: 2, current_command_id: '<img src=x>', queue_paused }) as unknown as FakeElement;
    expect(textOf(findByAttr(el, SIDE_PANEL_STATUS_VALUE_ATTR, 'queued-commands')!)).toContain('2');
    expect(textOf(findByAttr(el, SIDE_PANEL_STATUS_VALUE_ATTR, 'current-command')!)).toContain('<img src=x>');
    expect(textOf(findByAttr(el, SIDE_PANEL_STATUS_VALUE_ATTR, 'queue-state')!)).toContain(queue_paused ? 'Paused' : 'Ready');
    expect(findByTag(el, 'img')).toBeNull();
  });

  it('distinguishes an unavailable queue from a known idle queue', () => {
    const doc = makeFakeDocument();
    const unknown = renderBridgeDiagnosticSection(doc as unknown as Document, DEFAULT_DIAGNOSTIC_FRAME) as unknown as FakeElement;
    expect(textOf(findByAttr(unknown, SIDE_PANEL_STATUS_VALUE_ATTR, 'current-command')!)).toContain('Unavailable');
    const idle = renderBridgeDiagnosticSection(doc as unknown as Document, { ...DEFAULT_DIAGNOSTIC_FRAME,
      pending_command_count: 0, queue_paused: false }) as unknown as FakeElement;
    expect(textOf(findByAttr(idle, SIDE_PANEL_STATUS_VALUE_ATTR, 'current-command')!)).toContain('None');
    expect(textOf(findByAttr(idle, SIDE_PANEL_STATUS_VALUE_ATTR, 'queue-state')!)).toContain('Ready');
  });

  it('updateHeader flips title and subtitle for unpaired and paired states', () => {
    const doc = makeFakeDocument();
    const title = doc.createElement('h1');
    title.setAttribute('id', SIDE_PANEL_HEADER_TITLE_ID);
    const subtitle = doc.createElement('p');
    subtitle.setAttribute('id', SIDE_PANEL_HEADER_SUBTITLE_ID);

    updateHeader(doc as unknown as Document, {
      paired: false,
      server_url: null,
      server_display_name: null,
    });
    expect(title.textContent).toBe('Recued Bridge');
    expect(subtitle.textContent).toContain('Pair this bridge');

    const paired: SidePanelPairState = {
      paired: true,
      server_url: 'https://local.recued.test',
      server_display_name: 'Local Recued',
    };
    updateHeader(doc as unknown as Document, paired);
    expect(title.textContent).toBe('Recued Bridge');
    expect(subtitle.textContent).toBe(
      'Local Recued · https://local.recued.test',
    );
    expect(subtitle.getAttribute('title')).toBe(
      'Local Recued · https://local.recued.test',
    );
  });

  it('each list renderer stamps its canonical section attribute', () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    root.appendChild(renderRecipeResultsSection(doc as unknown as Document, emptyFrame(), NOW) as unknown as FakeElement);
    root.appendChild(renderNotificationsSection(doc as unknown as Document, emptyFrame(), NOW) as unknown as FakeElement);
    root.appendChild(renderApprovalsSection(doc as unknown as Document, emptyFrame(), NOW) as unknown as FakeElement);

    expect(
      findAllByAttr(root, SIDE_PANEL_SECTION_ATTR).map((el) =>
        el.getAttribute(SIDE_PANEL_SECTION_ATTR),
      ),
    ).toEqual(['recipe-results', 'notifications', 'approvals']);
  });

  it('renders populated list rows with item hooks, blank-title fallback, and inert text', () => {
    const doc = makeFakeDocument();
    const htmlishText = '<img src=x onerror=alert(1)> Raw body';
    const rowsFor = (root: FakeElement, section: string): FakeElement[] =>
      findAllByAttr(root, SIDE_PANEL_LIST_ITEM_ATTR).filter(
        (el) => el.getAttribute(SIDE_PANEL_LIST_ITEM_ATTR) === section,
      );

    const recipes = renderRecipeResultsSection(
      doc as unknown as Document,
      {
        items: [
          {
            run_id: 'run-ok',
            recipe_id: 'recipe-ok',
            status: 'ok',
            started_at: NOW - 20_000,
            duration_ms: null,
          },
          {
            run_id: 'run-error',
            recipe_id: 'recipe-error',
            status: 'error',
            started_at: NOW - 70_000,
            duration_ms: 3_000,
          },
        ],
        fetched_at: NOW,
        error: null,
      },
      NOW,
    ) as unknown as FakeElement;
    const recipeRows = rowsFor(recipes, 'recipe-results');
    expect(recipeRows).toHaveLength(2);
    expect(recipeRows.map((row) => row.getAttribute(SIDE_PANEL_LIST_ITEM_ATTR))).toEqual([
      'recipe-results',
      'recipe-results',
    ]);
    expect(textOf(recipeRows[0]!)).toContain('recipe-ok');
    expect(textOf(recipeRows[0]!)).toContain('OK');
    expect(textOf(recipeRows[0]!)).toContain('20s ago');
    expect(textOf(recipeRows[1]!)).toContain('recipe-error');
    expect(textOf(recipeRows[1]!)).toContain('Error');
    expect(textOf(recipeRows[1]!)).toContain('1m ago');

    const notifications = renderNotificationsSection(
      doc as unknown as Document,
      {
        items: [
          {
            id: 'notify-title',
            title: 'Nonblank title',
            text: 'Body sub-line',
            fired_at: NOW - 10_000,
          },
          {
            id: 'notify-blank',
            title: '',
            text: htmlishText,
            fired_at: NOW - 6_000,
          },
        ],
        fetched_at: NOW,
        error: null,
      },
      NOW,
    ) as unknown as FakeElement;
    const notificationRows = rowsFor(notifications, 'notifications');
    const notificationCard = notifications.children[1]!.children[0]!;
    expect(notificationRows).toHaveLength(2);
    expect(notificationRows.map((row) => row.getAttribute(SIDE_PANEL_LIST_ITEM_ATTR))).toEqual([
      'notifications',
      'notifications',
    ]);
    expect(notificationCard.children).toHaveLength(3);
    expect(textOf(notificationRows[0]!)).toContain('Nonblank title');
    expect(textOf(notificationCard.children[1]!)).toBe('Body sub-line');
    expect(textOf(notificationRows[1]!)).toContain(htmlishText);
    expect(findByTag(notifications, 'img')).toBeNull();
    expect(textOf(notifications)).toContain(htmlishText);

    const approvals = renderApprovalsSection(
      doc as unknown as Document,
      {
        items: [
          {
            ask_id: 'ask-1',
            title: 'Approve?',
            text: 'Pick an option',
            options: [
              { id: 'yes', label: 'Yes' },
              { id: 'no', label: 'No' },
            ],
            created_at: NOW - 120_000,
          },
        ],
        fetched_at: NOW,
        error: null,
      },
      NOW,
    ) as unknown as FakeElement;
    const approvalRows = rowsFor(approvals, 'approvals');
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0]!.getAttribute(SIDE_PANEL_LIST_ITEM_ATTR)).toBe('approvals');
    expect(textOf(approvalRows[0]!)).toContain('Approve?');
    expect(textOf(approvals)).toContain('Options: Yes / No');
    expect(findByTag(approvals, 'button')).toBeNull();
    expect(findByTag(approvals, 'input')).toBeNull();
  });

  // ── P3.2 — server status polish + state hardening ────────────────

  it('renderServerStatusSection leads with the connectedness hero pill', () => {
    const doc = makeFakeDocument();
    const el = renderServerStatusSection(
      doc as unknown as Document,
      statusFrame(),
      NOW,
    ) as unknown as FakeElement;

    const hero = findAllByClassToken(el, 'status-hero')[0];
    expect(hero).toBeDefined();
    // The hero carries the pill + the server name (not the k/v stat rows).
    expect(textOf(hero!)).toContain('Serving 2/3');
    expect(textOf(hero!)).toContain('Recued Local');
    // Serving stays hue-free (weight only) — no danger token on the pill.
    expect(findAllByClassToken(el, 'pill-danger')).toHaveLength(0);
    expect(findAllByClassToken(el, 'pill-ok')).toHaveLength(1);
  });

  it('renderServerStatusSection paints the offline state with the one danger hue', () => {
    const doc = makeFakeDocument();
    const el = renderServerStatusSection(
      doc as unknown as Document,
      statusFrame({
        status: {
          ...statusFrame().status!,
          ws_state: 'offline',
          paired_client_connected: 0,
        },
      }),
      NOW,
    ) as unknown as FakeElement;

    const danger = findAllByClassToken(el, 'pill-danger');
    expect(danger).toHaveLength(1);
    expect(textOf(danger[0]!)).toBe('Offline');
    expect(findAllByClassToken(el, 'pill-ok')).toHaveLength(0);
  });

  it('renderServerStatusSection renders null counts as em-dashes, never literal null/NaN', () => {
    const doc = makeFakeDocument();
    const el = renderServerStatusSection(
      doc as unknown as Document,
      statusFrame({
        fetched_at: null,
        status: {
          name: 'Quiet server',
          version: '0.0.0',
          uptime_seconds: 0,
          paired_client_count: 0,
          paired_client_connected: 0,
          ws_state: 'idle',
          last_sync_at: null,
          executions_last_hour: null,
          executions_last_24h: null,
          pending_asks: null,
          ask_load: null,
          schedule_queue_depth: null,
          recent_error_count: null,
          keyfile_sealing: null,
          snapshot_at: NOW,
        },
      }),
      NOW,
    ) as unknown as FakeElement;

    const text = textOf(el);
    expect(text).not.toContain('null');
    expect(text).not.toContain('NaN');
    // Null counts collapse to the em-dash; a null last-sync reads "never".
    expect(textOf(findByAttr(el, SIDE_PANEL_STATUS_VALUE_ATTR, 'executions')!)).toContain(
      '— / —',
    );
    expect(textOf(findByAttr(el, SIDE_PANEL_STATUS_VALUE_ATTR, 'pending-asks')!)).toContain(
      '—',
    );
    expect(textOf(findByAttr(el, SIDE_PANEL_STATUS_VALUE_ATTR, 'last-sync')!)).toContain(
      'never',
    );
    // fetched_at null → the "Refreshed …" footer is omitted (no "ago").
    expect(text).not.toContain('Refreshed');
  });

  // ── P3.3 — recipe results error-state polish ─────────────────────

  it('renders recipe error rows with the danger chip + category sub-line, keeping ok hue-free', () => {
    const doc = makeFakeDocument();
    const section = renderRecipeResultsSection(
      doc as unknown as Document,
      {
        items: [
          {
            run_id: 'run-ok',
            recipe_id: 'recipe-ok',
            status: 'ok',
            started_at: NOW - 5_000,
            duration_ms: 1_200,
          },
          {
            run_id: 'run-error',
            recipe_id: 'recipe-error',
            status: 'error',
            started_at: NOW - 90_000,
            duration_ms: 4_000,
            error_category: 'timeout',
          },
        ],
        fetched_at: NOW,
        error: null,
      },
      NOW,
    ) as unknown as FakeElement;

    // Exactly one danger chip (the failed run), reading "Error".
    const danger = findAllByClassToken(section, 'pill-danger');
    expect(danger).toHaveLength(1);
    expect(textOf(danger[0]!)).toBe('Error');
    // The ok run is hue-free (weighted chip, no danger token).
    const ok = findAllByClassToken(section, 'pill-ok');
    expect(ok).toHaveLength(1);
    expect(textOf(ok[0]!)).toBe('OK');
    // The failure category renders as a muted sub-line, NOT a list row.
    const sub = findAllByClassToken(section, 'subtle');
    expect(sub).toHaveLength(1);
    expect(textOf(sub[0]!)).toBe('timeout');
    expect(
      findAllByAttr(section, SIDE_PANEL_LIST_ITEM_ATTR).filter(
        (el) => el.getAttribute(SIDE_PANEL_LIST_ITEM_ATTR) === 'recipe-results',
      ),
    ).toHaveLength(2);
  });

  // ── P4 — notifications optional-surface gating ───────────────────

  const notifFrame = () => ({
    items: [{ id: 'n1', text: 'A live notification', fired_at: NOW - 1_000 }],
    fetched_at: NOW,
    error: null,
  });

  it('renderNotificationsSection shows a webclient-config affordance when mode is off', () => {
    const doc = makeFakeDocument();
    const section = renderNotificationsSection(
      doc as unknown as Document,
      notifFrame(),
      NOW,
      { enabled: false },
    ) as unknown as FakeElement;

    // Section stays present (not hidden) and carries the affordance...
    expect(section.getAttribute(SIDE_PANEL_SECTION_ATTR)).toBe('notifications');
    expect(textOf(section)).toContain('turn them on in the webclient');
    // ...with the live item + the "nothing yet" copy suppressed while off.
    expect(textOf(section)).not.toContain('A live notification');
    expect(textOf(section)).not.toContain('Nothing to show yet');
    expect(
      findAllByAttr(section, SIDE_PANEL_LIST_ITEM_ATTR).filter(
        (el) => el.getAttribute(SIDE_PANEL_LIST_ITEM_ATTR) === 'notifications',
      ),
    ).toHaveLength(0);
  });

  it('renderNotificationsSection renders the live list when mode is on (and by default)', () => {
    const doc = makeFakeDocument();
    for (const opts of [{ enabled: true }, undefined]) {
      const section = renderNotificationsSection(
        doc as unknown as Document,
        notifFrame(),
        NOW,
        opts,
      ) as unknown as FakeElement;
      expect(textOf(section)).toContain('A live notification');
      expect(textOf(section)).not.toContain('turn them on in the webclient');
      expect(
        findAllByAttr(section, SIDE_PANEL_LIST_ITEM_ATTR).filter(
          (el) => el.getAttribute(SIDE_PANEL_LIST_ITEM_ATTR) === 'notifications',
        ),
      ).toHaveLength(1);
    }
  });

  // ── brick 3 — "Watch this element" creator CTA ───────────────────

  it('renderElementWatchCta renders the launch button with no status line when idle', () => {
    const doc = makeFakeDocument();
    const el = renderElementWatchCta(
      doc as unknown as Document,
      { message: '', tone: 'info', webclient_link: false },
    ) as unknown as FakeElement;

    expect(el.hasAttribute(SIDE_PANEL_WATCH_CTA_ATTR)).toBe(true);
    const button = findByAttr(el, SIDE_PANEL_WATCH_BUTTON_ATTR);
    expect(button).not.toBeNull();
    expect(button!.tagName).toBe('BUTTON');
    expect(textOf(button!)).toBe('Watch this element');
    // Idle (empty message) → no status line, no webclient link.
    expect(findByAttr(el, SIDE_PANEL_WATCH_STATUS_ATTR)).toBeNull();
    expect(findByTag(el, 'a')).toBeNull();
  });

  it('renderElementWatchCta shows a created status with the webclient deep-link', () => {
    const doc = makeFakeDocument();
    const el = renderElementWatchCta(
      doc as unknown as Document,
      {
        message: 'Watch created — it is off. Enable it in the webclient.',
        tone: 'info',
        webclient_link: true,
      },
    ) as unknown as FakeElement;

    const status = findByAttr(el, SIDE_PANEL_WATCH_STATUS_ATTR);
    expect(status).not.toBeNull();
    expect(textOf(status!)).toContain('Watch created');
    // info tone — NOT the danger class.
    expect(findAllByClassToken(el, 'watch-status-danger')).toHaveLength(0);
    const link = findByTag(el, 'a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('https://app.recued.com/#automation');
  });

  it('renderElementWatchCta uses the one danger hue for a failure, no link', () => {
    const doc = makeFakeDocument();
    const el = renderElementWatchCta(
      doc as unknown as Document,
      { message: 'Could not start the picker.', tone: 'danger', webclient_link: false },
    ) as unknown as FakeElement;

    expect(findAllByClassToken(el, 'watch-status-danger')).toHaveLength(1);
    expect(findByTag(el, 'a')).toBeNull();
  });
});

describe('D-163 O-1 — Chrome has turned off this Bridge\'s notifications', () => {
  const render = (opts: { enabled?: boolean; desktopBlocked?: boolean }) =>
    renderNotificationsSection(makeFakeDocument() as unknown as Document, emptyFrame(), NOW, opts) as unknown as FakeElement;

  it('says so first, while this Bridge\'s notifications are on', () => {
    const el = render({ enabled: true, desktopBlocked: true });
    const notice = findByAttr(el, SIDE_PANEL_STATUS_VALUE_ATTR, 'desktop-notifications-blocked');
    expect(notice).not.toBeNull();
    expect(textOf(notice!)).toBe(DESKTOP_NOTIFICATIONS_BLOCKED_COPY);
    // The list still follows.
    expect(textOf(el)).toContain('Nothing to show yet');
  });

  it('says nothing when Chrome shows them, or when this Bridge sends none', () => {
    for (const opts of [{ enabled: true, desktopBlocked: false }, { enabled: true }, { enabled: false, desktopBlocked: true }]) {
      expect(findByAttr(render(opts), SIDE_PANEL_STATUS_VALUE_ATTR, 'desktop-notifications-blocked'), JSON.stringify(opts)).toBeNull();
    }
  });
});

describe('the Server status section\'s Disconnect', () => {
  const render = (disconnect: { phase: 'idle' | 'confirming' | 'working'; message: string } | undefined,
    frame = statusFrame()) =>
    renderServerStatusSection(makeFakeDocument() as unknown as Document, frame, NOW,
      disconnect === undefined ? undefined : { disconnect, serverName: 'Alice\'s server' }) as unknown as FakeElement;

  it('offers the button, and asks before it disconnects, naming the server', () => {
    const idle = render({ phase: 'idle', message: '' });
    expect(textOf(findByAttr(idle, SIDE_PANEL_DISCONNECT_ATTR, 'ask')!)).toBe('Disconnect this bridge');
    expect(findByAttr(idle, SIDE_PANEL_DISCONNECT_ATTR, 'confirm')).toBeNull();
    const asking = render({ phase: 'confirming', message: '' });
    expect(textOf(asking)).toContain('Disconnect this bridge from Alice\'s server? Recued stops using this browser '
      + 'until you pair it again.');
    expect(textOf(findByAttr(asking, SIDE_PANEL_DISCONNECT_ATTR, 'confirm')!)).toBe('Disconnect');
    expect(findByAttr(asking, SIDE_PANEL_DISCONNECT_ATTR, 'cancel')).not.toBeNull();
    expect(findByAttr(asking, SIDE_PANEL_DISCONNECT_ATTR, 'ask')).toBeNull();
  });

  it('under way: one disabled button, and no Cancel', () => {
    const working = render({ phase: 'working', message: '' });
    const confirm = findByAttr(working, SIDE_PANEL_DISCONNECT_ATTR, 'confirm') as unknown as { textContent: string; disabled?: boolean };
    expect(confirm.textContent).toBe('Disconnecting…');
    expect(confirm.disabled).toBe(true);
    expect(findByAttr(working, SIDE_PANEL_DISCONNECT_ATTR, 'cancel')).toBeNull();
  });

  it('says why one did not go through', () => {
    const failed = render({ phase: 'idle', message: 'This bridge could not be disconnected: bridge_not_ready.' });
    expect(textOf(findByAttr(failed, SIDE_PANEL_DISCONNECT_MESSAGE_ATTR)!)).toBe('This bridge could not be disconnected: bridge_not_ready.');
  });

  it('is there while the server cannot be reached, which is when an owner may want it most', () => {
    const offline = render({ phase: 'idle', message: '' }, { status: null, fetched_at: null, error: 'socket closed' });
    expect(findByAttr(offline, SIDE_PANEL_DISCONNECT_ATTR, 'ask')).not.toBeNull();
  });

  it('is left out where the panel gives it no state', () => {
    expect(findByAttr(render(undefined), SIDE_PANEL_DISCONNECT_ATTR)).toBeNull();
  });
});
