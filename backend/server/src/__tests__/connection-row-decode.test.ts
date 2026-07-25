/**
 * Unit coverage for decodeConnectionRow.
 *
 * Helper under test: backend/server/src/storage/connection-row-decode.ts
 */

import { describe, expect, it } from 'vitest';
import type { ConnectionRow } from '@recued/contracts';
import { decodeConnectionRow } from '../storage/connection-row-decode.js';

const makeRow = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  pk: 'api:hubspot-main',
  kind: 'api',
  subtype: 'hubspot',
  name: 'hubspot-main',
  display_name: 'HubSpot Main',
  publisher_id: 'publisher-hubspot',
  config_json: JSON.stringify({ base_url: 'https://api.hubapi.com' }),
  auth_ciphertext: JSON.stringify({
    type: 'oauth2_refresh',
    refresh_token: 'rt_123',
    access_token: 'at_456',
    expires_at: 1_700_000_500_000,
  }),
  enrolled_at: 1_700_000_000_000,
  updated_at: 1_700_000_100_000,
  last_used_at: 1_700_000_200_000,
  health_json: JSON.stringify({
    status: 'ok',
    last_probed_at: 1_700_000_300_000,
  }),
  ...overrides,
});

describe('decodeConnectionRow', () => {
  it('projects every populated field from a well-formed row', () => {
    const row = makeRow();
    const record = decodeConnectionRow(row);

    expect(record).toEqual({
      kind: 'api',
      subtype: 'hubspot',
      name: 'hubspot-main',
      display_name: 'HubSpot Main',
      publisher_id: 'publisher-hubspot',
      config: { base_url: 'https://api.hubapi.com' },
      auth: {
        type: 'oauth2_refresh',
        refresh_token: 'rt_123',
        access_token: 'at_456',
        expires_at: 1_700_000_500_000,
      },
      enrolled_at: 1_700_000_000_000,
      updated_at: 1_700_000_100_000,
      last_used_at: 1_700_000_200_000,
      health: { status: 'ok', last_probed_at: 1_700_000_300_000 },
    });
  });

  it('falls back to auth { type: "none" } when auth_ciphertext is opaque AEAD', () => {
    const row = makeRow({ auth_ciphertext: 'not-json-base64-aead-blob' });
    const record = decodeConnectionRow(row);

    expect(record).not.toBeNull();
    expect(record?.auth).toEqual({ type: 'none' });
    expect(record?.name).toBe('hubspot-main');
  });

  it('returns null when config_json is malformed', () => {
    const row = makeRow({ config_json: 'not-valid-json{' });

    expect(decodeConnectionRow(row)).toBeNull();
  });

  it('derives default health when health_json is absent', () => {
    const row = makeRow({
      health_json: undefined,
      updated_at: 1_700_000_111_000,
    });
    const record = decodeConnectionRow(row);

    expect(record?.health).toEqual({
      status: 'unknown',
      last_probed_at: 1_700_000_111_000,
    });
  });

  it('returns null when health_json is malformed (outer try/catch)', () => {
    const row = makeRow({ health_json: 'not-valid-json{' });

    expect(decodeConnectionRow(row)).toBeNull();
  });

  it('omits last_used_at when undefined on the row', () => {
    const row = makeRow({ last_used_at: undefined });
    const record = decodeConnectionRow(row);

    expect(record).not.toBeNull();
    expect(record).not.toHaveProperty('last_used_at');
  });

  it('omits last_used_at when null on the row', () => {
    const row = makeRow({ last_used_at: null as unknown as undefined });
    const record = decodeConnectionRow(row);

    expect(record).not.toBeNull();
    expect(record).not.toHaveProperty('last_used_at');
  });

  it('preserves undefined subtype + publisher_id on the projected record', () => {
    const row = makeRow({ subtype: undefined, publisher_id: undefined });
    const record = decodeConnectionRow(row);

    expect(record?.subtype).toBeUndefined();
    expect(record?.publisher_id).toBeUndefined();
  });

  it('parses oauth-refresh-shaped JSON auth ciphertext directly', () => {
    const row = makeRow({
      auth_ciphertext: JSON.stringify({ type: 'bearer', token: 'tk_789' }),
    });
    const record = decodeConnectionRow(row);

    expect(record?.auth).toEqual({ type: 'bearer', token: 'tk_789' });
  });
});
