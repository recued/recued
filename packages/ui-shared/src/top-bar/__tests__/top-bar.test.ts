/** D-119 Phase 3 — top-bar shell tests.
 *
 *  Combines render assertions for the four slots (search, attention,
 *  avatar, devices) with naming-sweep checks. Phase-4-and-later
 *  popovers / routes are out of scope here. */

import { describe, expect, it } from 'vitest';
import { renderTopBar, type TopBarState } from '../top-bar.js';
import { renderTopBarSearchInput } from '../search-input.js';
import { renderAttentionSlot } from '../attention-slot.js';
import { renderAvatar } from '../avatar.js';

const NOW = 1_700_000_000_000;

const baseState = (overrides: Partial<TopBarState> = {}): TopBarState => ({
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
      {
        id: 'this-extension',
        kind: 'self-extension',
        name: 'This Extension',
        lastSeenMs: null,
        current: true,
      },
    ],
    showPairServerCta: false,
    open: false,
    nowMs: NOW,
  },
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// Search slot
// ────────────────────────────────────────────────────────────────

describe('renderTopBarSearchInput', () => {
  it('renders an empty input when no query is active', () => {
    const html = renderTopBarSearchInput({ query: null });
    expect(html).toContain('data-field="recipe-filter"');
    expect(html).toContain('placeholder="Search Recipes…"');
    // The textInput primitive always emits value=, but it's empty
    // when query is null — the rendered field is blank.
    expect(html).toContain('value=""');
  });

  it('preserves the existing data-field hook so the runtime listener still fires', () => {
    const html = renderTopBarSearchInput({ query: 'risk' });
    expect(html).toContain('data-field="recipe-filter"');
    expect(html).toContain('value="risk"');
  });

  it('escapes the query value (XSS defence)', () => {
    const html = renderTopBarSearchInput({ query: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ────────────────────────────────────────────────────────────────
// Attention slot
// ────────────────────────────────────────────────────────────────

describe('renderAttentionSlot', () => {
  it('renders the idle button without a badge when blockingCount is zero', () => {
    const html = renderAttentionSlot({ blockingCount: 0 });
    expect(html).toContain('top-bar-attention--idle');
    expect(html).not.toContain('top-bar-attention-badge');
    expect(html).toContain('No items need your attention');
    expect(html).toContain('top-bar-attention-bell');
    expect(html).toContain('<svg width="18" height="18"');
    expect(html).not.toContain('⚠');
  });

  it('renders the active button with a numeric badge when blocking work exists', () => {
    const html = renderAttentionSlot({ blockingCount: 3 });
    expect(html).toContain('top-bar-attention--active');
    expect(html).toContain('top-bar-attention-badge');
    expect(html).toContain('>3<');
    expect(html).toContain('3 items need your attention');
  });

  it('keeps saved-for-later items discoverable without raising the badge', () => {
    const quiet = renderAttentionSlot({ blockingCount: 0, quietCount: 1 });
    expect(quiet).toContain('top-bar-attention--idle');
    expect(quiet).toContain('top-bar-attention--saved');
    expect(quiet).not.toContain('top-bar-attention-badge');
    expect(quiet).toContain(
      'No items need your attention; 1 item saved for later',
    );

    const ready = renderAttentionSlot({
      blockingCount: 0,
      quietCount: 1,
      quietStatus: 'ready',
    });
    expect(ready).toContain('top-bar-attention--ready');
    expect(ready).toContain('top-bar-attention-quiet-indicator');
    expect(ready).not.toContain('top-bar-attention-badge');
    expect(ready).toContain(
      'No items need your attention; 1 saved item ready to review',
    );

    const checking = renderAttentionSlot({
      blockingCount: 0,
      quietCount: 1,
      quietStatus: 'checking',
    });
    expect(checking).toContain('top-bar-attention--checking');
    expect(checking).toContain('top-bar-attention-quiet-indicator');
    expect(checking).not.toContain('top-bar-attention-badge');
    expect(checking).toContain(
      'No items need your attention; 1 saved review is being checked',
    );

    const retry = renderAttentionSlot({
      blockingCount: 0,
      quietCount: 1,
      quietStatus: 'retry',
    });
    expect(retry).toContain('top-bar-attention--retry');
    expect(retry).toContain('top-bar-attention-quiet-indicator');
    expect(retry).not.toContain('top-bar-attention-badge');
    expect(retry).toContain(
      'No items need your attention; 1 saved review needs retry',
    );

    const diagnosis = renderAttentionSlot({
      blockingCount: 0,
      quietCount: 1,
      quietStatus: 'diagnosis',
    });
    expect(diagnosis).toContain('top-bar-attention--diagnosis');
    expect(diagnosis).toContain('top-bar-attention-quiet-indicator');
    expect(diagnosis).not.toContain('top-bar-attention-badge');
    expect(diagnosis).toContain(
      'No items need your attention; 1 saved review needs diagnosis',
    );

    const decision = renderAttentionSlot({
      blockingCount: 0,
      quietCount: 1,
      quietStatus: 'decision',
    });
    expect(decision).toContain('top-bar-attention--decision');
    expect(decision).not.toContain('top-bar-attention-badge');
    expect(decision).toContain(
      'No items need your attention; 1 saved review needs a decision',
    );

    const closure = renderAttentionSlot({
      blockingCount: 0,
      quietCount: 1,
      quietStatus: 'closure',
    });
    expect(closure).toContain('top-bar-attention--closure');
    expect(closure).not.toContain('top-bar-attention-badge');
    expect(closure).toContain(
      'No items need your attention; 1 saved review needs closure',
    );

    const mixed = renderAttentionSlot({ blockingCount: 2, quietCount: 3 });
    expect(mixed).toContain('>2<');
    expect(mixed).toContain(
      '2 items need your attention; 3 items saved for later',
    );
  });

  it('uses singular phrasing when count is exactly 1', () => {
    const html = renderAttentionSlot({ blockingCount: 1 });
    expect(html).toContain('1 item needs your attention');
  });

  it('caps the badge at 99+ so layout stays stable', () => {
    const html = renderAttentionSlot({ blockingCount: 250 });
    expect(html).toContain('>99+<');
  });

  it('emits open-attention as the click action — Phase 4 will mount the popover', () => {
    const html = renderAttentionSlot({ blockingCount: 1 });
    expect(html).toContain('data-action="open-attention"');
  });
});

// ────────────────────────────────────────────────────────────────
// Avatar slot
// ────────────────────────────────────────────────────────────────

describe('renderAvatar', () => {
  it('renders the signed-out variant + open-signin action when user is null', () => {
    const html = renderAvatar({ user: null });
    expect(html).toContain('top-bar-avatar--signed-out');
    expect(html).toContain('data-action="open-signin"');
    expect(html).toContain('Sign in to publish recipes');
  });

  it('renders the signed-in variant + open-global-page action when user is set', () => {
    const html = renderAvatar({
      user: { id: 'user-1', email: 'nico@example.com' },
    });
    expect(html).toContain('top-bar-avatar--signed-in');
    expect(html).toContain('data-action="open-global-page"');
    expect(html).toContain('nico@example.com — Profile &amp; Global Settings');
  });

  it('escapes the email + first-letter glyph (XSS defence)', () => {
    const html = renderAvatar({
      user: { id: 'evil', email: '<img src=x onerror=alert(1)>@example.com' },
    });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;');
  });
});

// ────────────────────────────────────────────────────────────────
// Composed top bar
// ────────────────────────────────────────────────────────────────

describe('renderTopBar', () => {
  it('emits all four slots in the documented order', () => {
    const html = renderTopBar(baseState());
    const searchIdx = html.indexOf('top-bar-search');
    const attentionIdx = html.indexOf('top-bar-attention');
    const avatarIdx = html.indexOf('top-bar-avatar');
    const devicesIdx = html.indexOf('top-bar-devices-trigger');
    expect(searchIdx).toBeGreaterThan(-1);
    expect(attentionIdx).toBeGreaterThan(searchIdx);
    expect(avatarIdx).toBeGreaterThan(attentionIdx);
    expect(devicesIdx).toBeGreaterThan(avatarIdx);
  });

  it('mounts the dropdown popover only when state.devices.open is true', () => {
    const closed = renderTopBar(baseState());
    const open = renderTopBar(baseState({
      devices: {
        devices: baseState().devices.devices,
        showPairServerCta: false,
        open: true,
        nowMs: NOW,
      },
    }));
    expect(closed).not.toContain('top-bar-devices-popover');
    expect(open).toContain('top-bar-devices-popover');
  });
});

// ────────────────────────────────────────────────────────────────
// Naming sweep — instance → device in user-facing strings
// ────────────────────────────────────────────────────────────────

describe('naming sweep (instance → device)', () => {
  it('top-bar surfaces never expose the word "instance" — they say "device"', () => {
    const html = renderTopBar(baseState({
      devices: {
        devices: baseState().devices.devices,
        showPairServerCta: true,
        open: true,
        nowMs: NOW,
      },
    }));
    // Aria labels and visible copy use "device" / "Device".
    expect(html.toLowerCase()).not.toMatch(/\binstance/);
    expect(html).toContain('Device');
  });

  it('attention slot speaks of "items" — never "instances"', () => {
    const html = renderAttentionSlot({ blockingCount: 5 });
    expect(html.toLowerCase()).not.toMatch(/\binstance/);
  });
});
