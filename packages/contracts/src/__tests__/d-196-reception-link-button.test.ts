import { describe, expect, it } from 'vitest';
import {
  RECEPTION_LINK_BUTTON_DESCRIPTION_MAX,
  RECEPTION_LINK_BUTTON_LABEL_MAX,
  RECEPTION_LINK_BUTTON_URL_MAX,
  isReceptionLinkButtonUrl,
  validateReceptionLinkButton,
} from '../index.js';

describe('D-196 S3 Reception link_button contract', () => {
  it('accepts the closed label + HTTPS URL + optional description shape', () => {
    expect(validateReceptionLinkButton({
      label: 'Subscribe',
      url: 'https://buy.stripe.com/example',
      description: 'Choose a plan on the seller-hosted checkout page.',
    })).toEqual([]);
  });

  it.each([
    'http://example.com',
    '/reception/local',
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'not a url',
    'https:example.com',
    ' https://example.com',
    'https://example.com/with space',
  ])('rejects non-HTTPS navigation %s', (url) => {
    expect(isReceptionLinkButtonUrl(url)).toBe(false);
    expect(validateReceptionLinkButton({ label: 'Go', url }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: 'url_invalid' })]));
  });

  it('accepts the HTTPS scheme case-insensitively without widening its absolute shape', () => {
    expect(isReceptionLinkButtonUrl('HTTPS://example.com/path')).toBe(true);
  });

  it('rejects malformed, widened, and over-bound rows', () => {
    expect(validateReceptionLinkButton(null)).toEqual([
      expect.objectContaining({ code: 'shape_invalid' }),
    ]);
    expect(validateReceptionLinkButton({
      label: 'x'.repeat(RECEPTION_LINK_BUTTON_LABEL_MAX + 1),
      url: `https://example.com/${'x'.repeat(RECEPTION_LINK_BUTTON_URL_MAX)}`,
      description: 'x'.repeat(RECEPTION_LINK_BUTTON_DESCRIPTION_MAX + 1),
      form_action: 'post',
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unknown_key' }),
      expect.objectContaining({ code: 'label_too_long' }),
      expect.objectContaining({ code: 'url_too_long' }),
      expect.objectContaining({ code: 'description_too_long' }),
    ]));
  });
});
