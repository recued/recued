/** D-119 Phase 3 — devices-dropdown render tests.
 *
 *  Covers the three tier states from the spec wireframe + the open /
 *  closed states + per-row render decisions (current scope checkmark,
 *  online indicator). Phase 5 wires the actual scope router; the
 *  tests here are pure render assertions. */

import { describe, expect, it } from 'vitest';
import {
  renderDevicesDropdown,
  renderDevicesDropdownPopover,
  renderDevicesDropdownTrigger,
  type Device,
  type DevicesDropdownState,
} from '../devices-dropdown.js';

const NOW = 1_700_000_000_000;

const selfDevice: Device = {
  id: 'this-extension',
  kind: 'self-extension',
  name: 'This Extension',
  lastSeenMs: null,
  current: true,
};

const baseState = (overrides: Partial<DevicesDropdownState> = {}): DevicesDropdownState => ({
  devices: [selfDevice],
  showPairServerCta: false,
  open: false,
  nowMs: NOW,
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// Trigger button
// ────────────────────────────────────────────────────────────────

describe('renderDevicesDropdownTrigger', () => {
  it('shows the current-scope name + caret when closed', () => {
    const html = renderDevicesDropdownTrigger(baseState());
    expect(html).toContain('This Extension');
    expect(html).toContain('▼');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('toggle-devices-dropdown');
  });

  it('flags aria-expanded=true when open', () => {
    const html = renderDevicesDropdownTrigger(baseState({ open: true }));
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('top-bar-devices-trigger--open');
  });
});

// ────────────────────────────────────────────────────────────────
// Tier states
// ────────────────────────────────────────────────────────────────

describe('renderDevicesDropdownPopover — tier 1: anon / free, no server', () => {
  it('renders only the self row + jumps + pair-server upsell', () => {
    const html = renderDevicesDropdownPopover(baseState({
      open: true,
      showPairServerCta: true,
    }));
    expect(html).toContain('This Extension');
    expect(html).toContain('All Device Schedules');
    expect(html).toContain('+ Pair a server…');
    // Self row carries the checkmark since it's the current scope by
    // default in Phase 3 (Phase 5 wires the actual router).
    expect(html).toContain('aria-checked="true"');
  });
});

describe('renderDevicesDropdownPopover — tier 2: free, ext + paired server', () => {
  it('renders both rows + jumps and drops the upsell', () => {
    const html = renderDevicesDropdownPopover(baseState({
      open: true,
      showPairServerCta: false,
      devices: [
        selfDevice,
        {
          id: 'paired-server',
          kind: 'paired-server',
          name: 'Home Server',
          lastSeenMs: NOW,
          current: false,
        },
      ],
    }));
    expect(html).toContain('This Extension');
    expect(html).toContain('Home Server');
    expect(html).toContain('All Device Schedules');
    expect(html).not.toContain('+ Pair a server…');
    // Paired server row carries the green dot (lastSeen=NOW).
    expect(html).toContain('device-dot--green');
  });
});

describe('renderDevicesDropdownPopover — tier 3: Pro, multi-device', () => {
  it('renders every paired ext + server row, no upsell, no per-tier divergence', () => {
    const html = renderDevicesDropdownPopover(baseState({
      open: true,
      showPairServerCta: false,
      devices: [
        { id: 'ext-work', kind: 'remote-extension', name: 'Work Laptop', lastSeenMs: NOW - 30_000, current: false },
        { ...selfDevice, current: true },
        { id: 'ext-phone', kind: 'remote-extension', name: 'Phone Browser', lastSeenMs: NOW - 120_000, current: false },
        { id: 'paired-server', kind: 'paired-server', name: 'Home Server', lastSeenMs: NOW, current: false },
      ],
    }));
    expect(html).toContain('Work Laptop');
    expect(html).toContain('Phone Browser');
    expect(html).toContain('Home Server');
    expect(html).toContain('This Extension');
    expect(html).not.toContain('+ Pair a server…');
    // Three indicator dots: green for work, amber for phone, green for server.
    expect(html.match(/device-dot--green/g)?.length).toBe(2);
    expect(html.match(/device-dot--amber/g)?.length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────
// Per-row rendering
// ────────────────────────────────────────────────────────────────

describe('renderDevicesDropdownPopover — per-row decisions', () => {
  it('current scope row is aria-checked="true" with a visible checkmark', () => {
    const html = renderDevicesDropdownPopover(baseState({
      open: true,
      devices: [selfDevice],
    }));
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('top-bar-devices-row--current');
  });

  it('non-current scope row is aria-checked="false"', () => {
    const html = renderDevicesDropdownPopover(baseState({
      open: true,
      devices: [
        { ...selfDevice, current: false },
        {
          id: 'paired-server',
          kind: 'paired-server',
          name: 'Home Server',
          lastSeenMs: NOW,
          current: false,
        },
      ],
    }));
    // Both rows render with aria-checked="false"
    const matches = html.match(/aria-checked="false"/g);
    expect(matches?.length).toBe(2);
  });

  it('emits pick-device action with device-id data attribute on each row', () => {
    const html = renderDevicesDropdownPopover(baseState({
      open: true,
      devices: [
        selfDevice,
        { id: 'srv-abc', kind: 'paired-server', name: 'Home', lastSeenMs: NOW, current: false },
      ],
    }));
    expect(html).toContain('data-action="pick-device"');
    expect(html).toContain('data-device-id="this-extension"');
    expect(html).toContain('data-device-id="srv-abc"');
  });

  it('escapes device names — XSS defence', () => {
    const html = renderDevicesDropdownPopover(baseState({
      open: true,
      devices: [
        { id: 'evil', kind: 'remote-extension', name: '<img src=x onerror=alert(1)>', lastSeenMs: NOW, current: false },
      ],
    }));
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });

  it('skips the dot on the self-extension row (always implicitly online)', () => {
    const html = renderDevicesDropdownPopover(baseState({
      open: true,
      devices: [selfDevice],
    }));
    // No device-dot at all on the self row — the row exists but no dot HTML.
    expect(html).not.toContain('device-dot--');
  });
});

// ────────────────────────────────────────────────────────────────
// Combined trigger + popover render
// ────────────────────────────────────────────────────────────────

describe('renderDevicesDropdown', () => {
  it('emits trigger only when closed — no popover markup', () => {
    const html = renderDevicesDropdown(baseState({ open: false }));
    expect(html).toContain('top-bar-devices-trigger');
    expect(html).not.toContain('top-bar-devices-popover');
  });

  it('emits trigger + popover when open', () => {
    const html = renderDevicesDropdown(baseState({ open: true }));
    expect(html).toContain('top-bar-devices-trigger');
    expect(html).toContain('top-bar-devices-popover');
  });
});
