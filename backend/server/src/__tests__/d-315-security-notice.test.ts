/** D-315 §9 — recognizing a security notice: its own phrases, as whole words,
 *  never inside a link, an escape, a style rule or a colour, and never a
 *  phrase ordinary mail says too. */

import { describe, expect, it } from 'vitest';

import { looksLikeSecurityNoticeText } from '../mail-facts/security-notice.js';

describe('a security notice', () => {
  it.each([
    ['Your verification code', ''],
    ['Hello', 'Your one-time  passcode is 123456'],
    ['Hello', 'Your one time\npasscode is 123456'],
    ['Security alert', 'A new sign-in on Mac'],
    ['Sign-in attempt blocked', ''],
    ['Your account', 'Use this link to reset-password'],
    ['Neue Anmeldung bei Ihrem Konto', ''],
    // An HTML-only email's text can open with its style rules: they are not
    // the opening lines.
    ['Hello', `${'.a{color:#333;margin:0 auto} '.repeat(40)} Your verification code is 123456`],
  ])('is recognized: %s / %s', (subject, body) => {
    expect(looksLikeSecurityNoticeText(subject, body)).toBe(true);
  });

  it.each([
    // Its phrases inside what is not words.
    ['Your order', 'https://shop.example/track?u=%2Fa%2Fb&x=1'],
    ['Your order', 'body{color:#f2faff} Thanks for your order'],
    ['Your order', 'Our colour is #2fa000. Thanks'],
    ['Your order', 'Questions? Write to 2fa@shop.example'],
    // Words ordinary mail says.
    ['Your new device is on its way', 'Track it here'],
    ['Check-in details', 'The lockbox passcode is 4821'],
    ['Your stay', 'Your confirmation code is HMABC123'],
    ['Returns', 'A 2-step process: pack it, drop it off'],
    ['Buy a new device for mom', ''],
  ])('is not ordinary mail: %s / %s', (subject, body) => {
    expect(looksLikeSecurityNoticeText(subject, body)).toBe(false);
  });
});
