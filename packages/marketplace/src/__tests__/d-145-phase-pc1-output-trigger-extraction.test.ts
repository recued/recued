/** D-145 PC1 — output-map trigger extraction and host-case ratchets.
 *
 *  Covers the PC1 wiring added after the original four-gate tests:
 *  `output[<url>] = 'trigger'` is now a source of truth for gates 2 + 4,
 *  and URL hosts are lowercased before blocklist / mixed-surface matching.
 */

import { describe, expect, it } from 'vitest';
import {
  extractIngredientTriggers,
  flagMixedSurfaceDomain,
  runFourGateValidation,
  validateUrlClassifier,
  type BridgeSurfaceValidationManifest,
} from '../validators/bridge-surface-kind.js';

const domManifest = (
  patch: Partial<BridgeSurfaceValidationManifest>,
): BridgeSurfaceValidationManifest => ({
  kind: 'dom',
  surface_kind: 'reading',
  ...patch,
});

describe('D-145 PC1 — extractIngredientTriggers source-of-truth additions', () => {
  it('returns only top-level trigger entries when no output map exists', () => {
    const manifest = domManifest({
      trigger: ['github.com/*', 'app.linear.app/*'],
    });

    expect(extractIngredientTriggers(manifest)).toEqual([
      'github.com/*',
      'app.linear.app/*',
    ]);
  });

  it('returns only output-map trigger keys when top-level trigger is absent', () => {
    const manifest = domManifest({
      output: {
        'github.com/*': 'trigger',
        '.repo-title': 'title',
        '.repo-description': 'description',
      },
    });

    expect(extractIngredientTriggers(manifest)).toEqual(['github.com/*']);
  });

  it('merges top-level and output-map triggers while preserving first-seen order', () => {
    const manifest = domManifest({
      trigger: ['github.com/*', 'app.linear.app/*'],
      output: {
        'substack.com/*': 'trigger',
      },
    });

    expect(extractIngredientTriggers(manifest)).toEqual([
      'github.com/*',
      'app.linear.app/*',
      'substack.com/*',
    ]);
  });

  it('dedupes duplicate triggers across both carriers', () => {
    const manifest = domManifest({
      trigger: ['github.com/*', 'github.com/*'],
      output: {
        'github.com/*': 'trigger',
        'app.linear.app/*': 'trigger',
      },
    });

    expect(extractIngredientTriggers(manifest)).toEqual([
      'github.com/*',
      'app.linear.app/*',
    ]);
  });

  it('returns an empty array when neither trigger carrier is present', () => {
    expect(extractIngredientTriggers(domManifest({}))).toEqual([]);
  });

  it("skips output entries whose value is not the literal string 'trigger'", () => {
    const manifest = domManifest({
      output: {
        'github.com/*': 'url',
        'app.linear.app/*': 'Trigger',
        'substack.com/*': 'trigger',
      },
    });

    expect(extractIngredientTriggers(manifest)).toEqual(['substack.com/*']);
  });

  it('skips non-string top-level trigger values', () => {
    const manifest = domManifest({
      trigger: ['github.com/*', 123, null, 'substack.com/*'] as unknown as string[],
    });

    expect(extractIngredientTriggers(manifest)).toEqual([
      'github.com/*',
      'substack.com/*',
    ]);
  });

  it('skips non-string output values', () => {
    const manifest = domManifest({
      output: {
        'github.com/*': 'trigger',
        'web.whatsapp.com/*': true,
        'facebook.com/*': null,
      } as unknown as Record<string, string>,
    });

    expect(extractIngredientTriggers(manifest)).toEqual(['github.com/*']);
  });
});

describe('D-145 PC1 — parsePattern host lowercasing', () => {
  it('rejects an uppercase-scheme uppercase-host WhatsApp trigger', () => {
    const result = validateUrlClassifier(
      domManifest({ trigger: ['HTTPS://WEB.WHATSAPP.COM/*'] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('surface_kind_messaging_rejected_by_url_classifier');
      expect(result.trigger).toBe('HTTPS://WEB.WHATSAPP.COM/*');
    }
  });

  it('rejects a bare case-varied WhatsApp host trigger', () => {
    const result = validateUrlClassifier(
      domManifest({ trigger: ['Web.WhatsApp.COM/*'] }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('surface_kind_messaging_rejected_by_url_classifier');
    }
  });

  it('flags a case-varied Facebook trigger as a mixed-surface domain', () => {
    const flag = flagMixedSurfaceDomain(
      domManifest({ trigger: ['Facebook.com/*'] }),
    );

    expect(flag.mixed_surface_review_required).toBe(true);
    expect(flag.matched_domains).toEqual(['facebook.com']);
  });
});

describe('D-145 PC1 — output-map triggers feed gate 2 URL classifier', () => {
  it('rejects an output-only blocked messaging URL trigger', () => {
    const result = validateUrlClassifier(
      domManifest({
        output: {
          'web.whatsapp.com/*': 'trigger',
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('surface_kind_messaging_rejected_by_url_classifier');
      expect(result.trigger).toBe('web.whatsapp.com/*');
    }
  });

  it('passes an output-only safe URL trigger', () => {
    const result = validateUrlClassifier(
      domManifest({
        output: {
          'github.com/*': 'trigger',
          '.commit-message': 'body',
        },
      }),
    );

    expect(result.ok).toBe(true);
  });

  it('rejects a blocked output trigger even when top-level triggers are safe', () => {
    const result = validateUrlClassifier(
      domManifest({
        trigger: ['github.com/*'],
        output: {
          'web.telegram.org/k/*': 'trigger',
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.trigger).toBe('web.telegram.org/k/*');
    }
  });

  it('ignores blocked-looking output keys when they are ordinary selectors', () => {
    const result = validateUrlClassifier(
      domManifest({
        trigger: ['github.com/*'],
        output: {
          'web.whatsapp.com/*': 'body',
        },
      }),
    );

    expect(result.ok).toBe(true);
  });
});

describe('D-145 PC1 — output-map triggers feed gate 4 mixed-surface flag', () => {
  it('flags an output-only facebook.com trigger for mixed-surface review', () => {
    const flag = flagMixedSurfaceDomain(
      domManifest({
        output: {
          'facebook.com/*': 'trigger',
        },
      }),
    );

    expect(flag.mixed_surface_review_required).toBe(true);
    expect(flag.matched_domains).toEqual(['facebook.com']);
  });

  it('dedupes matched domains across top-level and output-map triggers', () => {
    const flag = flagMixedSurfaceDomain(
      domManifest({
        trigger: ['Facebook.com/*', 'facebook.com/profile/*'],
        output: {
          'facebook.com/feed': 'trigger',
          'instagram.com/*': 'trigger',
        },
      }),
    );

    expect(flag.mixed_surface_review_required).toBe(true);
    expect(flag.matched_domains).toEqual(['facebook.com', 'instagram.com']);
  });

  it('does not flag a mixed-surface-looking output key unless it is a trigger', () => {
    const flag = flagMixedSurfaceDomain(
      domManifest({
        output: {
          'facebook.com/*': 'body',
          'github.com/*': 'trigger',
        },
      }),
    );

    expect(flag.mixed_surface_review_required).toBe(false);
    expect(flag.matched_domains).toEqual([]);
  });

  it('composite validation consumes output-only triggers for the URL gate', () => {
    const result = runFourGateValidation(
      domManifest({
        output: {
          'web.whatsapp.com/*': 'trigger',
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.gate_url_classifier.ok).toBe(false);
  });
});
