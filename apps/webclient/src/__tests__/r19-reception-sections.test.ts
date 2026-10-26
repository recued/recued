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
