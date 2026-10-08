/** The install Access step lists a recipe under the tier that actually grants
 *  it — the seed's rule (`recipe-grant-seed.ts`: `exposed && accessCoversRisk`).
 *
 *  ⛔ Live drive, 2026-10-07: the Calendar Invites pack's Access step offered
 *  only "Read only — Look at things only", with all four recipes under it,
 *  three of which create bookings, events and commitments. None is chat-exposed,
 *  so the install writes all four closed at every tier: no tier grants them. */

import { describe, expect, it } from 'vitest';

import {
  installAccessOptions,
  installGrantableOps,
  installRecipeRiskFromPreview,
  type BulkPackManifest,
} from '../index.js';

const manifest = {
  manifest_version: 1,
  slug: 'calendar-invites',
  publisher: 'recued-core',
  name: 'Calendar Invites',
  description: 'test',
  version: 1,
  recipes: [
    { slug: 'track-booking-from-invite', version: 1 },
    { slug: 'notify-invite-answers-and-cancellations', version: 1 },
  ],
  requires: ['install_bulk_pack'],
  tags: [],
} as BulkPackManifest;

const listed = (recipe_id: string, top_risk: 'read' | 'write' | null) => ({ recipe_id, top_risk });

describe('installRecipeRiskFromPreview + installGrantableOps', () => {
  it('a recipe the resolved preview does not list is closed, so no tier lists it', () => {
    const risk = installRecipeRiskFromPreview({ resolved: true, will_enable: [] });
    expect(installGrantableOps(manifest, risk)).toEqual([]);
    // Nothing to grant ⇒ no Access step at all.
    expect(installAccessOptions(installGrantableOps(manifest, risk))).toEqual([]);
  });

  it('a listed recipe sits at its own tier', () => {
    const risk = installRecipeRiskFromPreview({
      resolved: true,
      will_enable: [listed('track-booking-from-invite', 'write')],
    });
    expect(installGrantableOps(manifest, risk)).toEqual([
      { id: 'recued-core/track-booking-from-invite', risk: 'write' },
    ]);
    expect(installAccessOptions(installGrantableOps(manifest, risk))).toEqual(['read', 'write']);
  });

  it('an underivable tier is listed where the seed grants it — Full access', () => {
    const risk = installRecipeRiskFromPreview({
      resolved: true,
      will_enable: [listed('track-booking-from-invite', null)],
    });
    expect(installGrantableOps(manifest, risk)).toEqual([
      { id: 'recued-core/track-booking-from-invite', risk: 'destructive' },
    ]);
    expect(installAccessOptions(installGrantableOps(manifest, risk))).toContain('all');
  });

  it('without a resolved preview every recipe is read, as before', () => {
    for (const preview of [undefined, { resolved: false, will_enable: [] }]) {
      const risk = installRecipeRiskFromPreview(preview);
      expect(risk).toBeUndefined();
      expect(installGrantableOps(manifest, risk).map((op) => op.risk)).toEqual(['read', 'read']);
    }
  });
});
