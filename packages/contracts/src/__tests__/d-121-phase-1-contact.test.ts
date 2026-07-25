/** D-121 Phase 1 — `data.contact` contracts tests.
 *
 *  Covers email canonicalization (case folding, plus-addressing
 *  preservation, angle-bracket stripping, malformed inputs), header
 *  splitting (quoted display names, comma inside quotes, angle-bracket
 *  containment), and address parsing across the four canonical RFC
 *  5322 shapes. Also pins the display schema entry + the
 *  CanonicalCollectionName widening so a future `contact` rename
 *  can't drift silently. */

import { describe, expect, it } from 'vitest';
import {
  canonicalizeEmail,
  parseAddress,
  splitAddressList,
  fallbackDisplayName,
  CONTACT_MATERIALIZE_BATCH_SIZE,
} from '../contact.js';
import { COLLECTION_DISPLAY_SCHEMAS, isCanonicalCollection } from '../collection-display.js';

describe('canonicalizeEmail', () => {
  it('lowercases both local-part and domain', () => {
    expect(canonicalizeEmail('Bob@X.COM')).toBe('bob@x.com');
    expect(canonicalizeEmail('BOB.SMITH@Example.Org')).toBe('bob.smith@example.org');
  });

  it('strips surrounding angle brackets', () => {
    expect(canonicalizeEmail('<bob@x.com>')).toBe('bob@x.com');
    expect(canonicalizeEmail('  <Bob@X.com>  ')).toBe('bob@x.com');
  });

  it('preserves plus-addressing as a distinct identity', () => {
    // `bob@x.com` and `bob+ml@x.com` are two contacts — users treat
    // aliases as separate identities for filtering / labelling.
    expect(canonicalizeEmail('bob+ml@x.com')).toBe('bob+ml@x.com');
    expect(canonicalizeEmail('bob+ml@x.com')).not.toBe(canonicalizeEmail('bob@x.com'));
  });

  it('returns empty string for non-email input', () => {
    expect(canonicalizeEmail('')).toBe('');
    expect(canonicalizeEmail('   ')).toBe('');
    expect(canonicalizeEmail('not-an-email')).toBe('');
    expect(canonicalizeEmail('@x.com')).toBe('');
    expect(canonicalizeEmail('bob@')).toBe('');
    expect(canonicalizeEmail('bob@@x.com')).toBe('');
  });

  it('handles unusual whitespace gracefully', () => {
    expect(canonicalizeEmail('   bob@x.com   ')).toBe('bob@x.com');
  });

  it('returns empty string for non-string input', () => {
    // Defensive guard for adapter-side junk; we never want a thrown
    // error to break a mail ingest just because one row had a null
    // From header.
    expect(canonicalizeEmail(null as unknown as string)).toBe('');
    expect(canonicalizeEmail(undefined as unknown as string)).toBe('');
    expect(canonicalizeEmail(42 as unknown as string)).toBe('');
  });
});

describe('parseAddress', () => {
  it('parses bare addresses', () => {
    expect(parseAddress('bob@x.com')).toEqual({ email: 'bob@x.com' });
  });

  it('parses display-name + angle-bracket format', () => {
    expect(parseAddress('Bob Smith <bob@x.com>')).toEqual({
      email: 'bob@x.com',
      name: 'Bob Smith',
    });
  });

  it('strips quotes from display names', () => {
    expect(parseAddress('"Smith, Bob" <bob@x.com>')).toEqual({
      email: 'bob@x.com',
      name: 'Smith, Bob',
    });
  });

  it('parses parenthesized comments as display names', () => {
    expect(parseAddress('bob@x.com (Bob Smith)')).toEqual({
      email: 'bob@x.com',
      name: 'Bob Smith',
    });
  });

  it('returns null for input without an @-sign', () => {
    expect(parseAddress('Just a name')).toBeNull();
    expect(parseAddress('')).toBeNull();
  });

  it('canonicalizes the address even when display name preserves case', () => {
    // Display name preserves case; email canonicalizes to lowercase.
    expect(parseAddress('Bob SMITH <Bob@X.COM>')).toEqual({
      email: 'bob@x.com',
      name: 'Bob SMITH',
    });
  });
});

describe('splitAddressList', () => {
  it('splits on commas outside quoted strings', () => {
    expect(splitAddressList('a@b.com, c@d.com')).toEqual([
      'a@b.com',
      'c@d.com',
    ]);
  });

  it('preserves commas inside quoted display names', () => {
    expect(
      splitAddressList('"Last, First" <a@b.com>, c@d.com'),
    ).toEqual(['"Last, First" <a@b.com>', 'c@d.com']);
  });

  it('preserves commas inside angle-bracket fragments', () => {
    // No legitimate ',' inside <…>, but defend against malformed input
    // that has them — splitter should keep them grouped, not produce
    // empty entries.
    expect(splitAddressList('Bob <a,b@x.com>, c@d.com')).toEqual([
      'Bob <a,b@x.com>',
      'c@d.com',
    ]);
  });

  it('returns empty array for empty / whitespace input', () => {
    expect(splitAddressList('')).toEqual([]);
    expect(splitAddressList('   ')).toEqual([]);
  });

  it('drops empty entries from leading or trailing commas', () => {
    expect(splitAddressList(', a@b.com, , c@d.com,')).toEqual([
      'a@b.com',
      'c@d.com',
    ]);
  });
});

describe('fallbackDisplayName', () => {
  it('returns the local-part of an email', () => {
    expect(fallbackDisplayName('bob@x.com')).toBe('bob');
    expect(fallbackDisplayName('bob.smith@example.org')).toBe('bob.smith');
  });

  it('returns the input unchanged when no @ is present', () => {
    expect(fallbackDisplayName('not-an-email')).toBe('not-an-email');
  });
});

describe('CONTACT_MATERIALIZE_BATCH_SIZE', () => {
  it('is a positive integer suitable for backfill batching', () => {
    expect(Number.isInteger(CONTACT_MATERIALIZE_BATCH_SIZE)).toBe(true);
    expect(CONTACT_MATERIALIZE_BATCH_SIZE).toBeGreaterThan(0);
  });
});

describe('CanonicalCollectionName widening', () => {
  it('recognizes "contact" as a canonical collection', () => {
    expect(isCanonicalCollection('contact')).toBe(true);
  });

  it('exposes a display schema for contact', () => {
    const schema = COLLECTION_DISPLAY_SCHEMAS.contact;
    expect(schema).toBeDefined();
    expect(schema.primary_field).toBe('name');
    expect(schema.summary_fields).toContain('email');
    expect(schema.summary_fields).toContain('last_interaction');
  });
});
