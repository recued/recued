/** How an approval's "what will happen" rows name a field (D-270).
 *
 *  Moved here from the shared approval card (2026-10-10) because the server now
 *  names fields inside a row's VALUE too: the card's `Not set` and `Empty` rows
 *  list the fields that carry nothing, and a row's value is final display text
 *  that no client rewrites. One rule, so a field reads the same as a row's label
 *  and inside one of those lists. */

/** Words a field name writes in lower case that people write as letters:
 *  `reconciliation_id` → "Reconciliation ID", `bcc` → "BCC". A closed list,
 *  drawn from the words in the shipped actions' field names (2026-10-19); a
 *  word that also reads as a plain word (`tax`, `zip`, `pin`) is left out, and
 *  any word not listed reads as written. */
const FIELD_ABBREVIATIONS: Readonly<Record<string, string>> = {
  ai: 'AI', api: 'API', bcc: 'BCC', bic: 'BIC', cc: 'CC', cid: 'CID', crm: 'CRM', csv: 'CSV',
  dns: 'DNS', ein: 'EIN', eta: 'ETA', eur: 'EUR', gbp: 'GBP', html: 'HTML', http: 'HTTP',
  https: 'HTTPS', iban: 'IBAN', id: 'ID', ids: 'IDs', ip: 'IP', iso: 'ISO', json: 'JSON',
  mime: 'MIME', oauth: 'OAuth', os: 'OS', pdf: 'PDF', qr: 'QR', sku: 'SKU', sms: 'SMS',
  ssl: 'SSL', ssn: 'SSN', sso: 'SSO', tls: 'TLS', ttl: 'TTL', tz: 'TZ', ui: 'UI', uri: 'URI',
  url: 'URL', urls: 'URLs', usd: 'USD', utc: 'UTC', uuid: 'UUID', vat: 'VAT', vin: 'VIN',
};

/** An arg key as words: `in_reply_to` → "In reply to", `reconciliation_id` →
 *  "Reconciliation ID". The `metadata.` prefix is producer bookkeeping and is
 *  dropped. */
export const humanizeAskField = (key: string): string => {
  const withoutMetadata = key.replace(/^metadata\./, '');
  const words = withoutMetadata.replace(/[._-]+/g, ' ')
    .replace(/[A-Za-z0-9]+/g, (word) => {
      const lower = word.toLowerCase();
      return Object.hasOwn(FIELD_ABBREVIATIONS, lower) ? FIELD_ABBREVIATIONS[lower]! : word;
    });
  return words.charAt(0).toLocaleUpperCase() + words.slice(1);
};

/** The label a D-270 detail row is shown under, on every surface that shows one.
 *  A pack-declared label stands as written; the raw arg key a server falls back
 *  to is humanized. ⚠ ONLY an identifier-shaped label: humanizing splits on
 *  `[._-]`, which would mangle a real label like "e-mail" into "E mail". Shared
 *  so the Approvals card and the top-bar tray cannot name one value two ways. */
export const askDetailLabel = (label: string): string =>
  /^[a-z][a-z0-9._]*$/.test(label) ? humanizeAskField(label) : label;

/** A top-level input the owner knows by another name. "Sender mail instance" was
 *  the field's name, not what the owner calls it (owner, 2026-10-19); its value
 *  already reads as the mailbox's address (`value_labels`). */
export const KNOWN_FIELD_NAMES: Readonly<Record<string, string>> = {
  sender_mail_instance: 'from',
};

/** How an approval names one input of the held call, wherever it names one: the
 *  card's rows, and the terms of "Allow this session". `sender_mail_instance` →
 *  "From", `in_reply_to` → "In reply to", `event.calendar_id` → "Event calendar
 *  id". One rule, so the terms and the rows above them never name a field two
 *  ways. */
export const approvalFieldLabel = (key: string): string =>
  askDetailLabel(Object.hasOwn(KNOWN_FIELD_NAMES, key) ? KNOWN_FIELD_NAMES[key]! : key);

/** How the owner knows a value a held call carries by another name: by the
 *  call's top-level argument, then by the value as the call passes it. A mailbox
 *  is passed by its name and known by its address, so
 *  `{ sender_mail_instance: { recueddev: 'recued.dev@gmail.com (Gmail)' } }`
 *  shows `sender_mail_instance: recueddev` as `recued.dev@gmail.com (Gmail)`.
 *  D-336 (spec §40) — and a recipient by the contact it is:
 *  `{ to: { 'mia@example.com': 'Mia Whitfield <mia@example.com>' } }`.
 *  The server records it on the held run's checkpoint
 *  (`PreflightCheckpointContext.value_labels`). Display only: the call still
 *  carries the name. */
export type ApprovalValueLabels = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** D-336 (spec §41) — the labels under this key name a value under any argument, at any
 *  depth: a contact's address as `Mia Whitfield <mia@example.com>` in a calendar event's
 *  attendees, a contact's id as `Mia Whitfield`. A label under the argument's own key wins. */
export const ANY_ARGUMENT = '*';

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The owner's name for one top-level argument value, or undefined. A list of
 *  strings (a mail's `to`) reads each member as the owner knows it, the rest as
 *  they are, joined as the ask joins a list; a list of more than one leads with
 *  its count, which a clipped line would otherwise lose. Undefined when no member
 *  has a label, so the line reads as it always did.
 *
 *  ⛔ READ DEFENSIVELY, AND OWN KEYS ONLY. The labels come back off a persisted
 *  checkpoint: a malformed one names nothing rather than failing the ask, and a
 *  value like `toString` must not find a function on the prototype. */
export const approvalValueLabel = (
  labels: unknown,
  key: string,
  value: unknown,
): string | undefined => {
  if (!isPlainRecord(labels)) return undefined;
  // The argument's own labels first, then those that name a value anywhere.
  const scopes = (key === ANY_ARGUMENT ? [key] : [key, ANY_ARGUMENT])
    .filter((scope) => Object.hasOwn(labels, scope))
    .map((scope) => labels[scope])
    .filter(isPlainRecord);
  if (scopes.length === 0) return undefined;
  const one = (member: string): string | undefined => {
    for (const byValue of scopes) {
      if (!Object.hasOwn(byValue, member)) continue;
      const label = byValue[member];
      if (typeof label === 'string' && label.trim() !== '') return label.trim();
    }
    return undefined;
  };
  if (typeof value === 'string') return one(value);
  if (!Array.isArray(value) || value.length === 0 || !value.every((member) => typeof member === 'string')) {
    return undefined;
  }
  const members = value as readonly string[];
  const known = members.map(one);
  if (known.every((label) => label === undefined)) return undefined;
  const body = members.map((member, i) => known[i] ?? member).join(', ');
  return members.length === 1 ? body : `${members.length}: ${body}`;
};

/** How deep `nameValuesIn` reads: deeper than any call a person reads. */
const NAME_DEPTH_MAX = 8;

/** D-336 (spec §41) — `value` with every string the labels name anywhere (`ANY_ARGUMENT`)
 *  read as its label, for a display that shows a structure: a calendar event's attendees
 *  `[{ email: 'Mia Whitfield <mia@example.com>' }]`. The same value when nothing in it is
 *  named. Display only. */
export const nameValuesIn = (value: unknown, labels: unknown, depth = 0): unknown => {
  if (typeof value === 'string') return approvalValueLabel(labels, ANY_ARGUMENT, value) ?? value;
  if (value === null || typeof value !== 'object' || depth >= NAME_DEPTH_MAX) return value;
  let changed = false;
  const named = (member: unknown): unknown => {
    const out = nameValuesIn(member, labels, depth + 1);
    if (out !== member) changed = true;
    return out;
  };
  // `fromEntries` defines each key as its own, a `__proto__` key included.
  const out = Array.isArray(value)
    ? value.map(named)
    : Object.fromEntries(Object.entries(value).map(([key, member]) => [key, named(member)]));
  return changed ? out : value;
};

/** Two sets of labels as one, per argument and per value, the first's label kept where both
 *  name a value. Read defensively, as either may come off a persisted checkpoint: what is
 *  malformed adds nothing. Undefined when neither names anything. */
export const mergeValueLabels = (first: unknown, second: unknown): ApprovalValueLabels | undefined => {
  const merged = new Map<string, Map<string, string>>();
  for (const labels of [first, second]) {
    if (!isPlainRecord(labels)) continue;
    for (const [key, byValue] of Object.entries(labels)) {
      if (!isPlainRecord(byValue)) continue;
      for (const [value, label] of Object.entries(byValue)) {
        if (typeof label !== 'string' || label.trim() === '') continue;
        const known = merged.get(key) ?? new Map<string, string>();
        if (!known.has(value)) merged.set(key, known.set(value, label));
      }
    }
  }
  return merged.size === 0 ? undefined
    : Object.fromEntries([...merged].map(([key, known]) => [key, Object.fromEntries(known)]));
};
