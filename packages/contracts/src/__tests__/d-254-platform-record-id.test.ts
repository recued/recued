/** D-254 slice 1 — `parsePlatformRecordTargetId`, the inverse the composer
 *  shipped without.
 *
 *  The cases that matter are the REFUSALS, not the round trip. A parser that
 *  guesses routes a write to the wrong account while looking correct, so every
 *  shape that carries no routing has to come back null:
 *    - a bare native id (what every vendor wrapper passes today)
 *    - an email (the local contact graph's key — D-254 cell A)
 *    - an unregistered `<vendor>_<entity>_` pair
 *    - a string two registry entries could both claim
 */

import { describe, expect, it } from 'vitest';

import {
  composePlatformRecordTargetId,
  CONNECTION_VENDOR_ENTITIES,
} from '../index.js';
import {
  CONNECTION_NAME_REGEX,
  isPlatformRecordTargetId,
  parsePlatformRecordTargetId,
  PlatformRecordIdError,
  routePlatformRecordOperationArgs,
  stampPlatformRecordIds,
} from '../platform-record-id.js';
import type { ConnectionVendorEntity } from '../connection-vendors.js';

const entry = (vendor: string, entity: string): ConnectionVendorEntity =>
  ({ vendor, entity } as unknown as ConnectionVendorEntity);

describe('parsePlatformRecordTargetId — round trip', () => {
  it.each([
    ['hubspot', 'deal', 'acme-corp', '47291'],
    ['hubspot', 'contact', 'acme-corp', '88'],
    ['hubspot', 'company', 'c1', '12'],
    ['salesforce', 'opportunity', 'sf1', '0061t00000abcDEF'],
    ['salesforce', 'contact', 'sf-prod', '0031t00000xyz'],
    ['pipedrive', 'person', 'pd1', '9'],
  ])('recovers %s/%s/%s/%s', (vendor, entity, connection, native) => {
    const id = composePlatformRecordTargetId(vendor, entity, connection, native);
    expect(parsePlatformRecordTargetId(id)).toEqual({
      vendor,
      entity,
      connection_name: connection,
      native_id: native,
    });
  });

  it('keeps a native id that itself contains underscores', () => {
    // The connection charset has no `_`, so the FIRST underscore after the
    // `<vendor>_<entity>_` prefix ends the connection and everything after it
    // belongs to the vendor — including its own separators.
    const id = composePlatformRecordTargetId('hubspot', 'deal', 'acme-corp', 'a_b_c_9');
    expect(parsePlatformRecordTargetId(id)).toEqual({
      vendor: 'hubspot',
      entity: 'deal',
      connection_name: 'acme-corp',
      native_id: 'a_b_c_9',
    });
  });

  it('round-trips every shipped registry entry', () => {
    for (const e of CONNECTION_VENDOR_ENTITIES) {
      const id = composePlatformRecordTargetId(e.vendor, e.entity, 'conn-1', 'nat-1');
      expect(parsePlatformRecordTargetId(id)).toEqual({
        vendor: e.vendor,
        entity: e.entity,
        connection_name: 'conn-1',
        native_id: 'nat-1',
      });
    }
  });
});

describe('parsePlatformRecordTargetId — refusals', () => {
  it('refuses a bare native id', () => {
    // What `recued-core.hubspot.contact.update { contact_id }` passes today.
    expect(parsePlatformRecordTargetId('47291')).toBeNull();
  });

  it('refuses an email — D-254 cell A', () => {
    // The local contact graph keys on the canonical email. Falling through to
    // "unparseable ⇒ treat as native" would send `PATCH /contacts/alice@x.com`.
    expect(parsePlatformRecordTargetId('alice@example.com')).toBeNull();
    expect(parsePlatformRecordTargetId('alice+tag@example.co.uk')).toBeNull();
  });

  it('refuses an unregistered vendor/entity pair', () => {
    expect(parsePlatformRecordTargetId('notavendor_deal_c1_9')).toBeNull();
    expect(parsePlatformRecordTargetId('hubspot_notanentity_c1_9')).toBeNull();
  });

  it('refuses an empty connection or native segment', () => {
    expect(parsePlatformRecordTargetId('hubspot_deal__9')).toBeNull();
    expect(parsePlatformRecordTargetId('hubspot_deal_c1_')).toBeNull();
    expect(parsePlatformRecordTargetId('hubspot_deal_c1')).toBeNull();
    expect(parsePlatformRecordTargetId('hubspot_deal_')).toBeNull();
  });

  it('refuses a connection segment outside the PK charset', () => {
    expect(parsePlatformRecordTargetId('hubspot_deal_Acme_9')).toBeNull();
    expect(parsePlatformRecordTargetId('hubspot_deal_-acme_9')).toBeNull();
    expect(parsePlatformRecordTargetId(`hubspot_deal_${'a'.repeat(49)}_9`)).toBeNull();
  });

  it('refuses a non-string or empty input', () => {
    expect(parsePlatformRecordTargetId(undefined)).toBeNull();
    expect(parsePlatformRecordTargetId(null)).toBeNull();
    expect(parsePlatformRecordTargetId(42)).toBeNull();
    expect(parsePlatformRecordTargetId('')).toBeNull();
  });
});

describe('parsePlatformRecordTargetId — ambiguity is refused, never resolved', () => {
  it('returns null when two registry entries both yield a complete parse', () => {
    // `a_b_c_conn_9` parses as (a,b)+conn=`c`+native=`conn_9` AND as
    // (a_b,c)+conn=`conn`+native=`9`. Preferring either would route a write to
    // the wrong vendor the day such a pair is registered.
    const ambiguous = [entry('a', 'b'), entry('a_b', 'c')];
    expect(parsePlatformRecordTargetId('a_b_c_conn_9', ambiguous)).toBeNull();
  });

  it('still parses when only one of several entries matches', () => {
    const registry = [entry('a', 'b'), entry('zz', 'yy')];
    expect(parsePlatformRecordTargetId('a_b_c1_9', registry)).toEqual({
      vendor: 'a',
      entity: 'b',
      connection_name: 'c1',
      native_id: '9',
    });
  });

  it('⛔ the SHIPPED registry holds no prefix-shadowing pair', () => {
    // The exact condition under which no string can match two entries: no
    // entry's `<vendor>_<entity>_` prefix is a prefix of another's. Asserted
    // here so adding one is a red test rather than a silent routing change.
    const prefixes = CONNECTION_VENDOR_ENTITIES.map((e) => `${e.vendor}_${e.entity}_`);
    const shadowed = prefixes.flatMap((a, i) =>
      prefixes
        .filter((b, j) => i !== j && b.startsWith(a))
        .map((b) => `${a} shadows ${b}`),
    );
    expect(shadowed).toEqual([]);
  });
});

describe('CONNECTION_NAME_REGEX + isPlatformRecordTargetId', () => {
  it('matches the composer doc-comment charset', () => {
    expect(CONNECTION_NAME_REGEX.test('acme-corp')).toBe(true);
    expect(CONNECTION_NAME_REGEX.test('a')).toBe(true);
    expect(CONNECTION_NAME_REGEX.test('9lives')).toBe(true);
    expect(CONNECTION_NAME_REGEX.test('acme_corp')).toBe(false);
    expect(CONNECTION_NAME_REGEX.test('acme.corp')).toBe(false);
    expect(CONNECTION_NAME_REGEX.test('-acme')).toBe(false);
    expect(CONNECTION_NAME_REGEX.test('')).toBe(false);
  });

  it('agrees with the parser', () => {
    const id = composePlatformRecordTargetId('hubspot', 'deal', 'acme-corp', '9');
    expect(isPlatformRecordTargetId(id)).toBe(true);
    expect(isPlatformRecordTargetId('9')).toBe(false);
    expect(isPlatformRecordTargetId('alice@example.com')).toBe(false);
  });
});

describe('routePlatformRecordOperationArgs', () => {
  const id_arg = 'contact_id';
  const composed = (conn: string, native: string, entity = 'contact'): string =>
    composePlatformRecordTargetId('hubspot', entity, conn, native);

  it('unwraps to the vendor-native id when connection and entity agree', () => {
    const out = routePlatformRecordOperationArgs({
      id_arg,
      operation: 'contact.update',
      connection_name: 'acme-corp',
      args: { contact_id: composed('acme-corp', '88'), 'body.properties': { jobtitle: 'CTO' } },
    });
    // The provider receives ITS OWN id; every other arg is untouched.
    expect(out.args).toEqual({ contact_id: '88', 'body.properties': { jobtitle: 'CTO' } });
    expect(out.routed).toEqual({
      vendor: 'hubspot',
      entity: 'contact',
      connection_name: 'acme-corp',
      native_id: '88',
      id_arg: 'contact_id',
    });
  });

  it('passes a bare native id through untouched — every shipped recipe does this', () => {
    const args = { contact_id: '88', 'body.properties': { jobtitle: 'CTO' } };
    const out = routePlatformRecordOperationArgs({
      id_arg, operation: 'contact.update', connection_name: 'acme-corp', args,
    });
    expect(out.args).toEqual(args);
    expect(out.routed).toBeUndefined();
  });

  it('passes through when the op declares no record target', () => {
    const args = { contact_id: composed('acme-corp', '88') };
    const out = routePlatformRecordOperationArgs({
      id_arg: undefined, operation: 'contact.update', connection_name: 'acme-corp', args,
    });
    expect(out.args).toEqual(args);
  });

  it('⛔ refuses a foreign connection — D-254 cell B, and names the retry target', () => {
    let err: unknown;
    try {
      routePlatformRecordOperationArgs({
        id_arg,
        operation: 'contact.update',
        connection_name: 'acme-corp',
        args: { contact_id: composed('other-crm', '2364') },
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PlatformRecordIdError);
    const e = err as InstanceType<typeof PlatformRecordIdError>;
    expect(e.code).toBe('PLATFORM_ID_SOURCE_MISMATCH');
    expect(e.expected_source).toBe('acme-corp');
    expect(e.actual_source).toBe('other-crm');
    // The message must say nothing happened, or a model retries a write twice.
    expect(e.message).toContain('No provider call was made');
    expect(e.message).toContain('other-crm');
  });

  it('⛔ refuses a routable id with no connection named', () => {
    expect(() => routePlatformRecordOperationArgs({
      id_arg,
      operation: 'contact.update',
      connection_name: '',
      args: { contact_id: composed('acme-corp', '88') },
    })).toThrow(/PLATFORM_ID_CONNECTION_REQUIRED/);
  });

  it('does not mutate the caller args object', () => {
    const args = { contact_id: composed('acme-corp', '88') };
    routePlatformRecordOperationArgs({
      id_arg, operation: 'contact.update', connection_name: 'acme-corp', args,
    });
    expect(args.contact_id).toBe(composed('acme-corp', '88'));
  });
});

describe('stampPlatformRecordIds — composing on the way out', () => {
  const args = { vendor: 'hubspot', entity: 'contact', connection_name: 'acme-corp' };

  it('adds target_id to a single record, leaving the vendor id untouched', () => {
    const out = stampPlatformRecordIds({
      ...args,
      result: { id: '88', properties: { firstname: 'Sandra' } },
    }) as Record<string, unknown>;
    // ⛔ D-190 C2 — `id` is a vendor-shaped selector and must survive verbatim.
    expect(out.id).toBe('88');
    expect(out.properties).toEqual({ firstname: 'Sandra' });
    expect(out.target_id).toBe('hubspot_contact_acme-corp_88');
  });

  it('stamps every row under the declared result_path', () => {
    const out = stampPlatformRecordIds({
      ...args,
      records_path: ['result', 'results'],
      result: { result: { results: [{ id: '1' }, { id: '2' }], total: 2 } },
    }) as { result: { results: Record<string, unknown>[]; total: number } };
    expect(out.result.results.map((r) => r.target_id)).toEqual([
      'hubspot_contact_acme-corp_1',
      'hubspot_contact_acme-corp_2',
    ]);
    expect(out.result.total).toBe(2);
  });

  it('falls through to the vendor body when the collection path does not apply', () => {
    // The surface declares ONE result_path for the whole catalog, so a targeted
    // `contact.read` carries no `results` key. Half the ops take this branch, and
    // the record is at the path's FIRST segment — the executor envelope.
    const out = stampPlatformRecordIds({
      ...args, records_path: ['result', 'results'], result: { result: { id: '88' } },
    }) as { result: Record<string, unknown> };
    expect(out.result.target_id).toBe('hubspot_contact_acme-corp_88');
    expect(out.result.id).toBe('88');
  });

  it('stringifies a numeric vendor id without coercing the field', () => {
    const out = stampPlatformRecordIds({
      vendor: 'pipedrive', entity: 'person', connection_name: 'pd1', result: { id: 42 },
    }) as Record<string, unknown>;
    expect(out.id).toBe(42); // still a number — D-190 C2's accepted divergence
    expect(out.target_id).toBe('pipedrive_person_pd1_42');
  });

  it('⛔ never overwrites a target_id the vendor already carries', () => {
    const out = stampPlatformRecordIds({
      ...args, result: { id: '88', target_id: 'vendor-owned' },
    }) as Record<string, unknown>;
    expect(out.target_id).toBe('vendor-owned');
  });

  it('⛔ does nothing it cannot establish, rather than guessing', () => {
    const r = { id: '88' };
    // unregistered pair → an id that could never parse back
    expect(stampPlatformRecordIds({ ...args, entity: 'ticket', result: r })).toBe(r);
    expect(stampPlatformRecordIds({ ...args, vendor: 'notavendor', result: r })).toBe(r);
    // no vendor / no connection
    expect(stampPlatformRecordIds({ ...args, vendor: undefined, result: r })).toBe(r);
    expect(stampPlatformRecordIds({ ...args, connection_name: '', result: r })).toBe(r);
    // no scalar selector to compose from
    expect(stampPlatformRecordIds({ ...args, result: { properties: {} } }))
      .toEqual({ properties: {} });
    expect(stampPlatformRecordIds({ ...args, result: null })).toBeNull();
  });

  it('🔑 ROUND TRIP: what compose emits, the router accepts and unwraps', () => {
    // The property the whole slice exists for. Compose at the read door, hand the
    // id to the write door, get the vendor's own id back — and a DIFFERENT
    // connection is refused rather than silently writing the wrong account.
    const read = stampPlatformRecordIds({
      ...args, result: { id: '88' },
    }) as Record<string, unknown>;

    const routed = routePlatformRecordOperationArgs({
      id_arg: 'contact_id',
      operation: 'contact.update',
      connection_name: 'acme-corp',
      args: { contact_id: read.target_id },
    });
    expect(routed.args.contact_id).toBe('88');

    expect(() => routePlatformRecordOperationArgs({
      id_arg: 'contact_id',
      operation: 'contact.update',
      connection_name: 'other-crm',
      args: { contact_id: read.target_id },
    })).toThrow(/PLATFORM_ID_SOURCE_MISMATCH/);
  });
});
