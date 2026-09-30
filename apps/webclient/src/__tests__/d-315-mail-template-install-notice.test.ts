/** D-315 §5.2 — a recipe installed on its own from Discover has no dialog to
 *  ask first, so the install says what it did with the template it brings. */

import { describe, expect, it } from 'vitest';

import type { MailTemplateInstallOutcome } from '@recued/contracts';

import { mailTemplateInstallNotice } from '../discover/recipe-discovery.js';

const outcome = (over: Partial<MailTemplateInstallOutcome> = {}): MailTemplateInstallOutcome => ({
  recipe_id: 'shop-parcels',
  variable: 'template',
  template_id: 'mtpl_1',
  name: 'Shop parcels',
  action: 'created',
  active: true,
  ...over,
});

describe('what a standalone install says about its template', () => {
  it('says it added the template, with its AI off', () => {
    expect(mailTemplateInstallNotice([outcome()])).toBe('Added the mail template “Shop parcels”; its AI is off.');
  });

  it('⛔ says which of the owner’s templates it switched off, and where to switch it back', () => {
    expect(mailTemplateInstallNotice([outcome({ switched_off: { template_id: 'mtpl_0', name: 'My shop' } })])).toBe(
      'Added the mail template “Shop parcels”. Your “My shop” read the same mail, and is off now: switch it back in Data → Mail facts → Templates.',
    );
  });

  it('says so when it kept the owner’s on instead', () => {
    expect(mailTemplateInstallNotice([outcome({ active: false, uses: { template_id: 'mtpl_0', name: 'My shop' } })])).toBe(
      'Added the mail template “Shop parcels”, off: your “My shop” already reads that mail, and the Recipe uses it.',
    );
  });

  it('says nothing for a recipe that brings none, or an update that changed nothing', () => {
    expect(mailTemplateInstallNotice(undefined)).toBeUndefined();
    expect(mailTemplateInstallNotice([outcome({ action: 'unchanged' })])).toBeUndefined();
  });
});
