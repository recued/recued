/** D-336 (spec §42) — what an approval says of an email passed as encoded text.
 *
 *  Gmail's `message.send_raw` takes the whole message base64url-encoded, so its approval read
 *  `body.raw: VG86IG1pYS53aGl0ZmllbGRA…`: neither whom it goes to nor what it is about could be
 *  read. Its headers say both, so the approval reads them: "An email to Mia Whitfield
 *  <mia.whitfield@example.test>; subject: Late". Only the start of the value is decoded, enough
 *  for the headers and never the body or an attachment. Display only: the call sends the value
 *  as it is. */

/** Encoded text: base64 or base64url, one unbroken token. */
const ENCODED = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;
/** How much is decoded: the headers of any email a person writes. */
const HEAD_CHARS = 8192;
/** An address inside a header, between the other parts of a mailbox. */
const ADDRESS_IN = /[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+\.[A-Za-z]{2,}/g;
/** A header line: a field name, a colon, its value. */
const HEADER = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/;

export interface EncodedEmailHeaders {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  /** Plain printable text only; an encoded word (`=?UTF-8?…?=`) is left out, never shown raw. */
  readonly subject?: string;
}

const decodeHead = (value: string): string | undefined => {
  const head = value.slice(0, HEAD_CHARS - (HEAD_CHARS % 4)).replace(/=+$/, '');
  const base64 = head.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  } catch {
    return undefined;
  }
};

/** The headers of an encoded email, or undefined for anything else: a value that does not
 *  decode, does not open with a header, or names no one to send to. */
export const readEncodedEmailHeaders = (value: unknown): EncodedEmailHeaders | undefined => {
  if (typeof value !== 'string' || !ENCODED.test(value)) return undefined;
  const text = decodeHead(value);
  if (text === undefined) return undefined;
  // The header block ends at the first empty line; a folded line continues the one before.
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((line) => line === '');
  const unfolded: string[] = [];
  for (const line of end < 0 ? lines : lines.slice(0, end)) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) unfolded[unfolded.length - 1] += ` ${line.trim()}`;
    else unfolded.push(line);
  }
  if (unfolded.length === 0 || !HEADER.test(unfolded[0]!)) return undefined;
  const fields = new Map<string, string[]>();
  for (const line of unfolded) {
    const match = HEADER.exec(line);
    if (match === null) continue;
    const name = match[1]!.toLowerCase();
    fields.set(name, [...(fields.get(name) ?? []), match[2]!]);
  }
  const addresses = (name: string): string[] =>
    [...new Set((fields.get(name) ?? []).flatMap((field) => field.match(ADDRESS_IN) ?? []))];
  const to = addresses('to');
  const cc = addresses('cc');
  const bcc = addresses('bcc');
  if (to.length + cc.length + bcc.length === 0) return undefined;
  const subject = fields.get('subject')?.[0]?.trim();
  const plain = subject !== undefined && subject !== '' && /^[\x20-\x7e]+$/.test(subject) && !subject.includes('=?');
  return { to, cc, bcc, ...(plain ? { subject } : {}) };
};

/** "An email to Mia Whitfield <mia@…>, bob@example.com; cc: …; subject: Late", each address as
 *  `nameOf` knows it. Undefined for anything that is not an encoded email. */
export const describeEncodedEmail = (
  value: unknown,
  nameOf?: (address: string) => string | undefined,
): string | undefined => {
  const headers = readEncodedEmailHeaders(value);
  if (headers === undefined) return undefined;
  // More than one leads with its count, as a list does, which a clipped line would otherwise lose.
  const people = (addresses: readonly string[]): string =>
    `${addresses.length > 1 ? `${addresses.length}: ` : ''}${addresses.map((a) => nameOf?.(a) ?? a).join(', ')}`;
  const parts = [
    headers.to.length > 0 ? `An email to ${people(headers.to)}` : 'An email',
    ...(headers.cc.length > 0 ? [`cc: ${people(headers.cc)}`] : []),
    ...(headers.bcc.length > 0 ? [`bcc: ${people(headers.bcc)}`] : []),
    ...(headers.subject !== undefined ? [`subject: ${headers.subject}`] : []),
  ];
  return parts.join('; ');
};
