/** D-165 vendor OAuth-start slice 1 — cloud API redirect helpers. */

import { describe, expect, it } from 'vitest';

import {
  canonicalizeServerPublicUrl,
  OAUTH_CLOUD_CALLBACK_URL,
  vendorOAuthRedirectChoices,
} from '../index.js';

describe('D-165 vendor OAuth redirect helpers', () => {
  it.each([
    ['https://h.example.com', 'https://h.example.com'],
    ['https://h.example.com/', 'https://h.example.com'],
    ['https://h:8443', 'https://h:8443'],
    ['http://h', null],
    ['https://u:p@h', null],
    ['https://h/path', null],
    ['https://h/?q', null],
    ['https://h/#f', null],
    ['not a url', null],
    ['', null],
  ])('canonicalizeServerPublicUrl(%j) -> %j', (raw, expected) => {
    expect(canonicalizeServerPublicUrl(raw)).toBe(expected);
  });

  it('returns the cloud callback and direct server callback for a valid HTTPS origin', () => {
    expect(vendorOAuthRedirectChoices('https://h.example.com/')).toEqual([
      OAUTH_CLOUD_CALLBACK_URL,
      'https://h.example.com/oauth/complete',
    ]);
  });

  it.each([
    ['http://h'],
    ['https://h/path'],
    ['not a url'],
    [''],
  ])('returns no redirect choices for invalid server_url %j', (raw) => {
    expect(vendorOAuthRedirectChoices(raw)).toEqual([]);
  });
});
