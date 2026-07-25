/** D-149 P4 § A.5.1 — `ReceptionPageConfig` validator tests.
 *
 *  Covers:
 *    - Length-bounded fields reject over-limit input.
 *    - URL scheme allowlist rejects `javascript:` / `data:` / `file:` /
 *      `vbscript:` (TR-8 mitigation).
 *    - Relative `/reception/_static/` path accepted; path-traversal
 *      `..` segment rejected.
 *    - Closed-shape gates reject caller-supplied extra keys on
 *      `sections_enabled` + `linked_endpoints`.
 *    - Preferred contact methods closed list enforced.
 *    - Custom-links cardinality cap enforced. */

import { describe, expect, it } from 'vitest';
import {
  RECEPTION_PAGE_CUSTOM_LINKS_MAX,
  RECEPTION_PAGE_DISPLAY_NAME_MAX,
  RECEPTION_PAGE_STATIC_PATH_PREFIX,
  RECEPTION_PAGE_TAGLINE_MAX,
  RECEPTION_PAGE_TZ_LABEL_MAX,
  RECEPTION_PAGE_URL_SCHEME_SET,
  isReceptionPageUrlAllowed,
  validateReceptionPageConfig,
  type ReceptionPageConfig,
} from '../index.js';

const minimalConfig: ReceptionPageConfig = {
  display_overrides: {
    display_name: 'Mary',
    tagline: 'Available for client work',
    tz_label: 'America/Los_Angeles',
    preferred_contact_methods: ['email'],
  },
  sections_enabled: {
    contact_card: true,
    contact_methods: true,
    availability_cta: false,
    intake_cta: false,
    drop_cta: false,
    custom_links: false,
  },
  linked_endpoints: {},
};

describe('D-149 P4 § A.5.1 — isReceptionPageUrlAllowed', () => {
  it('accepts http(s) absolute URLs', () => {
    expect(isReceptionPageUrlAllowed('https://example.com/foo')).toBe(true);
    expect(isReceptionPageUrlAllowed('http://example.com/')).toBe(true);
  });

  it('accepts relative paths under /reception/_static/', () => {
    expect(
      isReceptionPageUrlAllowed(`${RECEPTION_PAGE_STATIC_PATH_PREFIX}avatar/abc`),
    ).toBe(true);
    expect(isReceptionPageUrlAllowed(`${RECEPTION_PAGE_STATIC_PATH_PREFIX}style.css`)).toBe(
      true,
    );
  });

  it('rejects path traversal in relative paths', () => {
    expect(
      isReceptionPageUrlAllowed(`${RECEPTION_PAGE_STATIC_PATH_PREFIX}../etc/passwd`),
    ).toBe(false);
    expect(
      isReceptionPageUrlAllowed(`${RECEPTION_PAGE_STATIC_PATH_PREFIX}a/../b`),
    ).toBe(false);
  });

  it('rejects javascript: / data: / file: / vbscript: schemes (TR-8)', () => {
    expect(isReceptionPageUrlAllowed('javascript:alert(1)')).toBe(false);
    expect(isReceptionPageUrlAllowed('data:text/html,<script>1</script>')).toBe(false);
    expect(isReceptionPageUrlAllowed('file:///etc/passwd')).toBe(false);
    expect(isReceptionPageUrlAllowed('vbscript:MsgBox')).toBe(false);
  });

  it('rejects malformed / empty / non-string input', () => {
    expect(isReceptionPageUrlAllowed('')).toBe(false);
    expect(isReceptionPageUrlAllowed(null)).toBe(false);
    expect(isReceptionPageUrlAllowed(undefined)).toBe(false);
    expect(isReceptionPageUrlAllowed(42)).toBe(false);
    expect(isReceptionPageUrlAllowed('not a url')).toBe(false);
  });

  it('rejects scheme-relative URLs (//example.com is ambiguous)', () => {
    // URL parses scheme-relative paths as the surrounding doc's scheme;
    // the validator's plain `new URL(raw)` rejects them because there's
    // no base. Acceptable behavior — scheme-relative URLs are not in
    // the closed-list allowlist anyway.
    expect(isReceptionPageUrlAllowed('//example.com/foo')).toBe(false);
  });

  it('closed scheme list is exactly http(s)', () => {
    expect(RECEPTION_PAGE_URL_SCHEME_SET.has('http:')).toBe(true);
    expect(RECEPTION_PAGE_URL_SCHEME_SET.has('https:')).toBe(true);
    expect(RECEPTION_PAGE_URL_SCHEME_SET.size).toBe(2);
  });
});

describe('D-149 P4 § A.5.1 — validateReceptionPageConfig', () => {
  it('accepts a minimal valid config', () => {
    const failures = validateReceptionPageConfig(minimalConfig);
    expect(failures).toEqual([]);
  });

  it('rejects empty display_name', () => {
    const cfg: ReceptionPageConfig = {
      ...minimalConfig,
      display_overrides: { ...minimalConfig.display_overrides, display_name: '' },
    };
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('display_name_empty');
  });

  it('rejects whitespace-only display_name (trim semantics)', () => {
    const cfg: ReceptionPageConfig = {
      ...minimalConfig,
      display_overrides: { ...minimalConfig.display_overrides, display_name: '   ' },
    };
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('display_name_empty');
  });

  it('rejects over-limit display_name', () => {
    const cfg: ReceptionPageConfig = {
      ...minimalConfig,
      display_overrides: {
        ...minimalConfig.display_overrides,
        display_name: 'x'.repeat(RECEPTION_PAGE_DISPLAY_NAME_MAX + 1),
      },
    };
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('display_name_too_long');
  });

  it('rejects over-limit tagline', () => {
    const cfg: ReceptionPageConfig = {
      ...minimalConfig,
      display_overrides: {
        ...minimalConfig.display_overrides,
        tagline: 'x'.repeat(RECEPTION_PAGE_TAGLINE_MAX + 1),
      },
    };
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('tagline_too_long');
  });

  it('rejects empty tz_label', () => {
    const cfg: ReceptionPageConfig = {
      ...minimalConfig,
      display_overrides: { ...minimalConfig.display_overrides, tz_label: '' },
    };
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('tz_label_empty');
  });

  it('rejects over-limit tz_label', () => {
    const cfg: ReceptionPageConfig = {
      ...minimalConfig,
      display_overrides: {
        ...minimalConfig.display_overrides,
        tz_label: 'x'.repeat(RECEPTION_PAGE_TZ_LABEL_MAX + 1),
      },
    };
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('tz_label_too_long');
  });

  it('rejects javascript: avatar_url', () => {
    const cfg: ReceptionPageConfig = {
      ...minimalConfig,
      display_overrides: {
        ...minimalConfig.display_overrides,
        avatar_url: 'javascript:alert(1)',
      },
    };
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('avatar_url_invalid');
  });

  it('accepts relative /reception/_static/ avatar_url', () => {
    const cfg: ReceptionPageConfig = {
      ...minimalConfig,
      display_overrides: {
        ...minimalConfig.display_overrides,
        avatar_url: `${RECEPTION_PAGE_STATIC_PATH_PREFIX}avatar/abc123`,
      },
    };
    expect(validateReceptionPageConfig(cfg)).toEqual([]);
  });

  it('rejects unknown preferred_contact_method', () => {
    const cfg: ReceptionPageConfig = {
      ...minimalConfig,
      display_overrides: {
        ...minimalConfig.display_overrides,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        preferred_contact_methods: ['email', 'mastodon' as any],
      },
    };
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('preferred_contact_method_unknown');
  });

  it('rejects extra section keys', () => {
    const cfg = {
      ...minimalConfig,
      sections_enabled: {
        ...minimalConfig.sections_enabled,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ad_banner: true as any,
      } as never,
    } as ReceptionPageConfig;
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('sections_enabled_unknown_key');
  });

  it('rejects extra linked_endpoints keys', () => {
    const cfg = {
      ...minimalConfig,
      linked_endpoints: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        approval_link_endpoint_id: 'x' as any,
      } as never,
    } as ReceptionPageConfig;
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('linked_endpoints_unknown_key');
  });

  it('rejects custom_links cardinality over cap', () => {
    const links = Array.from({ length: RECEPTION_PAGE_CUSTOM_LINKS_MAX + 1 }, (_, i) => ({
      label: `link-${i}`,
      url: `https://example.com/${i}`,
    }));
    const cfg: ReceptionPageConfig = { ...minimalConfig, custom_links: links };
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('custom_links_count_exceeded');
  });

  it('rejects custom_link with javascript: url', () => {
    const cfg: ReceptionPageConfig = {
      ...minimalConfig,
      custom_links: [{ label: 'Bad', url: 'javascript:alert(1)' }],
    };
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('custom_link_url_invalid');
  });

  it('applies D-196 link_button semantics without narrowing legacy custom_links', () => {
    expect(validateReceptionPageConfig({
      ...minimalConfig,
      link_buttons: [{
        label: 'Subscribe',
        url: 'https://buy.stripe.com/example',
        description: 'Choose a plan.',
      }],
    })).toEqual([]);
    expect(validateReceptionPageConfig({
      ...minimalConfig,
      link_buttons: [{ label: 'Insecure', url: 'http://example.com' }],
    }).map((failure) => failure.code)).toContain('link_button_invalid');
    expect(validateReceptionPageConfig({
      ...minimalConfig,
      link_buttons: [{ label: 'Widened', url: 'https://example.com', form_action: 'post' }],
    } as never).map((failure) => failure.code)).toContain('link_button_invalid');
    expect(validateReceptionPageConfig({
      ...minimalConfig,
      custom_links: [{ label: 'Legacy HTTP', url: 'http://example.com' }],
    })).toEqual([]);
  });

  it('rejects empty custom_link label', () => {
    const cfg: ReceptionPageConfig = {
      ...minimalConfig,
      custom_links: [{ label: '', url: 'https://example.com' }],
    };
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('custom_link_label_empty');
  });
});

describe('D-149 P4 Codex fold — section toggle type-gate (P2)', () => {
  it('rejects sections_enabled.<key>: "true" (string, not boolean)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg: any = {
      ...minimalConfig,
      sections_enabled: { ...minimalConfig.sections_enabled, availability_cta: 'true' },
    };
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('sections_enabled_unknown_key');
  });

  it('rejects sections_enabled.<key>: 1 (number, not boolean)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg: any = {
      ...minimalConfig,
      sections_enabled: { ...minimalConfig.sections_enabled, contact_card: 1 },
    };
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('sections_enabled_unknown_key');
  });
});

describe('D-149 P4 Codex fold — response_time_estimate non-string rejected (P2)', () => {
  it('rejects response_time_estimate: 42 (number)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg: any = {
      ...minimalConfig,
      display_overrides: { ...minimalConfig.display_overrides, response_time_estimate: 42 },
    };
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('response_time_estimate_too_long');
  });

  it('rejects avatar_url: { malicious: object }', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg: any = {
      ...minimalConfig,
      display_overrides: { ...minimalConfig.display_overrides, avatar_url: { x: 1 } },
    };
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('avatar_url_invalid');
  });
});

describe('D-149 P4 Codex fold — linked_endpoints share_url validation (P2)', () => {
  it('accepts http(s) share_url', () => {
    const cfg: ReceptionPageConfig = {
      ...minimalConfig,
      linked_endpoints: {
        scheduling_link_endpoint_id: 'sl_abc',
        scheduling_link_share_url: 'https://mary.example.com/reception/scheduling/sl_abc?t=xyz',
      },
    };
    const failures = validateReceptionPageConfig(cfg);
    expect(failures).toEqual([]);
  });

  it('rejects javascript: share_url', () => {
    const cfg = {
      ...minimalConfig,
      linked_endpoints: {
        scheduling_link_endpoint_id: 'sl_abc',
        scheduling_link_share_url: 'javascript:alert(1)',
      },
    } as ReceptionPageConfig;
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('custom_link_url_invalid');
  });

  it('rejects non-string share_url', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg: any = {
      ...minimalConfig,
      linked_endpoints: {
        scheduling_link_endpoint_id: 'sl_abc',
        scheduling_link_share_url: 42,
      },
    };
    const failures = validateReceptionPageConfig(cfg);
    expect(failures.map((f) => f.code)).toContain('linked_endpoints_unknown_key');
  });
});
