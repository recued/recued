/**
 * D-315 slice 2 — carrier tracking numbers, only with context (§7.1).
 *
 * A check digit rejects nine random numbers in ten, not all of them: one bare
 * 10-digit (DHL Express) or 12-digit (FedEx) order, invoice or account number
 * in ten passes, so the shape alone would turn ordinary mail from any sender
 * into shipments. A number of those shapes counts only when its check digit
 * holds AND the carrier is established: inside the carrier's own tracking link,
 * beside the carrier's name, in mail the carrier sent, or beside a tracking
 * label in mail that names that carrier and no other. UPS's `1Z…` and USPS's
 * 22-digit `9…` are specific enough on their own.
 *
 * Whatever its shape, a number an order, invoice, account or booking label
 * introduces is not a tracking number.
 *
 * Bounded and linear: the first `TEXT_MAX_CHARS` of the text and the first
 * `MAX_LINKS` links are read, each match looks only at the text around it, and
 * the matches of one shape are blanked in one pass.
 */

import { canonicalMailFactCarrier, canonicalMailFactText, MAIL_FACT_CARRIER_NAMES, type MailFactCarrier } from '@recued/contracts';

import { htmlLinks } from './html-scan.js';

export { MAIL_FACT_CARRIERS, type MailFactCarrier } from '@recued/contracts';

export interface FoundTrackingNumber {
  readonly carrier: MailFactCarrier;
  readonly tracking_number: string;
  /** The carrier's tracking link it was read from, when it was. */
  readonly tracking_url?: string;
}

/** FedEx Express, 12 digits: the first eleven weighted 3, 1, 7 from the left,
 *  the sum mod 11, and 10 read as 0. */
export const fedexCheckDigitHolds = (digits: string): boolean => {
  if (!/^\d{12}$/.test(digits)) return false;
  const weights = [3, 1, 7];
  let sum = 0;
  for (let i = 0; i < 11; i += 1) sum += Number(digits[i]) * weights[i % 3]!;
  return (sum % 11) % 10 === Number(digits[11]);
};

/** DHL Express, 10 digits: the first nine, as a number, mod 7. */
export const dhlCheckDigitHolds = (digits: string): boolean =>
  /^\d{10}$/.test(digits) && Number(digits.slice(0, 9)) % 7 === Number(digits[9]);

interface CarrierSpec {
  readonly carrier: MailFactCarrier;
  /** The carrier's name in running text. */
  readonly name: RegExp;
  /** Domains whose links and mail are the carrier's own. */
  readonly domains: readonly string[];
  /** The number's shape, global; separators allowed where carriers print them. */
  readonly shape: RegExp;
  /** Specific enough with no context. */
  readonly alone: boolean;
  readonly checkDigit?: (digits: string) => boolean;
}

/** In this order: the specific shapes first, and each match is blanked before
 *  the next carrier looks, so a spaced USPS number never yields a FedEx one. */
const CARRIERS: readonly CarrierSpec[] = [
  {
    carrier: 'UPS',
    name: MAIL_FACT_CARRIER_NAMES.UPS,
    domains: ['ups.com'],
    shape: /\b1Z(?: ?[0-9A-Z]){16}\b/gi,
    alone: true,
  },
  {
    carrier: 'USPS',
    name: MAIL_FACT_CARRIER_NAMES.USPS,
    domains: ['usps.com'],
    shape: /\b9\d{3}(?: ?\d{4}){4} ?\d{2}\b/g,
    alone: true,
  },
  {
    carrier: 'FedEx',
    name: MAIL_FACT_CARRIER_NAMES.FedEx,
    domains: ['fedex.com'],
    shape: /\b\d{4} ?\d{4} ?\d{4}\b/g,
    alone: false,
    checkDigit: fedexCheckDigitHolds,
  },
  {
    carrier: 'DHL',
    name: MAIL_FACT_CARRIER_NAMES.DHL,
    domains: ['dhl.com', 'dhl.de'],
    shape: /\b\d{10}\b/g,
    alone: false,
    checkDigit: dhlCheckDigitHolds,
  },
];

/** A tracking label (group 1), or a label that makes a number something else
 *  (group 2). The LAST one before a number decides. */
const LABEL = /(tracking(?:\s+(?:no\.?|number|#|id|code))?|track\s+(?:your\s+)?(?:package|parcel|shipment|order)|waybill|\bawb\b|sendungsnummer|sendungsverfolgung|num[eé]ro\s+de\s+suivi|n[uú]mero\s+de\s+seguimiento)|\b(order|invoice|account|acct|reference|booking|reservation|confirmation|customer|member|phone|tel|fax|mobile)\b/gi;

const LOOK_BEFORE = 120;
const LOOK_AFTER = 60;
/** Text past this is not read for numbers. */
const TEXT_MAX_CHARS = 200_000;
/** Links past these are not read: a link longer than a tracking link, or more
 *  links than a transactional email carries. */
const MAX_LINKS = 1_000;
const MAX_LINK_CHARS = 4_096;

const digitsOf = (text: string): string => text.replace(/ /g, '').toUpperCase();

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const onDomain = (host: string, domains: readonly string[]): boolean =>
  domains.some((domain) => host === domain || host.endsWith(`.${domain}`));

/** A link and any link a redirector wrapped inside it (`?u=https%3A…`): every
 *  `http` occurrence starts one, since an inner link runs to the end of the
 *  outer one and a single match would swallow it. */
const unwrapped = (url: string): string[] => {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // keep the raw text
  }
  const links = new Set([decoded]);
  for (const match of decoded.matchAll(/https?:\/\//gi)) {
    if (match.index === 0) continue;
    const rest = decoded.slice(match.index);
    const end = rest.search(/[\s"'<>]/);
    links.add(end < 0 ? rest : rest.slice(0, end));
  }
  return [...links];
};

const TEXT_URL = /https?:\/\/[^\s<>"')\]]+/gi;

/** The text around a match, not crossing a blank line. Only the look-around
 *  is searched for one, so a text with no blank line costs no more per match. */
const around = (text: string, start: number, end: number): { before: string; window: string } => {
  const lookFrom = Math.max(0, start - LOOK_BEFORE);
  const paragraphBefore = text.slice(lookFrom, start).lastIndexOf('\n\n');
  const from = paragraphBefore >= 0 ? lookFrom + paragraphBefore + 2 : lookFrom;
  const lookTo = Math.min(text.length, end + LOOK_AFTER);
  const paragraphAfter = text.slice(end, lookTo + 1).indexOf('\n\n');
  const to = paragraphAfter >= 0 && end + paragraphAfter < lookTo ? end + paragraphAfter : lookTo;
  return { before: text.slice(from, start), window: text.slice(from, to) };
};

/** `true` a tracking label introduces it, `false` another label does, `null` neither. */
const introducedAsTracking = (before: string): boolean | null => {
  let last: boolean | null = null;
  for (const match of before.slice(-60).matchAll(LABEL)) last = match[1] !== undefined;
  return last;
};

const hasTrackingLabel = (window: string): boolean => [...window.matchAll(LABEL)].some((m) => m[1] !== undefined);

export interface TrackingNumberSource {
  readonly subject: string;
  readonly body_text: string;
  readonly html: string | null;
  readonly from_address: string;
}

export const findTrackingNumbers = (source: TrackingNumberSource): FoundTrackingNumber[] => {
  // Read canonical (§9): a number in fullwidth digits, or a label with a
  // zero-width space in it, is the one written plainly. Each text is cut
  // before and after, so one that grows as it is read stays bounded.
  const read = (text: string): string => canonicalMailFactText(text.slice(0, TEXT_MAX_CHARS)).slice(0, TEXT_MAX_CHARS);
  const email = {
    subject: read(source.subject),
    body_text: read(source.body_text),
    html: source.html,
    from_address: read(source.from_address),
  };
  const found = new Map<string, FoundTrackingNumber>();
  const add = (entry: FoundTrackingNumber): void => {
    const key = `${entry.carrier}|${entry.tracking_number}`;
    const existing = found.get(key);
    if (existing === undefined || (existing.tracking_url === undefined && entry.tracking_url !== undefined)) {
      found.set(key, entry);
    }
  };

  const body = email.body_text;

  // 1. The carrier's own tracking links, from the HTML and from the text.
  const urls = [
    ...(email.html !== null ? htmlLinks(email.html).map((link) => read(link.href)) : []),
    ...[...`${email.subject}\n${body}`.matchAll(TEXT_URL)].map((m) => m[0]),
  ].filter((url) => url.length <= MAX_LINK_CHARS).slice(0, MAX_LINKS);
  for (const url of urls) {
    for (const candidate of unwrapped(url)) {
      const host = hostOf(candidate);
      if (host === null) continue;
      for (const spec of CARRIERS) {
        if (!onDomain(host, spec.domains)) continue;
        for (const match of candidate.matchAll(new RegExp(spec.shape.source, spec.shape.flags))) {
          const number = digitsOf(match[0]);
          if (spec.checkDigit !== undefined && !spec.checkDigit(number)) continue;
          add({ carrier: spec.carrier, tracking_number: number, tracking_url: candidate });
        }
      }
    }
  }

  // 2. The running text, with each shape's matches blanked before the next looks.
  let text = `${email.subject}\n\n${body.replace(TEXT_URL, (url) => ' '.repeat(url.length))}`;
  const senderHost = email.from_address.slice(email.from_address.lastIndexOf('@') + 1).toLowerCase();
  const named = CARRIERS.filter((spec) => spec.name.test(text) || onDomain(senderHost, spec.domains));
  for (const spec of CARRIERS) {
    const matches = [...text.matchAll(new RegExp(spec.shape.source, spec.shape.flags))];
    for (const match of matches) {
      const start = match.index!;
      const end = start + match[0].length;
      const number = digitsOf(match[0]);
      const { before, window } = around(text, start, end);
      const introduced = introducedAsTracking(before);
      if (introduced === false) continue;
      if (spec.checkDigit !== undefined && !spec.checkDigit(number)) continue;
      const established = spec.alone
        || spec.name.test(window)
        || onDomain(senderHost, spec.domains)
        || ((introduced === true || hasTrackingLabel(window)) && named.length === 1 && named[0] === spec);
      if (!established) continue;
      add({ carrier: spec.carrier, tracking_number: number });
    }
    if (matches.length > 0) {
      const parts: string[] = [];
      let at = 0;
      for (const match of matches) {
        parts.push(text.slice(at, match.index!), ' '.repeat(match[0].length));
        at = match.index! + match[0].length;
      }
      parts.push(text.slice(at));
      text = parts.join('');
    }
  }
  return [...found.values()];
};

/** A carrier's name as schema.org, a template or the AI writes it, canonical
 *  where it is one of the four (`Federal Express` → `FedEx`), so every pass
 *  names one parcel the same way and its identity joins. Every pass reaches it
 *  through `normalizeValue` for a `carrier` variable; the rule is contracts'. */
export const canonicalCarrierName = canonicalMailFactCarrier;
