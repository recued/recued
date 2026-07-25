/** D-156 P2 — Settings → Devices renderer tests.
 *
 *  Pure render assertions over the renderer in `account/devices-page.ts`.
 *  Covers:
 *    • Section + table scaffolding (Device | Status | Paired | Actions)
 *    • Roster sort (current → connected → offline, most-recent paired)
 *    • Per-kind label rendering
 *    • Self-revoke blocked (no Revoke button on the current row)
 *    • Status cell (Online now / Offline) + Paired cell (relative date)
 *    • Inline confirm panel state (visible / revoking / error)
 *    • XSS escaping on display_name
 *
 *  R30 — revoked rows are filtered out at the mount, so the renderer no
 *  longer models a `revoked` row (that support + the "Last seen" column,
 *  which mislabeled the pairing time, were dropped). Adapted from the
 *  original `d-121-phase-7-devices-page.test.ts` at `649ac948` minus every
 *  tier-aware widget retired by D-148 P12. */

import { describe, expect, it } from 'vitest';
import {
  renderDevicesPage,
  type DevicesPageRow,
  type DevicesPageState,
} from '../account/devices-page.js';

const NOW = 1_700_000_000_000;

const row = (overrides: Partial<DevicesPageRow> = {}): DevicesPageRow => ({
  instance_id: 'i1',
  display_name: 'Laptop',
  kind: 'webclient',
  connected: true,
  paired_at: NOW,
  isCurrent: false,
  ...overrides,
});

const state = (overrides: Partial<DevicesPageState> = {}): DevicesPageState => ({
  rows: [row({ instance_id: 'i1', isCurrent: true })],
  nowMs: NOW,
  ...overrides,
});

describe('renderDevicesPage — layout', () => {
  it('renders the section title + 4-column table scaffolding', () => {
    const html = renderDevicesPage(state());
    expect(html).toContain('Devices');
    expect(html).toContain('account-devices-table');
    // Device | Status | Paired | Actions — no Mode column (D-148 P12),
    // no "Last seen" (it mislabeled the pairing time — R30 dropped it).
    expect(html).toContain('>Device<');
    expect(html).toContain('>Status<');
    expect(html).toContain('>Paired<');
    expect(html).toContain('>Actions<');
    expect(html).not.toContain('>Mode<');
    expect(html).not.toContain('>Last seen<');
  });

  it('omits tier-aware widgets retired by D-148 P12', () => {
    const html = renderDevicesPage(state());
    // No Pro/Free badge, no executor-limit copy, no overage / grace
    // banners — none of these widgets render in any state.
    expect(html).not.toContain('account-devices-tier-badge');
    expect(html).not.toContain('Free tier');
    expect(html).not.toContain('Unlimited executor');
    expect(html).not.toContain('account-devices-banner--overage');
    expect(html).not.toContain('account-devices-banner--grace');
    // No mode toggle, no demote action.
    expect(html).not.toContain('account-devices-mode--toggle');
    expect(html).not.toContain('data-action="set-self-mode"');
    expect(html).not.toContain('data-action="demote-device"');
  });

  it('renders an empty-roster placeholder when no rows exist', () => {
    const html = renderDevicesPage(state({ rows: [] }));
    expect(html).toContain('account-devices-empty');
    expect(html).toContain('No paired devices yet');
  });

  it('renders the kind label parenthesized after the display name', () => {
    const html = renderDevicesPage(
      state({
        rows: [
          row({ instance_id: 'a', display_name: 'Phone', kind: 'webclient' }),
          row({ instance_id: 'b', display_name: 'Work laptop', kind: 'bridge' }),
          row({ instance_id: 'c', display_name: 'Server CLI', kind: 'cli' }),
        ],
      }),
    );
    expect(html).toContain('>Phone<');
    expect(html).toContain('(Webclient)');
    expect(html).toContain('>Work laptop<');
    expect(html).toContain('(Bridge)');
    expect(html).toContain('>Server CLI<');
    expect(html).toContain('(CLI)');
  });

  it('escapes display_name to prevent HTML injection', () => {
    const html = renderDevicesPage(
      state({
        rows: [row({ instance_id: 'a', display_name: '<script>alert(1)</script>' })],
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('renderDevicesPage — current row + self-revoke blocked', () => {
  it('current device gets the This-device badge', () => {
    const html = renderDevicesPage(
      state({ rows: [row({ instance_id: 'self', isCurrent: true })] }),
    );
    expect(html).toContain('This device');
    expect(html).toContain('account-devices-row--current');
  });

  it('current device gets no Revoke button — self-revoke blocked', () => {
    const html = renderDevicesPage(
      state({ rows: [row({ instance_id: 'self', isCurrent: true })] }),
    );
    expect(html).not.toContain('data-action="revoke-device"');
    expect(html).toContain('account-devices-action-placeholder');
  });

  it('non-current devices get a Revoke button stamped with their instance_id', () => {
    const html = renderDevicesPage(
      state({
        rows: [
          row({ instance_id: 'self', isCurrent: true }),
          row({ instance_id: 'phone', display_name: 'Phone', isCurrent: false }),
        ],
      }),
    );
    expect(html).toContain('data-action="revoke-device"');
    expect(html).toContain('data-instance-id="phone"');
  });
});

describe('renderDevicesPage — sort order', () => {
  it('current → connected → offline', () => {
    const html = renderDevicesPage(
      state({
        rows: [
          row({ instance_id: 'offline', connected: false, paired_at: NOW - 50_000 }),
          row({ instance_id: 'connected-other', connected: true, paired_at: NOW - 1000 }),
          row({ instance_id: 'self', isCurrent: true, connected: true }),
        ],
      }),
    );
    const idxSelf = html.indexOf('data-instance-id="self"');
    const idxConn = html.indexOf('data-instance-id="connected-other"');
    const idxOff = html.indexOf('data-instance-id="offline"');
    expect(idxSelf).toBeGreaterThan(0);
    expect(idxSelf).toBeLessThan(idxConn);
    expect(idxConn).toBeLessThan(idxOff);
  });

  it('actives sort by paired_at descending (most-recently paired first)', () => {
    const html = renderDevicesPage(
      state({
        rows: [
          row({ instance_id: 'older', connected: true, paired_at: NOW - 5000 }),
          row({ instance_id: 'newest', connected: true, paired_at: NOW - 100 }),
        ],
      }),
    );
    const idxNew = html.indexOf('data-instance-id="newest"');
    const idxOld = html.indexOf('data-instance-id="older"');
    expect(idxNew).toBeGreaterThan(0);
    expect(idxNew).toBeLessThan(idxOld);
  });
});

describe('renderDevicesPage — status + paired cells', () => {
  it('connected rows show "Online now"', () => {
    const html = renderDevicesPage(
      state({ rows: [row({ isCurrent: true, connected: true })] }),
    );
    expect(html).toContain('Online now');
  });

  it('offline rows show "Offline" (no mislabeled last-seen)', () => {
    const html = renderDevicesPage(
      state({
        rows: [
          row({ instance_id: 'self', isCurrent: true }),
          row({
            instance_id: 'gone',
            connected: false,
            paired_at: NOW - 25 * 3600 * 1000,
            isCurrent: false,
          }),
        ],
      }),
    );
    expect(html).toContain('Offline');
  });

  it('the Paired column shows a relative date from paired_at', () => {
    const html = renderDevicesPage(
      state({
        rows: [row({ connected: false, paired_at: NOW - 25 * 3600 * 1000 })],
      }),
    );
    expect(html).toContain('1 day ago');
  });

  it('formatRelative covers under-minute, minutes, hours, days', () => {
    const cases = [
      { paired_at: NOW, expected: 'Just now' },
      { paired_at: NOW - 5_000, expected: 'Just now' },
      { paired_at: NOW - 5 * 60_000, expected: '5 minutes ago' },
      { paired_at: NOW - 1 * 60_000, expected: '1 minute ago' },
      { paired_at: NOW - 2 * 3600_000, expected: '2 hours ago' },
      { paired_at: NOW - 1 * 3600_000, expected: '1 hour ago' },
      { paired_at: NOW - 3 * 86_400_000, expected: '3 days ago' },
    ];
    for (const c of cases) {
      const html = renderDevicesPage(
        state({ rows: [row({ paired_at: c.paired_at })] }),
      );
      expect(html).toContain(c.expected);
    }
  });

  it('paired_at=0 renders "Unknown"', () => {
    const html = renderDevicesPage(state({ rows: [row({ paired_at: 0 })] }));
    expect(html).toContain('Unknown');
  });
});

describe('renderDevicesPage — inline revoke-confirm panel', () => {
  const confirmingState = (
    extras: Partial<DevicesPageState> = {},
  ): DevicesPageState => ({
    rows: [
      row({ instance_id: 'self', isCurrent: true }),
      row({ instance_id: 'phone', display_name: 'Phone', isCurrent: false }),
    ],
    confirmingInstanceId: 'phone',
    nowMs: NOW,
    ...extras,
  });

  it('does not render the confirm panel when no row is in confirm state', () => {
    const html = renderDevicesPage(
      state({
        rows: [
          row({ instance_id: 'self', isCurrent: true }),
          row({ instance_id: 'phone', isCurrent: false }),
        ],
      }),
    );
    expect(html).not.toContain('account-devices-confirm-panel');
    expect(html).not.toContain('data-action="confirm-revoke"');
    expect(html).not.toContain('data-action="cancel-revoke"');
  });

  it('renders the confirm panel under the row whose instance_id matches', () => {
    const html = renderDevicesPage(confirmingState());
    expect(html).toContain('account-devices-confirm-panel');
    expect(html).toContain('account-devices-row--confirming');
    expect(html).toContain('data-action="cancel-revoke"');
    expect(html).toContain('data-action="confirm-revoke"');
    // Confirm button copy quotes the display_name for clarity.
    expect(html).toContain('Yes, revoke');
    expect(html).toContain('Phone');
    // Recovery-key reminder copy.
    expect(html).toContain('24-word recovery key');
    // Both action buttons stamp the instance_id so the host can route.
    const confirmIdx = html.indexOf('data-action="confirm-revoke"');
    const cancelIdx = html.indexOf('data-action="cancel-revoke"');
    expect(html.slice(confirmIdx, confirmIdx + 200)).toContain('data-instance-id="phone"');
    expect(html.slice(cancelIdx, cancelIdx + 200)).toContain('data-instance-id="phone"');
  });

  it('confirm panel appears AFTER its row in DOM order', () => {
    const html = renderDevicesPage(confirmingState());
    const rowIdx = html.indexOf('<tr class="account-devices-row');
    const phoneRowIdx = html.indexOf('data-instance-id="phone"', rowIdx);
    const confirmRowIdx = html.indexOf('account-devices-confirm-row', phoneRowIdx);
    expect(phoneRowIdx).toBeGreaterThan(rowIdx);
    expect(confirmRowIdx).toBeGreaterThan(phoneRowIdx);
  });

  it('revoking state disables both buttons + shows the Revoking… status', () => {
    const html = renderDevicesPage(
      confirmingState({ revokingInstanceId: 'phone' }),
    );
    expect(html).toContain('Revoking…');
    expect(html).toContain('account-devices-confirm-status');
    // Both buttons disabled while in flight.
    const confirmIdx = html.indexOf('data-action="confirm-revoke"');
    const cancelIdx = html.indexOf('data-action="cancel-revoke"');
    expect(html.slice(confirmIdx, confirmIdx + 300)).toContain(' disabled');
    expect(html.slice(cancelIdx, cancelIdx + 300)).toContain(' disabled');
  });

  it('rpc failure surfaces the error inline while keeping the confirm panel open', () => {
    const html = renderDevicesPage(
      confirmingState({ revokeError: 'Server unreachable' }),
    );
    expect(html).toContain('account-devices-confirm-error');
    expect(html).toContain('Server unreachable');
    // Buttons re-enabled so the user can retry / cancel.
    const confirmIdx = html.indexOf('data-action="confirm-revoke"');
    expect(html.slice(confirmIdx, confirmIdx + 300)).not.toContain(' disabled');
  });

  it('revokeError is suppressed while a new revoke is in flight', () => {
    const html = renderDevicesPage(
      confirmingState({
        revokingInstanceId: 'phone',
        revokeError: 'Server unreachable',
      }),
    );
    // The retry has dispatched — surface the spinner, not the stale error.
    expect(html).toContain('Revoking…');
    expect(html).not.toContain('Server unreachable');
  });

  it('confirm panel only renders for the matching row when multiple peers exist', () => {
    const html = renderDevicesPage({
      rows: [
        row({ instance_id: 'self', isCurrent: true }),
        row({ instance_id: 'phone', display_name: 'Phone', isCurrent: false }),
        row({ instance_id: 'tablet', display_name: 'Tablet', isCurrent: false }),
      ],
      confirmingInstanceId: 'tablet',
      nowMs: NOW,
    });
    const confirmCount = (html.match(/account-devices-confirm-panel/g) ?? []).length;
    expect(confirmCount).toBe(1);
    const confirmIdx = html.indexOf('account-devices-confirm-row');
    expect(html.slice(confirmIdx, confirmIdx + 200)).toContain('data-instance-id="tablet"');
  });

  it('escapes display_name inside the confirm button copy', () => {
    const html = renderDevicesPage({
      rows: [
        row({ instance_id: 'self', isCurrent: true }),
        row({
          instance_id: 'phone',
          display_name: '<img src=x onerror=1>',
          isCurrent: false,
        }),
      ],
      confirmingInstanceId: 'phone',
      nowMs: NOW,
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});
