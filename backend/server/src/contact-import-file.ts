/** Owner-uploaded contacts are manual contributions. Preview and apply both parse
 * the original bytes; clients select dates, never supply replacement identities. */
import { createHash } from 'node:crypto';
import {
  CONTACT_SOURCE_ID_MANUAL, canonicalizeEmail, normalizeAliasPattern,
  type AssetRule, type ContactImportFileChange, type ContactImportFilePlan,
  type ContactImportOccasion, type ContactImportOccasionSelection,
  type ContactRecord, type MailingAddress, type Occasion,
} from '@recued/contracts';
import { parseContactFile, type ParsedContactEntry } from './contact-import-parse.js';
import { isMentionOnlyEmail, type ContactStore } from './storage/contact-store.js';
import type { ProactiveHistoryStore } from './storage/proactive-history-store.js';

export interface ContactImportFileDeps {
  store: ContactStore;
  history?: ProactiveHistoryStore;
  transaction?: <T>(work: () => T) => T;
  now?: () => number;
}
const emailsOf = (entry: ParsedContactEntry): string[] => entry.emails ?? (entry.email ? [entry.email] : []);
const phonesOf = (entry: ParsedContactEntry): string[] => entry.phones ?? (entry.phone ? [entry.phone] : []);
const resolveIdentity = (store: ContactStore, entry: ParsedContactEntry): { contact: ContactRecord | null; ambiguous: boolean } => {
  const matches = new Map<string, ContactRecord>();
  for (const email of emailsOf(entry)) {
    try {
      const contact = store.get(store.resolveCanonicalEmail(email).canonical_email);
      if (contact) matches.set(contact.email, contact);
    } catch { /* An unknown address is available for this contact. */ }
  }
  if (matches.size > 1) return { contact: null, ambiguous: true };
  if (matches.size === 1) return { contact: [...matches.values()][0]!, ambiguous: false };
  // Shared phone numbers are allowed in the warehouse, but cannot identify a
  // person for an import. Known email identities take precedence over phones.
  for (const phone of phonesOf(entry)) {
    const hit = store.findByPhone(phone);
    if (hit.alternatives.length) return { contact: null, ambiguous: true };
    if (hit.contact) matches.set(hit.contact.email, hit.contact);
  }
  return { contact: matches.size === 1 ? [...matches.values()][0]! : null, ambiguous: matches.size > 1 };
};
const FIELD_READERS: ReadonlyArray<{ field: string; read: (c: ContactRecord) => unknown; from: (e: ParsedContactEntry) => unknown }> = [
  { field: 'name', read: c => c.name, from: e => e.name },
  { field: 'phone', read: c => c.phone, from: e => e.phone },
  { field: 'company', read: c => c.company, from: e => e.company },
  { field: 'title', read: c => c.title, from: e => e.title },
  { field: 'photo', read: c => c.photo, from: e => e.photo },
  { field: 'birthday', read: c => c.birthday, from: e => e.birthday },
  { field: 'anniversary', read: c => c.anniversary, from: e => e.anniversary },
  { field: 'address', read: c => c.mailing_address, from: e => e.address },
];
const sameValue = (a: unknown, b: unknown): boolean => {
  if (a == null) return b == null;
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  return JSON.stringify(a) === JSON.stringify(b);
};
const describe = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  const a = v as MailingAddress;
  return [a.address1, a.city, a.zip, a.country].filter(Boolean).join(', ');
};
const changesFor = (store: ContactStore, contact: ContactRecord, entry: ParsedContactEntry): ContactImportFileChange['fields'] => {
  const fields: { field: string; from: string; to: string }[] = [];
  if (entry.email && isMentionOnlyEmail(contact.email)) fields.push({ field: 'email', from: '', to: entry.email });
  for (const f of FIELD_READERS) {
    const next = f.from(entry);
    if (next == null || next === '' || sameValue(f.read(contact), next)) continue;
    fields.push({ field: f.field, from: describe(f.read(contact)), to: describe(next) });
  }
  const aliases = contact.contact_id ? store.listResolvedContactAliases(contact.contact_id) : [];
  for (const [kind, values, field] of [
    ['email_alias', emailsOf(entry), 'additional emails'], ['phone_alias', phonesOf(entry), 'additional phones'],
  ] as const) {
    const known = new Set(aliases.filter(a => a.kind === kind).map(a => a.alias_pattern_normalized));
    known.add(kind === 'email_alias' ? canonicalizeEmail(contact.email) : normalizeAliasPattern(contact.phone ?? ''));
    const missing = values.filter(v => !known.has(kind === 'email_alias' ? canonicalizeEmail(v) : normalizeAliasPattern(v)));
    if (missing.length) fields.push({ field, from: '', to: missing.join(', ') });
  }
  return fields;
};
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dateKey = (entry: ParsedContactEntry, date: { label: string; date: string }): string => hash([entry.line, date.label, date.date]);
const occasionId = (contactId: string, label: string): string => `contact-import-${hash([contactId, normalizeAliasPattern(label)])}`;
const importedOccasion = (deps: ContactImportFileDeps, contactId: string, label: string): { occasion: Occasion | null; conflict: boolean } => {
  const matches = deps.store.resolvedContactIds(contactId)
    .map(id => deps.history?.occasion(occasionId(id, label)))
    .filter((occasion): occasion is Occasion => !!occasion);
  return { occasion: matches[0] ?? null, conflict: matches.length > 1 };
};
const MERGED_DATES = 'This merged contact has more than one occasion with that label. Review them in Yours → Occasions first.';
const existingDate = (occasion: Occasion): NonNullable<ContactImportOccasion['existing']> => ({
  title: occasion.title, date: occasion.source_next_on ?? `--${occasion.month_day}`,
  recurrence: occasion.source_next_on !== undefined ? 'once' : 'yearly',
  version: hash(occasion),
});
const datesFor = (deps: ContactImportFileDeps, entry: ParsedContactEntry, contact: ContactRecord | null): ContactImportOccasion[] => {
  const labels = new Map<string, number>();
  for (const date of entry.dates ?? []) { const label = normalizeAliasPattern(date.label); labels.set(label, (labels.get(label) ?? 0) + 1); }
  return (entry.dates ?? []).map(date => {
    const resolved = contact?.contact_id ? importedOccasion(deps, contact.contact_id, date.label) : null;
    const old = resolved?.occasion;
    const duplicates = labels.get(normalizeAliasPattern(date.label))! > 1;
    const unavailable = !deps.history ? 'Occasion reminders are not available on this server.'
      : duplicates ? 'Give dates with the same label distinct names before importing them.'
      : resolved?.conflict ? MERGED_DATES
      : !emailsOf(entry).length && !phonesOf(entry).length ? 'An email or phone is needed to match this contact on re-import.' : undefined;
    return { key: dateKey(entry, date), line: entry.line, name: contact?.name ?? entry.name ?? entry.email ?? entry.phone ?? 'Contact',
      label: date.label, date: date.date, ...(old ? { existing: existingDate(old) } : {}), ...(unavailable ? { unavailable } : {}) };
  });
};

export const planContactFileImport = (deps: ContactImportFileDeps, text: string): ContactImportFilePlan => {
  const parsed = parseContactFile(text); const errors = [...parsed.errors];
  const changes: ContactImportFileChange[] = []; const occasions: ContactImportOccasion[] = [];
  let adds = 0; let unchanged = 0; let additional_emails = 0; let additional_phones = 0;
  for (const entry of parsed.entries) {
    const { contact, ambiguous } = resolveIdentity(deps.store, entry);
    if (ambiguous) { errors.push(`line ${entry.line}: identifiers match more than one contact — resolve the duplicate first`); continue; }
    additional_emails += Math.max(0, emailsOf(entry).length - 1);
    additional_phones += Math.max(0, phonesOf(entry).length - 1);
    occasions.push(...datesFor(deps, entry, contact));
    if (!contact) { adds++; continue; }
    const fields = changesFor(deps.store, contact, entry);
    if (!fields.length) unchanged++;
    else changes.push({ email: contact.email, name: contact.name ?? contact.email, line: entry.line, fields });
  }
  return { format: parsed.format, adds, unchanged, changes, errors,
    ...(additional_emails ? { additional_emails } : {}), ...(additional_phones ? { additional_phones } : {}),
    ...(occasions.length ? { occasions } : {}), ...(parsed.date_notes.length ? { date_notes: parsed.date_notes } : {}) };
};
const reminder = (title: string, days: ContactImportOccasionSelection['reminder_days'] = 7): AssetRule => ({
  id: 'date', title, enabled: days !== null, muted: false, pinned: false, consequence: 'routine', expiry_policy: 'strict_expire',
  when: { kind: 'expiry', field: 'next_on' }, reaction: { notify: true, occurrence: 'notice', emit: false },
  schedule: { before: days ? [{ amount: days, unit: 'days' }] : [], on_day: true },
});

export const applyContactFileImport = (
  deps: ContactImportFileDeps, text: string, apply_changes: boolean, selections?: ReadonlyArray<ContactImportOccasionSelection>,
): { added: number; changed: number; skipped: number; failures: string[]; occasions_saved?: number } => {
  const now = deps.now?.() ?? Date.now(); const parsed = parseContactFile(text);
  if (typeof apply_changes !== 'boolean') throw new Error('Choose whether to apply contact changes');
  const selected = new Map<string, ContactImportOccasionSelection>();
  if (selections !== undefined) {
    if (!Array.isArray(selections) || selections.length > 10000) throw new Error('Invalid occasion selection');
    const candidates = new Map((planContactFileImport(deps, text).occasions ?? []).map(date => [date.key, date]));
    for (const selection of selections) {
      const date = selection && candidates.get(selection.key);
      if (!date || selected.has(selection.key) || date.unavailable || !['yearly', 'once'].includes(selection.recurrence)
        || (selection.recurrence === 'once' && date.date.startsWith('--'))
        || (selection.reminder_days !== undefined && ![null, 0, 1, 7, 30].includes(selection.reminder_days))) {
        throw new Error(date?.unavailable ?? 'Invalid occasion selection; preview the file again');
      }
      if (selection.expected_version !== date.existing?.version) throw new Error('An occasion changed since this review. Preview the file again.');
      selected.set(selection.key, selection);
    }
  }
  let added = 0; let changed = 0; let skipped = 0; let occasions_saved = 0; const failures: string[] = [];
  for (const entry of parsed.entries) {
    const { contact, ambiguous } = resolveIdentity(deps.store, entry);
    if (ambiguous) { skipped++; failures.push(`line ${entry.line}: identifiers match more than one contact`); continue; }
    const isNew = !contact;
    const writeContact = isNew || apply_changes;
    const dates = (entry.dates ?? []).filter(date => selected.has(dateKey(entry, date)));
    if (!writeContact && !dates.length) { skipped++; continue; }
    try {
      const run = deps.transaction ?? (<T>(work: () => T): T => work());
      const didChange = contact ? changesFor(deps.store, contact, entry).length > 0 : true;
      const afterCommit: Array<() => void> = [];
      const writeOptions = { deferNotifications: (notify: () => void) => { afterCommit.push(notify); } };
      run(() => {
        let saved = contact;
        if (writeContact && didChange && saved?.contact_id && isMentionOnlyEmail(saved.email) && entry.email) {
          saved = deps.store.promoteMentionOnlyToVerified({ contact_id: saved.contact_id, email: entry.email }, now, writeOptions);
        }
        if (writeContact && didChange && (saved ? !isMentionOnlyEmail(saved.email) : entry.email)) {
          saved = deps.store.upsertManual({ email: saved?.email ?? entry.email!,
            ...(entry.name !== undefined ? { name: entry.name } : {}), ...(entry.phone !== undefined ? { phone: entry.phone } : {}),
            ...(entry.company !== undefined ? { company: entry.company } : {}), ...(entry.title !== undefined ? { title: entry.title } : {}),
            ...(entry.photo !== undefined ? { photo: entry.photo } : {}), ...(entry.birthday !== undefined ? { birthday: entry.birthday } : {}),
            ...(entry.anniversary !== undefined ? { anniversary: entry.anniversary } : {}), ...(entry.address !== undefined ? { mailing_address: entry.address } : {}),
          }, now, writeOptions);
        } else if (writeContact && !saved) {
          saved = deps.store.createMentionOnlyContact({ name: entry.name ?? entry.phone ?? '' }, now, writeOptions);
        }
        const contact_id = saved?.contact_id;
        if (!contact_id) throw new Error('Contact has no stable identity');
        if (writeContact && didChange) {
          for (const [kind, value] of [
            ['name', entry.name], ['org', entry.company], ['title', entry.title], ['photo', entry.photo],
            ['birthday', entry.birthday], ['anniversary', entry.anniversary], ['address', entry.address],
          ] as const) {
            if (value === undefined || !isMentionOnlyEmail(saved!.email)) continue;
            deps.store.upsertContactAttribute({ contact_id, kind, value, source: 'manual', source_id: CONTACT_SOURCE_ID_MANUAL, as_of: now }, now);
          }
          for (const email of emailsOf(entry)) {
            // Merged identities retain aliases on absorbed contacts. Do not move
            // an address already resolving to this person onto another row.
            let known: string | undefined;
            try { known = deps.store.resolveCanonicalEmail(email).canonical_email; } catch { /* New address. */ }
            if (known === saved!.email) continue;
            deps.store.upsertContactAlias({ contact_id, kind: 'email_alias', alias_pattern: email, source: 'manual' }, now);
          }
          for (const phone of phonesOf(entry)) deps.store.upsertContactAlias({ contact_id, kind: 'phone_alias', alias_pattern: phone, source: 'manual',
            ...(phone === entry.phone ? { primary: true } : {}) }, now);
          deps.store.materializeContactProjection(contact_id, now);
        }
        for (const date of dates) {
          const selection = selected.get(dateKey(entry, date))!;
          const resolved = importedOccasion(deps, contact_id, date.label);
          if (resolved.conflict) throw new Error(MERGED_DATES);
          const old = resolved.occasion; const id = old?.id ?? occasionId(contact_id, date.label);
          if (selection.expected_version !== (old ? hash(old) : undefined)) throw new Error('An occasion changed since this review. Preview the file again.');
          const title = old?.title ?? `${saved?.name ?? entry.name ?? entry.email ?? 'Contact'} · ${date.label}`.slice(0, 500);
          // Keep owner-edited titles, people, mute settings and rules. A selected
          // date authorizes only the reviewed date/recurrence update.
          const { source_next_on: _previousDate, ...base } = old ?? {};
          deps.history!.saveOccasion({ ...base, id, title, month_day: date.date.slice(-5),
            ...(selection.recurrence === 'once' ? { source_next_on: date.date } : {}),
            people: [...new Set([...(old?.people ?? []), contact_id].map(person => deps.store.getByContactIdResolved(person)?.contact_id ?? person))], muted: old?.muted ?? false,
            rules: old?.rules ?? [reminder(title, selection.reminder_days)] }, now);
        }
      });
      for (const notify of afterCommit) {
        try { notify(); } catch { /* Notifications cannot undo an already committed import. */ }
      }
      if (!writeContact || !didChange) skipped++; else if (isNew) added++; else changed++;
      occasions_saved += dates.length;
    } catch (err) { failures.push(`line ${entry.line}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  return { added, changed, skipped, failures, ...(selections !== undefined ? { occasions_saved } : {}) };
};
