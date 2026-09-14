/** D-264 slice 2 — the dispatch helper's two capability gates.
 *
 *  `composeStateToSendPayload` answers one question differently per mode and
 *  everything else identically. Both halves need pinning:
 *
 *    - the DIFFERENCE — a draft-only Source validates for `draft` and fails
 *      for `send`;
 *    - the SAMENESS — recipients, subject, body and the self-loop guard do not
 *      relax just because the caller asked for a draft. A draft is the same
 *      message, held.
 *
 *  ⛔ `send` is the DEFAULT. A caller that forgets the argument must get the
 *  stricter rule, never the looser one.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_MAIL_COMPOSE_VALUES,
  composeStateToSendPayload,
  type MailComposeValues,
  type MailSenderSourceOption,
} from '../index.js';

const source = (over: Partial<MailSenderSourceOption> = {}): MailSenderSourceOption => ({
  id: 'work',
  label: 'me@example.com (IMAP)',
  account_email: 'me@example.com',
  send_capable: true,
  draft_capable: true,
  mail_instance_slug: 'work',
  ...over,
});

const values = (over: Partial<MailComposeValues> = {}): MailComposeValues => ({
  ...EMPTY_MAIL_COMPOSE_VALUES,
  sender_source: 'work',
  to: ['them@example.com'],
  subject: 'Subject',
  body: 'Body',
  ...over,
});

const hooks = (option: MailSenderSourceOption | null) => ({
  resolveContactEmail: (ref: string) => ref,
  findSenderSource: (id: string) => (option && option.id === id ? option : null),
});

describe('D-264 — the sender gate differs by mode', () => {
  it('accepts a draft-only Source for `draft` and refuses it for `send`', () => {
    const draftOnly = source({ send_capable: false, draft_capable: true });

    const asDraft = composeStateToSendPayload(values(), hooks(draftOnly), 'draft');
    expect(asDraft.ok).toBe(true);

    const asSend = composeStateToSendPayload(values(), hooks(draftOnly), 'send');
    expect(asSend.ok).toBe(false);
    if (!asSend.ok) {
      expect(asSend.errors.sender_source).toContain('outbound send');
    }
  });

  it('accepts a send-capable Source for BOTH — send implies it can hold the draft', () => {
    // The stored-row case: every existing draft belongs to a send-capable
    // instance, some of which are not mutation-capable. `draft` must accept
    // `send_capable || draft_capable`, never `draft_capable` alone.
    const sendOnly = source({ send_capable: true, draft_capable: false });
    expect(composeStateToSendPayload(values(), hooks(sendOnly), 'send').ok).toBe(true);
    expect(composeStateToSendPayload(values(), hooks(sendOnly), 'draft').ok).toBe(true);
  });

  it('refuses a Source that can do neither, in either mode', () => {
    const inert = source({ send_capable: false, draft_capable: false });
    for (const mode of ['send', 'draft'] as const) {
      const result = composeStateToSendPayload(values(), hooks(inert), mode);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.sender_source).toBeDefined();
    }
  });

  it('defaults to `send` — the stricter gate — when the mode is omitted', () => {
    const draftOnly = source({ send_capable: false, draft_capable: true });
    const omitted = composeStateToSendPayload(values(), hooks(draftOnly));
    expect(omitted.ok).toBe(false);
  });

  it('names the draft gate in its own words', () => {
    const missing = composeStateToSendPayload(
      values({ sender_source: '' }), hooks(source()), 'draft',
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.sender_source).toContain('save this draft');
  });
});

describe('D-264 — `draft` relaxes the sender gate and NOTHING else', () => {
  const draftOnly = source({ send_capable: false, draft_capable: true });

  it('still requires a subject, a body and a recipient', () => {
    for (const patch of [{ subject: '' }, { body: '' }, { to: [] }]) {
      const result = composeStateToSendPayload(values(patch), hooks(draftOnly), 'draft');
      expect(result.ok).toBe(false);
    }
  });

  it('still refuses an unresolvable recipient', () => {
    const result = composeStateToSendPayload(values(), {
      resolveContactEmail: () => null,
      findSenderSource: (id) => (id === draftOnly.id ? draftOnly : null),
    }, 'draft');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.to).toBeDefined();
  });

  it('still refuses a Source with no instance slug', () => {
    const slugless = source({ send_capable: false, draft_capable: true, mail_instance_slug: '  ' });
    const result = composeStateToSendPayload(values(), hooks(slugless), 'draft');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.sender_source).toContain('mail-instance slug');
  });

  it('keeps the self-loop guard on a SEND-capable sender in draft mode', () => {
    // The guard is keyed on send-capability, not on mode: only a message that
    // can actually go out can loop back. A send-capable sender drafting to
    // itself is still the mistake the guard exists to catch.
    const both = source({ send_capable: true, draft_capable: true });
    const result = composeStateToSendPayload(
      values({ to: [both.account_email] }), hooks(both), 'draft',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.to).toContain('yourself');
  });
});
