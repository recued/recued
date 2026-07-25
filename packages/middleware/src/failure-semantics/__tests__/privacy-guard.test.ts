/** D-145 PB15 — privacy hard-fail runtime guard tests. */

import { describe, it, expect } from 'vitest';
import type { ContextItem } from '@recued/contracts';
import { checkPrivacyContext } from '../privacy-guard.js';

const mk = (overrides: Partial<ContextItem>): ContextItem => ({
  source_ref: 'data.contact.alice@example.com',
  content_class: 'work_entity',
  persist_policy: 'persist',
  ...overrides,
} as ContextItem);

describe('D-145 PB15 — privacy guard', () => {
  it('returns ok on empty included_context', () => {
    expect(checkPrivacyContext({ included_context: [] }).kind).toBe('ok');
  });

  it('returns ok on well-formed context', () => {
    const result = checkPrivacyContext({
      included_context: [
        mk({ content_class: 'work_entity', persist_policy: 'persist' }),
        mk({
          content_class: 'standing_instruction',
          persist_policy: 'redacted_only',
          redacted_payload: '<redacted>',
        }),
      ],
    });
    expect(result.kind).toBe('ok');
  });

  it('detects social_raw_body with persist policy as social_content_persist', () => {
    const result = checkPrivacyContext({
      included_context: [
        mk({
          content_class: 'social_raw_body',
          persist_policy: 'persist',
          redacted_payload: 'should_not_persist',
        }),
      ],
    });
    expect(result.kind).toBe('violation');
    if (result.kind === 'violation') {
      expect(result.violation_class).toBe('social_content_persist');
      expect(result.offending_index).toBe(0);
    }
  });

  it('detects social_raw_body with redacted_only policy as social_content_persist', () => {
    // social_raw_body MUST be immediate_use_only — redacted_only fails too.
    const result = checkPrivacyContext({
      included_context: [
        mk({
          content_class: 'social_raw_body',
          persist_policy: 'redacted_only',
          redacted_payload: 'still_wrong',
        }),
      ],
    });
    expect(result.kind).toBe('violation');
    if (result.kind === 'violation') {
      expect(result.violation_class).toBe('social_content_persist');
    }
  });

  it('passes social_raw_body with immediate_use_only persist policy', () => {
    const result = checkPrivacyContext({
      included_context: [
        mk({
          content_class: 'social_raw_body',
          persist_policy: 'immediate_use_only',
          redacted_payload: 'session-bound',
        }),
      ],
    });
    expect(result.kind).toBe('ok');
  });

  it('detects contact_alias in MCP packet as mcp_alias_leak', () => {
    const result = checkPrivacyContext({
      included_context: [
        mk({
          content_class: 'contact_alias',
          persist_policy: 'redacted_only',
          redacted_payload: '<alias>',
        }),
      ],
      mcp_dispatch: true,
    });
    expect(result.kind).toBe('violation');
    if (result.kind === 'violation') {
      expect(result.violation_class).toBe('mcp_alias_leak');
    }
  });

  it('passes contact_alias outside MCP packet', () => {
    const result = checkPrivacyContext({
      included_context: [
        mk({
          content_class: 'contact_alias',
          persist_policy: 'redacted_only',
          redacted_payload: '<alias>',
        }),
      ],
      mcp_dispatch: false,
    });
    expect(result.kind).toBe('ok');
  });

  it('detects standing_instruction with persist policy as standing_instruction_leak', () => {
    const result = checkPrivacyContext({
      included_context: [
        mk({
          content_class: 'standing_instruction',
          persist_policy: 'persist',
        }),
      ],
    });
    expect(result.kind).toBe('violation');
    if (result.kind === 'violation') {
      expect(result.violation_class).toBe('standing_instruction_leak');
    }
  });

  it('catch-all context_leak fires for class × policy mismatches outside named gates', () => {
    // calendar_event admits only 'persist' per CONTEXT_CLASS_PERSIST_POLICIES.
    // A mutated row with 'redacted_only' should trip the catch-all.
    const result = checkPrivacyContext({
      included_context: [
        mk({
          content_class: 'calendar_event',
          persist_policy: 'redacted_only',
          redacted_payload: '<x>',
        }),
      ],
    });
    expect(result.kind).toBe('violation');
    if (result.kind === 'violation') {
      expect(result.violation_class).toBe('context_leak');
    }
  });

  it('returns first violation found (does not exhaustively scan)', () => {
    const result = checkPrivacyContext({
      included_context: [
        mk({ content_class: 'work_entity', persist_policy: 'persist' }),
        mk({
          content_class: 'social_raw_body',
          persist_policy: 'persist',
          redacted_payload: 'first_violation',
        }),
        mk({
          content_class: 'standing_instruction',
          persist_policy: 'persist',
        }),
      ],
    });
    expect(result.kind).toBe('violation');
    if (result.kind === 'violation') {
      expect(result.offending_index).toBe(1);
      expect(result.violation_class).toBe('social_content_persist');
    }
  });

  it('Codex P1 fold: off-list content_class hard-fails as context_leak', () => {
    // Parsed-JSON or `as unknown as` cast with a bogus content_class.
    // The compile-time matrix doesn't cover it; the runtime backstop
    // MUST treat it as a leak (substrate is the pre-AI-packet defense).
    const result = checkPrivacyContext({
      included_context: [
        // @ts-expect-error — testing runtime backstop on off-list value
        mk({ content_class: 'not_a_real_class', persist_policy: 'persist' }),
      ],
    });
    expect(result.kind).toBe('violation');
    if (result.kind === 'violation') {
      expect(result.violation_class).toBe('context_leak');
      expect(result.detail).toMatch(/off-list/);
    }
  });

  it('violation detail never echoes redacted_payload content', () => {
    const result = checkPrivacyContext({
      included_context: [
        mk({
          content_class: 'social_raw_body',
          persist_policy: 'persist',
          redacted_payload: 'PRIVATE_USER_SECRET',
        }),
      ],
    });
    if (result.kind === 'violation') {
      expect(result.detail).not.toContain('PRIVATE_USER_SECRET');
    }
  });
});
