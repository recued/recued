/** D-119 Phase 13 — Annotation + Link contract tests.
 *
 *  Covers the helpers exported from `annotation.ts`: policy enum,
 *  staleness stamping detection, staleness comparison, dedupe / role
 *  key formats, and the canonical-collection widening to include
 *  `'annotation'` + `'link'`. */

import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_POLICIES,
  DEFAULT_ANNOTATION_POLICY,
  MAX_ANNOTATION_VALUE_BYTES,
  ANNOTATION_INLINE_CUTOFF_BYTES,
  isStalenessStamped,
  isAnnotationStale,
  annotationDedupeKey,
  linkRoleKey,
  type Annotation,
  type Link,
  type AnnotationFilter,
  type LinkFilter,
} from '../annotation.js';
import {
  stampCanonicalFields,
  extractCanonicalRef,
  type CanonicalCollectionName,
} from '../canonical-record.js';

describe('annotation policy enum', () => {
  it('lists the two policy values in stable order', () => {
    expect(ANNOTATION_POLICIES).toEqual(['keep_stale', 'evict_on_stale']);
  });

  it('defaults to keep_stale (conservative — never auto-deletes)', () => {
    expect(DEFAULT_ANNOTATION_POLICY).toBe('keep_stale');
  });

  it('default is one of the listed policies', () => {
    expect(ANNOTATION_POLICIES).toContain(DEFAULT_ANNOTATION_POLICY);
  });
});

describe('value size limits', () => {
  it('caps annotation values at 10 MiB', () => {
    expect(MAX_ANNOTATION_VALUE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('inlines values up to 64 KiB', () => {
    expect(ANNOTATION_INLINE_CUTOFF_BYTES).toBe(64 * 1024);
  });

  it('inline cutoff is below the hard cap', () => {
    expect(ANNOTATION_INLINE_CUTOFF_BYTES).toBeLessThan(MAX_ANNOTATION_VALUE_BYTES);
  });
});

describe('isStalenessStamped', () => {
  it('returns true when both stamps are non-empty strings', () => {
    expect(isStalenessStamped({ source_record_hash: 'a', recipe_hash: 'b' })).toBe(true);
  });

  it('returns false when source_record_hash is empty', () => {
    expect(isStalenessStamped({ source_record_hash: '', recipe_hash: 'b' })).toBe(false);
  });

  it('returns false when recipe_hash is empty', () => {
    expect(isStalenessStamped({ source_record_hash: 'a', recipe_hash: '' })).toBe(false);
  });
});

describe('isAnnotationStale', () => {
  const baseStamps = {
    source_record_hash: 'src-1',
    recipe_hash: 'rec-1',
    model_used: 'gpt-4',
  };

  it('returns false when every stamp matches', () => {
    expect(isAnnotationStale(baseStamps, baseStamps)).toBe(false);
  });

  it('returns true when source_record_hash drifts', () => {
    expect(
      isAnnotationStale(baseStamps, { ...baseStamps, source_record_hash: 'src-2' }),
    ).toBe(true);
  });

  it('returns true when recipe_hash drifts', () => {
    expect(
      isAnnotationStale(baseStamps, { ...baseStamps, recipe_hash: 'rec-2' }),
    ).toBe(true);
  });

  it('returns true when model_used drifts (annotation has stamp)', () => {
    expect(
      isAnnotationStale(baseStamps, { ...baseStamps, model_used: 'claude-3' }),
    ).toBe(true);
  });

  it('ignores model_used drift when annotation has no model stamp', () => {
    // Transform-only annotations don't stamp model_used; rotating the
    // ambient model must not flip them stale.
    const transformOnly = { source_record_hash: 'src-1', recipe_hash: 'rec-1' };
    expect(
      isAnnotationStale(transformOnly, { ...baseStamps, model_used: 'claude-3' }),
    ).toBe(false);
  });
});

describe('annotationDedupeKey', () => {
  it('joins the (target_collection, target_id, key) triple with spaces', () => {
    expect(
      annotationDedupeKey({ target_collection: 'mail', target_id: 'msg-1', key: 'summary' }),
    ).toBe('mail msg-1 summary');
  });

  it('produces stable keys across calls', () => {
    const a = annotationDedupeKey({ target_collection: 'calendar', target_id: 'evt-1', key: 'tldr' });
    const b = annotationDedupeKey({ target_collection: 'calendar', target_id: 'evt-1', key: 'tldr' });
    expect(a).toBe(b);
  });

  it('distinguishes between collections and keys', () => {
    const a = annotationDedupeKey({ target_collection: 'mail', target_id: 'x', key: 'summary' });
    const b = annotationDedupeKey({ target_collection: 'mail', target_id: 'x', key: 'tldr' });
    const c = annotationDedupeKey({ target_collection: 'calendar', target_id: 'x', key: 'summary' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('linkRoleKey', () => {
  it('joins (side, collection, id, role) with spaces', () => {
    expect(linkRoleKey('from', 'mail', 'msg-1', 'attachment')).toBe(
      'from mail msg-1 attachment',
    );
  });

  it('distinguishes sides — outbound vs inbound queries are independent', () => {
    expect(linkRoleKey('from', 'mail', 'msg-1', 'reply-to')).not.toBe(
      linkRoleKey('to', 'mail', 'msg-1', 'reply-to'),
    );
  });
});

describe('canonical collection widening (annotation + link)', () => {
  it('annotations carry _collection: annotation', () => {
    const ann: Annotation = {
      _id: 'ann-1',
      _collection: 'annotation',
      target_collection: 'mail',
      target_id: 'msg-1',
      key: 'summary',
      value: 'Quarterly review',
      authored_by_recipe_id: 'r1',
      source_record_hash: 'src-1',
      recipe_hash: 'rec-1',
      authored_at: 1_700_000_000_000,
    };
    expect(ann._collection).toBe('annotation');
    expect(extractCanonicalRef(ann)).toEqual({ collection: 'annotation', id: 'ann-1' });
  });

  it('links carry _collection: link', () => {
    const link: Link = {
      _id: 'link-1',
      _collection: 'link',
      from_collection: 'mail',
      from_id: 'msg-1',
      to_collection: 'file',
      to_id: 'file-1',
      role: 'attachment',
      created_at: 1_700_000_000_000,
      authored_by_recipe_id: 'r1',
    };
    expect(link._collection).toBe('link');
    expect(extractCanonicalRef(link)).toEqual({ collection: 'link', id: 'link-1' });
  });

  it('stampCanonicalFields accepts annotation + link', () => {
    const a = stampCanonicalFields({ key: 'x' }, 'annotation', 'ann-1');
    expect(a._collection).toBe('annotation' satisfies CanonicalCollectionName);
    const l = stampCanonicalFields({ role: 'r' }, 'link', 'link-1');
    expect(l._collection).toBe('link' satisfies CanonicalCollectionName);
  });
});

describe('AnnotationFilter / LinkFilter shape contracts', () => {
  it('AnnotationFilter accepts every documented field', () => {
    const f: AnnotationFilter = {
      target_collection: 'mail',
      target_id: 'msg-1',
      key: 'summary',
      authored_by_recipe_id: 'r1',
      since: 1,
      until: 2,
      limit: 10,
    };
    // type-only assertion — runtime check just confirms shape compiles.
    expect(f.limit).toBe(10);
  });

  it('LinkFilter accepts every documented field', () => {
    const f: LinkFilter = {
      from_collection: 'mail',
      from_id: 'msg-1',
      to_collection: 'file',
      to_id: 'file-1',
      role: 'attachment',
      authored_by_recipe_id: 'r1',
      since: 1,
      until: 2,
      limit: 10,
    };
    expect(f.role).toBe('attachment');
  });

  it('all filter fields are individually optional', () => {
    const f1: AnnotationFilter = {};
    const f2: LinkFilter = {};
    expect(Object.keys(f1)).toHaveLength(0);
    expect(Object.keys(f2)).toHaveLength(0);
  });
});
