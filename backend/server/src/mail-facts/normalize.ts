/**
 * D-315 — reading a value into its kind (§3.2, §4.2, §9).
 *
 * A rule finds text; this turns it into a value of the variable's kind, or
 * refuses it with a reason. Refused, never coerced: a value that is not what
 * its kind says stays `null`, and the facts list shows why.
 *
 * `money` and `date` are read per locale, so a German `12,50 €` and a US
 * `$12.50` both land as money. What cannot be told apart is refused rather
 * than guessed: a date that could be day or month first, unless the rule's
 * locale says which (`en` alone does not: the US and the UK disagree); a zone
 * abbreviation several zones use (`CST`, `IST`, `BST`) without a region. An
 * amount is read by its currency's own decimals — `KWD 12.500` is twelve and a
 * half dinars, not twelve thousand — and a number that begins `0.` has a
 * decimal point, whatever follows.
 *
 * Two safety rules live here too (§9): `account_ref` keeps only its last four
 * characters, and a full card number is refused wherever it appears in a fact.
 *
 * Spec: D-315 §3.2, §4.2, §9.
 */

import {
  canonicalMailFactText,
  mailFactStoredId,
  mailFactStoredText,
  type MailFactMoney,
  type MailFactValue,
  type MailFactVariableKind,
} from '@recued/contracts';

import { canonicalCarrierName } from './tracking-numbers.js';

/** Bump when a value is read differently — a date, a time or its zone, an
 *  amount, a number, what is refused. A fact's source names the version that
 *  read it, so a backfill reads again, rather than keeps, what an older reader
 *  read (ruling 13): read by `d8bf5bac7`, *9:00–10:00 PM* was nine in the
 *  morning, and a backfill kept it so after the reader came to read nine at
 *  night. 1: as the twenty-fourth round reads. 2: every reader reads text as
 *  `canonicalMailFactText` gives it, and a fact stores text so. 3: a date and a
 *  time are read whole — a fraction of a second, and seconds after a dot, as
 *  well — and a number or an amount is checked for a card once read. */
export const MAIL_FACT_READING_VERSION = 3;

export type NormalizeResult =
  | { readonly ok: true; readonly value: MailFactValue }
  | { readonly ok: false; readonly reason: string };

const ok = (value: MailFactValue): NormalizeResult => ({ ok: true, value });
const refuse = (reason: string): NormalizeResult => ({ ok: false, reason });

/** A variable's text is short by nature; data is bounded by the fact's cap. */
export const MAX_VARIABLE_TEXT_LENGTH = 1000;

/** Found text as every reader here reads it (§9): as a fact stores text —
 *  canonical (`canonicalMailFactText`: a fullwidth `４` is a `4`, a zero-width
 *  space is nothing), on one line. */
const readable = mailFactStoredText;

/** Found text as a refusal quotes it: short, so a reason stored on a fact and
 *  carried by its events never holds a page of the email. */
const quoted = (text: string): string => `'${text.length > 60 ? `${text.slice(0, 57)}…` : text}'`;

// ────────────────────────────────────────────────────────────────
// Locale
// ────────────────────────────────────────────────────────────────

/** Languages that write a decimal COMMA (`12,50`). Everything else is read with
 *  a decimal point. */
const COMMA_DECIMAL_LANGUAGES = new Set([
  'de', 'fr', 'es', 'it', 'nl', 'pt', 'da', 'sv', 'nb', 'no', 'fi', 'pl', 'cs', 'sk', 'hu',
  'ro', 'bg', 'hr', 'sl', 'lt', 'lv', 'et', 'el', 'tr', 'ru', 'uk', 'id', 'vi',
]);

const languageOf = (locale: string | undefined): string | undefined =>
  locale === undefined ? undefined : locale.toLowerCase().split('-')[0];

/** Month-first dates are a US convention; every other locale reads day first.
 *  English alone names no convention — the US and the UK write it both ways —
 *  so it decides nothing. */
const monthFirst = (locale: string | undefined): boolean | undefined => {
  if (locale === undefined) return undefined;
  const lower = locale.toLowerCase().replace('_', '-');
  if (lower === 'en') return undefined;
  return lower === 'en-us' || lower === 'en-ph' || lower === 'en-ca-us';
};

/** How a number's marks are read when the locale does not say. */
export interface DecimalHints {
  /** The decimal mark is this, whatever the locale: schema.org writes `.`. */
  readonly decimalMark?: '.' | ',';
  /** The currency's own decimals (KWD 3, USD 2, JPY 0): with three, a lone mark
   *  before three digits is its decimal mark. */
  readonly minorDigits?: number;
}

// ────────────────────────────────────────────────────────────────
// Numbers and money
// ────────────────────────────────────────────────────────────────

/** Read a number written with thousands separators and a decimal mark, as a
 *  plain decimal string (`1.234,50` de → `1234.50`). `null` when it is not one. */
export const readDecimal = (raw: string, locale?: string, hints: DecimalHints = {}): string | null => {
  let text = raw.trim().replace(/[  ']/g, ' ');
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith('-') || text.startsWith('−')) {
    negative = true;
    text = text.slice(1).trim();
  }
  if (!/^[\d][\d.,\s]*$/.test(text)) return null;
  // A space — an apostrophe, a no-break space — groups thousands and nothing
  // else: `1 250` is twelve hundred and fifty, `12 50` is no number.
  if (/\s/.test(text) && !/^\d{1,3}(?:\s\d{3})+(?:[.,]\d+)?$/.test(text)) return null;
  const compact = text.replace(/\s/g, '');
  const language = languageOf(locale);
  let decimalMark: '.' | ',' | null;
  if (hints.decimalMark !== undefined) {
    decimalMark = hints.decimalMark;
  } else if (language !== undefined) {
    decimalMark = COMMA_DECIMAL_LANGUAGES.has(language) ? ',' : '.';
  } else {
    // No locale: the rightmost mark is the decimal one when both appear. A
    // lone mark before exactly three digits separates thousands — unless the
    // number begins `0` (`0.125`, which no thousands can), or its currency has
    // three decimals (`KWD 12.500`).
    const lastDot = compact.lastIndexOf('.');
    const lastComma = compact.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      decimalMark = lastDot > lastComma ? '.' : ',';
    } else if (lastDot >= 0 || lastComma >= 0) {
      const mark = lastDot >= 0 ? '.' : ',';
      const after = compact.length - compact.lastIndexOf(mark) - 1;
      const occurrences = compact.split(mark).length - 1;
      const decimalOnly = compact.startsWith('0') || hints.minorDigits === 3;
      decimalMark = occurrences > 1 || (after === 3 && !decimalOnly) ? null : mark;
    } else {
      decimalMark = null;
    }
  }
  let [whole, fraction] = decimalMark === null
    ? [compact, undefined]
    : [compact.slice(0, compact.lastIndexOf(decimalMark)), compact.slice(compact.lastIndexOf(decimalMark) + 1)];
  if (decimalMark !== null && !compact.includes(decimalMark)) {
    whole = compact;
    fraction = undefined;
  }
  // What is left of the decimal mark separates thousands, in groups of three
  // (or India's lakh: `1,23,456`) — else it was never a thousands mark, and
  // `12,50` read with a decimal point is refused, not read as 1250.
  const marks = [...new Set(whole.match(/[.,]/g) ?? [])];
  if (marks.length > 1 || (marks.length === 1 && marks[0] === decimalMark)) return null;
  if (marks.length === 1) {
    const western = marks[0] === '.' ? /^\d{1,3}(?:\.\d{3})+$/ : /^\d{1,3}(?:,\d{3})+$/;
    if (!western.test(whole) && !(marks[0] === ',' && /^\d{1,2}(?:,\d{2})+,\d{3}$/.test(whole))) return null;
    whole = whole.replace(/[.,]/g, '');
  }
  if (!/^\d+$/.test(whole) || (fraction !== undefined && !/^\d+$/.test(fraction))) return null;
  const trimmedWhole = whole.replace(/^0+(?=\d)/, '');
  const value = fraction === undefined ? trimmedWhole : `${trimmedWhole}.${fraction}`;
  return negative && /[1-9]/.test(value) ? `-${value}` : value;
};

/** Currency symbols with one clear meaning. `$` is read as USD unless a
 *  country prefix says otherwise (`CA$`, `A$`). */
const CURRENCY_SYMBOLS: ReadonlyArray<readonly [string, string]> = [
  ['US$', 'USD'], ['CA$', 'CAD'], ['C$', 'CAD'], ['AU$', 'AUD'], ['A$', 'AUD'], ['NZ$', 'NZD'],
  ['HK$', 'HKD'], ['S$', 'SGD'], ['R$', 'BRL'], ['MX$', 'MXN'], ['$', 'USD'], ['€', 'EUR'],
  ['£', 'GBP'], ['¥', 'JPY'], ['₹', 'INR'], ['₩', 'KRW'], ['₺', 'TRY'], ['₪', 'ILS'],
  ['₫', 'VND'], ['฿', 'THB'], ['₱', 'PHP'], ['zł', 'PLN'], ['Kč', 'CZK'], ['CHF', 'CHF'],
];

/** ISO 4217 codes the runtime knows, so a stray upper-case word (`VAT`) is not
 *  read as a currency. Empty on a runtime without `Intl.supportedValuesOf`, in
 *  which case any three capitals are accepted. */
const ISO_CURRENCIES: ReadonlySet<string> = (() => {
  try {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    return new Set(supported === undefined ? [] : supported('currency'));
  } catch {
    return new Set<string>();
  }
})();

const isIsoCurrency = (code: string): boolean => ISO_CURRENCIES.size === 0 || ISO_CURRENCIES.has(code);

/** A bare `$` by the rule's locale region; USD otherwise. */
const DOLLAR_BY_REGION: ReadonlyMap<string, string> = new Map([
  ['ca', 'CAD'], ['au', 'AUD'], ['nz', 'NZD'], ['sg', 'SGD'], ['hk', 'HKD'], ['mx', 'MXN'],
  ['ar', 'ARS'], ['cl', 'CLP'], ['co', 'COP'], ['tw', 'TWD'],
]);

/** A currency's own decimals: KWD 3, USD 2, JPY 0. */
const minorDigitsOf = (currency: string): number => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
};

/** Read an amount and its currency (`12,50 €`, `$1,234.56`, `EUR 12.50`). */
export const parseMoney = (raw: string, locale?: string, hints: Pick<DecimalHints, 'decimalMark'> = {}): NormalizeResult => {
  const text = readable(raw);
  if (text.length === 0) return refuse('no amount');
  let currency: string | undefined;
  let rest = text;
  for (const [symbol, code] of CURRENCY_SYMBOLS) {
    const at = rest.indexOf(symbol);
    if (at >= 0) {
      const region = locale?.toLowerCase().split('-')[1];
      currency = symbol === '$' && region !== undefined ? DOLLAR_BY_REGION.get(region) ?? code : code;
      rest = `${rest.slice(0, at)} ${rest.slice(at + symbol.length)}`;
      break;
    }
  }
  if (currency === undefined) {
    for (const match of rest.matchAll(/\b([A-Z]{3})\b/g)) {
      if (isIsoCurrency(match[1]!)) {
        currency = match[1]!;
        rest = rest.replace(match[0], ' ');
        break;
      }
    }
  }
  if (currency === undefined) return refuse('no currency');
  const amount = readDecimal(rest.replace(/^[\s:]+|[\s:]+$/g, ''), locale, {
    ...hints,
    minorDigits: minorDigitsOf(currency),
  });
  if (amount === null) return refuse(`${quoted(text)} is not an amount`);
  const money: MailFactMoney = { amount, currency };
  return ok(money);
};

// ────────────────────────────────────────────────────────────────
// Dates and times
// ────────────────────────────────────────────────────────────────

/** Month names and their common short forms, in the languages whose senders an
 *  owner most often receives mail from. Keys are lower case, without a dot. */
const MONTHS: ReadonlyMap<string, number> = (() => {
  const table: Record<number, string[]> = {
    1: ['january', 'jan', 'januar', 'janvier', 'janv', 'enero', 'ene', 'gennaio', 'gen', 'januari', 'janeiro'],
    2: ['february', 'feb', 'februar', 'février', 'fevrier', 'févr', 'fevr', 'febrero', 'febbraio', 'februari', 'fevereiro', 'fev'],
    3: ['march', 'mar', 'märz', 'maerz', 'mars', 'marzo', 'maart', 'março', 'marco', 'mär'],
    4: ['april', 'apr', 'avril', 'avr', 'abril', 'abr', 'aprile'],
    5: ['may', 'mai', 'mayo', 'maggio', 'mag', 'mei', 'maio'],
    6: ['june', 'jun', 'juni', 'juin', 'junio', 'giugno', 'giu', 'junho'],
    7: ['july', 'jul', 'juli', 'juillet', 'juil', 'julio', 'luglio', 'lug', 'julho'],
    8: ['august', 'aug', 'août', 'aout', 'agosto', 'ago', 'augustus'],
    9: ['september', 'sep', 'sept', 'septembre', 'septiembre', 'settembre', 'set', 'setembro'],
    10: ['october', 'oct', 'oktober', 'okt', 'octobre', 'octubre', 'ottobre', 'ott', 'outubro', 'out'],
    11: ['november', 'nov', 'novembre', 'noviembre', 'novembro'],
    12: ['december', 'dec', 'dezember', 'dez', 'décembre', 'decembre', 'déc', 'diciembre', 'dic', 'dicembre', 'dezembro'],
  };
  const map = new Map<string, number>();
  for (const [month, names] of Object.entries(table)) {
    for (const name of names) map.set(name, Number(month));
  }
  return map;
})();

const pad2 = (n: number): string => String(n).padStart(2, '0');

const validDate = (year: number, month: number, day: number): string | null => {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
};

const fullYear = (year: number): number => (year < 100 ? 2000 + year : year);

/** Read a date (`2026-09-26`, `26.09.2026`, `September 26, 2026`,
 *  `26 septembre 2026`) as `YYYY-MM-DD`. The date is read from the start of
 *  the text; anything after it (a time) is left for `parseDateTime`. */
const readDate = (
  raw: string,
  locale?: string,
): { readonly date: string; readonly rest: string } | { readonly error: string } => {
  const text = readable(raw).replace(/^[A-Za-zÀ-ÿ]{2,9}\.?,?\s+(?=\d|[A-Za-zÀ-ÿ]{3})/, (weekday) =>
    // Drop a leading weekday ("Fri, Sep 26 2026"), but not a month name.
    MONTHS.has(weekday.replace(/[.,\s]/g, '').toLowerCase()) ? weekday : '',
  );
  // Each read whole: a digit past it (`2026-09-280`) makes it no date, not the
  // one it begins with. Words after it are no part of it.
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(text);
  if (m !== null) {
    const date = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    return date === null ? { error: `${quoted(raw)} is not a real date` } : { date, rest: text.slice(m[0].length) };
  }
  m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?!\d)/.exec(text);
  if (m !== null) {
    const date = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    return date === null ? { error: `${quoted(raw)} is not a real date` } : { date, rest: text.slice(m[0].length) };
  }
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?!\d)/.exec(text);
  if (m !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = fullYear(Number(m[3]));
    let first = monthFirst(locale);
    if (first === undefined) {
      if (a > 12 && b <= 12) first = false;
      else if (b > 12 && a <= 12) first = true;
      else if (a === b) first = false;
      else return { error: `${quoted(raw)} could be either day or month first; the rule needs a locale` };
    }
    const date = first ? validDate(year, a, b) : validDate(year, b, a);
    return date === null ? { error: `${quoted(raw)} is not a real date` } : { date, rest: text.slice(m[0].length) };
  }
  // Month name first: "September 26, 2026", "Sep. 26 2026".
  m = /^([A-Za-zÀ-ÿ]{3,10})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)/.exec(text);
  if (m !== null && MONTHS.has(m[1]!.toLowerCase())) {
    const date = validDate(Number(m[3]), MONTHS.get(m[1]!.toLowerCase())!, Number(m[2]));
    return date === null ? { error: `${quoted(raw)} is not a real date` } : { date, rest: text.slice(m[0].length) };
  }
  // Day first: "26 September 2026", "26. September 2026", "26 de septiembre de 2026".
  m = /^(\d{1,2})(?:st|nd|rd|th)?\.?\s+(?:de\s+)?([A-Za-zÀ-ÿ]{3,10})\.?,?\s+(?:de\s+)?(\d{4})(?!\d)/.exec(text);
  if (m !== null && MONTHS.has(m[2]!.toLowerCase())) {
    const date = validDate(Number(m[3]), MONTHS.get(m[2]!.toLowerCase())!, Number(m[1]));
    return date === null ? { error: `${quoted(raw)} is not a real date` } : { date, rest: text.slice(m[0].length) };
  }
  return { error: `${quoted(raw)} is not a date` };
};

export const parseDate = (raw: string, locale?: string): NormalizeResult => {
  const read = readDate(raw, locale);
  return 'error' in read ? refuse(read.error) : ok(read.date);
};

/** Zone abbreviations a sender commonly writes, as minutes east of UTC. */
const ZONES: ReadonlyMap<string, number> = new Map([
  ['z', 0], ['utc', 0], ['gmt', 0], ['wet', 0], ['cet', 60], ['cest', 120],
  ['eet', 120], ['eest', 180], ['msk', 180], ['sgt', 480], ['hkt', 480],
  ['jst', 540], ['kst', 540], ['aest', 600], ['aedt', 660], ['nzst', 720], ['nzdt', 780],
  ['est', -300], ['edt', -240], ['cdt', -300], ['mst', -420], ['mdt', -360],
  ['pst', -480], ['pdt', -420], ['akst', -540], ['akdt', -480], ['hst', -600],
]);

/** Abbreviations several zones share, told apart by the locale's region:
 *  China's CST and the US's, India's IST, Ireland's and Israel's, the UK's
 *  summer time and Bangladesh's. */
const SHARED_ZONES: ReadonlyMap<string, ReadonlyMap<string, number>> = new Map([
  ['cst', new Map([['us', -360], ['ca', -360], ['mx', -360], ['cn', 480], ['tw', 480], ['cu', -300]])],
  ['ist', new Map([['in', 330], ['ie', 60], ['il', 120]])],
  ['bst', new Map([['gb', 60], ['uk', 60], ['bd', 360]])],
]);

const offsetText = (minutes: number): string => {
  if (minutes === 0) return 'Z';
  const sign = minutes > 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
};

/** The widest offset a time zone has: Kiribati's +14:00. */
const MAX_OFFSET_MINUTES = 14 * 60;

/** An offset as written (`+0200`, `+02:00`, with a minus sign too) as ISO
 *  writes it, or `null` for one no time zone has — minutes past 59, or past
 *  ±14:00. */
const offsetOf = (text: string): string | null => {
  const offset = /^([+\u2212-])(\d{2}):?(\d{2})$/.exec(text);
  if (offset === null) return null;
  const [, sign, hours, minutes] = offset;
  if (Number(minutes) > 59 || Number(hours) * 60 + Number(minutes) > MAX_OFFSET_MINUTES) return null;
  return `${sign === '+' ? '+' : '-'}${hours}:${minutes}`;
};

/** An offset written after a zone's name (`+2`, `+0200`, `+5:30`) as minutes
 *  east of UTC, or `null` for one no time zone has, or one not read whole. */
const offsetMinutesOf = (text: string): number | null => {
  const offset = /^([+\u2212-])(\d{1,2})(?::?(\d{2}))?$/.exec(text);
  if (offset === null) return null;
  const [, sign, hours, minutes = '00'] = offset;
  const total = Number(hours) * 60 + Number(minutes);
  if (Number(minutes) > 59 || total > MAX_OFFSET_MINUTES) return null;
  return sign === '+' ? total : -total;
};

const noOffset = (raw: string): NormalizeResult => refuse(`${quoted(raw)} has an offset no time zone has`);

/** GMT and UTC: an offset written after either is the zone (`GMT+2`). */
const UTC_NAMES: ReadonlySet<string> = new Set(['gmt', 'utc']);

/** The zone written after a time, read whole: a zone's name, an offset
 *  (`-0700`, `(+02:00)`), or both (`GMT+2`, `UTC+08:00`, `CEST +0200`). After
 *  GMT or UTC the offset is the zone; after another name it is that zone's
 *  own — which tells apart the zones a name is shared by — or the text states
 *  two zones and neither is taken. A name no zone has is none: a local time,
 *  as when nothing follows. `''` for no zone. */
const zoneAfter = (
  text: string,
  raw: string,
  locale: string | undefined,
): { readonly zone: string } | { readonly error: string } => {
  const named = /^\s*\(?\s*([A-Za-z]{1,5})(?:\s*([+\u2212-]\d[\d:]*))?/.exec(text);
  if (named !== null) {
    const name = named[1]!.toLowerCase();
    const own = UTC_NAMES.has(name) ? 0 : ZONES.get(name);
    const shared = SHARED_ZONES.get(name);
    if (named[2] !== undefined) {
      const stated = offsetMinutesOf(named[2]);
      if (stated === null) return { error: `${quoted(raw)} has an offset no time zone has` };
      if (UTC_NAMES.has(name) || own === stated || [...(shared?.values() ?? [])].includes(stated)) {
        return { zone: offsetText(stated) };
      }
      if (own !== undefined || shared !== undefined) {
        return { error: `${quoted(raw)} names a time zone and an offset it does not have` };
      }
      return { zone: '' };
    }
    if (shared !== undefined) {
      const minutes = shared.get(locale?.toLowerCase().replace('_', '-').split('-')[1] ?? '');
      if (minutes === undefined) {
        return { error: `'${named[1]}' is the name of several time zones; the rule needs a locale with its country` };
      }
      return { zone: offsetText(minutes) };
    }
    return { zone: own === undefined ? '' : offsetText(own) };
  }
  // Read whole: a digit or a colon past it (`+02:000`, `-070099`) makes it no
  // offset a zone has — read as its first four, it was taken as `+02:00`.
  const bare = /^\s*\(?\s*([+\u2212-]\d{2}:?\d{2})([\d:]*)/.exec(text);
  if (bare === null) return { zone: '' };
  const offset = bare[2] === '' ? offsetOf(bare[1]!) : null;
  return offset === null ? { error: `${quoted(raw)} has an offset no time zone has` } : { zone: offset };
};

interface Clock {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** A time of day from its parts — hour, minutes, seconds, a.m. or p.m. — or
 *  `null` for one that does not exist. `meridiem` reads it in that half of the
 *  day instead of the one its parts say. */
const clockOf = (parts: readonly (string | undefined)[], meridiemText = parts[4]): Clock | null => {
  let hour = Number(parts[1]);
  const minute = parts[2] === undefined ? 0 : Number(parts[2]);
  const second = parts[3] === undefined ? 0 : Number(parts[3]);
  const meridiem = meridiemText?.toLowerCase().replace(/\./g, '');
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
};

/** The end of a range of times after its start — `-12:00`, ` - 11:00 AM`,
 *  `–11 am`: a dash right after a time, or one with a space on each side. An
 *  offset is written after a space (`10:00:00 -0700`), and a range's end is no
 *  offset: the zone written after it is the range's. */
const RANGE_END_RE = /^(?:\s*[\u2013\u2014]\s*|-|\s+-\s+)(\d{1,2})(?:[:.h](\d{2}))?(?:[:.](\d{2}))?(?:\s*(a\.?m\.?|p\.?m\.?))?/i;

/** More figures right after a time — a digit, or a separator and a digit
 *  (`10:000`, `10:00:0`, `10am5`): it is no time. Read by its beginning, it
 *  was taken as ten o'clock, and met a required time's entrance. */
const MORE_FIGURES_RE = /^[:.h]?\d/i;

const secondsOf = (clock: Clock): number => clock.hour * 3600 + clock.minute * 60 + clock.second;

/** A range's start whose a.m. or p.m. only its end says (`9:00\u201310:00 PM`): in
 *  the end's half of the day \u2014 or in the other, when that one would put it
 *  after the end (`11:00\u20131:00 PM` is 11 AM). A start written as a 24-hour time
 *  keeps it. */
const rangeStartOf = (start: RegExpExecArray, meridiem: string, end: Clock): Clock | null => {
  const hour = Number(start[1]);
  if (hour < 1 || hour > 12) return clockOf(start);
  const same = clockOf(start, meridiem);
  if (same === null) return null;
  return secondsOf(same) <= secondsOf(end) ? same : clockOf(start, /^p/i.test(meridiem) ? 'am' : 'pm');
};

/** Read a date and a time as ISO 8601. With the zone when the text states one;
 *  otherwise a local time without an offset — a check-in at "3:00 PM" is the
 *  venue's local time, which the email's own clock would get wrong. The zone
 *  is read whole or refused: `GMT+0200` is two hours east of UTC, not UTC. A
 *  range (`10:00-12:00`) is read by its start, with the zone written after it. */
export const parseDateTime = (raw: string, locale?: string): NormalizeResult => {
  const text = readable(raw);
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(text);
  if (iso !== null) {
    const date = parseDate(iso[1]!);
    if (!date.ok) return date;
    if (Number(iso[2]) > 23 || Number(iso[3]) > 59 || Number(iso[4] ?? 0) > 59) return refuse(`${quoted(raw)} is not a real time`);
    // A fraction of a second is kept: two observations of one second are two.
    // Only after the seconds, and none when it is all zeros.
    if (iso[5] !== undefined && iso[4] === undefined) return refuse(`${quoted(raw)} is not a real time`);
    const fraction = iso[5] !== undefined && /[1-9]/.test(iso[5]) ? iso[5] : '';
    let zone = '';
    if (iso[6] !== undefined) {
      const offset = iso[6].toUpperCase() === 'Z' ? 'Z' : offsetOf(iso[6]);
      if (offset === null) return noOffset(raw);
      zone = offset;
    }
    return ok(`${date.value as string}T${iso[2]}:${iso[3]}:${iso[4] ?? '00'}${fraction}${zone}`);
  }
  const read = readDate(text, locale);
  if ('error' in read) return refuse(read.error);
  // Seconds after a colon or a dot (`10.30.45`), and a fraction of a second
  // after them, which is kept, as ISO keeps it.
  const time = /^[\s,]*(?:at|um|à|a las|alle|om|às)?\s*(\d{1,2})(?:[:.h](\d{2}))?(?:[:.](\d{2})(?:\.\d+)?)?(?:\s*(a\.?m\.?|p\.?m\.?))?/i.exec(read.rest);
  if (time === null) return refuse(`${quoted(raw)} has a date but no time`);
  let after = read.rest.slice(time[0].length);
  if (MORE_FIGURES_RE.test(after)) return refuse(`${quoted(raw)} is not a real time`);
  // The fraction, read where the time above read it: after its minutes and seconds.
  const written = /^[\s,]*(?:at|um|à|a las|alle|om|às)?\s*\d{1,2}[:.h]\d{2}[:.]\d{2}(\.\d+)/i.exec(read.rest)?.[1];
  const fraction = written !== undefined && /[1-9]/.test(written) ? written : '';
  // A range's end — a time — is read before its start: the zone is written
  // after it, and so may the a.m. or p.m. the start leaves to it.
  const range = RANGE_END_RE.exec(after);
  const end = range !== null && (range[2] !== undefined || range[4] !== undefined) ? clockOf(range) : null;
  if (end !== null) {
    after = after.slice(range![0].length);
    if (MORE_FIGURES_RE.test(after)) return refuse(`${quoted(raw)} is not a real time`);
  }
  const shared = end !== null && time[4] === undefined ? range![4] : undefined;
  if (time[2] === undefined && time[4] === undefined && shared === undefined) {
    return refuse(`${quoted(raw)} has a date but no time`);
  }
  const clock = shared === undefined ? clockOf(time) : rangeStartOf(time, shared, end!);
  if (clock === null) return refuse(`${quoted(raw)} is not a real time`);
  const zone = zoneAfter(after, raw, locale);
  if ('error' in zone) return refuse(zone.error);
  return ok(`${read.date}T${pad2(clock.hour)}:${pad2(clock.minute)}:${pad2(clock.second)}${fraction}${zone.zone}`);
};

// ────────────────────────────────────────────────────────────────
// Card numbers and account references (§9)
// ────────────────────────────────────────────────────────────────

const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
};

/** A card number's issuer prefix and length. The check digit alone passes one
 *  random number in ten, so an order number would often look like a card. */
const isCardShaped = (digits: string): boolean => {
  const n = digits.length;
  const p2 = Number(digits.slice(0, 2));
  const p3 = Number(digits.slice(0, 3));
  const p4 = Number(digits.slice(0, 4));
  const visa = digits.startsWith('4') && (n === 13 || n === 16 || n === 19);
  const mastercard = n === 16 && ((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720));
  const amex = n === 15 && (p2 === 34 || p2 === 37);
  const discover = n >= 16 && n <= 19 && (p4 === 6011 || p2 === 65 || (p3 >= 644 && p3 <= 649));
  const jcb = n >= 16 && n <= 19 && p4 >= 3528 && p4 <= 3589;
  const diners = n >= 14 && n <= 19 && (p2 === 36 || p2 === 38 || (p3 >= 300 && p3 <= 305));
  const unionpay = n >= 16 && n <= 19 && p2 === 62;
  return visa || mastercard || amex || discover || jcb || diners || unionpay;
};

/** Digit groups written together: `4111 1111 1111 1111`, `4111 - 1111`, `12/26`
 *  apart. A run of separators parts two groups as one does: four spaces, or a
 *  tab and a line, group a card as a space does (§9). */
const DIGIT_GROUPS_RE = /\d+(?:[ .-]+\d+)*/g;

/** Text as the detectors read it: in its compatibility form first, as an
 *  identity key reads it — a fullwidth `４` is a `4`, and a card written in
 *  fullwidth digits was stored, and plain in its key — then any space is a
 *  space, any dash a dash, and a character that shows nothing (a zero-width
 *  space) is not there: a card or an IBAN grouped by no-break spaces is
 *  refused as one grouped by spaces is (§9). */
const plainSeparators = (text: string): string =>
  canonicalMailFactText(text).replace(/\s/g, ' ').replace(/\p{Pd}/gu, '-');

/** Does the text hold a full card number (an issuer prefix, a card length and a
 *  valid check digit)? Its digits may be grouped by spaces, dashes or dots, a
 *  run of them as one, and other numbers may stand beside it — `… 1111 12/26`, `Order 12345 4111…` — so
 *  every run of whole groups is tried, not only the longest. Only whole groups:
 *  a window cut through a group would find a card-shaped part inside a long
 *  tracking or order number about one time in ten. */
export const containsCardNumber = (raw: string): boolean => {
  const text = plainSeparators(raw);
  for (const match of text.matchAll(DIGIT_GROUPS_RE)) {
    // Only digits and what parts them: every group, however it was parted.
    const groups = match[0].split(/\D+/);
    for (let start = 0; start < groups.length; start += 1) {
      let digits = '';
      for (let end = start; end < groups.length; end += 1) {
        digits += groups[end]!;
        if (digits.length > 19) break;
        if (digits.length >= 13 && isCardShaped(digits) && luhn(digits)) return true;
      }
    }
  }
  return false;
};

/** Each IBAN country and its IBAN's length (the SWIFT IBAN registry). */
const IBAN_LENGTHS: ReadonlyMap<string, number> = new Map(
  ('AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BI27 BR29 BY28 CH21 CR22 CY28 CZ24 DE22 DJ27 DK18 DO28 '
    + 'EE20 EG29 ES24 FI18 FK18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HN28 HR21 HU28 IE22 IL23 IQ23 IS26 '
    + 'IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20 LU20 LV21 LY25 MC27 MD24 ME22 MK19 MN20 MR27 MT31 MU30 NI28 '
    + 'NL18 NO15 OM23 PK24 PL28 PS29 PT25 QA29 RO24 RS22 RU33 SA24 SC31 SD18 SE24 SI19 SK24 SM27 SO23 ST25 '
    + 'SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20 YE30').split(' ').map((entry) => [entry.slice(0, 2), Number(entry.slice(2))]),
);

const ALPHANUMERIC = /[A-Z0-9]/;

/** A gap between an IBAN's groups, read where the last group ended. */
const IBAN_GAP_RE = /[ .-]+/y;

/** The IBAN check: moved to the end, letters as numbers, it leaves 1 over 97. */
const ibanChecks = (iban: string): boolean => {
  let remainder = 0;
  for (const char of `${iban.slice(4)}${iban.slice(0, 4)}`) {
    const code = char.charCodeAt(0);
    for (const digit of code >= 65 ? String(code - 55) : char) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
};

/** Does the text hold an IBAN: an IBAN country, two check digits and that
 *  country's length of letters and digits (in groups or not), whose check
 *  holds? The one account number that can be told from an order or tracking
 *  number with certainty (§3.1). The length is the country's, so the words
 *  after one (`… 0130 00 by Friday`) are not read into it. */
export const containsIban = (raw: string): boolean => {
  const upper = plainSeparators(raw).toUpperCase();
  for (const match of upper.matchAll(/\b[A-Z]{2}\d{2}/g)) {
    const length = IBAN_LENGTHS.get(match[0].slice(0, 2));
    if (length === undefined) continue;
    let iban = '';
    let at = match.index;
    while (at < upper.length && iban.length < length) {
      const char = upper[at]!;
      if (ALPHANUMERIC.test(char)) {
        iban += char;
        at += 1;
        continue;
      }
      // Between two groups, what groups a card may: a run of spaces, dashes and dots.
      IBAN_GAP_RE.lastIndex = at;
      const gap = IBAN_GAP_RE.exec(upper)?.[0];
      if (gap === undefined || !ALPHANUMERIC.test(upper[at + gap.length] ?? '')) break;
      at += gap.length;
    }
    if (iban.length === length && !ALPHANUMERIC.test(upper[at] ?? '') && ibanChecks(iban)) return true;
  }
  return false;
};

/** `account_ref` keeps only the last four characters (§3.1). Mask characters
 *  are dropped (`XXXX-1234` → `1234`); anything longer than four is refused. */
export const normalizeAccountRef = (raw: string): NormalizeResult => {
  const kept = canonicalMailFactText(raw).replace(/[\s*xX•·.\-_#]/g, '');
  if (kept.length === 0) return refuse('no account reference');
  if (kept.length > 4) return refuse('only the last four characters of an account may be kept');
  return ok(kept);
};

// ────────────────────────────────────────────────────────────────
// By kind
// ────────────────────────────────────────────────────────────────

export interface NormalizeOptions {
  readonly locale?: string;
  /** The decimal mark, whatever the locale: the standards pass reads schema.org,
   *  which writes `.` (`"price": "1.500"` is one and a half). */
  readonly decimalMark?: '.' | ',';
  /** For `enum`: the declared values. */
  readonly values?: readonly string[];
  /** The variable's name, for the rules a single name carries (`account_ref`;
   *  `carrier`, named as the four carriers are, so one parcel is one thing). */
  readonly variable?: string;
}

/** Turn found text into a value of `kind`, or refuse it with a reason. */
export const normalizeValue = (
  raw: string,
  kind: MailFactVariableKind,
  options: NormalizeOptions = {},
): NormalizeResult => {
  // Read, checked and kept canonical: a value in fullwidth digits, or with a
  // zero-width space inside it, is the value written plainly.
  const text = readable(raw);
  if (text.length === 0) return refuse('empty');
  if (options.variable === 'account_ref') {
    // Its last four, then as the kind it is declared: a kind that says number
    // holds no letters (a kind saved before `account_ref` had to be text).
    const lastFour = normalizeAccountRef(text);
    if (!lastFour.ok || kind === 'text') return lastFour;
    const { variable: _account, ...asKind } = options;
    return normalizeValue(String(lastFour.value), kind, asKind);
  }
  if (containsCardNumber(text)) return refuse('holds a full card number');
  if (containsIban(text)) return refuse('holds a full account number (an IBAN)');
  switch (kind) {
    case 'text':
      return text.length > MAX_VARIABLE_TEXT_LENGTH
        ? refuse(`longer than ${MAX_VARIABLE_TEXT_LENGTH} characters`)
        : ok(options.variable === 'carrier' ? canonicalCarrierName(text) : text);
    case 'number': {
      const decimal = readDecimal(text, options.locale, options.decimalMark !== undefined ? { decimalMark: options.decimalMark } : {});
      if (decimal === null) return refuse(`${quoted(text)} is not a number`);
      // Past what a number holds it reads as Infinity, which is stored as
      // nothing: refused, so a required one is not taken as read.
      const number = Number(decimal);
      if (!Number.isFinite(number)) return refuse(`${quoted(text)} is too large a number`);
      // Checked again as it is kept: grouped by thousands, 4,111,111,111,111,111
      // holds no card, and the number 4111111111111111 is one.
      return containsCardNumber(String(number)) ? refuse('holds a full card number') : ok(number);
    }
    case 'boolean': {
      const lower = text.toLowerCase();
      if (['yes', 'true', 'y', '1', 'on'].includes(lower)) return ok(true);
      if (['no', 'false', 'n', '0', 'off'].includes(lower)) return ok(false);
      return refuse(`${quoted(text)} is not yes or no`);
    }
    case 'enum': {
      const wanted = text.toLowerCase().replace(/[\s-]+/g, '_');
      const match = (options.values ?? []).find((value) => value.toLowerCase() === wanted);
      return match === undefined
        ? refuse(`${quoted(text)} is not one of ${(options.values ?? []).join(', ')}`)
        : ok(match);
    }
    case 'money': {
      const money = parseMoney(text, options.locale, options.decimalMark !== undefined ? { decimalMark: options.decimalMark } : {});
      // Its amount as it is kept, checked again, as a number's is.
      return money.ok && containsCardNumber((money.value as MailFactMoney).amount) ? refuse('holds a full card number') : money;
    }
    case 'date':
      return parseDate(text, options.locale);
    case 'datetime':
      return parseDateTime(text, options.locale);
    case 'id': {
      const id = mailFactStoredId(text);
      if (id.length === 0) return refuse('empty');
      if (id.length > 200) return refuse('longer than 200 characters');
      return ok(id);
    }
    case 'file':
      // A file is picked by the attachment finder, never read from text.
      return refuse('a file comes from an attachment, not text');
  }
};

/** A JSON number read for a `number` variable: the number it is, whatever
 *  form JavaScript writes it in (`0.0000001` is `1e-7`), and refused only as
 *  any number is — past what one holds, or a full card number. */
export const normalizeJsonNumber = (value: number): NormalizeResult => {
  if (!Number.isFinite(value)) return refuse(`'${String(value)}' is too large a number`);
  if (containsCardNumber(String(value))) return refuse('holds a full card number');
  return ok(value);
};

/** JSON's own form of a number: `1.125`, `-3`, `1e-7`. */
const JSON_NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** A value written as a fact holds it — the form a read returns, and a query
 *  names a thing by: a number as JSON writes one (`1.125`, `1e-7`), and a
 *  number or an amount with a decimal point, never the thousands mark an
 *  email's "1.125" can be. Anything else as `normalizeValue` reads it. */
export const normalizeHeldValue = (
  raw: string,
  kind: MailFactVariableKind,
  options: NormalizeOptions = {},
): NormalizeResult => {
  const text = readable(raw);
  if (kind === 'number' && JSON_NUMBER_RE.test(text)) return normalizeJsonNumber(Number(text));
  return normalizeValue(raw, kind, kind === 'number' || kind === 'money' ? { ...options, decimalMark: '.' } : options);
};

/** A datetime as what it names (§3.1): with a zone, an instant — `10:00+01:00`
 *  is `09:00Z`, and `10:00-01:00` two hours later, not the same clock with its
 *  punctuation gone — keyed in UTC; with none, the local time it states, which
 *  is no instant. A time in UTC and a time with no zone keep the keys they had.
 *  Null for text not in the form `parseDateTime` gives. */
const datetimeIdentityKey = (text: string): string | null => {
  const iso = /^(\d{4})-(\d{2})-(\d{2})t(\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:(z)|([+-])(\d{2}):(\d{2}))?$/.exec(text);
  if (iso === null) return null;
  const [, year, month, day, hour, minute, second, fraction, utc, sign, offsetHours, offsetMinutes] = iso;
  // A fraction of a second by its value (`.100` is `.1`); none, or zeros, adds nothing.
  const digits = (fraction ?? '').slice(1).replace(/0+$/, '');
  const part = digits.length > 0 ? `f${digits}` : '';
  if (utc === undefined && sign === undefined) return `${year}${month}${day}t${hour}${minute}${second}${part}`;
  const offset = sign === undefined ? 0 : (sign === '-' ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes));
  const at = new Date(0);
  at.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  at.setUTCHours(Number(hour), Number(minute) - offset, Number(second));
  return `${String(at.getUTCFullYear()).padStart(4, '0')}${pad2(at.getUTCMonth() + 1)}${pad2(at.getUTCDate())}`
    + `t${pad2(at.getUTCHours())}${pad2(at.getUTCMinutes())}${pad2(at.getUTCSeconds())}${part}z`;
};

/** An amount as its value, for comparing two: `12.50` is `12.5`, `12.00` is
 *  `12`, and `-0` is `0`. The amount stays as the email wrote it — `12.50`,
 *  and a dinar's `12.500` — this is only how two compare. */
export const moneyAmountKey = (amount: string): string => {
  const [whole = '', fraction = ''] = amount.split('.');
  const digits = fraction.replace(/0+$/, '');
  const value = digits.length > 0 ? `${whole}.${digits}` : whole;
  return /^-?0$/.test(value) ? '0' : value;
};

/** The variables that name who sends or serves the thing — a shop, a carrier,
 *  a biller — which a template and the markup may write differently for one
 *  thing (a template's "Amazon", the markup's "Amazon.com, Inc."). Every other
 *  part of an identity says which thing it is: a period, an account, an id. */
export const MAIL_FACT_NAME_VARIABLES: ReadonlySet<string> = new Set(['merchant', 'carrier', 'provider', 'issuer', 'service', 'platform', 'source']);

/** An email address, as an identity reads one. */
const EMAIL_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** How an identity value compares (§3.1): case, spacing and punctuation aside
 *  — `112-1234567` is `1121234567`, `WB 1204` is `wb1204` — and for a name
 *  (`variable` one of `MAIL_FACT_NAME_VARIABLES`), a company ending and a web
 *  address ending too, so the markup's "Amazon.com, Inc." and a template's
 *  "Amazon" are one merchant. An email address is the address, its case
 *  aside: `alex@acme.com` is not `alex@acme.net`, nor `a.b@x.com` `ab@x.com`.
 *  Empty when nothing is left to compare. */
export const identityValueKey = (value: MailFactValue, kind?: MailFactVariableKind, variable?: string): string => {
  // An amount by its value: EUR 12.50 and EUR 12.5 are one.
  if (typeof value === 'object') return `${value.currency}:${moneyAmountKey(String(value.amount))}`;
  // A number is its value: its sign and its decimal point are not punctuation
  // (1.25, 125 and -125 are three). A whole number keeps the key it had.
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  // An enum's value is one of the words its kind declares, each its own:
  // `v1_2` and `v12` are two. The words are lower-case letters, digits and `_`.
  if (kind === 'enum') return String(value);
  let text = canonicalMailFactText(String(value)).toLowerCase().trim();
  if (kind === 'datetime') {
    const instant = datetimeIdentityKey(text);
    if (instant !== null) return instant;
  }
  if (EMAIL_ADDRESS_RE.test(text)) return text;
  if (kind === 'text' && variable !== undefined && MAIL_FACT_NAME_VARIABLES.has(variable)) {
    text = text
      .replace(/[\s,]+(?:inc|incorporated|llc|l\.l\.c|ltd|limited|gmbh|corp|corporation|co|plc|s\.?a|a\.?g|b\.?v|pty)\.?$/u, '')
      .replace(/\.(?:com|net|org|co|io|shop|store)(?:\.[a-z]{2})?$/u, '');
  }
  return text.replace(/[^\p{L}\p{N}]+/gu, '');
};
