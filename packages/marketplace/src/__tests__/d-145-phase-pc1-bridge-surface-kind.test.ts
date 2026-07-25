/** D-145 PC1 — Publishing-vs-messaging marketplace validator tests
 *  (four-gate).
 *
 *  Per § C.1.7. Acceptance ratchets:
 *    - bridge-surface-kind-self-declaration.ratchet (gate 1)
 *    - bridge-url-classifier.ratchet (gate 2)
 *    - bridge-selector-classifier.ratchet (gate 3)
 *    - mixed-surface-review-required.ratchet (gate 4)
 *    - bridge-catalog-no-messaging.ratchet — applied via the
 *      catalog scan in the dedicated catalog test file
 *      (community/ingredients/__tests__/social-graph-manifests.test.ts). */

import { describe, expect, it } from 'vitest';
import {
  validateBridgeSurfaceKind,
  validateUrlClassifier,
  validateSelectorClassifier,
  flagMixedSurfaceDomain,
  runFourGateValidation,
  BRIDGE_SURFACE_VALIDATION_ERROR_CODES,
  type BridgeSurfaceValidationManifest,
} from '../validators/bridge-surface-kind.js';

// ── PC1.2 gate 1 — Self-declaration ─────────────────────────────────

describe('D-145 PC1 — gate 1 self-declaration ratchet', () => {
  it('rejects messaging / private_chat / dm self-declarations', () => {
    for (const sk of ['messaging', 'private_chat', 'dm']) {
      const manifest: BridgeSurfaceValidationManifest = {
        kind: 'dom',
        surface_kind: sk,
        trigger: ['example.com/*'],
      };
      const result = validateBridgeSurfaceKind(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('surface_kind_messaging_rejected');
      }
    }
  });

  it('accepts publishing / authoring / reading self-declarations', () => {
    for (const sk of ['publishing', 'authoring', 'reading'] as const) {
      const manifest: BridgeSurfaceValidationManifest = {
        kind: 'dom',
        surface_kind: sk,
        trigger: ['example.com/*'],
      };
      const result = validateBridgeSurfaceKind(manifest);
      expect(result.ok).toBe(true);
    }
  });

  it('rejects missing surface_kind with surface_kind_missing', () => {
    const manifest: BridgeSurfaceValidationManifest = {
      kind: 'dom',
      trigger: ['example.com/*'],
    };
    const result = validateBridgeSurfaceKind(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('surface_kind_missing');
  });

  it('rejects empty-string surface_kind with surface_kind_missing', () => {
    const manifest: BridgeSurfaceValidationManifest = {
      kind: 'dom',
      surface_kind: '',
      trigger: ['example.com/*'],
    };
    const result = validateBridgeSurfaceKind(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('surface_kind_missing');
  });

  it('rejects unknown surface_kind values with surface_kind_invalid', () => {
    const manifest: BridgeSurfaceValidationManifest = {
      kind: 'dom',
      surface_kind: 'admin',
      trigger: ['example.com/*'],
    };
    const result = validateBridgeSurfaceKind(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('surface_kind_invalid');
  });
});

// ── PC1.4 gate 2 — URL classifier ───────────────────────────────────

describe('D-145 PC1 — gate 2 URL classifier ratchet', () => {
  it('domain blocklist rejects WhatsApp / Messenger / Signal / Telegram / iMessage', () => {
    const cases = [
      { trigger: ['web.whatsapp.com/*'] },
      { trigger: ['messenger.com/*'] },
      { trigger: ['signal.org/inbox/*'] },
      { trigger: ['web.telegram.org/k/*'] },
      { trigger: ['imessage.apple.com/*'] },
    ];
    for (const m of cases) {
      const manifest: BridgeSurfaceValidationManifest = {
        kind: 'dom',
        surface_kind: 'reading',
        ...m,
      };
      const result = validateUrlClassifier(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('surface_kind_messaging_rejected_by_url_classifier');
      }
    }
  });

  it('rejects suffix-host matches (subdomain of whatsapp.com)', () => {
    const manifest: BridgeSurfaceValidationManifest = {
      kind: 'dom',
      surface_kind: 'reading',
      trigger: ['*.whatsapp.com/*'],
    };
    const result = validateUrlClassifier(manifest);
    expect(result.ok).toBe(false);
  });

  it('path-pattern blocklist rejects /messages/* /dm/* /chats/* /direct/* across hosts', () => {
    const cases = [
      { trigger: ['anything.example.com/messages/*'] },
      { trigger: ['app.example.com/dm/*'] },
      { trigger: ['something.example.com/chats/*'] },
      { trigger: ['site.example.com/direct/*'] },
      { trigger: ['site.example.com/conversation/*'] },
    ];
    for (const m of cases) {
      const manifest: BridgeSurfaceValidationManifest = {
        kind: 'dom',
        surface_kind: 'reading',
        ...m,
      };
      const result = validateUrlClassifier(manifest);
      expect(result.ok).toBe(false);
    }
  });

  it('passes legitimate publishing-surface URL patterns', () => {
    const cases = [
      'facebook.com/profile/*',
      'x.com/*/tweets/*',
      'instagram.com/*',
      'github.com/*',
      'app.linear.app/*',
      'app.hubspot.com/contacts/*',
    ];
    for (const trigger of cases) {
      const manifest: BridgeSurfaceValidationManifest = {
        kind: 'dom',
        surface_kind: 'reading',
        trigger: [trigger],
      };
      const result = validateUrlClassifier(manifest);
      expect(result.ok).toBe(true);
    }
  });

  it('echoes offending trigger pattern in rejection detail', () => {
    const manifest: BridgeSurfaceValidationManifest = {
      kind: 'dom',
      surface_kind: 'reading',
      trigger: ['safe.example.com/*', 'web.whatsapp.com/*'],
    };
    const result = validateUrlClassifier(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.trigger).toBe('web.whatsapp.com/*');
    }
  });

  it('handles missing trigger field gracefully (passes — submission flow handles elsewhere)', () => {
    const manifest: BridgeSurfaceValidationManifest = {
      kind: 'dom',
      surface_kind: 'reading',
    };
    const result = validateUrlClassifier(manifest);
    expect(result.ok).toBe(true);
  });
});

// ── PC1.4 gate 3 — Selector classifier ──────────────────────────────

describe('D-145 PC1 — gate 3 selector classifier ratchet', () => {
  it('rejects DM-conversation selectors (substring match)', () => {
    const cases: Array<Record<string, string>> = [
      { '[data-testid="conversation-list"]': 'dm_list' },
      { '[aria-label="Direct Messages"]': 'dm_inbox' },
      { '.conversation-thread span': 'message_text' },
      { ".dm-thread .body": 'msg_body' },
    ];
    for (const output of cases) {
      const manifest: BridgeSurfaceValidationManifest = {
        kind: 'dom',
        surface_kind: 'reading',
        trigger: ['app.slack.com/*'],
        output,
      };
      const result = validateSelectorClassifier(manifest);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('selector_pattern_messaging_rejected');
    }
  });

  it('passes legitimate publishing-surface DOM selectors', () => {
    const manifest: BridgeSurfaceValidationManifest = {
      kind: 'dom',
      surface_kind: 'reading',
      trigger: ['facebook.com/*'],
      output: {
        'facebook.com/*': 'trigger',
        "[role='feed'] [data-pagelet*='FeedUnit'] span[dir='auto']": 'post_body',
      },
    };
    const result = validateSelectorClassifier(manifest);
    expect(result.ok).toBe(true);
  });

  it('case-insensitive substring match on blocklist', () => {
    const manifest: BridgeSurfaceValidationManifest = {
      kind: 'dom',
      surface_kind: 'reading',
      trigger: ['example.com/*'],
      output: {
        '[data-testid="CONVERSATION-LIST"]': 'caps_dm_list',
      },
    };
    const result = validateSelectorClassifier(manifest);
    expect(result.ok).toBe(false);
  });

  it('handles missing output field gracefully (passes)', () => {
    const manifest: BridgeSurfaceValidationManifest = {
      kind: 'dom',
      surface_kind: 'reading',
      trigger: ['example.com/*'],
    };
    const result = validateSelectorClassifier(manifest);
    expect(result.ok).toBe(true);
  });
});

// ── PC1.4 gate 4 — Mixed-surface flag ───────────────────────────────

describe('D-145 PC1 — gate 4 mixed-surface domain flag', () => {
  it('flags mixed-surface domains for human review', () => {
    const cases = [
      'slack.com',
      'discord.com',
      'linkedin.com',
      'facebook.com',
      'instagram.com',
    ];
    for (const host of cases) {
      const manifest: BridgeSurfaceValidationManifest = {
        kind: 'dom',
        surface_kind: 'reading',
        trigger: [`${host}/*`],
      };
      const flag = flagMixedSurfaceDomain(manifest);
      expect(flag.mixed_surface_review_required).toBe(true);
      expect(flag.matched_domains).toContain(host);
    }
  });

  it('does NOT flag pure-publishing domains (github / x / substack)', () => {
    const cases = ['github.com', 'x.com', 'substack.com', 'app.hubspot.com'];
    for (const host of cases) {
      const manifest: BridgeSurfaceValidationManifest = {
        kind: 'dom',
        surface_kind: 'reading',
        trigger: [`${host}/*`],
      };
      const flag = flagMixedSurfaceDomain(manifest);
      expect(flag.mixed_surface_review_required).toBe(false);
    }
  });

  it('dedupes matched domains in the reviewer payload', () => {
    const manifest: BridgeSurfaceValidationManifest = {
      kind: 'dom',
      surface_kind: 'reading',
      trigger: ['facebook.com/*', 'facebook.com/profile/*', 'facebook.com/feed'],
    };
    const flag = flagMixedSurfaceDomain(manifest);
    expect(flag.matched_domains).toEqual(['facebook.com']);
  });
});

// ── PC1.5 — Composite four-gate runner ──────────────────────────────

describe('D-145 PC1 — runFourGateValidation composite', () => {
  it('returns ok=true when all gates pass + no mixed-surface flag', () => {
    const manifest: BridgeSurfaceValidationManifest = {
      kind: 'dom',
      surface_kind: 'reading',
      trigger: ['github.com/*'],
      output: {
        'github.com/*': 'trigger',
        '.commit-message': 'body',
      },
    };
    const result = runFourGateValidation(manifest);
    expect(result.ok).toBe(true);
    expect(result.mixed_surface_flag.mixed_surface_review_required).toBe(false);
  });

  it('returns ok=true + mixed-surface flag for facebook (reviewer queues)', () => {
    const manifest: BridgeSurfaceValidationManifest = {
      kind: 'dom',
      surface_kind: 'reading',
      trigger: ['facebook.com/*'],
      output: {
        'facebook.com/*': 'trigger',
      },
    };
    const result = runFourGateValidation(manifest);
    expect(result.ok).toBe(true);
    expect(result.mixed_surface_flag.mixed_surface_review_required).toBe(true);
  });

  it('returns ok=false on URL classifier rejection', () => {
    const manifest: BridgeSurfaceValidationManifest = {
      kind: 'dom',
      surface_kind: 'reading',
      trigger: ['web.whatsapp.com/*'],
    };
    const result = runFourGateValidation(manifest);
    expect(result.ok).toBe(false);
    expect(result.gate_url_classifier.ok).toBe(false);
  });

  it('returns ok=false on selector classifier rejection (even when other gates pass)', () => {
    const manifest: BridgeSurfaceValidationManifest = {
      kind: 'dom',
      surface_kind: 'reading',
      trigger: ['github.com/*'],
      output: {
        'github.com/*': 'trigger',
        '.dm-thread': 'leak_attempt',
      },
    };
    const result = runFourGateValidation(manifest);
    expect(result.ok).toBe(false);
    expect(result.gate_selector_classifier.ok).toBe(false);
  });
});

// ── Error code closed list ──────────────────────────────────────────

describe('D-145 PC1 — error code closed list', () => {
  it('contains every expected code', () => {
    expect([...BRIDGE_SURFACE_VALIDATION_ERROR_CODES].sort()).toEqual([
      'selector_pattern_messaging_rejected',
      'surface_kind_invalid',
      'surface_kind_messaging_rejected',
      'surface_kind_messaging_rejected_by_url_classifier',
      'surface_kind_missing',
    ]);
  });

  it('codes are unique', () => {
    expect(new Set(BRIDGE_SURFACE_VALIDATION_ERROR_CODES).size).toBe(
      BRIDGE_SURFACE_VALIDATION_ERROR_CODES.length,
    );
  });
});
