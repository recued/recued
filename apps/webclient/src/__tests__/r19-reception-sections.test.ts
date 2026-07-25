/** R19 — reception sections vocabulary (`reception-sections.ts`).
 *
 *  The closed-list section vocabulary + the segment-0 resolver behind the
 *  `#reception/<section>` sub-router. Pure functions — no DOM. */

import { describe, expect, it } from 'vitest';

import {
  RECEPTION_DEFAULT_SECTION,
  RECEPTION_SECTIONS,
  RECEPTION_ROUTE_CONTENT_ATTR,
  RECEPTION_ROUTE_HOST_ATTR,
  RECEPTION_ROUTE_TABS_ATTR,
  RECEPTION_SECTION_NAV_STYLES,
  resolveReceptionSection,
} from '../settings/reception-sections.js';

describe('R19 — reception sections vocabulary', () => {
  it('lists the sections in frequency order: inbox · records · abuse · endpoints', () => {
    // D-210 §4c inserted `records` in SECOND place — beside the Inbox, whose gap it covers (a
    // held row has no held op for the Inbox to show). The order is the surface's IA, so it is
    // pinned here rather than left to whoever appends next.
    expect(RECEPTION_SECTIONS.map((s) => s.id)).toEqual([
      'inbox',
      'records',
      'abuse',
      'endpoints',
    ]);
    expect(RECEPTION_SECTIONS.map((s) => s.label)).toEqual([
      'Inbox',
      'Records',
      'Abuse',
      'Endpoints',
    ]);
  });

  it('defaults to Inbox', () => {
    expect(RECEPTION_DEFAULT_SECTION).toBe('inbox');
    // The default must be the FIRST section (the active-tab pre-selection
    // assumes it).
    expect(RECEPTION_SECTIONS[0]!.id).toBe(RECEPTION_DEFAULT_SECTION);
  });
});

describe('R19 — resolveReceptionSection', () => {
  it('passes through every known section', () => {
    for (const { id } of RECEPTION_SECTIONS) {
      expect(resolveReceptionSection(id)).toBe(id);
    }
  });

  it('degrades an absent segment to the default (Inbox)', () => {
    expect(resolveReceptionSection(undefined)).toBe('inbox');
  });

  it('degrades an unknown / empty segment to the default (never rejects)', () => {
    expect(resolveReceptionSection('')).toBe('inbox');
    expect(resolveReceptionSection('not_a_section')).toBe('inbox');
    expect(resolveReceptionSection('INBOX')).toBe('inbox'); // case-sensitive → unknown → default
  });
});

describe('R19 — section nav styles', () => {
  it('targets the route host, tab bar, and content attributes', () => {
    expect(RECEPTION_SECTION_NAV_STYLES).toContain(`[${RECEPTION_ROUTE_HOST_ATTR}]`);
    expect(RECEPTION_SECTION_NAV_STYLES).toContain(`[${RECEPTION_ROUTE_TABS_ATTR}]`);
    expect(RECEPTION_SECTION_NAV_STYLES).toContain(`[${RECEPTION_ROUTE_CONTENT_ATTR}]`);
    // The active-tab treatment, route introduction, and content reset ship.
    expect(RECEPTION_SECTION_NAV_STYLES).toContain('.reception-route-tab--active');
    expect(RECEPTION_SECTION_NAV_STYLES).toContain('.reception-route-subtitle');
    expect(RECEPTION_SECTION_NAV_STYLES).toContain('var(--surface-sunk)');
    expect(RECEPTION_SECTION_NAV_STYLES).toContain('.reception-page');
  });
});
