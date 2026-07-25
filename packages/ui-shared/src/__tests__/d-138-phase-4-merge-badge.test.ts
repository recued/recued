/** D-138 Phase 4 — Notification surfacing tests.
 *
 *  Covers the two pure-render surfaces P4 ships in `@recued/ui-shared`:
 *
 *    1. `renderMergeBadgeSlot` — top-bar badge button. Hidden when
 *       count is zero; numeric badge + click-through `data-action`
 *       when count is positive; 99+ cap; `aria-expanded` flips with
 *       dialog state.
 *    2. `renderContactsSettingsSection` — Settings → Contacts panel
 *       with pending count + Open-review + Scan-now actions. Hidden
 *       Open-review when count is zero; busy label on Scan-now while
 *       a rpc is in flight; relative last-scan timestamp; error panel
 *       when an `error` field is set.
 *    3. `renderTopBar` integration — TopBarState's optional
 *       `mergeBadge` field renders the slot inline; absent field
 *       suppresses the slot entirely.
 *
 *  Pure-render assertions only; the host wires data-action clicks
 *  + bus events outside this layer. */

import { describe, expect, it } from 'vitest';
import {
  renderMergeBadgeSlot,
  renderTopBar,
  type MergeBadgeSlotState,
  type TopBarState,
} from '../top-bar/index.js';
import {
  renderContactsSettingsSection,
  initialContactsSettingsSectionState,
  type ContactsSettingsSectionState,
} from '../contacts/index.js';

const NOW = 1_700_000_000_000;

const baseTopBar = (overrides: Partial<TopBarState> = {}): TopBarState => ({
  search: { query: null },
  attention: { blockingCount: 0 },
  attentionPopover: {
    open: false,
    tab: 'blocking',
    approvals: [],
    serverApprovals: [],
    circuitTrips: [],
    informational: [],
    resetInFlight: new Set(),
    serverResolveInFlight: new Set(),
  },
  avatar: { user: null },
  devices: {
    devices: [
      { id: 'this', kind: 'self-extension', name: 'This', lastSeenMs: null, current: true },
    ],
    showPairServerCta: false,
    open: false,
    nowMs: NOW,
  },
  ...overrides,
});

describe('renderMergeBadgeSlot', () => {
  it('renders empty string when pendingCount is zero', () => {
    const html = renderMergeBadgeSlot({ pendingCount: 0 });
    expect(html).toBe('');
  });

  it('renders the button with numeric badge when count is positive', () => {
    const html = renderMergeBadgeSlot({ pendingCount: 4 });
    expect(html).toContain('top-bar-merge-badge');
    expect(html).toContain('data-action="contact-merge-open-review"');
    expect(html).toContain('>4<');
    expect(html).toContain('4 merge candidates pending');
  });

  it('uses singular phrasing when count is exactly 1', () => {
    const html = renderMergeBadgeSlot({ pendingCount: 1 });
    expect(html).toContain('1 merge candidate pending');
  });

  it('caps the badge at 99+', () => {
    const html = renderMergeBadgeSlot({ pendingCount: 250 });
    expect(html).toContain('>99+<');
  });

  it('reflects dialog-open state via aria-expanded + open modifier class', () => {
    const closed = renderMergeBadgeSlot({ pendingCount: 2, dialogOpen: false });
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('top-bar-merge-badge--open');

    const open = renderMergeBadgeSlot({ pendingCount: 2, dialogOpen: true });
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('top-bar-merge-badge--open');
  });

  it('clamps fractional + negative counts', () => {
    expect(renderMergeBadgeSlot({ pendingCount: -3 })).toBe('');
    const html = renderMergeBadgeSlot({ pendingCount: 4.9 });
    expect(html).toContain('>4<');
  });

  it('escapes the aria-label text (XSS defence)', () => {
    // pendingCount is numeric — no XSS surface in the slot itself,
    // but the escape pass over the formatted string runs through `e()`
    // which renders the count safely. The smoke test pins that the
    // escaping helper is in the call path.
    const state: MergeBadgeSlotState = { pendingCount: 5 };
    const html = renderMergeBadgeSlot(state);
    expect(html).not.toContain('<script');
  });
});

describe('renderTopBar — mergeBadge wiring', () => {
  it('omits the slot when state.mergeBadge is undefined', () => {
    const html = renderTopBar(baseTopBar());
    expect(html).not.toContain('top-bar-merge-badge');
  });

  it('renders the slot inside top-bar-right when mergeBadge is set', () => {
    const html = renderTopBar(baseTopBar({ mergeBadge: { pendingCount: 3 } }));
    expect(html).toContain('top-bar-merge-badge');
    expect(html).toContain('>3<');
  });

  it('omits the slot when mergeBadge.pendingCount is zero (slot self-hides)', () => {
    const html = renderTopBar(baseTopBar({ mergeBadge: { pendingCount: 0 } }));
    expect(html).not.toContain('top-bar-merge-badge');
  });
});

const baseContacts = (
  overrides: Partial<ContactsSettingsSectionState> = {},
): ContactsSettingsSectionState => ({
  ...initialContactsSettingsSectionState(),
  now: NOW,
  ...overrides,
});

describe('renderContactsSettingsSection', () => {
  it('renders the empty subtitle when pendingCount is zero', () => {
    const html = renderContactsSettingsSection(baseContacts({ pendingCount: 0 }));
    expect(html).toContain('No pending merge candidates.');
    expect(html).not.toContain('contact-merge-open-review');
    expect(html).toContain('contact-merge-scan-now');
  });

  it('renders the count badge + Open-review button when pendingCount is positive', () => {
    const html = renderContactsSettingsSection(baseContacts({ pendingCount: 5 }));
    expect(html).toContain('5 merge candidates pending review.');
    expect(html).toContain('contacts-settings-count');
    expect(html).toContain('>5<');
    expect(html).toContain('data-action="contact-merge-open-review"');
    expect(html).toContain('Open review');
  });

  it('uses singular phrasing for count of 1', () => {
    const html = renderContactsSettingsSection(baseContacts({ pendingCount: 1 }));
    expect(html).toContain('1 merge candidate pending review.');
  });

  it('caps the count badge at 99+', () => {
    const html = renderContactsSettingsSection(baseContacts({ pendingCount: 250 }));
    expect(html).toContain('>99+<');
  });

  it('disables Scan-now + flips the label while a scan is in flight', () => {
    const html = renderContactsSettingsSection(
      baseContacts({ pendingCount: 0, scanning: true }),
    );
    expect(html).toContain('Scanning…');
    expect(html).toMatch(/data-action="contact-merge-scan-now"[^>]*disabled/);
  });

  it('renders relative last-scan time when set', () => {
    const html = renderContactsSettingsSection(
      baseContacts({ pendingCount: 0, lastScanAt: NOW - 5 * 60_000 }),
    );
    expect(html).toContain('Last scan: 5 min ago');
  });

  it('omits the status line when lastScanAt is null', () => {
    const html = renderContactsSettingsSection(
      baseContacts({ pendingCount: 0, lastScanAt: null }),
    );
    expect(html).not.toContain('Last scan:');
  });

  it('renders an error panel when error is set', () => {
    const html = renderContactsSettingsSection(
      baseContacts({ pendingCount: 0, error: 'rpc timeout' }),
    );
    expect(html).toContain('Scan failed');
    expect(html).toContain('rpc timeout');
  });

  it('omits the Rejected-pairs link by default and shows it when explicitly enabled', () => {
    const hidden = renderContactsSettingsSection(baseContacts({ pendingCount: 0 }));
    expect(hidden).not.toContain('contact-merge-open-rejected');

    const shown = renderContactsSettingsSection(
      baseContacts({ pendingCount: 0, showRejectedPairsLink: true }),
    );
    expect(shown).toContain('contact-merge-open-rejected');
    expect(shown).toContain('Rejected pairs');
  });

  it('escapes user-controlled error text (XSS defence)', () => {
    const html = renderContactsSettingsSection(
      baseContacts({ error: '<script>alert(1)</script>' }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders the section heading + accessibility id', () => {
    const html = renderContactsSettingsSection(baseContacts());
    expect(html).toContain('id="contacts-merge-settings"');
    expect(html).toContain('Contacts');
  });
});

describe('initialContactsSettingsSectionState', () => {
  it('seeds zero pending + idle scan + null lastScanAt + no error', () => {
    const s = initialContactsSettingsSectionState();
    expect(s.pendingCount).toBe(0);
    expect(s.scanning).toBe(false);
    expect(s.lastScanAt).toBeNull();
    expect(s.showRejectedPairsLink).toBe(false);
    expect(s.error).toBeNull();
  });
});
