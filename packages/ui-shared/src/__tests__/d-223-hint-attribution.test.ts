/** D-223 Slice 2 — a pre-filled box says who filled it, until the owner touches it.
 *
 *  A seeded field and one the owner typed look identical, and afterwards "I
 *  checked that" and "I did not look" become indistinguishable. The marker exists
 *  to keep them apart while the decision is being made, which is also why it is a
 *  DISPLAY fact and never stored on the enrolled connection. */

import { describe, expect, it } from 'vitest';

import { renderConnectionsPage } from '../connections/page.js';
import {
  initialConnectionsDialogState,
  initialConnectionsPageState,
} from '../connections/state.js';
import type { ConnectionsDialogState } from '../connections/state.js';

const html = (over: Partial<ConnectionsDialogState>): string => renderConnectionsPage({
  ...initialConnectionsPageState(),
  dialog: {
    ...initialConnectionsDialogState(),
    stage: 'form',
    mode: 'create',
    kind: 'api',
    ...over,
  },
});

describe('D-223 — hint attribution', () => {
  it('marks a field whose value a pack suggested', () => {
    const out = html({
      values: { 'config.base_url': 'https://api.acme.example' },
      hintedFields: { 'config.base_url': 'acme-co' },
    });
    expect(out).toContain('data-suggested-by="acme-co"');
    expect(out).toContain('Suggested by acme-co');
  });

  it('leaves an unhinted field unmarked (the permitting case)', () => {
    // Without this, a marker on every field would pass the test above while
    // telling the owner nothing.
    const out = html({ values: { 'config.base_url': 'https://api.acme.example' } });
    expect(out).not.toContain('data-suggested-by');
    expect(out).not.toContain('Suggested by');
  });

  it('marks only the hinted field, not its neighbours', () => {
    const out = html({
      values: { 'config.base_url': 'https://api.acme.example', name: 'acme' },
      hintedFields: { 'config.base_url': 'acme-co' },
    });
    expect(out.match(/data-suggested-by=/gu) ?? []).toHaveLength(1);
  });

  it('does not claim Recued verified anything', () => {
    // ⚠ The wording constraint from the decision, pinned. "Suggested by X" tells
    // the owner where a value came from; anything reading as assurance would be
    // worse than no label, because it would transfer a judgement Recued has not
    // made. If this ever needs relaxing, it is a decision, not a copy edit.
    const out = html({
      values: { 'config.base_url': 'https://api.acme.example' },
      hintedFields: { 'config.base_url': 'acme-co' },
    });
    for (const forbidden of ['verified', 'Verified', 'trusted', 'Trusted', 'checked by', 'safe']) {
      expect(out, forbidden).not.toContain(forbidden);
    }
  });

  it('escapes the publisher rather than trusting it', () => {
    // The publisher handle reaches this markup from a manifest. It is data.
    const out = html({
      values: { 'config.base_url': 'https://api.acme.example' },
      hintedFields: { 'config.base_url': '<img src=x onerror=alert(1)>' },
    });
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img');
  });

  it('starts with no attribution at all', () => {
    expect(initialConnectionsDialogState().hintedFields).toEqual({});
  });
});
