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
  name?: string;
  /** As written. The store canonicalizes; we do not guess at E.164 here. */
  phone?: string;
  company?: string;
  title?: string;
  photo?: string;
  /** ISO-8601 `YYYY-MM-DD`. Year is often absent upstream; stored verbatim. */
  birthday?: string;
  address?: MailingAddress;
}

export interface ParseResult {
  entries: ParsedContactEntry[];
  /** Rows the parser could not use, verbatim. **Never silently dropped** — a row
   *  that vanishes is a person missing from the user's contacts, and they would have
   *  no way to know. */
  errors: string[];
  format: 'vcard' | 'csv';
}

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
  // Drop a group prefix (`item1.EMAIL` — Apple emits these).
  const dot = name.lastIndexOf('.');
  return {
    name: dot === -1 ? name : name.slice(dot + 1),
    params: (semi === -1 ? '' : head.slice(semi + 1)).toUpperCase(),
    value,
  };
};

/** Is this property flagged PREFERRED? Both dialects appear in the wild:
 *  vCard 3.0 `TYPE=PREF` and vCard 4.0 `PREF=1`. */
const isPreferred = (params: string): boolean =>
  params.includes('PREF');

/** Take the PREFERRED value, else the first. A contact whose email is not flagged
 *  primary still HAS an email. */
const pick = (values: { value: string; preferred: boolean }[]): string | undefined => {
  const p = values.find((v) => v.preferred);
  return (p ?? values[0])?.value;
};

const parseVCardBlock = (lines: string[], startLine: number): ParsedContactEntry | string => {
  const emails: { value: string; preferred: boolean }[] = [];
  const phones: { value: string; preferred: boolean }[] = [];
  const entry: ParsedContactEntry = { line: startLine };
  let structuredName: string | undefined;

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
        emails.push({ value: v, preferred: isPreferred(prop.params) });
        break;
      case 'TEL':
        phones.push({ value: v, preferred: isPreferred(prop.params) });
        break;
      case 'ORG':
        // `Company;Department` — the org is the first component.
        entry.company = splitStructured(prop.value)[0] ?? v;
        break;
      case 'TITLE':
        entry.title = v;
        break;
      case 'BDAY':
        // `19800402` or `1980-04-02`. Stored VERBATIM as `YYYY-MM-DD` — never
        // coerced to a timestamp, because "March 4th, year unknown" is a real and
        // common vCard value and a timestamp cannot hold it.
        entry.birthday = /^\d{8}$/.test(v)
          ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`
          : v;
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

  const email = pick(emails);
  if (email !== undefined) {
    const canonical = canonicalizeEmail(email);
    if (canonical !== '') entry.email = canonical;
  }
  const phone = pick(phones);
  if (phone !== undefined) entry.phone = phone;

  // An entry with neither an address nor a name is an identity nothing could ever
  // match — not by the address space, not by a phone lookup, not by a blocking key.
  // Importing it would add a row findable only by scrolling.
  if (entry.email === undefined && entry.name === undefined && entry.phone === undefined) {
    return `line ${startLine}: no email, name or phone — nothing could identify this person`;
  }
  return entry;
};

const parseVCard = (text: string): ParseResult => {
  const lines = unfold(text);
  const entries: ParsedContactEntry[] = [];
  const errors: string[] = [];

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
      else entries.push(parsed);
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
  return { entries, errors, format: 'vcard' };
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
      format: 'csv',
    };
  }
  // Google splits the display name across First/Last. Compose whenever those columns
  // exist and the row carries no single display-name value.
  const firstIdx = header.indexOf(CSV_NAME_PARTS[0]);
  const lastIdx = header.indexOf(CSV_NAME_PARTS[1]);
  const composeName = firstIdx !== -1 || lastIdx !== -1;

  const entries: ParsedContactEntry[] = [];
  const errors: string[] = [];

  for (let r = 1; r < rows.length; r += 1) {
    const cells = splitCsvLine(rows[r]!);
    const entry: ParsedContactEntry = { line: r + 1 };

    for (const [i, field] of map) {
      const raw = cells[i];
      if (raw === undefined || raw.length === 0) continue;
      if (field === 'email') {
        const canonical = canonicalizeEmail(raw);
        if (canonical !== '') entry.email = canonical;
        continue;
      }
      if (field === 'address') continue; // structured; not a single CSV cell
      (entry as unknown as Record<string, unknown>)[field] = raw;
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
  }

  return { entries, errors, format: 'csv' };
};

// ────────────────────────────────────────────────────────────────

/** Parse an uploaded contact file. Format is DETECTED, not declared: a user picks a
 *  file, not a MIME type, and a wrong guess would produce a confident list of
 *  garbage rather than an error. */
export const parseContactFile = (text: string): ParseResult =>
  /BEGIN:VCARD/i.test(text) ? parseVCard(text) : parseCsv(text);
