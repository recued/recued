/** D-205 #5c — vCard / CSV parsing for the manual contact import.
 *
 *  ## An upload is the USER speaking, not a Source
 *
 *  A file the owner uploads is a BATCH `contact.upsert` — the same act as typing a
 *  contact in, done at scale. It is NOT a D-145 Source: no connection, no sync
 *  cadence, no delete diff, no completeness proof, no health row. Registering one
 *  would be inventing a Source with nothing behind it, which is this family's single
 *  most-repeated mistake.
 *
 *  So everything an upload writes lands at the `manual` rung with
 *  `CONTACT_SOURCE_ID_MANUAL` — the singleton instance whose own contract says it
 *  best: *"a constant, because there is exactly one of the user."* Contributions are
 *  keyed `(contact_id, kind, source_id)` and UPSERT, so a re-upload REPLACES the
 *  previous value for each field rather than accumulating. **That is what makes
 *  export → edit in a spreadsheet → re-upload work as MODIFY, and the substrate
 *  already did it.**
 *
 *  ⚠ The ladder's warning — *"an importer writing `manual` would park a vendor's
 *  value at the TOP where the user's own typing could never correct it"* — protects
 *  the user FROM importers. A file the user uploads is not an importer; it is the
 *  user, and they can re-upload or re-type at any time.
 *
 *  ## This module is PURE
 *
 *  Text in, canonical entries out. No store, no IO, no clock — so the parse is
 *  deterministic, and `preview` and `apply` can both run it over the same bytes and
 *  reach the same plan without carrying server state between two rpcs.
 *
 *  ⚠ Deliberately NOT a complete RFC 6350 implementation. It handles what real
 *  exports actually emit (Google Contacts, Apple Contacts, Outlook) and says so when
 *  it cannot — a parser that silently drops a field it did not understand would put
 *  a HOLE in the user's contact graph and call it a success. */

import {
  canonicalizeEmail,
  canonicalizeMailingAddress,
  isContactAnnualDate,
  type MailingAddress,
} from '@recued/contracts';

/** One parsed entry, in the vocabulary the contact store already speaks.
 *
 *  Every field is OPTIONAL and an ABSENT field means "the file did not say" — never
 *  "the file says this is empty". That distinction is the whole of the diff: a CSV
 *  column the export omitted must not blank a value the user already has. */
export interface ParsedContactEntry {
  /** 1-based line (vCard) / row (CSV) — so an error names WHERE. */
  line: number;
  email?: string;
  emails?: string[];
  name?: string;
  /** As written. The store canonicalizes; we do not guess at E.164 here. */
  phone?: string;
  phones?: string[];
  dates?: Array<{ label: string; date: string }>;
  company?: string;
  title?: string;
  photo?: string;
  /** ISO-8601 `YYYY-MM-DD`. Year is often absent upstream; stored verbatim. */
  birthday?: string;
  anniversary?: string;
  address?: MailingAddress;
}

export interface ParseResult {
  entries: ParsedContactEntry[];
  /** Rows the parser could not use, verbatim. **Never silently dropped** — a row
   *  that vanishes is a person missing from the user's contacts, and they would have
   *  no way to know. */
  errors: string[];
  /** Dates the file carries that could not be used as written: a birthday kept as
   *  text, an anniversary left out, a labelled date with no field on a contact. The
   *  person is still imported; the date is named so a reminder the owner expects is
   *  not missing without a word. */
  date_notes: string[];
  format: 'vcard' | 'csv';
}

const REWRITE_DATE = 'Write it as YYYY-MM-DD, or --MM-DD without a year.';
const birthdayKeptAsText = (value: string): string =>
  `birthday "${value}" is not a date, so it is kept as text and will not remind you. ${REWRITE_DATE}`;
const anniversaryLeftOut = (value: string): string =>
  `anniversary "${value}" is not a date and was not imported. ${REWRITE_DATE}`;
/** Where in the file, and whose: the name is known only once the entry is read. */
const dateNote = (where: string, entry: ParsedContactEntry, note: string): string => {
  const who = entry.name ?? entry.email ?? entry.phone;
  return `${where}${who !== undefined ? ` (${who})` : ''}: ${note}`;
};

// ────────────────────────────────────────────────────────────────
// vCard
// ────────────────────────────────────────────────────────────────

/** RFC 6350 line folding: a continuation line begins with a space or tab and belongs
 *  to the line before it. Real exports fold long PHOTO / ADR values, so a parser that
 *  skips this reads half an address and calls it whole. */
const unfold = (text: string): string[] => {
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
};

/** vCard value escaping: `\n` `\,` `\;` `\\`. */
const unescapeVCard = (v: string): string =>
  v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();

/** Split a structured value (`ADR`, `N`, `ORG`) on UNESCAPED semicolons. */
const splitStructured = (v: string): string[] => {
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < v.length; i += 1) {
    const c = v[i]!;
    if (c === '\\' && i + 1 < v.length) {
      cur += c + v[i + 1]!;
      i += 1;
      continue;
    }
    if (c === ';') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map(unescapeVCard);
};

interface VCardProp {
  name: string;
  /** The group prefix (`item1` of `item1.X-ABDATE`), which ties Apple's labelled
   *  date to its `X-ABLabel`. Null when the line has none. */
  group: string | null;
  params: string;
  value: string;
}

const parseProp = (line: string): VCardProp | null => {
  const colon = line.indexOf(':');
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const semi = head.indexOf(';');
  const name = (semi === -1 ? head : head.slice(0, semi)).toUpperCase().trim();
  // Split off a group prefix (`item1.EMAIL` — Apple emits these).
  const dot = name.lastIndexOf('.');
  return {
    name: dot === -1 ? name : name.slice(dot + 1),
    group: dot === -1 ? null : name.slice(0, dot),
    params: (semi === -1 ? '' : head.slice(semi + 1)).toUpperCase(),
    value,
  };
};

/** Apple wraps its own labels as `_$!<Anniversary>!$_`; a label the owner typed is
 *  plain text. */
const appleLabel = (value: string): string => value.replace(/^_\$!<(.*)>!\$_$/u, '$1').trim();

/** A date of all zeros is no date: some exports write `0/0/00` for an empty one. */
const isZeroDate = (raw: string): boolean => /\d/u.test(raw) && !/[1-9]/u.test(raw);

/** A file's date as a contact's annual date: `YYYY-MM-DD`, or `--MM-DD` when the
 *  year is unknown — RFC 6350's basic `--0415` included, and Apple's `1604` year
 *  (`X-APPLE-OMIT-YEAR`). Undefined for anything else, including a day-first or
 *  month-first `4/2/1980` that cannot be read without guessing. */
const annualDate = (raw: string, params = ''): string | undefined => {
  const value = raw.trim();
  const full = /^(\d{4})-?(\d{2})-?(\d{2})(?:T[\d:.]+(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/u.exec(value);
  const yearless = /^--(\d{2})-?(\d{2})$/u.exec(value);
  const omitted = /X-APPLE-OMIT-YEAR=(\d{4})/u.exec(params)?.[1] ?? '1604';
  const date = full ? (full[1] === omitted ? `--${full[2]}-${full[3]}` : `${full[1]}-${full[2]}-${full[3]}`)
    : yearless ? `--${yearless[1]}-${yearless[2]}` : undefined;
  return date !== undefined && isContactAnnualDate(date) ? date : undefined;
};

/** A dated entry with a label: Apple's `X-ABDATE` + `X-ABLabel`, or a Google
 *  Contacts export's `Event N` columns. The one labelled "Anniversary" is the
 *  contact's anniversary, unless the file already gave one. Other valid labelled
 *  dates are offered for optional, contact-linked Occasions. */
const placeLabelledDate = (
  entry: ParsedContactEntry, notes: string[], label: string | undefined, raw: string, params = '',
): void => {
  if (isZeroDate(raw)) return;
  const date = annualDate(raw, params);
  if (label?.toLowerCase() === 'birthday') {
    if (entry.birthday !== undefined) return;
    entry.birthday = date ?? raw;
    if (date === undefined) notes.push(birthdayKeptAsText(raw));
    return;
  }
  if (label?.toLowerCase() === 'anniversary') {
    if (entry.anniversary !== undefined) return;
    if (date !== undefined) entry.anniversary = date;
    else notes.push(anniversaryLeftOut(raw));
    return;
  }
  if (date !== undefined && label?.trim()) {
    (entry.dates ??= []).push({ label: label.trim(), date });
  } else {
    notes.push(`${label ? `"${label}"` : 'a date with no label'} (${date ?? raw}) could not be offered as an Occasion. `
      + (date === undefined ? REWRITE_DATE : 'Give the date a label in your contact file.'));
  }
};

/** Is this property flagged PREFERRED? Both dialects appear in the wild:
 *  vCard 3.0 `TYPE=PREF` and vCard 4.0 `PREF=1`. */
const preference = (params: string): number => {
  const numeric = /(?:^|;)PREF="?(\d+)"?(?:;|$)/u.exec(params)?.[1];
  if (numeric !== undefined && Number(numeric) >= 1 && Number(numeric) <= 100) return Number(numeric);
  return params.split(';').some(param => param === 'PREF'
    || param.startsWith('TYPE=') && param.slice(5).replace(/^"|"$/gu, '').split(',').includes('PREF')) ? 1 : 101;
};

/** Take the PREFERRED value, else the first. A contact whose email is not flagged
 *  primary still HAS an email. */
const orderedValues = (values: { value: string; preference: number }[]): string[] =>
  [...new Set([...values].sort((a, b) => a.preference - b.preference).map(v => v.value))];

const parseVCardBlock = (lines: string[], startLine: number): { entry: ParsedContactEntry; notes: string[] } | string => {
  const emails: { value: string; preference: number }[] = [];
  const phones: { value: string; preference: number }[] = [];
  const entry: ParsedContactEntry = { line: startLine };
  let structuredName: string | undefined;
  const notes: string[] = [];
  const labelledDates: { group: string | null; value: string; params: string }[] = [];
  const labels = new Map<string, string>();

  for (const line of lines) {
    const prop = parseProp(line);
    if (prop === null) continue;
    const v = unescapeVCard(prop.value);
    if (v.length === 0) continue;

    switch (prop.name) {
      case 'FN':
        entry.name = v;
        break;
      case 'N': {
        // `Family;Given;Middle;Prefix;Suffix`. Only a FALLBACK — `FN` is the
        // display name the user actually chose, and an export that carries both
        // means the two can disagree.
        const [family, given] = splitStructured(prop.value);
        const composed = [given, family].filter((x) => x !== undefined && x.length > 0).join(' ');
        if (composed.length > 0) structuredName = composed;
        break;
      }
      case 'EMAIL':
        if (canonicalizeEmail(v)) emails.push({ value: canonicalizeEmail(v), preference: preference(prop.params) });
        break;
      case 'TEL':
        if (v.replace(/^tel:/iu, '').trim()) phones.push({ value: v.replace(/^tel:/iu, '').trim(), preference: preference(prop.params) });
        break;
      case 'ORG':
        // `Company;Department` — the org is the first component.
        entry.company = splitStructured(prop.value)[0] ?? v;
        break;
      case 'TITLE':
        entry.title = v;
        break;
      case 'BDAY': {
        // `19800402`, `1980-04-02` or yearless `--0402`, as `YYYY-MM-DD` / `--MM-DD` —
        // never coerced to a timestamp, because "March 4th, year unknown" is a real
        // and common vCard value and a timestamp cannot hold it. Anything else
        // (`circa 1800`) is kept verbatim, and named: it will never remind anyone.
        if (isZeroDate(v)) break;
        const date = annualDate(v, prop.params);
        entry.birthday = date ?? v;
        if (date === undefined) notes.push(birthdayKeptAsText(v));
        break;
      }
      case 'ANNIVERSARY': {
        // The store takes only a date here, so a value that is not one is left out
        // rather than failing the whole contact, and named.
        if (isZeroDate(v)) break;
        const date = annualDate(v, prop.params);
        if (date !== undefined) entry.anniversary = date;
        else notes.push(anniversaryLeftOut(v));
        break;
      }
      // Apple's vCard 3.0 has no ANNIVERSARY: it writes each extra date as a grouped
      // `itemN.X-ABDATE` and its name as `itemN.X-ABLabel`, in either order.
      case 'X-ABDATE':
        labelledDates.push({ group: prop.group, value: v, params: prop.params });
        break;
      case 'X-ABLABEL':
        if (prop.group !== null) labels.set(prop.group, appleLabel(v));
        break;
      case 'PHOTO':
        // A URL only. ⛔ A `data:` / base64 PHOTO is DROPPED, deliberately: C-2's
        // North star is that bytes are NEVER fetched or stored, and `photo` is a
        // reference. Inlining a megabyte of JPEG into a contact row would break that
        // on the one field named for it.
        if (/^https?:\/\//i.test(v)) entry.photo = v;
        break;
      case 'ADR': {
        // `POBox;Extended;Street;Locality;Region;PostalCode;Country`
        const p = splitStructured(prop.value);
        const canonical = canonicalizeMailingAddress({
          address1: p[2] ?? undefined,
          address2: p[1] ?? undefined,
          city: p[3] ?? undefined,
          state: p[4] ?? undefined,
          zip: p[5] ?? undefined,
          country: p[6] ?? undefined,
        });
        // 🔑 A HALF address contributes NOTHING. It feeds D-138's
        // `address_zip_country_key` blocking key, and a partial one yields a key that
        // matches the WRONG people — worse than no key, which merely produces no
        // match. `canonicalizeMailingAddress` returns null unless it is whole.
        if (canonical !== null) entry.address = canonical;
        break;
      }
      default:
        break;
    }
  }

  if (entry.name === undefined && structuredName !== undefined) entry.name = structuredName;

  if (emails.length) {
    entry.emails = orderedValues(emails);
    entry.email = entry.emails[0]!;
  }
  if (phones.length) {
    entry.phones = orderedValues(phones);
    entry.phone = entry.phones[0]!;
  }

  // An entry with neither an address nor a name is an identity nothing could ever
  // match — not by the address space, not by a phone lookup, not by a blocking key.
  // Importing it would add a row findable only by scrolling.
  if (entry.email === undefined && entry.name === undefined && entry.phone === undefined) {
    return `line ${startLine}: no email, name or phone — nothing could identify this person`;
  }

  // Labels are read once the whole card is, since Apple writes them in either order.
  for (const dated of labelledDates) {
    placeLabelledDate(entry, notes, dated.group === null ? undefined : labels.get(dated.group), dated.value, dated.params);
  }
  return { entry, notes: notes.map((note) => dateNote(`line ${startLine}`, entry, note)) };
};

const parseVCard = (text: string): ParseResult => {
  const lines = unfold(text);
  const entries: ParsedContactEntry[] = [];
  const errors: string[] = [];
  const date_notes: string[] = [];

  let block: string[] | null = null;
  let blockStart = 0;
  lines.forEach((line, i) => {
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VCARD') {
      block = [];
      blockStart = i + 1;
      return;
    }
    if (upper === 'END:VCARD') {
      if (block === null) return;
      const parsed = parseVCardBlock(block, blockStart);
      if (typeof parsed === 'string') errors.push(parsed);
      else {
        entries.push(parsed.entry);
        date_notes.push(...parsed.notes);
      }
      block = null;
      return;
    }
    if (block !== null) block.push(line);
  });

  // An unterminated block is a TRUNCATED FILE — the upload was cut off. Say so; a
  // silent drop would lose contacts the user believes they imported.
  if (block !== null) {
    errors.push(`line ${blockStart}: vCard block is not terminated (END:VCARD missing) — truncated file?`);
  }
  return { entries, errors, date_notes, format: 'vcard' };
};

// ────────────────────────────────────────────────────────────────
// CSV
// ────────────────────────────────────────────────────────────────

/** One CSV row → cells. Handles RFC 4180 quoting: `"a,b"` is one cell, `""` is an
 *  escaped quote. Hand-rolled because the alternative is a dependency for eighty
 *  lines, and the failure mode of a naive `split(',')` is a shifted column map —
 *  every field of every contact silently wrong. */
const splitCsvLine = (line: string): string[] => {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
      continue;
    }
    if (c === ',') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
};

/** Header synonyms, lowercased. Covers what Google Contacts, Outlook and Apple
 *  actually export — the three files a user will realistically have.
 *
 *  ⚠ An UNRECOGNIZED column is IGNORED, not an error: exports carry dozens of
 *  columns Recued has no home for (Notes, Groups, custom fields), and failing the
 *  file over one would make the feature unusable. But a file with no recognizable
 *  IDENTITY column at all IS an error — see `parseCsv`. */
const CSV_COLUMNS: Readonly<Record<string, keyof ParsedContactEntry>> = {
  'email': 'email',
  'e-mail': 'email',
  'e-mail address': 'email',
  'email address': 'email',
  'primary email': 'email',
  // ⚠ Google Contacts emits `E-mail 1 - Value` — with the hyphen. Getting this string
  // wrong does not error; it silently reads every row as having no email, so every
  // contact in the file is created as a nameless stranger. The exports' EXACT header
  // spellings are the contract here, not a reasonable-looking guess.
  'e-mail 1 - value': 'email',
  'email 1 - value': 'email',
  'name': 'name',
  'full name': 'name',
  'display name': 'name',
  'phone': 'phone',
  'phone number': 'phone',
  'phone 1 - value': 'phone', // Google Contacts
  'mobile phone': 'phone',
  'primary phone': 'phone',
  'company': 'company',
  'organization': 'company',
  'organization name': 'company',
  'organization 1 - name': 'company', // Google Contacts
  'title': 'title',
  'job title': 'title',
  'organization 1 - title': 'title',
  'birthday': 'birthday',
  'anniversary': 'anniversary',
};

/** ⛔ `First Name` / `Last Name` are deliberately NOT in the table above. Mapping
 *  `first name → name` would set the display name to "Bob" and then the compose step
 *  would see a name already present and never run — so every Google export would
 *  silently lose every surname. They are composed, and only composed. */
const CSV_NAME_PARTS = ['first name', 'last name'] as const;

const parseCsv = (text: string): ParseResult => {
  const rows = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((r) => r.trim().length > 0);
  if (rows.length < 2) {
    return {
      entries: [],
      errors: ['the file has no data rows (a header and at least one contact are required)'],
      date_notes: [],
      format: 'csv',
    };
  }

  const header = splitCsvLine(rows[0]!).map((h) => h.toLowerCase());
  const map = new Map<number, keyof ParsedContactEntry>();
  header.forEach((h, i) => {
    const field = CSV_COLUMNS[h];
    if (field !== undefined && !map.has(i)) map.set(i, field);
  });

  // ⚠ No identity column ⇒ REFUSE THE WHOLE FILE. Importing it would create rows
  // nothing could ever match, and the user would see a count of contacts added and a
  // graph that had not usefully changed. Name the columns we DID find so the failure
  // is actionable rather than a shrug.
  const fields = new Set(map.values());
  const hasNameParts = CSV_NAME_PARTS.some((h) => header.includes(h));
  if (!fields.has('email') && !fields.has('name') && !fields.has('phone') && !hasNameParts) {
    return {
      entries: [],
      errors: [
        `no email, name or phone column found — the header was: ${header.join(', ')}`,
      ],
      date_notes: [],
      format: 'csv',
    };
  }
  // Google splits the display name across First/Last. Compose whenever those columns
  // exist and the row carries no single display-name value.
  const firstIdx = header.indexOf(CSV_NAME_PARTS[0]);
  const lastIdx = header.indexOf(CSV_NAME_PARTS[1]);
  const composeName = firstIdx !== -1 || lastIdx !== -1;
  // A Google Contacts export keeps a person's other dates as numbered `Event N - Value`
  // columns, each named by its `Event N - Type` (older exports) or `- Label` column.
  const events = new Map<string, { label?: number; value?: number }>();
  header.forEach((h, i) => {
    const column = /^event (\d+) - (type|label|value)$/u.exec(h);
    if (column === null) return;
    const slot = events.get(column[1]!) ?? {};
    if (column[2] === 'value') slot.value ??= i;
    else slot.label ??= i;
    events.set(column[1]!, slot);
  });

  const entries: ParsedContactEntry[] = [];
  const errors: string[] = [];
  const date_notes: string[] = [];

  for (let r = 1; r < rows.length; r += 1) {
    const cells = splitCsvLine(rows[r]!);
    const entry: ParsedContactEntry = { line: r + 1 };
    const notes: string[] = [];

    for (const [i, field] of map) {
      const raw = cells[i];
      if (raw === undefined || raw.length === 0) continue;
      if (field === 'email') {
        const canonical = canonicalizeEmail(raw);
        if (canonical !== '') entry.email = canonical;
        continue;
      }
      if (field === 'address') continue; // structured; not a single CSV cell
      // ⛔ Never guessed: `4/2/1980` is 2 April or 4 February depending on who wrote
      // it. A date not written `YYYY-MM-DD` (or `--MM-DD`) is named instead.
      if (field === 'birthday' || field === 'anniversary') {
        if (isZeroDate(raw)) continue;
        const date = annualDate(raw);
        if (field === 'birthday') entry.birthday = date ?? raw;
        else if (date !== undefined) entry.anniversary = date;
        if (date === undefined) notes.push(field === 'birthday' ? birthdayKeptAsText(raw) : anniversaryLeftOut(raw));
        continue;
      }
      (entry as unknown as Record<string, unknown>)[field] = raw;
    }
    // After the named columns, so a file's own Anniversary column wins. Google marks a
    // primary entry's type with a leading `* `.
    for (const slot of events.values()) {
      const raw = slot.value === undefined ? undefined : cells[slot.value];
      if (raw === undefined || raw.length === 0) continue;
      const label = slot.label === undefined ? '' : (cells[slot.label] ?? '').replace(/^\*\s*/u, '').trim();
      placeLabelledDate(entry, notes, label || undefined, raw);
    }

    if (composeName && entry.name === undefined) {
      const composed = [cells[firstIdx] ?? '', cells[lastIdx] ?? '']
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
        .join(' ');
      if (composed.length > 0) entry.name = composed;
    }

    if (entry.email === undefined && entry.name === undefined && entry.phone === undefined) {
      errors.push(`row ${r + 1}: no email, name or phone — nothing could identify this person`);
      continue;
    }
    entries.push(entry);
    date_notes.push(...notes.map((note) => dateNote(`row ${r + 1}`, entry, note)));
  }

  return { entries, errors, date_notes, format: 'csv' };
};

// ────────────────────────────────────────────────────────────────

/** Parse an uploaded contact file. Format is DETECTED, not declared: a user picks a
 *  file, not a MIME type, and a wrong guess would produce a confident list of
 *  garbage rather than an error. */
export const parseContactFile = (text: string): ParseResult =>
  /BEGIN:VCARD/i.test(text) ? parseVCard(text) : parseCsv(text);
