import { describe, expect, it } from 'vitest';

import {
  BULK_PACK_INSTALL_PERMISSION,
  PACK_PAID_WORKFLOW_LIFECYCLE_ROLES,
  parseBulkPackManifest,
} from '../bulk-pack.js';

const lifecycle = {
  prepare_checkout_recipe: 'prepare-checkout',
  verify_payment_recipe: 'verify-payment',
  fulfill_recipe: 'fulfill-outcome',
  review_recipe: 'review-outcome',
  deliver_recipe: 'deliver-outcome',
  reconcile_recipe: 'reconcile-outcome',
};

const manifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  manifest_version: 2,
  slug: 'paid-workflow-pack',
  publisher: 'recued-core',
  name: 'Paid workflow pack',
  description: 'One governed transactional outcome.',
  version: 1,
  requires: [BULK_PACK_INSTALL_PERMISSION],
  tags: ['workflow'],
  pack_kind: 'app_pack',
  service_kind: 'workflow',
  contents: Object.values(lifecycle).map((slug) => ({
    type: 'recipe',
    slug,
    version: 1,
    visible: true,
  })),
  transactional_offer: {
    kind: 'paid_workflow',
    outcome_label: 'One reviewed outcome',
    lifecycle,
  },
  ...overrides,
});

const errorCodes = (input: unknown): string[] =>
  parseBulkPackManifest(input).issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.code);

describe('D-200 Slice 6 paid-workflow offer descriptor', () => {
  it('preserves one closed descriptor whose six roles resolve inside the workflow pack', () => {
    const parsed = parseBulkPackManifest(manifest());

    expect(parsed.ok, JSON.stringify(parsed.issues)).toBe(true);
    if (!parsed.ok) return;
    expect(PACK_PAID_WORKFLOW_LIFECYCLE_ROLES).toHaveLength(6);
    expect(parsed.manifest.transactional_offer).toEqual({
      kind: 'paid_workflow',
      outcome_label: 'One reviewed outcome',
      lifecycle,
    });
  });

  it.each([
    ['v1 manifest', { manifest_version: 1, recipes: Object.values(lifecycle).map((slug) => ({ slug, version: 1 })), contents: undefined }],
    ['non-app pack', { pack_kind: 'recipe_pack' }],
    ['non-workflow service', { service_kind: 'tool_function' }],
  ])('rejects a transactional offer on a %s', (_label, overrides) => {
    expect(errorCodes(manifest(overrides))).toContain(
      'pack_transactional_offer_pack_shape',
    );
  });

  it('rejects price/authority fields instead of becoming a generic recipe pricing toggle', () => {
    expect(errorCodes(manifest({
      transactional_offer: {
        kind: 'paid_workflow',
        outcome_label: 'One reviewed outcome',
        lifecycle,
        price_minor: 5_000,
        currency: 'usd',
      },
    }))).toContain('pack_transactional_offer_unknown_field');
  });

  it('rejects missing, unknown, undeclared, and duplicate lifecycle roles', () => {
    expect(errorCodes(manifest({
      transactional_offer: {
        kind: 'paid_workflow',
        outcome_label: 'One reviewed outcome',
        lifecycle: {
          ...lifecycle,
          reconcile_recipe: undefined,
          refund_recipe: 'refund-outcome',
        },
      },
    }))).toEqual(expect.arrayContaining([
      'pack_transactional_offer_lifecycle_unknown_role',
      'pack_transactional_offer_lifecycle_role',
    ]));

    expect(errorCodes(manifest({
      transactional_offer: {
        kind: 'paid_workflow',
        outcome_label: 'One reviewed outcome',
        lifecycle: { ...lifecycle, reconcile_recipe: 'not-in-pack' },
      },
    }))).toContain('pack_transactional_offer_lifecycle_ref');

    expect(errorCodes(manifest({
      transactional_offer: {
        kind: 'paid_workflow',
        outcome_label: 'One reviewed outcome',
        lifecycle: { ...lifecycle, reconcile_recipe: lifecycle.deliver_recipe },
      },
    }))).toContain('pack_transactional_offer_lifecycle_duplicate');
  });

  it('rejects malformed or unbounded presentation copy without throwing', () => {
    expect(() => parseBulkPackManifest(manifest({ transactional_offer: [] })))
      .not.toThrow();
    expect(errorCodes(manifest({ transactional_offer: [] }))).toContain(
      'pack_transactional_offer_shape',
    );
    expect(errorCodes(manifest({
      transactional_offer: {
        kind: 'paid_workflow',
        outcome_label: ` ${'x'.repeat(121)}`,
        lifecycle,
      },
    }))).toContain('pack_transactional_offer_outcome_label');
    expect(errorCodes(manifest({
      transactional_offer: {
        kind: 'paid_workflow',
        outcome_label: 'One\u2028reviewed outcome',
        lifecycle,
      },
    }))).toContain('pack_transactional_offer_outcome_label');
  });
});
