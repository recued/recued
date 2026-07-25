/** D-127 Phase 1.2 — mail-send error taxonomy (D-172 P2 update).
 *
 *  Asserts the `MAIL_SEND_*` codes are registered in the typed
 *  `RecipeErrorCode` union, that severity is wired correctly (6 'error'
 *  + 1 'warn'; D-172 P2 retired the lone 'fatal'
 *  `ATTACHMENTS_NOT_YET_IMPLEMENTED` and added the 'error'
 *  `ATTACHMENT_UNRESOLVABLE` resolve-failure code), and that
 *  user-facing copy exists for each. */

import { describe, it, expect } from 'vitest';
import {
  ERR,
  ERROR_MESSAGES,
  defaultErrorMessage,
  type ErrorSeverity,
  type RecipeErrorCode,
} from '../errors.js';

/** Spec-defined severity classification per P1.2 § Implementation. */
const MAIL_SEND_FAMILY: ReadonlyArray<{ code: RecipeErrorCode; severity: ErrorSeverity }> = [
  { code: 'MAIL_SEND_NOT_CAPABLE',                  severity: 'error' },
  { code: 'MAIL_SEND_AUTH_FAILED',                  severity: 'error' },
  { code: 'MAIL_SEND_RECIPIENT_INVALID',            severity: 'error' },
  { code: 'MAIL_SEND_NETWORK_FAILED',               severity: 'error' },
  { code: 'MAIL_SEND_SELF_LOOP_TO',                 severity: 'error' },
  { code: 'MAIL_SEND_APPEND_FAILED',                severity: 'warn' },
  // D-172 P2 — `MAIL_SEND_ATTACHMENTS_NOT_YET_IMPLEMENTED` retired
  // (attachments-v2 shipped); replaced by the resolve-failure code.
  { code: 'MAIL_SEND_ATTACHMENT_UNRESOLVABLE',      severity: 'error' },
];

describe('D-127 P1.2 — MAIL_SEND_* codes graduated to RecipeErrorCode', () => {
  it('every code in the mail-send family has an ERR severity entry', () => {
    for (const { code } of MAIL_SEND_FAMILY) {
      expect(ERR[code], `ERR missing entry for ${code}`).toBeDefined();
    }
  });

  it.each(MAIL_SEND_FAMILY)('$code is severity $severity', ({ code, severity }) => {
    expect(ERR[code]).toBe(severity);
  });

  it('every mail-send-family code has a user-facing ERROR_MESSAGES entry', () => {
    for (const { code } of MAIL_SEND_FAMILY) {
      const msg = ERROR_MESSAGES[code];
      expect(msg, `ERROR_MESSAGES missing entry for ${code}`).toBeDefined();
      expect(msg.length, `${code} message should be non-empty`).toBeGreaterThan(0);
    }
  });

  it('defaultErrorMessage returns a non-fallback string for every mail-send-family code', () => {
    for (const { code } of MAIL_SEND_FAMILY) {
      const msg = defaultErrorMessage(code);
      expect(msg, `${code} should resolve via ERROR_MESSAGES, not fallback`).not.toMatch(
        /^Recipe stopped \(/,
      );
    }
  });

  it('APPEND_FAILED is the only warn severity (passive consequence of SMTP submission ≠ rolled-back send)', () => {
    const warns = MAIL_SEND_FAMILY.filter((e) => e.severity === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].code).toBe('MAIL_SEND_APPEND_FAILED');
  });

  it('D-172 P2 — ATTACHMENT_UNRESOLVABLE is an error (recoverable: re-drop the file or send without it)', () => {
    expect(ERR.MAIL_SEND_ATTACHMENT_UNRESOLVABLE).toBe('error');
  });

  it('SELF_LOOP_TO copy mentions cc/bcc as the legitimate alternative for archival', () => {
    expect(ERROR_MESSAGES.MAIL_SEND_SELF_LOOP_TO).toMatch(/bcc/i);
  });
});
