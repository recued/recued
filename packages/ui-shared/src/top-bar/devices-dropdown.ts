/** D-119 Phase 3 — top-bar Devices Dropdown.
 *
 *  Renders the device-scope switcher (this client + every paired
 *  server / remote client) above a horizontal rule, with the
 *  cross-cutting `All Device Schedules` jump and the (anon-only)
 *  `+ Pair a server…` upsell below.
 *
 *  Three tier states (matching the spec wireframe exactly):
 *    1. Anon, no server paired → only "This Device" + the upsell.
 *    2. Ext + paired server    → both rows + jumps, no upsell.
 *    3. Multi-device           → every paired client + server row.
 *
 *  Pure module. */

import { e } from '../template.js';
import {
  computeOnlineIndicator,
  renderOnlineDot,
  type OnlineIndicator,
} from './online-indicator.js';

/** One row in the dropdown switcher. The `kind` discriminator drives
 *  the icon, ordering, and routing. */
export interface Device {
  /** Stable id used for scope routing. `'this-extension'` for the
   *  local client, `instance_id` for remote clients, server id for
   *  paired servers. */
  id: string;
  kind: 'self-extension' | 'paired-server' | 'remote-extension';
  /** Display label. Must be human-readable — naming sweep means we
   *  never surface raw `instance_id` here. */
  name: string;
  /** Last heartbeat in ms. `null` for the local self-extension (which
   *  is always "online" by definition since we're rendering inside
   *  it). Servers + remote clients feed their last_seen here. */
  lastSeenMs: number | null;
  /** True when this is the currently-selected scope. */
  current: boolean;
}

export interface DevicesDropdownState {
  /** Switcher rows, already ordered the way they should render. */
  devices: Device[];
  /** When true, render the `+ Pair a server…` upsell beneath the
   *  jumps. Driven by tier state in the sidebar (no paired server +
   *  no remote clients). */
  showPairServerCta: boolean;
  /** Whether the dropdown is currently expanded. The trigger always
   *  renders; the popover only when `open`. */
  open: boolean;
  /** Reference time for online-indicator computation. Defaults to
   *  `Date.now()` at call time; tests pin it for determinism. */
  nowMs?: number;
}

/** Glyph for each device kind. Kept as small unicode so we don't pull
 *  in an icon dependency for Phase 3. */
const DEVICE_KIND_GLYPH: Record<Device['kind'], string> = {
  'self-extension': '🧩',
  'paired-server': '🖥',
  'remote-extension': '🌐',
};

const ariaLabelFor = (device: Device, indicator: OnlineIndicator): string => {
  const status =
    device.kind === 'self-extension' ? 'this device' : indicator;
  return `${device.name} — ${status}`;
};

const renderDeviceRow = (device: Device, nowMs: number): string => {
  // Self-extension is always "online" — it's the device we're rendered
  // inside. Skip the heartbeat math and force green.
  const indicator: OnlineIndicator =
    device.kind === 'self-extension'
      ? 'green'
      : computeOnlineIndicator(device.lastSeenMs, nowMs);
  const dot =
    device.kind === 'self-extension'
      ? '' // spec wireframe shows no dot on the self row
      : renderOnlineDot(indicator);
  const checkmark = device.current
    ? `<span class="top-bar-devices-row-check" aria-hidden="true">✓</span>`
    : `<span class="top-bar-devices-row-check top-bar-devices-row-check--empty" aria-hidden="true"></span>`;
  return `
    <button type="button"
      class="top-bar-devices-row top-bar-devices-row--${e(device.kind)}${device.current ? ' top-bar-devices-row--current' : ''}"
      data-action="pick-device"
      data-device-id="${e(device.id)}"
      data-device-kind="${e(device.kind)}"
      role="menuitemradio"
      aria-checked="${device.current ? 'true' : 'false'}"
      aria-label="${e(ariaLabelFor(device, indicator))}">
      ${checkmark}
      <span class="top-bar-devices-row-glyph" aria-hidden="true">${DEVICE_KIND_GLYPH[device.kind]}</span>
      <span class="top-bar-devices-row-name">${e(device.name)}</span>
      ${dot}
    </button>
  `;
};

/** Render the closed-state trigger button. The popover (open state)
 *  renders separately so the sidebar can position it absolutely. */
export const renderDevicesDropdownTrigger = (state: DevicesDropdownState): string => {
  const current = state.devices.find((d) => d.current) ?? state.devices[0];
  const label = current ? current.name : 'Devices';
  return `
    <button type="button"
      class="top-bar-devices-trigger ${state.open ? 'top-bar-devices-trigger--open' : ''}"
      data-action="toggle-devices-dropdown"
      aria-haspopup="menu"
      aria-expanded="${state.open ? 'true' : 'false'}"
      aria-label="Switch device — currently ${e(label)}">
      <span class="top-bar-devices-label">${e(label)}</span>
      <span class="top-bar-devices-caret" aria-hidden="true">▼</span>
    </button>
  `;
};

/** Render the open dropdown popover (switcher list + jumps). Caller
 *  decides whether to mount it (i.e. only when `state.open === true`). */
export const renderDevicesDropdownPopover = (state: DevicesDropdownState): string => {
  const nowMs = state.nowMs ?? Date.now();
  const rows = state.devices.map((d) => renderDeviceRow(d, nowMs)).join('');
  const allSchedulesJump = `
    <button type="button"
      class="top-bar-devices-jump"
      data-action="open-all-device-schedules"
      role="menuitem">
      All Device Schedules
    </button>
  `;
  const pairServerCta = state.showPairServerCta
    ? `
      <button type="button"
        class="top-bar-devices-jump top-bar-devices-jump--cta"
        data-action="open-pair-server"
        role="menuitem">
        + Pair a server…
      </button>
    `
    : '';
  return `
    <div class="top-bar-devices-popover" role="menu" aria-label="Devices">
      <div class="top-bar-devices-rows">
        ${rows}
      </div>
      <div class="top-bar-devices-rule" role="separator"></div>
      <div class="top-bar-devices-jumps">
        ${allSchedulesJump}
        ${pairServerCta}
      </div>
    </div>
  `;
};

/** Convenience: render trigger + popover together. The sidebar passes
 *  `state.open` so the popover is omitted when closed. */
export const renderDevicesDropdown = (state: DevicesDropdownState): string => `
  <div class="top-bar-devices ${state.open ? 'top-bar-devices--open' : ''}">
    ${renderDevicesDropdownTrigger(state)}
    ${state.open ? renderDevicesDropdownPopover(state) : ''}
  </div>
`;
