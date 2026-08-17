/** D-238 / D-210 finding 15 — a landing-page answer is attributed to the channel
 *  that actually carried the link.
 *
 *  ⛔⛔ Before this, EVERY landing submission was recorded as an `email` reply —
 *  on the ask row and in the durable audit activity. That was already wrong for
 *  Slack, and D-238 made it materially worse: a Teams ask carries the same link,
 *  so an office's approval trail would claim `email` for every decision taken in
 *  Teams. A false approval trail is a worse defect than a missing one, which is
 *  why the spec listed this as a P2 prerequisite rather than a carry.
 *
 *  ⚠ `d-158-phase-2b-ii-ask-landing.test.ts` still asserts an `email`
 *  attribution and still passes — correctly. It submits no `via`, which is
 *  exactly a link minted before this existed. That test now pins the FALLBACK;
 *  the ones below pin the behaviour. */

import { describe, expect, it } from 'vitest';

import {
  ASK_LANDING_VIA_KEY,
  parseAskLandingSubmission,
  renderAskLandingHtml,
  resolveAskLandingVia,
} from '../channels/ask-landing.js';
import type { PendingAsk } from '../types.js';

const OPEN_ASK: PendingAsk = {
  ask_id: 'ask-1',
  status: 'open',
  message: { title: 'Approval pending', text: 'mail-send to dana@example.com' },
  options: [
    { id: 'approve', label: 'Approve' },
    { id: 'deny', label: 'Deny' },
  ],
} as unknown as PendingAsk;

const submit = (fields: Record<string, string>) =>
  parseAskLandingSubmission(new URLSearchParams(fields).toString());

describe('resolveAskLandingVia', () => {
  it('accepts a real channel', () => {
    expect(resolveAskLandingVia('teams')).toBe('teams');
    expect(resolveAskLandingVia('slack')).toBe('slack');
  });

  /** A legacy link carries nothing, and an emailed ask genuinely IS an email
   *  reply — so the fallback is honest rather than a shrug. */
  it('falls back to email when absent', () => {
    expect(resolveAskLandingVia(null)).toBe('email');
    expect(resolveAskLandingVia('')).toBe('email');
    expect(resolveAskLandingVia('   ')).toBe('email');
  });

  /** ⛔ The value arrives from a URL the owner could have edited and lands in a
   *  DURABLE AUDIT ROW. A wrong-but-plausible channel name written through would
   *  be worse than the honest legacy default. */
  it('refuses a value that is not a channel rather than writing it through', () => {
    expect(resolveAskLandingVia('teams-prod')).toBe('email');
    expect(resolveAskLandingVia('__proto__')).toBe('email');
    expect(resolveAskLandingVia('Teams')).toBe('email');
  });
});

describe('the submission carries the originating channel', () => {
  it('attributes an answer to the channel the link came from', () => {
    const parsed = submit({
      ask_id: 'ask-1',
      option: 'approve',
      form_nonce: 'n-1',
      [ASK_LANDING_VIA_KEY]: 'teams',
    });
    expect('reply' in parsed && parsed.reply.via).toBe('teams');
  });

  it('still attributes to email when the field is absent (a legacy link)', () => {
    const parsed = submit({ ask_id: 'ask-1', option: 'approve', form_nonce: 'n-1' });
    expect('reply' in parsed && parsed.reply.via).toBe('email');
  });

  it('does not let a tampered value into the trail', () => {
    const parsed = submit({
      ask_id: 'ask-1',
      option: 'approve',
      form_nonce: 'n-1',
      [ASK_LANDING_VIA_KEY]: 'not-a-channel',
    });
    expect('reply' in parsed && parsed.reply.via).toBe('email');
  });
});

describe('the rendered form rides the channel through', () => {
  /** ⛔ THE JOIN. The resolver and the parser can both be right while the form
   *  never carries the value — and then every answer is an `email` answer again,
   *  with both unit suites green. */
  it('emits the channel as a hidden field so the POST can read it back', () => {
    const html = renderAskLandingHtml({
      ask: OPEN_ASK,
      form_nonce: 'n-1',
      action: '/ask/ask-1',
      via: 'teams',
    });
    expect(html).toContain(`name="${ASK_LANDING_VIA_KEY}"`);
    expect(html).toContain('value="teams"');
  });

  it('emits the email fallback when the page was reached without one', () => {
    const html = renderAskLandingHtml({
      ask: OPEN_ASK,
      form_nonce: 'n-1',
      action: '/ask/ask-1',
    });
    expect(html).toContain(`name="${ASK_LANDING_VIA_KEY}"`);
    expect(html).toContain('value="email"');
  });

  /** End to end over the three units: render with a channel, scrape the hidden
   *  field back out, submit it, and confirm the attribution survives. */
  it('round-trips render → form field → submission', () => {
    const html = renderAskLandingHtml({
      ask: OPEN_ASK,
      form_nonce: 'n-1',
      action: '/ask/ask-1',
      via: 'slack',
    });
    const match = new RegExp(
      `name="${ASK_LANDING_VIA_KEY}" value="([^"]+)"`,
    ).exec(html);
    expect(match?.[1]).toBe('slack');
    const parsed = submit({
      ask_id: 'ask-1',
      option: 'approve',
      form_nonce: 'n-1',
      [ASK_LANDING_VIA_KEY]: match![1]!,
    });
    expect('reply' in parsed && parsed.reply.via).toBe('slack');
  });
});
