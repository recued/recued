/** D-165 P3.path-picker Slice 1 — sub-resource path contracts. */

import { describe, expect, it } from 'vitest';
import {
  SUBRESOURCE_PATH_MAX_LEN,
  canonicalizeSubresourcePath,
  connectionViewFromRow,
  type ConnectionRow,
} from '../index.js';

const makeRow = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  pk: 'api:hubspot',
  kind: 'api',
  name: 'hubspot',
  display_name: 'HubSpot Production',
  config_json: JSON.stringify({ base_url: 'https://api.hubapi.com' }),
  auth_ciphertext: 'ROW-AUTH-CIPHERTEXT-DO-NOT-LEAK',
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  ...overrides,
});

describe('canonicalizeSubresourcePath', () => {
  it.each([
    ['undefined', undefined, '/'],
    ['null', null, '/'],
    ['empty string', '', '/'],
    ['whitespace', '   ', '/'],
    ['root', '/', '/'],
    ['double slash root', '//', '/'],
    ['triple slash root', '///', '/'],
    ['already canonical path', '/photos', '/photos'],
    ['trailing slash', '/photos/', '/photos'],
    ['repeated internal slashes', '/photos//albums/', '/photos/albums'],
    ['bare path', 'photos', '/photos'],
    ['trimmed path', '  /photos  ', '/photos'],
    ['uppercase path', '/INBOX', '/INBOX'],
    ['mixed-case path', '/Photos/Albums', '/Photos/Albums'],
  ])('canonicalizes %s to %s', (_label, raw, expected) => {
    expect(canonicalizeSubresourcePath(raw)).toBe(expected);
  });

  it('is idempotent for representative inputs', () => {
    const inputs: Array<string | null | undefined> = [
      undefined,
      null,
      '',
      '   ',
      '/',
      '//',
      'photos',
      '/photos/',
      '/photos//albums/',
      '/INBOX',
      '/Photos/Albums',
    ];

    for (const input of inputs) {
      const once = canonicalizeSubresourcePath(input);
      expect(canonicalizeSubresourcePath(once)).toBe(once);
    }
  });
});

describe('connectionViewFromRow subresource_path projection', () => {
  it('surfaces a row-level subresource_path when present', () => {
    const view = connectionViewFromRow(makeRow({ subresource_path: '/photos' }));

    expect(view.subresource_path).toBe('/photos');
  });

  it('omits the subresource_path key when the row lacks it', () => {
    const view = connectionViewFromRow(makeRow());

    expect(Object.prototype.hasOwnProperty.call(view, 'subresource_path')).toBe(false);
  });

  it('does not let config_json subresource_path shadow the row-level value', () => {
    const view = connectionViewFromRow(makeRow({
      subresource_path: '/photos',
      config_json: JSON.stringify({
        subresource_path: '/evil',
        base_url: 'https://api.example.test',
      }),
    }));

    expect(view.subresource_path).toBe('/photos');
    expect(view.subresource_path).not.toBe('/evil');
    expect(view.base_url).toBe('https://api.example.test');
  });

  it('does not surface config_json subresource_path when the row field is absent', () => {
    const view = connectionViewFromRow(makeRow({
      config_json: JSON.stringify({
        subresource_path: '/evil',
        base_url: 'https://api.example.test',
      }),
    }));

    expect(Object.prototype.hasOwnProperty.call(view, 'subresource_path')).toBe(false);
    expect(view.subresource_path).not.toBe('/evil');
    expect(view.base_url).toBe('https://api.example.test');
  });

  it('never exposes auth or auth_ciphertext through the projected view', () => {
    const view = connectionViewFromRow(makeRow({
      config_json: JSON.stringify({
        auth: 'CONFIG-AUTH-DO-NOT-LEAK',
        auth_ciphertext: 'CONFIG-CIPHERTEXT-DO-NOT-LEAK',
        base_url: 'https://api.example.test',
      }),
    }));

    const flat = JSON.stringify(view);
    expect(flat.includes('ROW-AUTH-CIPHERTEXT-DO-NOT-LEAK')).toBe(false);
    expect(flat.includes('CONFIG-AUTH-DO-NOT-LEAK')).toBe(false);
    expect(flat.includes('CONFIG-CIPHERTEXT-DO-NOT-LEAK')).toBe(false);
    expect(flat.includes('auth')).toBe(false);
    expect(flat.includes('auth_ciphertext')).toBe(false);
  });
});

describe('SUBRESOURCE_PATH_MAX_LEN', () => {
  it('is exported as a positive numeric cap', () => {
    expect(typeof SUBRESOURCE_PATH_MAX_LEN).toBe('number');
    expect(SUBRESOURCE_PATH_MAX_LEN).toBeGreaterThan(0);
  });
});
