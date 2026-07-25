/** D-145 PB8 — Social-graph intelligence addon (contracts tests).
 *
 *  Closed-list registries + per-platform mappings + four-class
 *  persist-policy invariants + bridge-platform classification +
 *  IngredientManifest.surface_kind widening. */

import { describe, it, expect } from 'vitest';
import {
  // Closed lists / mappings
  SOCIAL_PLATFORMS,
  SOCIAL_PLATFORM_SET,
  SOCIAL_ALIAS_KIND,
  SOCIAL_PLATFORM_INGREDIENT_SLUG,
  SOCIAL_PLATFORM_LOGIN_SITE,
  SOCIAL_CONTENT_CLASSES,
  SOCIAL_CONTENT_CLASS_SET,
  SOCIAL_CLASS_REQUIRED_POLICIES,
  detectSocialClassPolicyDrift,
  SOCIAL_ALIAS_RESOLUTION_DECISIONS,
  SOCIAL_ALIAS_RESOLUTION_DECISION_SET,
  SOCIAL_ALIAS_AUTO_CONFIRM_FLOOR,
  SOCIAL_ALIAS_REJECT_FLOOR,
  // Bridge platform classification
  FORBIDDEN_SURFACE_KINDS,
  FORBIDDEN_SURFACE_KIND_SET,
  PUBLISHING_PLATFORMS,
  MESSAGING_PLATFORMS_REJECTED,
  AUTHORING_PLATFORMS,
  READING_PLATFORMS,
  MESSAGING_DOMAIN_BLOCKLIST,
  MESSAGING_SELECTOR_BLOCKLIST,
  MIXED_SURFACE_DOMAINS,
  MIXED_SURFACE_DOMAIN_SET,
  // Cross-package re-checks
  CONTEXT_CONTENT_CLASSES,
  CONTEXT_CLASS_PERSIST_POLICIES,
  BRIDGE_SURFACE_KINDS,
  type IngredientManifest,
  type SocialPlatform,
  type SocialContentClass,
} from '../index.js';

describe('D-145 PB8 — SOCIAL_PLATFORMS closed list', () => {
  it('contains exactly five v1 platforms', () => {
    expect([...SOCIAL_PLATFORMS].sort()).toEqual([
      'facebook',
      'github',
      'instagram',
      'linkedin',
      'x',
    ]);
  });

  it('SOCIAL_PLATFORM_SET membership matches the array', () => {
    for (const p of SOCIAL_PLATFORMS) {
      expect(SOCIAL_PLATFORM_SET.has(p)).toBe(true);
    }
    expect(SOCIAL_PLATFORM_SET.has('whatsapp' as SocialPlatform)).toBe(false);
  });

  it('every platform has an ingredient slug + login site mapping', () => {
    for (const p of SOCIAL_PLATFORMS) {
      expect(SOCIAL_PLATFORM_INGREDIENT_SLUG[p]).toMatch(/-profile-reader$/);
      expect(SOCIAL_PLATFORM_LOGIN_SITE[p]).toMatch(/\.com$/);
    }
  });

  it('SOCIAL_ALIAS_KIND is the uniform `platform_id` constant', () => {
    expect(SOCIAL_ALIAS_KIND).toBe('platform_id');
  });
});

describe('D-145 PB8 — Four-class content registry', () => {
  it('SOCIAL_CONTENT_CLASSES is the four-element closed list', () => {
    expect([...SOCIAL_CONTENT_CLASSES].sort()).toEqual([
      'response_synthesis',
      'social_derived_summary',
      'social_raw_body',
      'system_provenance',
    ]);
  });

  it('every class is a member of CONTEXT_CONTENT_CLASSES upstream', () => {
    for (const cls of SOCIAL_CONTENT_CLASSES) {
      expect((CONTEXT_CONTENT_CLASSES as ReadonlyArray<string>)).toContain(cls);
    }
  });

  it('social_raw_body MUST be immediate_use_only (substrate hard rule)', () => {
    expect(SOCIAL_CLASS_REQUIRED_POLICIES.social_raw_body).toEqual([
      'immediate_use_only',
    ]);
  });

  it('social_derived_summary + response_synthesis + system_provenance MUST persist', () => {
    expect(SOCIAL_CLASS_REQUIRED_POLICIES.social_derived_summary).toEqual([
      'persist',
    ]);
    expect(SOCIAL_CLASS_REQUIRED_POLICIES.response_synthesis).toEqual(['persist']);
    expect(SOCIAL_CLASS_REQUIRED_POLICIES.system_provenance).toEqual(['persist']);
  });

  it('upstream CONTEXT_CLASS_PERSIST_POLICIES agrees per class (substrate ratchet)', () => {
    for (const cls of SOCIAL_CONTENT_CLASSES) {
      expect(SOCIAL_CLASS_REQUIRED_POLICIES[cls]).toEqual(
        CONTEXT_CLASS_PERSIST_POLICIES[cls],
      );
    }
  });

  it('detectSocialClassPolicyDrift returns empty list at boot', () => {
    expect(detectSocialClassPolicyDrift()).toEqual([]);
  });

  it('SOCIAL_CONTENT_CLASS_SET membership matches the array', () => {
    for (const cls of SOCIAL_CONTENT_CLASSES) {
      expect(SOCIAL_CONTENT_CLASS_SET.has(cls)).toBe(true);
    }
  });
});

describe('D-145 PB8 — Alias resolution decision', () => {
  it('SOCIAL_ALIAS_RESOLUTION_DECISIONS is the three-element closed list', () => {
    expect([...SOCIAL_ALIAS_RESOLUTION_DECISIONS].sort()).toEqual([
      'auto_confirm',
      'queue_for_user_confirm',
      'reject',
    ]);
  });

  it('confidence floors are sane (reject < auto_confirm)', () => {
    expect(SOCIAL_ALIAS_REJECT_FLOOR).toBeGreaterThan(0);
    expect(SOCIAL_ALIAS_AUTO_CONFIRM_FLOOR).toBeLessThan(1);
    expect(SOCIAL_ALIAS_REJECT_FLOOR).toBeLessThan(SOCIAL_ALIAS_AUTO_CONFIRM_FLOOR);
  });

  it('SOCIAL_ALIAS_RESOLUTION_DECISION_SET membership matches the array', () => {
    for (const d of SOCIAL_ALIAS_RESOLUTION_DECISIONS) {
      expect(SOCIAL_ALIAS_RESOLUTION_DECISION_SET.has(d)).toBe(true);
    }
  });
});

describe('D-145 PC1 — Bridge platform classification', () => {
  it('FORBIDDEN_SURFACE_KINDS is the messaging-permanently-rejected list', () => {
    expect([...FORBIDDEN_SURFACE_KINDS].sort()).toEqual([
      'dm',
      'messaging',
      'private_chat',
    ]);
  });

  it('FORBIDDEN_SURFACE_KIND_SET disjoint from BRIDGE_SURFACE_KINDS', () => {
    for (const allowed of BRIDGE_SURFACE_KINDS) {
      expect(FORBIDDEN_SURFACE_KIND_SET.has(allowed)).toBe(false);
    }
  });

  it('PUBLISHING_PLATFORMS includes all five v1 social platforms (facebook/x/instagram/linkedin/github)', () => {
    expect(PUBLISHING_PLATFORMS).toContain('facebook.com');
    expect(PUBLISHING_PLATFORMS).toContain('x.com');
    expect(PUBLISHING_PLATFORMS).toContain('instagram.com');
    expect(PUBLISHING_PLATFORMS).toContain('linkedin.com');
    expect(PUBLISHING_PLATFORMS).toContain('github.com');
  });

  it('MESSAGING_PLATFORMS_REJECTED includes the well-known DM platforms', () => {
    expect(MESSAGING_PLATFORMS_REJECTED).toContain('whatsapp.com');
    expect(MESSAGING_PLATFORMS_REJECTED).toContain('messenger.com');
    expect(MESSAGING_PLATFORMS_REJECTED).toContain('signal.org');
    expect(MESSAGING_PLATFORMS_REJECTED).toContain('imessage.apple.com');
    expect(MESSAGING_PLATFORMS_REJECTED).toContain('telegram.org');
  });

  it('MESSAGING_DOMAIN_BLOCKLIST contains both host + path patterns', () => {
    expect(MESSAGING_DOMAIN_BLOCKLIST).toContain('web.whatsapp.com');
    expect(MESSAGING_DOMAIN_BLOCKLIST).toContain('*/messages/*');
    expect(MESSAGING_DOMAIN_BLOCKLIST).toContain('*/dm/*');
    expect(MESSAGING_DOMAIN_BLOCKLIST).toContain('*/conversation/*');
  });

  it('MESSAGING_SELECTOR_BLOCKLIST contains DM-conversation selectors', () => {
    const lower = MESSAGING_SELECTOR_BLOCKLIST.map((s) => s.toLowerCase());
    expect(lower.some((s) => s.includes("conversation-list"))).toBe(true);
    expect(lower.some((s) => s.includes('direct messages'))).toBe(true);
  });

  it('MIXED_SURFACE_DOMAINS includes the five known dual-surface hosts', () => {
    expect([...MIXED_SURFACE_DOMAINS].sort()).toEqual([
      'discord.com',
      'facebook.com',
      'instagram.com',
      'linkedin.com',
      'slack.com',
    ]);
  });

  it('AUTHORING_PLATFORMS subset of publishing platforms', () => {
    for (const a of AUTHORING_PLATFORMS) {
      expect(PUBLISHING_PLATFORMS).toContain(a);
    }
  });

  it('READING_PLATFORMS does not overlap with messaging blocklist hosts', () => {
    for (const r of READING_PLATFORMS) {
      const host = r.replace(/^\*\./, '');
      expect(MESSAGING_PLATFORMS_REJECTED).not.toContain(host);
    }
  });

  it('MIXED_SURFACE_DOMAIN_SET membership matches the array', () => {
    for (const d of MIXED_SURFACE_DOMAINS) {
      expect(MIXED_SURFACE_DOMAIN_SET.has(d)).toBe(true);
    }
  });
});

describe('D-145 PB8 — IngredientManifest.surface_kind widening', () => {
  it('accepts the three valid BridgeSurfaceKind values on a dom manifest', () => {
    for (const sk of ['publishing', 'authoring', 'reading'] as const) {
      const m: IngredientManifest = {
        slug: `test-${sk}`,
        name: 'Test',
        description: 'Test',
        author: 'recued-core',
        kind: 'dom',
        category: 'data',
        risk_tier: 'read',
        input: {},
        output: { 'example.com/*': 'trigger' },
        surface_kind: sk,
      };
      expect(m.surface_kind).toBe(sk);
    }
  });

  it('field is optional (TypeScript-level — pre-launch dom manifests may omit)', () => {
    const m: IngredientManifest = {
      slug: 'test-no-surface',
      name: 'Test',
      description: 'Test',
      author: 'recued-core',
      kind: 'dom',
      category: 'data',
      risk_tier: 'read',
      input: {},
      output: { 'example.com/*': 'trigger' },
    };
    expect(m.surface_kind).toBeUndefined();
  });
});
