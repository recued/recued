/** What the receiving provider's `Authentication-Results` stamp (RFC 8601)
 *  says about a message's sender — read where a door decides whose a message
 *  is: D-158's emailed approval answers (D-318 P23) and D-318's chat door (the
 *  audit's open items, and proof (b), step 8).
 *
 *  ⚠ ONLY THE RECEIVER'S STAMP COUNTS. A receiving server prepends its stamp,
 *  and the header map keeps a header's FIRST value (`mailHeaderMap`), so a
 *  stamp a sender planted further down is never the one read — on a server that
 *  stamps. One that stamps nothing leaves a planted stamp first: read as a
 *  pass it proves nothing a sender could not write, which is why a pass alone
 *  never lets a stranger's mail through (P23 needs the owner's address too; the
 *  chat door also needs the owner's Sent record, or, under proof (b), the
 *  checker the owner's own email showed, `stampAuthservId`), and a fail can
 *  only refuse.
 *
 *  ⛔ THE RECEIVER'S OWN STAMP CAN CARRY A SENDER'S TEXT (step 8). Gmail and Zoho
 *  write the envelope sender into the stamp, in an SPF comment and as
 *  `smtp.mailfrom=`. That address is the sender's to choose. A quoted local part
 *  can hold `)`, `;` and `=`, so `"a);dmarc=pass header.from=example.com;x=y (b"@evil.example`
 *  closes the comment early and leaves what reads as a result of the receiver's
 *  own: a `dmarc=pass` placed BEFORE the receiver's real `dmarc=fail`. So the
 *  two answers are read differently:
 *    - A FAIL from the raw text, whatever surrounds it: a sender can add text to
 *      the stamp but cannot take the receiver's verdict out of it. A planted
 *      fail only refuses the planter's own mail.
 *    - A PASS only from a stamp that parses cleanly: no quote or backslash
 *      anywhere (no receiver writes one into an address it is not quoting), the
 *      comments balanced, every result `method=result` followed by plain
 *      `name=value` properties, and at most one DMARC result for the domain. */

/** One result in a stamp: `spf=pass smtp.mailfrom=me@example.com`. */
interface StampResult {
  readonly method: string;
  readonly result: string;
  /** Its properties, `header.from` → `example.com`, lower case. */
  readonly props: Readonly<Record<string, string>>;
}

interface ParsedStamp {
  /** Who wrote it (`stampAuthservId`). */
  readonly authserv_id: string;
  readonly results: readonly StampResult[];
  /** Not the shape a receiver writes: no pass is read from it. */
  readonly suspect: boolean;
}

/** A property: `header.from=example.com`, or a value a receiver quoted
 *  (`header.b="AbC/="`, as OpenDKIM writes one with `/` or `=` in it). */
const PROPERTY = /^([a-z0-9_.-]+)=(?:"([^"\\;()\s]*)"|([a-z0-9._@+=/:-]+))$/;
const RESULT = /^([a-z0-9_.-]+)\s*=\s*([a-z0-9_-]+)(?:\s+([\s\S]*))?$/;

const quotes = (text: string): number => (text.match(/"/g) ?? []).length;

/** The stamp without its comments, nested ones too. `null` when a comment is
 *  not closed, or a `)` closes none. */
const withoutComments = (header: string): string | null => {
  let out = '';
  let depth = 0;
  for (const ch of header) {
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      if (depth === 0) return null;
      depth -= 1;
      if (depth === 0) out += ' ';
      continue;
    }
    if (depth === 0) out += ch;
  }
  return depth === 0 ? out : null;
};

/** Who wrote a stamp: the token before its first `;` — or nobody named, when
 *  that is already a result, as Microsoft's is. Read before anything else, so a
 *  stamp that does not parse still says who wrote it. */
const authservIdOf = (header: string): string => {
  const first = header.split(/[;(]/)[0]!.trim().toLowerCase();
  return first === '' || first.includes('=') ? '' : first.split(/\s+/)[0]!;
};

const parseStamp = (header: string): ParsedStamp => {
  const authserv_id = authservIdOf(header);
  const text = withoutComments(header);
  // A backslash escapes a character in a comment or a quoted value; a receiver
  // writing one is quoting a sender's text, and none of it is read as a pass.
  if (text === null || header.includes('\\')) return { authserv_id, results: [], suspect: true };
  // A quote inside a comment is the sender's text too: a receiver quotes only
  // a value.
  let suspect = quotes(header) !== quotes(text);
  const parts = text.toLowerCase().split(';').map((part) => part.trim());
  const results: StampResult[] = [];
  for (const part of authserv_id !== '' ? parts.slice(1) : parts) {
    if (part === '' || part === 'none') continue;
    const result = RESULT.exec(part);
    if (result === null) {
      suspect = true;
      continue;
    }
    const props = Object.create(null) as Record<string, string>;
    for (const token of (result[3] ?? '').split(/\s+/).filter((piece) => piece !== '')) {
      const property = PROPERTY.exec(token);
      if (property === null) {
        suspect = true;
        continue;
      }
      props[property[1]!] = property[2] ?? property[3]!;
    }
    results.push({ method: result[1]!, result: result[2]!, props });
  }
  return { authserv_id, results, suspect };
};

/** D-318 step 8 — who wrote a stamp: its authserv-id (RFC 8601 §2.5), the
 *  receiving server's own name for itself, lower case (`mx.google.com`,
 *  `mx.zohomail.com`). `''` for a stamp that names none: Microsoft's starts at
 *  its first result (`spf=pass …`). */
export const stampAuthservId = (header: string): string => parseStamp(header).authserv_id;

/** Does the stamp say, anywhere in its text, that the domain FAILED DMARC? Read
 *  raw, so no sender text around it can hide it. */
const dmarcFailFor = (header: string, domain: string): boolean => {
  const want = domain.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `\\bdmarc\\s*=\\s*fail\\b(?:[^;(]|\\([^)]*\\))*?\\bheader\\.from\\s*=\\s*"?${want}(?![a-z0-9.-])`, 'i',
  ).test(header);
};

/** The clean stamp's DMARC results for the domain, or `null` when no pass may
 *  be read from it. */
const dmarcResultsFor = (stamp: ParsedStamp, domain: string): readonly StampResult[] | null =>
  stamp.suspect ? null : stamp.results.filter((result) =>
    result.method === 'dmarc' && result.props['header.from'] === domain);

/** The DMARC result the stamp reports for `domain`: `pass`, `fail`, `none` (the
 *  domain publishes no policy), `temperror`, `permerror`, or a provider's own
 *  word (Microsoft's `bestguesspass`). `null` when the stamp is absent or names
 *  no DMARC result for that domain — and when a pass could not be trusted: a
 *  stamp that does not parse cleanly, or one with two results for the domain.
 *  `fail` wins over anything else in it. Comments are left out:
 *  `dmarc=pass (p=NONE) header.from=example.com`. A stamp with no authserv-id
 *  (Microsoft's starts at its first result) reads the same. */
export const dmarcResultFor = (header: string | undefined, domain: string): string | null => {
  if (header === undefined || domain === '') return null;
  const want = domain.toLowerCase();
  if (dmarcFailFor(header, want)) return 'fail';
  const dmarc = dmarcResultsFor(parseStamp(header), want);
  return dmarc !== null && dmarc.length === 1 ? dmarc[0]!.result : null;
};

/** Does the stamp report a DMARC pass for `domain`? */
export const dmarcPassFor = (header: string | undefined, domain: string): boolean =>
  dmarcResultFor(header, domain) === 'pass';

/** The domain of an address-or-domain property value: `me@example.com` and
 *  `example.com` are both `example.com`. */
const domainPart = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : value.slice(value.lastIndexOf('@') + 1);

/** An SPF pass for the envelope sender's domain, or a DKIM pass by the signing
 *  domain, that is exactly `domain`. */
const alignedPassFor = (stamp: ParsedStamp, domain: string): boolean => {
  const spf = stamp.results.filter((result) => result.method === 'spf');
  // One envelope, one SPF result: two is not a shape a receiver writes.
  if (spf.length === 1 && spf[0]!.result === 'pass' && domainPart(spf[0]!.props['smtp.mailfrom']) === domain) return true;
  return stamp.results.some((result) => result.method === 'dkim' && result.result === 'pass'
    && (result.props['header.d'] ?? domainPart(result.props['header.i'])) === domain);
};

export type SenderCheckResult = 'pass' | 'fail' | 'unknown';

export interface SenderCheck {
  /** Who made the check (`stampAuthservId`): `''` for a stamp that names
   *  none, `null` when there is no stamp. */
  readonly stamped_by: string | null;
  readonly result: SenderCheckResult;
}

/** D-318 step 8 — the receiver's word, in its first stamp, on whether `domain`'s
 *  own servers sent a message.
 *
 *  `result` is the stamp's DMARC verdict for the domain: `pass` (Microsoft's
 *  `bestguesspass` too — no policy published, but the check aligned), `fail`,
 *  or `unknown`.
 *
 *  ⚠ WHERE THE STAMP GIVES NO VERDICT FOR THE DOMAIN, A PASS IS DERIVED as DMARC
 *  would: an SPF pass whose `smtp.mailfrom` domain, or a DKIM pass whose signing
 *  domain, is EXACTLY `domain`. Zoho's stamps never give a verdict (§8.11), and
 *  `dmarc=none` means a domain without a policy. The match is exact, not DMARC's
 *  relaxed one: that needs the public suffix list to find two names' common
 *  organisation. An exact match passes under every policy, so a derived pass is
 *  never one DMARC would fail. A subdomain's bounce address
 *  (`bounce.example.com`) just goes unproven. A derived verdict is `pass` or
 *  `unknown`, never `fail`: only the receiver says fail. A `temperror` or
 *  `permerror` is the receiver saying it could not tell, and nothing is derived
 *  over it. */
export const senderCheckFor = (header: string | undefined, domain: string): SenderCheck => {
  if (header === undefined || header.trim() === '') return { stamped_by: null, result: 'unknown' };
  const stamp = parseStamp(header);
  const want = domain.toLowerCase();
  if (want === '') return { stamped_by: stamp.authserv_id, result: 'unknown' };
  if (dmarcFailFor(header, want)) return { stamped_by: stamp.authserv_id, result: 'fail' };
  const dmarc = dmarcResultsFor(stamp, want);
  if (dmarc === null || dmarc.length > 1) return { stamped_by: stamp.authserv_id, result: 'unknown' };
  const verdict = dmarc[0]?.result;
  if (verdict === 'pass' || verdict === 'bestguesspass') return { stamped_by: stamp.authserv_id, result: 'pass' };
  if (verdict !== undefined && verdict !== 'none') return { stamped_by: stamp.authserv_id, result: 'unknown' };
  return { stamped_by: stamp.authserv_id, result: alignedPassFor(stamp, want) ? 'pass' : 'unknown' };
};
