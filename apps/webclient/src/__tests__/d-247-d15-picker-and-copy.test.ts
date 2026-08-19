/** D-247 D15.1 (the picker's tier) + D10 (the consent copy).
 *
 *  ⛔⛔ THE DEFECT D15.1 CLOSES EXISTS TODAY, INDEPENDENT OF D-247. The picker
 *  scored EVERY recipe tool at `read`, whatever its ops do — so a pack shipping a
 *  `chat_exposed` destructive open adapter would be offered under "Read only".
 *  ⚠ The hazard is PROSPECTIVE: all 36 open adapters in the shipped corpus are
 *  `chat_exposed: false`, so the seed lands them closed regardless. That is why
 *  this is a picker fix and not an incident. */

import { describe, expect, it } from 'vitest';

import { installGrantModelFromManifest } from '../settings/install-grant-picker.js';
import { recipeConsentLine } from '../settings/packs-install-dialog.js';

const manifest = {
  pack_slug: 'fleet-money', publisher: 'recued-core', version: 1,
  name: 'Fleet', description: 'd',
  recipes: [{ slug: 'refund-payment-square', version: 1 }],
} as never;

describe('D-247 D15.1 — a recipe is scored on what it can REACH', () => {
  it('without the preview it stays read-tier — the pre-D-247 behaviour', () => {
    const model = installGrantModelFromManifest(manifest);
    expect(model!.accessOptions).toEqual(['read']);
    expect(model!.grantsByAccess.read).toEqual(['recued-core/refund-payment-square']);
  });

  it('⛔ with the preview a DESTRUCTIVE recipe is offered at "All", not "Read"', () => {
    const model = installGrantModelFromManifest(
      manifest,
      new Map([['refund-payment-square', 'destructive' as const]]),
    );
    // The owner answering "Read only" must no longer be handed this.
    expect(model!.grantsByAccess.read).toEqual([]);
    expect(model!.grantsByAccess.all).toEqual(['recued-core/refund-payment-square']);
    expect(model!.accessOptions).toContain('all');
    // …and Read is still the pre-selected default, so the safe answer is one click.
    expect(model!.defaultAccess).toBe('read');
  });

  it('a WRITE recipe lands under +Write', () => {
    const model = installGrantModelFromManifest(
      manifest,
      new Map([['refund-payment-square', 'write' as const]]),
    );
    expect(model!.grantsByAccess.write).toEqual(['recued-core/refund-payment-square']);
    expect(model!.grantsByAccess.read).toEqual([]);
  });
});

describe('D-247 D10 — the consent copy', () => {
  const base = {
    publisher_id: 'recued-core', recipe_id: 'r', name: 'Refund Square payment',
    operation_ids: ['refund_payment'],
  };

  it('names the VERB before the tier, so an admin READ stops sounding like a write', () => {
    // `key-identity-brief-honeycomb` wraps `auth.read` at admin tier and is a
    // read-only brief: "grants auth.read (admin)" is TRUE and reads far scarier
    // than the act.
    const line = recipeConsentLine({
      ...base, name: 'Key identity brief', grant_class: 'read_adapter',
      top_risk: 'admin', operation_ids: ['auth.read'],
    } as never);
    expect(line).toContain('administer via');
    expect(line).toContain('(admin)');
  });

  it('an open adapter says the call STILL ASKS — the grant is ACCESS, not approval', () => {
    // Without the trailing clause, "grants destructive" is read as consent to the
    // act by exactly the owner this copy exists for.
    const line = recipeConsentLine({
      ...base, grant_class: 'open_adapter', top_risk: 'destructive',
    } as never);
    expect(line).toContain('with no added constraint');
    expect(line).toContain('each call still asks');
  });

  it('a constraining recipe is described as narrower, not as its raw op', () => {
    const line = recipeConsentLine({
      ...base, grant_class: 'constraining', top_risk: 'write',
    } as never);
    expect(line).toContain('narrower capability');
    expect(line).not.toContain('no added constraint');
  });

  it('an underivable closure says so rather than guessing', () => {
    const line = recipeConsentLine({ ...base, grant_class: 'unknown', top_risk: null } as never);
    expect(line).toContain('could not be determined');
  });
});
