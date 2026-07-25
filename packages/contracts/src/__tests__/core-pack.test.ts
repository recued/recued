import { describe, it, expect } from 'vitest';
import {
  CORE_SLUG_PREFIX,
  isCoreSlug,
  stripCorePrefix,
  CORE_CAPABILITY_SLUGS,
  isCoreCapabilitySlug,
} from '../core-pack.js';
import { BATCH_CAPABLE_AI_SLUGS } from '../ai-batch.js';

describe('§5 core-pack namespace', () => {
  it('CORE_SLUG_PREFIX is the hyphen form (fits the existing slug regex)', () => {
    expect(CORE_SLUG_PREFIX).toBe('core-');
    // Must be admissible by the slug regex ^[a-z][a-z0-9-]*[a-z0-9]$ (a prefix of a valid slug).
    expect(/^[a-z][a-z0-9-]*-$/.test(CORE_SLUG_PREFIX)).toBe(true);
  });

  it('isCoreSlug matches only the reserved prefix', () => {
    expect(isCoreSlug('core-ai-classify')).toBe(true);
    expect(isCoreSlug('core-notification-send')).toBe(true);
    expect(isCoreSlug('ai-classify')).toBe(false);
    expect(isCoreSlug('hardcore-metrics')).toBe(false); // contains 'core' but not a prefix
    expect(isCoreSlug('')).toBe(false);
  });

  it('stripCorePrefix strips a single leading core- and passes through bare slugs', () => {
    expect(stripCorePrefix('core-ai-classify')).toBe('ai-classify');
    expect(stripCorePrefix('core-notification-send')).toBe('notification-send');
    expect(stripCorePrefix('ai-classify')).toBe('ai-classify'); // passthrough
    expect(stripCorePrefix('hardcore-metrics')).toBe('hardcore-metrics'); // not a prefix
    // Only a single leading prefix is stripped.
    expect(stripCorePrefix('core-core-foo')).toBe('core-foo');
  });

  it('CORE_CAPABILITY_SLUGS holds bare names only (the gate allow-set after stripping)', () => {
    for (const s of CORE_CAPABILITY_SLUGS) {
      expect(isCoreSlug(s)).toBe(false); // never the prefixed form
    }
    // The 13 binding-free capabilities: 9 contracted AI + ai-prompt + 3 notification dispatch.
    expect(CORE_CAPABILITY_SLUGS.has('ai-classify')).toBe(true);
    expect(CORE_CAPABILITY_SLUGS.has('notification-send')).toBe(true);
    expect(CORE_CAPABILITY_SLUGS.has('mail-post')).toBe(true);
    expect(CORE_CAPABILITY_SLUGS.has('slack-post')).toBe(true);
    // ai-prompt is now admitted (its threat surface matches the contracted nine; the
    // publishable core- variant drops the one differing capability, web-search egress —
    // forced off by the executor for every core- AI slug via isCoreSlug). D-174 R28 —
    // ai-embed is admitted too (embeddings; same egress profile, no web-search capability).
    expect(CORE_CAPABILITY_SLUGS.has('ai-prompt')).toBe(true);
    expect(CORE_CAPABILITY_SLUGS.has('ai-embed')).toBe(true);
    expect(CORE_CAPABILITY_SLUGS.size).toBe(14);
  });

  it('isCoreCapabilitySlug requires BOTH the core- prefix AND a known bare capability', () => {
    expect(isCoreCapabilitySlug('core-ai-classify')).toBe(true);
    expect(isCoreCapabilitySlug('core-notification-send')).toBe(true);
    // bare (un-prefixed) is NOT a core capability step — must be packaged/prefixed.
    expect(isCoreCapabilitySlug('ai-classify')).toBe(false);
    // prefixed but not a known capability — cannot smuggle a richer kind by self-naming.
    expect(isCoreCapabilitySlug('core-http-fetch')).toBe(false);
    // core-ai-prompt is now a publishable core capability (web-search egress neutralized).
    expect(isCoreCapabilitySlug('core-ai-prompt')).toBe(true);
  });

  it('drift guard — every batch-capable contracted slug is a core capability', () => {
    for (const s of BATCH_CAPABLE_AI_SLUGS) {
      expect(CORE_CAPABILITY_SLUGS.has(s)).toBe(true);
    }
  });
});
