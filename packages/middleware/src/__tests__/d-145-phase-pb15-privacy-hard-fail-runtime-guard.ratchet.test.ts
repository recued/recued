/** D-145 PB15 — `privacy-hard-fail-runtime-guard` ratchet.
 *
 *  Pins the substrate-level invariant from § B.15.9 + § C.3.6: parsed-
 *  JSON / object-mutation / peer-MCP-input paths that bypass the
 *  compile-time `ContextContentClass × persist_policy` type matrix
 *  MUST be caught by the runtime guard.
 *
 *  Three named gates (the gates the spec calls out):
 *    1. `social_raw_body` persisting → social_content_persist
 *    2. `contact_alias` entering MCP packet → mcp_alias_leak
 *    3. `standing_instruction` content reaching AI packet → standing_-
 *       instruction_leak
 *
 *  Plus the catch-all `context_leak` for any class × policy mismatch
 *  outside the closed admissible-set matrix.
 *
 *  Drift requires substrate D-spec change. */

import { describe, it, expect } from 'vitest';
import {
  TRANSPARENCY_PRIVACY_VIOLATION_CLASSES,
  type ContextItem,
} from '@recued/contracts';
import { checkPrivacyContext } from '../failure-semantics/index.js';

const mk = (overrides: Partial<ContextItem>): ContextItem => ({
  source_ref: 'data.contact.alice@example.com',
  content_class: 'work_entity',
  persist_policy: 'persist',
  ...overrides,
} as ContextItem);

describe('D-145 PB15 — privacy-hard-fail-runtime-guard.ratchet', () => {
  it('TRANSPARENCY_PRIVACY_VIOLATION_CLASSES is exactly 4 entries', () => {
    expect(TRANSPARENCY_PRIVACY_VIOLATION_CLASSES.length).toBe(4);
    expect(new Set(TRANSPARENCY_PRIVACY_VIOLATION_CLASSES)).toEqual(
      new Set([
        'context_leak',
        'mcp_alias_leak',
        'social_content_persist',
        'standing_instruction_leak',
      ]),
    );
  });

  it('catches social_raw_body with non-immediate_use_only policy', () => {
    for (const policy of ['persist', 'redacted_only'] as const) {
      const result = checkPrivacyContext({
        included_context: [
          mk({
            content_class: 'social_raw_body',
            persist_policy: policy,
            redacted_payload: '<x>',
          }),
        ],
      });
      expect(result.kind).toBe('violation');
      if (result.kind === 'violation') {
        expect(result.violation_class).toBe('social_content_persist');
      }
    }
  });

  it('catches contact_alias in MCP-bound packet', () => {
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

  it('catches standing_instruction with non-redacted_only policy', () => {
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
    // work_entity admits only 'persist'; mutated row with 'redacted_only'
    // hits the catch-all.
    const result = checkPrivacyContext({
      included_context: [
        mk({
          content_class: 'work_entity',
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

  it('runtime guard violation detail never echoes redacted_payload content', () => {
    const SECRET = 'PRIVATE_USER_SECRET_VALUE_DO_NOT_LEAK';
    const result = checkPrivacyContext({
      included_context: [
        mk({
          content_class: 'social_raw_body',
          persist_policy: 'persist',
          redacted_payload: SECRET,
        }),
      ],
    });
    if (result.kind === 'violation') {
      expect(result.detail).not.toContain(SECRET);
    }
  });
});
