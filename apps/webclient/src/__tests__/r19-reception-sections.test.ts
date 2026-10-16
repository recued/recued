/** R19 — reception sections vocabulary (`sections.ts`).
 *
 *  The closed-list section vocabulary + the segment-0 resolver behind the
 *  `#reception/<section>` sub-router. Pure functions — no DOM. */

import { describe, expect, it } from 'vitest';

import {
  RECEPTION_DEFAULT_SECTION,
  RECEPTION_SECTIONS,
  RECEPTION_NAV_GROUPS,
  RECEPTION_CUSTOMER_SECTIONS,
  RECEPTION_ROUTE_CONTENT_ATTR,
  RECEPTION_ROUTE_HOST_ATTR,
  RECEPTION_ROUTE_TABS_ATTR,
  RECEPTION_SECTION_NAV_STYLES,
  resolveReceptionSection,
} from '../reception/sections.js';

describe('R19 — reception sections vocabulary', () => {
  it('keeps customer work and setup in deliberate navigation groups', () => {
    expect(RECEPTION_SECTIONS.map(s=>s.id)).toEqual(['inbox','jobs','records','signoffs','accounts','receivables','followups','abuse','endpoints']);
    expect(RECEPTION_NAV_GROUPS.map(s=>s.label)).toEqual(['Inbox','Customer work','Records','Manage']);
    expect(RECEPTION_CUSTOMER_SECTIONS).toEqual(['jobs','signoffs','accounts','receivables','followups']);
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
    expect(RECEPTION_SECTION_NAV_STYLES).toMatch(
      /\[data-recued-reception-route\]\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(RECEPTION_SECTION_NAV_STYLES).toMatch(/\.reception-route-tab\s*\{[^}]*white-space:\s*nowrap[^}]*flex-shrink:\s*0/s);
    expect(RECEPTION_SECTION_NAV_STYLES).toContain('overflow-x: auto');
  });
});
