/** The receiving provider's \`Authentication-Results\` stamp, read for its
 *  DMARC verdict: the shapes Gmail, Microsoft and Zoho write; and (D-318 step 8)
 *  who wrote it, a pass derived where it states none, and a sender's text
 *  inside it. */

import { describe, expect, it } from 'vitest';

import { dmarcPassFor, dmarcResultFor, senderCheckFor, stampAuthservId } from '../authentication-results.js';

const GMAIL = 'mx.google.com; dkim=pass header.i=@owner.example header.s=s1 header.b=abc; '
  + 'spf=pass (google.com: domain of me@owner.example designates 192.0.2.1 as permitted sender) '
  + 'smtp.mailfrom=me@owner.example; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=owner.example';
const MICROSOFT = 'spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=owner.example; dkim=pass (signature was verified) '
  + 'header.d=owner.example;dmarc=fail action=quarantine header.from=owner.example;compauth=fail reason=000';

describe('dmarcResultFor', () => {
  it('reads Gmail’s and Microsoft’s stamps, comments and all', () => {
    expect(dmarcResultFor(GMAIL, 'owner.example')).toBe('pass');
    expect(dmarcResultFor(GMAIL, 'OWNER.example')).toBe('pass');
    expect(dmarcResultFor(MICROSOFT, 'owner.example')).toBe('fail');
    expect(dmarcResultFor('x.example; dmarc=bestguesspass action=none header.from=owner.example', 'owner.example'))
      .toBe('bestguesspass');
  });

  it('says nothing for another domain, no DMARC result, or no stamp', () => {
    expect(dmarcResultFor(GMAIL, 'elsewhere.example')).toBeNull();
    expect(dmarcResultFor('mx.google.com; spf=pass smtp.mailfrom=me@owner.example', 'owner.example')).toBeNull();
    expect(dmarcResultFor(undefined, 'owner.example')).toBeNull();
    expect(dmarcResultFor(GMAIL, '')).toBeNull();
  });

  it('a pass is a pass, and nothing else is', () => {
    expect(dmarcPassFor(GMAIL, 'owner.example')).toBe(true);
    expect(dmarcPassFor(MICROSOFT, 'owner.example')).toBe(false);
    expect(dmarcPassFor('x; dmarc=passive header.from=owner.example', 'owner.example')).toBe(false);
  });
});

/** The owner's real Zoho sample, as the fixture keeps it: Zoho's stamp names no
 *  DMARC result (§8.11). */
const ZOHO = 'mx.zohomail.com; dkim=pass; spf=pass (zohomail.com: domain of sender@firm.example designates 192.0.2.10 '
  + 'as permitted sender)  smtp.mailfrom=sender@firm.example';

describe('D-318 step 8 — who wrote the stamp', () => {
  it('names the receiver: Gmail’s, Zoho’s, and nobody for Microsoft’s', () => {
    expect(stampAuthservId(GMAIL)).toBe('mx.google.com');
    expect(stampAuthservId(ZOHO)).toBe('mx.zohomail.com');
    expect(stampAuthservId('MX.Example.COM 1; none')).toBe('mx.example.com');
    expect(stampAuthservId(MICROSOFT)).toBe('');
    // Even a stamp that does not parse says who wrote it.
    expect(stampAuthservId('mx.example.com; spf=pass (unclosed')).toBe('mx.example.com');
  });
});

describe('D-318 step 8 — senderCheckFor: the receiver’s word on the From domain', () => {
  it('reads a stated verdict: Gmail’s pass, Microsoft’s fail and best-guess pass', () => {
    expect(senderCheckFor(GMAIL, 'owner.example')).toEqual({ stamped_by: 'mx.google.com', result: 'pass' });
    expect(senderCheckFor(MICROSOFT, 'owner.example')).toEqual({ stamped_by: '', result: 'fail' });
    expect(senderCheckFor('spf=pass smtp.mailfrom=owner.example;dmarc=bestguesspass action=none header.from=owner.example',
      'owner.example').result).toBe('pass');
  });

  it('derives a pass where the stamp states none — Zoho’s — from an SPF or DKIM pass for EXACTLY the domain', () => {
    expect(senderCheckFor(ZOHO, 'firm.example')).toEqual({ stamped_by: 'mx.zohomail.com', result: 'pass' });
    expect(senderCheckFor(ZOHO, 'FIRM.example').result).toBe('pass');
    // DKIM by its signing domain, or Gmail's `header.i`.
    expect(senderCheckFor('mx.x; dkim=pass header.d=firm.example', 'firm.example').result).toBe('pass');
    expect(senderCheckFor('mx.x; dkim=pass header.i=@firm.example header.s=s1', 'firm.example').result).toBe('pass');
    // `dmarc=none` is a domain without a policy: derived too.
    expect(senderCheckFor('mx.x; spf=pass smtp.mailfrom=firm.example; dmarc=none header.from=firm.example', 'firm.example')
      .result).toBe('pass');
    // OpenDKIM quotes a signature with `/` or `=` in it.
    expect(senderCheckFor('mx.x; dkim=pass header.d=firm.example header.b="Ab/c="', 'firm.example').result).toBe('pass');
  });

  it('derives nothing for another domain, a subdomain, a failed result, or a verdict the receiver could not make', () => {
    // Another sender's domain, or its bounce subdomain: not exactly the From domain.
    expect(senderCheckFor(ZOHO, 'owner.example').result).toBe('unknown');
    expect(senderCheckFor('mx.x; spf=pass smtp.mailfrom=bounce.firm.example', 'firm.example').result).toBe('unknown');
    expect(senderCheckFor('mx.x; dkim=pass header.d=mail.firm.example', 'firm.example').result).toBe('unknown');
    expect(senderCheckFor('mx.x; spf=softfail smtp.mailfrom=firm.example', 'firm.example').result).toBe('unknown');
    // Zoho's bare `dkim=pass` names no signing domain.
    expect(senderCheckFor('mx.zohomail.com; dkim=pass', 'firm.example').result).toBe('unknown');
    // The receiver said it could not tell: nothing is derived over it.
    expect(senderCheckFor('mx.x; spf=pass smtp.mailfrom=firm.example; dmarc=temperror header.from=firm.example',
      'firm.example').result).toBe('unknown');
    // Only the receiver says fail.
    expect(senderCheckFor('mx.x; spf=fail smtp.mailfrom=firm.example', 'firm.example').result).toBe('unknown');
  });

  it('says nothing without a stamp, and names no checker', () => {
    expect(senderCheckFor(undefined, 'firm.example')).toEqual({ stamped_by: null, result: 'unknown' });
    expect(senderCheckFor('  ', 'firm.example')).toEqual({ stamped_by: null, result: 'unknown' });
    expect(senderCheckFor(GMAIL, '')).toEqual({ stamped_by: 'mx.google.com', result: 'unknown' });
  });
});

/** ⛔ The envelope sender is the sender's to choose, and Gmail and Zoho write it
 *  into their own stamp. A quoted local part holding `)` and `;` closes the SPF
 *  comment early, leaving what reads as a result of the receiver's own. */
describe('D-318 step 8 — a sender’s text inside the receiver’s own stamp', () => {
  const inject = 'a);dmarc=pass header.from=owner.example;x=y (b';
  const mailfrom = `"${inject}"@evil.example`;
  /** Gmail's stamp of a forgery, its real verdict last, as Gmail orders them. */
  const gmailForged = `mx.google.com; spf=pass (google.com: domain of ${mailfrom} designates 192.0.2.9 as `
    + `permitted sender) smtp.mailfrom=${mailfrom}; dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=owner.example`;
  /** Zoho's: no verdict of its own to contradict the planted one. */
  const zohoForged = `mx.zohomail.com; dkim=pass; spf=pass (zohomail.com: domain of ${mailfrom} designates 192.0.2.9 `
    + `as permitted sender) smtp.mailfrom=${mailfrom}`;

  it('the receiver’s fail still refuses, though a planted pass reads first', () => {
    expect(dmarcResultFor(gmailForged, 'owner.example')).toBe('fail');
    expect(dmarcPassFor(gmailForged, 'owner.example')).toBe(false);
    expect(senderCheckFor(gmailForged, 'owner.example').result).toBe('fail');
  });

  it('where the receiver states no verdict, the planted one is not read as a pass', () => {
    expect(dmarcResultFor(zohoForged, 'owner.example')).toBeNull();
    expect(dmarcPassFor(zohoForged, 'owner.example')).toBe(false);
    expect(senderCheckFor(zohoForged, 'owner.example')).toEqual({ stamped_by: 'mx.zohomail.com', result: 'unknown' });
  });

  it('a comment left open cannot swallow the receiver’s fail', () => {
    const open = 'mx.google.com; spf=pass (google.com: domain of "a(b"@evil.example designates 192.0.2.9) '
      + 'smtp.mailfrom=x@evil.example; dmarc=fail (p=REJECT) header.from=owner.example';
    expect(dmarcResultFor(open, 'owner.example')).toBe('fail');
    expect(senderCheckFor(open, 'owner.example').result).toBe('fail');
  });

  it('nothing passes from a stamp with a quote in a comment, a backslash, a stray word, or two verdicts', () => {
    const shapes = [
      'mx.x; spf=pass (domain of "x"@owner.example) smtp.mailfrom=owner.example; dmarc=pass header.from=owner.example',
      'mx.x; spf=pass (a \\) b) smtp.mailfrom=owner.example; dmarc=pass header.from=owner.example',
      'mx.x; spf=pass smtp.mailfrom=owner.example stray; dmarc=pass header.from=owner.example',
      'mx.x; dmarc=pass header.from=owner.example; dmarc=pass header.from=owner.example',
      'mx.x; spf=pass smtp.mailfrom="a;b"@owner.example',
    ];
    for (const shape of shapes) {
      expect(senderCheckFor(shape, 'owner.example').result, shape).toBe('unknown');
      expect(dmarcPassFor(shape, 'owner.example'), shape).toBe(false);
    }
  });
});
