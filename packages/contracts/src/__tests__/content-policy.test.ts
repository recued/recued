import { describe, it, expect } from 'vitest';
import {
  canonicalizePublisher,
  validatePublisherHandle,
  validateTextContent,
  validateTags,
  validateSlug,
  RECIPE_BUNDLE_SHARED_STATES,
  isRecipeBundleSharedRowKeySegment,
  recipeBundleSharedKey,
  recipeBundleSharedPrefix,
  sanitizeRecipeBundleKey,
  validateRecipeBundleKey,
  validateRecipeBundlePublisher,
  validateRecipeContent,
  validateIngredientContent,
  RESERVED_HANDLES,
} from '../content-policy.js';

const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code);

// ── Publisher handles ──

describe('validatePublisherHandle', () => {
  it('accepts valid handles (≥6 chars)', () => {
    expect(validatePublisherHandle('alice-123')).toEqual([]);
    expect(validatePublisherHandle('my-company')).toEqual([]);
    expect(validatePublisherHandle('devteam')).toEqual([]);
    expect(validatePublisherHandle('abcdef')).toEqual([]); // exactly 6
  });

  it('rejects empty handle', () => {
    expect(codes(validatePublisherHandle(''))).toContain('handle_empty');
  });

  it('rejects too short (<6 chars)', () => {
    expect(codes(validatePublisherHandle('ab'))).toContain('handle_too_short');
    expect(codes(validatePublisherHandle('dev42'))).toContain('handle_too_short'); // 5 chars
  });

  it('rejects too long', () => {
    expect(codes(validatePublisherHandle('a'.repeat(41)))).toContain('handle_too_long');
  });

  it('rejects bad format (uppercase)', () => {
    expect(codes(validatePublisherHandle('MyHandle'))).toContain('handle_format');
  });

  it('rejects bad format (starting with number)', () => {
    expect(codes(validatePublisherHandle('123abc'))).toContain('handle_format');
  });

  it('rejects bad format (trailing hyphen)', () => {
    expect(codes(validatePublisherHandle('my-handle-'))).toContain('handle_format');
  });

  it('rejects reserved: recued', () => {
    expect(codes(validatePublisherHandle('recued'))).toContain('handle_reserved');
  });

  it('rejects reserved: admin', () => {
    expect(codes(validatePublisherHandle('admin'))).toContain('handle_reserved');
  });

  it('rejects reserved: master', () => {
    expect(codes(validatePublisherHandle('master'))).toContain('handle_reserved');
  });

  it('rejects reserved: password', () => {
    expect(codes(validatePublisherHandle('password'))).toContain('handle_reserved');
  });

  it('rejects reserved: hubspot (impersonation)', () => {
    expect(codes(validatePublisherHandle('hubspot'))).toContain('handle_reserved');
  });

  it('rejects reserved: offensive words', () => {
    expect(codes(validatePublisherHandle('fuck'))).toContain('handle_reserved');
    expect(codes(validatePublisherHandle('nigger'))).toContain('handle_reserved');
  });

  it('rejects reserved: null/undefined/localhost', () => {
    expect(codes(validatePublisherHandle('null'))).toContain('handle_reserved');
    expect(codes(validatePublisherHandle('localhost'))).toContain('handle_reserved');
  });

  it('RESERVED_HANDLES set has expected size', () => {
    expect(RESERVED_HANDLES.size).toBeGreaterThan(40);
  });

  it('rejects AI/LLM-related handles (vault namespace collision)', () => {
    for (const handle of ['ai', 'llm', 'model', 'bot', 'chatbot', 'agent']) {
      expect(codes(validatePublisherHandle(handle))).toContain('handle_reserved');
    }
  });

  it('§5 — rejects the reserved core handle', () => {
    expect(codes(validatePublisherHandle('core'))).toContain('handle_reserved');
  });

  it('rejects grant-identity publisher handles used by dotted pack stamps', () => {
    for (const handle of ['data', 'enrichment', 'primitive', 'ingredient']) {
      expect(codes(validatePublisherHandle(handle)), handle).toContain('handle_reserved');
    }
  });
});

// ── Text content ──

describe('validateTextContent', () => {
  it('passes clean text', () => {
    expect(validateTextContent('Deal risk detector for HubSpot', 'name')).toEqual([]);
  });

  it('blocks profanity', () => {
    expect(codes(validateTextContent('This recipe is fucking great', 'description'))).toContain('content_blocked');
  });

  it('blocks slurs', () => {
    expect(codes(validateTextContent('some nigger test', 'description'))).toContain('content_blocked');
  });

  it('does not false-positive on substrings', () => {
    // "assassin" contains "ass" but should not trigger
    expect(validateTextContent('Classify assassination risk', 'description')).toEqual([]);
  });

  it('case insensitive', () => {
    expect(codes(validateTextContent('FUCK this', 'name'))).toContain('content_blocked');
  });
});

// ── Tags ──

describe('validateTags', () => {
  it('passes valid tags', () => {
    expect(validateTags(['hubspot', 'deal', 'risk'])).toEqual([]);
  });

  it('rejects too long tag', () => {
    expect(codes(validateTags(['a'.repeat(31)]))).toContain('tag_too_long');
  });

  it('rejects bad format tag', () => {
    expect(codes(validateTags(['My Tag']))).toContain('tag_format');
  });

  it('rejects too many tags', () => {
    const tags = Array.from({ length: 16 }, (_, i) => `tag-${i}`);
    expect(codes(validateTags(tags))).toContain('tags_too_many');
  });

  it('blocks offensive tags', () => {
    expect(codes(validateTags(['fuck-you']))).toContain('content_blocked');
  });
});

// ── Slugs ──

describe('validateSlug', () => {
  it('passes valid slugs', () => {
    expect(validateSlug('deal-reader-hubspot')).toEqual([]);
    expect(validateSlug('ai-classify')).toEqual([]);
  });

  it('rejects too short', () => {
    expect(codes(validateSlug('ab'))).toContain('slug_too_short');
  });

  it('rejects reserved prefixes', () => {
    expect(codes(validateSlug('recued-internal-tool'))).toContain('slug_reserved_prefix');
    expect(codes(validateSlug('system-admin'))).toContain('slug_reserved_prefix');
  });

  it('§5 — rejects the reserved core- kernel-capability prefix', () => {
    // A third party must not be able to publish (and thereby shadow) a core- slug,
    // which is the publish gate's trust anchor.
    expect(codes(validateSlug('core-ai-classify'))).toContain('slug_reserved_prefix');
    expect(codes(validateSlug('core-anything'))).toContain('slug_reserved_prefix');
    // A non-prefixed slug that merely contains 'core' is fine.
    expect(validateSlug('hardcore-metrics')).toEqual([]);
  });

  it('rejects offensive slugs', () => {
    expect(codes(validateSlug('fuck-checker'))).toContain('content_blocked');
  });
});

// ── Full content validation ──

describe('validateRecipeContent', () => {
  it('passes clean recipe', () => {
    const recipe = {
      recipe_id: 'deal-risk-detector',
      metadata: { name: 'Deal Risk Detector', description: 'Detects stale deals', tags: ['deal', 'risk'] },
    };
    expect(validateRecipeContent(recipe)).toEqual([]);
  });

  it('catches offensive description', () => {
    const recipe = {
      recipe_id: 'test-recipe',
      metadata: { name: 'Test', description: 'This shit is broken' },
    };
    expect(codes(validateRecipeContent(recipe))).toContain('content_blocked');
  });

  it('catches too-long name', () => {
    const recipe = {
      recipe_id: 'test',
      metadata: { name: 'x'.repeat(101) },
    };
    expect(codes(validateRecipeContent(recipe))).toContain('name_too_long');
  });
});

describe('validateRecipeBundleKey', () => {
  it('accepts a well-formed publisher/bundle slug pair', () => {
    expect(validateRecipeBundleKey('recued-core/outbound-follow-up-response')).toEqual([]);
  });

  it('rejects non-string and empty values', () => {
    expect(codes(validateRecipeBundleKey(42))).toContain('recipe_bundle_type');
    expect(codes(validateRecipeBundleKey(''))).toContain('recipe_bundle_empty');
  });

  it('rejects non-namespaced and nested namespaced values', () => {
    expect(codes(validateRecipeBundleKey('outbound-follow-up-response'))).toContain('recipe_bundle_format');
    expect(codes(validateRecipeBundleKey('recued-core/outbound/follow-up'))).toContain('recipe_bundle_format');
  });

  it('rejects uppercase, underscore, dot, and edge-hyphen segments', () => {
    expect(codes(validateRecipeBundleKey('Recued-Core/outbound-follow-up'))).toContain('handle_format');
    expect(codes(validateRecipeBundleKey('recued_core/outbound-follow-up'))).toContain('handle_format');
    expect(codes(validateRecipeBundleKey('recued-core/outbound.follow-up'))).toContain('slug_format');
    expect(codes(validateRecipeBundleKey('recued-core/outbound-follow-up-'))).toContain('slug_format');
  });

  it('applies recipe slug reserved-prefix and text-safety rules to the bundle slug', () => {
    expect(codes(validateRecipeBundleKey('trusted-publisher/recued-shadow'))).toContain('slug_reserved_prefix');
    expect(codes(validateRecipeBundleKey('trusted-publisher/rape-follow-up'))).toContain('content_blocked');
  });

  it('checks publisher equality only when a publisher_id is supplied', () => {
    const recipe = {
      metadata: { recipe_bundle: 'recued-core/outbound-follow-up-response' },
    };
    expect(validateRecipeBundlePublisher(recipe, 'recued-core')).toEqual([]);
    expect(codes(validateRecipeBundlePublisher(recipe, 'other-publisher'))).toContain('recipe_bundle_publisher_mismatch');
  });
});

describe('recipe bundle shared prefixes', () => {
  it('derives the sanitized shared-storage key from the full bundle key', () => {
    expect(sanitizeRecipeBundleKey('recued-core/outbound-follow-up-response'))
      .toBe('recued-core_outbound-follow-up-response');
    expect(sanitizeRecipeBundleKey('trusted-publisher/outbound-follow-up-response'))
      .toBe('trusted-publisher_outbound-follow-up-response');
  });

  it('builds state-partitioned data.shared prefixes for watcher bundles', () => {
    expect(recipeBundleSharedPrefix('recued-core/outbound-follow-up-response', 'active'))
      .toBe('data.shared.recipe.recued-core_outbound-follow-up-response.active.');
    expect(recipeBundleSharedPrefix('recued-core/outbound-follow-up-response', 'timed_out'))
      .toBe('data.shared.recipe.recued-core_outbound-follow-up-response.timed_out.');
  });

  it('builds full row keys only from one concrete dot-free segment', () => {
    expect(recipeBundleSharedKey('recued-core/outbound-follow-up-response', 'active', 'Thread_1-A'))
      .toBe('data.shared.recipe.recued-core_outbound-follow-up-response.active.Thread_1-A');
    expect(isRecipeBundleSharedRowKeySegment('Thread_1-A')).toBe(true);
    expect(isRecipeBundleSharedRowKeySegment('thread.1')).toBe(false);
    expect(isRecipeBundleSharedRowKeySegment('thread/1')).toBe(false);
    expect(isRecipeBundleSharedRowKeySegment('{{step.thread_key}}')).toBe(false);
    expect(isRecipeBundleSharedRowKeySegment('')).toBe(false);
    expect(isRecipeBundleSharedRowKeySegment('thread key')).toBe(false);
    expect(isRecipeBundleSharedRowKeySegment(42)).toBe(false);
    expect(recipeBundleSharedKey('recued-core/outbound-follow-up-response', 'active', 'thread.1'))
      .toBeNull();
    expect(recipeBundleSharedKey('recued-core/outbound-follow-up-response', 'active', 42))
      .toBeNull();
  });

  it('keeps the D-195 lifecycle partitions plus D-200 stable row closed', () => {
    expect(RECIPE_BUNDLE_SHARED_STATES).toEqual([
      'state',
      'active',
      'needs_owner',
      'proposal',
      'timed_out',
      'closed',
    ]);
  });

  it('rejects invalid bundle keys and unknown state partitions', () => {
    expect(sanitizeRecipeBundleKey('outbound-follow-up-response')).toBeNull();
    expect(sanitizeRecipeBundleKey('recued-core/outbound.follow-up')).toBeNull();
    expect(recipeBundleSharedPrefix('recued-core/outbound-follow-up-response', 'unknown' as never))
      .toBeNull();
    expect(recipeBundleSharedKey('recued-core/outbound-follow-up-response', 'unknown' as never, 'thread-1'))
      .toBeNull();
  });
});

describe('validateIngredientContent', () => {
  it('passes clean ingredient', () => {
    expect(validateIngredientContent({
      slug: 'deal-reader-hubspot',
      name: 'HubSpot Deal Reader',
      description: 'Reads deals from HubSpot',
      tags: ['hubspot', 'deal'],
    })).toEqual([]);
  });

  it('catches reserved slug prefix', () => {
    expect(codes(validateIngredientContent({
      slug: 'recued-internal-reader',
      name: 'Test',
    }))).toContain('slug_reserved_prefix');
  });
});

// ── canonicalizePublisher ──

describe('canonicalizePublisher', () => {
  it('lowercases', () => {
    expect(canonicalizePublisher('Recued-Core')).toBe('recued-core');
    expect(canonicalizePublisher('REcued')).toBe('recued');
  });

  it('trims whitespace', () => {
    expect(canonicalizePublisher('  alice  ')).toBe('alice');
    expect(canonicalizePublisher('\talice\n')).toBe('alice');
  });

  it('combines trim + lowercase', () => {
    expect(canonicalizePublisher(' Recued-Core ')).toBe('recued-core');
  });

  it('returns empty string for null/undefined/empty input', () => {
    expect(canonicalizePublisher(null)).toBe('');
    expect(canonicalizePublisher(undefined)).toBe('');
    expect(canonicalizePublisher('')).toBe('');
    expect(canonicalizePublisher('   ')).toBe('');
  });

  it('coerces non-string input defensively', () => {
    // Callers pass raw JSON values; a number or object shouldn't throw
    expect(canonicalizePublisher(42 as unknown as string)).toBe('42');
  });

  it('is idempotent', () => {
    const a = canonicalizePublisher('Recued-Core');
    const b = canonicalizePublisher(a);
    expect(a).toBe(b);
  });
});

// ────────────────────────────────────────────────────────────────
// Remaining gap tests
// ────────────────────────────────────────────────────────────────

describe('validateSlug — extra branches', () => {
  it('rejects slugs longer than 80 chars', () => {
    const tooLong = 'x'.repeat(81);
    expect(codes(validateSlug(tooLong))).toContain('slug_too_long');
  });

  it('rejects slug with uppercase (bad format)', () => {
    expect(codes(validateSlug('BadSlug'))).toContain('slug_format');
  });

  it('rejects slug with underscores (bad format)', () => {
    expect(codes(validateSlug('no_underscores'))).toContain('slug_format');
  });

  it('rejects the local/ prefix', () => {
    expect(codes(validateSlug('local/my-recipe'))).toContain('slug_reserved_prefix');
  });
});

describe('validateTags — skip format on single-char', () => {
  it('does not emit tag_format for a 1-char tag (skipped by h.length > 1 guard)', () => {
    const r = validateTags(['a']);
    expect(codes(r)).not.toContain('tag_format');
  });
});

describe('validateRecipeContent — length limits and readme', () => {
  it('flags description_too_long when description exceeds 500 chars', () => {
    const r = validateRecipeContent({
      recipe_id: 'ok-id-here',
      metadata: { name: 'Name', description: 'x'.repeat(501) },
    });
    expect(codes(r)).toContain('description_too_long');
  });

  it('flags readme_too_long when readme exceeds 10000 chars', () => {
    const r = validateRecipeContent({
      recipe_id: 'ok-id-here',
      metadata: { name: 'Name', readme: 'x'.repeat(10_001) },
    });
    expect(codes(r)).toContain('readme_too_long');
  });

  it('scans readme for blocked content', () => {
    const r = validateRecipeContent({
      recipe_id: 'ok-id-here',
      metadata: { name: 'Name', readme: 'This is fucking bad' },
    });
    expect(codes(r)).toContain('content_blocked');
  });

  it('propagates tag validation errors', () => {
    const r = validateRecipeContent({
      recipe_id: 'ok-id-here',
      metadata: { name: 'Name', tags: ['bad tag with spaces'] },
    });
    expect(codes(r)).toContain('tag_format');
  });

  it('handles recipe with no metadata gracefully', () => {
    const r = validateRecipeContent({ recipe_id: 'ok-id-here' });
    expect(r).toEqual([]);
  });
});

describe('validateIngredientContent — length limits', () => {
  it('flags name_too_long when name exceeds 100 chars', () => {
    expect(codes(validateIngredientContent({
      slug: 'ok-slug-here',
      name: 'x'.repeat(101),
    }))).toContain('name_too_long');
  });

  it('flags description_too_long when description exceeds 500 chars', () => {
    expect(codes(validateIngredientContent({
      slug: 'ok-slug-here',
      description: 'x'.repeat(501),
    }))).toContain('description_too_long');
  });

  it('propagates tag errors', () => {
    expect(codes(validateIngredientContent({
      slug: 'ok-slug-here',
      tags: ['has spaces'],
    }))).toContain('tag_format');
  });

  it('scans ingredient name for blocked content', () => {
    expect(codes(validateIngredientContent({
      slug: 'ok-slug-here',
      name: 'Very shit reader',
    }))).toContain('content_blocked');
  });
});

describe('validatePublisherHandle — single-char edge', () => {
  it('does not emit handle_format for single-char handle (guarded by h.length > 1)', () => {
    // Only handle_too_short fires; format regex is skipped.
    const r = validatePublisherHandle('a');
    const c = codes(r);
    expect(c).toContain('handle_too_short');
    expect(c).not.toContain('handle_format');
  });
});
