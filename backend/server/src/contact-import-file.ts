/** D-205 #5c — the manual contact import: `contact.import.{file_preview, file_apply}`.
 *
 *  ## An upload is a BATCH `contact.upsert`
 *
 *  Not a Source. A file the owner uploads has none of a Source's properties — no
 *  connection, no sync cadence, no delete diff, no completeness proof, no health row
 *  — so registering one would invent a Source with nothing behind it, which is this
 *  family's most-repeated mistake. It is the user, speaking, in bulk.
 *
 *  Everything it writes therefore lands at the `manual` rung with
 *  `CONTACT_SOURCE_ID_MANUAL`, whose own contract says why: *"a constant, because
 *  there is exactly one of the user."* Contributions upsert on
 *  `(contact_id, kind, source_id)`, so a re-upload REPLACES each field's value rather
 *  than accumulating — which is exactly what makes **export → edit in a spreadsheet →
 *  re-upload** work as MODIFY. The substrate already did this; nothing new was needed.
 *
 *  ## 🔑 Why the CHANGES are reviewed and the ADDS are not
 *
 *  `manual` is the TOP of the ladder: nothing can ever correct it. That is right when
 *  you TYPE a value — you meant it. It is a foot-gun when you upload a 2019 export you
 *  never opened, because three thousand stale values would silently freeze the graph
 *  and your live CRM could never fix any of them.
 *
 *  So the plan splits exactly where the risk does, and it is the same split
 *  `full_import` already makes:
 *
 *    - **ADD** — nobody by that identity exists. There is nothing to overwrite, so
 *      there is nothing to review. It just lands.
 *    - **UNCHANGED** — the file says what Recued already shows. A no-op, counted so
 *      the user can see the import was mostly agreement.
 *    - **CHANGE** — the file DISAGREES with a value the user can see today. **That,
 *      and only that, is the review.** It is opt-in, and it renders as
 *      `from → to` per field.
 *
 *  ⚠ The diff compares against the **PROJECTED** value — what the user actually SEES
 *  — not against their previous manual contribution. If HubSpot currently supplies
 *  Bob's phone and the file disagrees, applying it CHANGES what is on screen, and the
 *  review must say so. Diffing against the manual row would call that "unchanged" and
 *  then change it anyway.
 *
 *  ⚠ An ABSENT field is not an empty one. A CSV that has no `Title` column is not
 *  asserting the user has no job. Absent ⇒ contributes nothing, diffs as nothing. */

import {
  CONTACT_SOURCE_ID_MANUAL,
  canonicalizeEmail,
  type ContactImportFileChange,
  type ContactImportFilePlan,
  type MailingAddress,
} from '@recued/contracts';

import { parseContactFile, type ParsedContactEntry } from './contact-import-parse.js';
import type { ContactStore } from './storage/contact-store.js';
import type { ContactRecord } from '@recued/contracts';

export interface ContactImportFileDeps {
  store: ContactStore;
  now?: () => number;
}

/** The identity an entry resolves to, and HOW.
 *
 *  🔑 The phone leg is the manual path's duplicate-dentist fix. An entry with no
 *  email can never resolve through the address space, so on a re-upload it would look
 *  brand new EVERY time and mint the same person again and again. `findByPhone` is
 *  the re-identification key — and it refuses to guess: a phone shared by two
 *  contacts (`alternatives`) resolves to NOBODY rather than to whichever row sorted
 *  first. */
const resolveIdentity = (
  store: ContactStore,
  entry: ParsedContactEntry,
): { contact: ContactRecord | null; ambiguous: boolean } => {
  if (entry.email !== undefined) {
    const canonical = canonicalizeEmail(entry.email);
    if (canonical !== null) {
      try {
        // Through the ADDRESS SPACE — the same resolution the sync's match uses.
        // Recued may know this person under a different address (an import attached
        // one), and a naive `get(email)` would call them new and mint a duplicate.
        const survivor = store.resolveCanonicalEmail(canonical).canonical_email;
        return { contact: store.get(survivor), ambiguous: false };
      } catch {
        return { contact: null, ambiguous: false };
      }
    }
  }
  if (entry.phone !== undefined) {
    const hit = store.findByPhone(entry.phone);
    if (hit.alternatives.length > 0) return { contact: null, ambiguous: true };
    if (hit.contact !== null) return { contact: hit.contact, ambiguous: false };
  }
  return { contact: null, ambiguous: false };
};

/** Every field the file can carry, paired with what the contact currently PROJECTS.
 *  One table, so the diff and the write can never disagree about what a field IS. */
const FIELD_READERS: ReadonlyArray<{
  field: string;
  read: (c: ContactRecord) => unknown;
  from: (e: ParsedContactEntry) => unknown;
}> = [
  { field: 'name', read: (c) => c.name, from: (e) => e.name },
  { field: 'phone', read: (c) => c.phone, from: (e) => e.phone },
  { field: 'company', read: (c) => c.company, from: (e) => e.company },
  { field: 'title', read: (c) => c.title, from: (e) => e.title },
  { field: 'photo', read: (c) => c.photo, from: (e) => e.photo },
  { field: 'birthday', read: (c) => c.birthday, from: (e) => e.birthday },
  { field: 'address', read: (c) => c.mailing_address, from: (e) => e.address },
];

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === undefined || a === null) return b === undefined || b === null;
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  // `address` is structured; compare canonically (both sides are already canonical).
  return JSON.stringify(a) === JSON.stringify(b);
};

const describe = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  const a = v as MailingAddress;
  return [a.address1, a.city, a.zip, a.country].filter((x) => x).join(', ');
};

/** Parse + diff. PURE over the store's current state — no writes, so `preview` and
 *  `apply` run the SAME function and can never disagree about the plan. */
export const planContactFileImport = (
  deps: ContactImportFileDeps,
  text: string,
): ContactImportFilePlan => {
  const parsed = parseContactFile(text);
  const errors = [...parsed.errors];
  const changes: ContactImportFileChange[] = [];
  let adds = 0;
  let unchanged = 0;

  for (const entry of parsed.entries) {
    const { contact, ambiguous } = resolveIdentity(deps.store, entry);

    if (ambiguous) {
      // Two contacts share this phone. Guessing would silently rewrite the wrong
      // person — the one failure this whole family is built to prevent.
      errors.push(
        `line ${entry.line}: '${entry.phone ?? ''}' matches more than one contact — resolve the duplicate first`,
      );
      continue;
    }

    if (contact === null) {
      // Nobody by this identity. Nothing to overwrite ⇒ nothing to review.
      adds += 1;
      continue;
    }

    const fields: { field: string; from: string; to: string }[] = [];
    for (const f of FIELD_READERS) {
      const next = f.from(entry);
      // ABSENT ≠ EMPTY. A file that omits a column is not asserting the field is
      // blank, and blanking a value the user already has would be data loss dressed
      // as an import.
      if (next === undefined || next === null || next === '') continue;
      const current = f.read(contact);
      if (sameValue(current, next)) continue;
      fields.push({ field: f.field, from: describe(current), to: describe(next) });
    }

    if (fields.length === 0) {
      unchanged += 1;
      continue;
    }
    changes.push({
      email: contact.email,
      name: contact.name ?? contact.email,
      line: entry.line,
      fields,
    });
  }

  return { format: parsed.format, adds, unchanged, changes, errors };
};

/** Apply the plan. Re-parses the SAME bytes, so the client cannot hand back a plan
 *  it edited — **the client sends the FILE; the SERVER decides what it means.**
 *
 *  `apply_changes: false` lands the ADDs only. That is the whole point of the split:
 *  a user who uploads a stale export can take the new people without letting three
 *  thousand stale values freeze the graph. */
export const applyContactFileImport = (
  deps: ContactImportFileDeps,
  text: string,
  apply_changes: boolean,
): { added: number; changed: number; skipped: number; failures: string[] } => {
  const now = deps.now?.() ?? Date.now();
  const parsed = parseContactFile(text);
  const failures: string[] = [];
  let added = 0;
  let changed = 0;
  let skipped = 0;

  for (const entry of parsed.entries) {
    const { contact, ambiguous } = resolveIdentity(deps.store, entry);
    if (ambiguous) {
      skipped += 1;
      continue;
    }

    const isNew = contact === null;
    if (!isNew && !apply_changes) {
      // The user declined the changes. An EXISTING contact is left exactly as it is
      // — including one whose fields all agree, which was never a change anyway.
      skipped += 1;
      continue;
    }

    try {
      if (entry.email !== undefined) {
        // The emailed path IS `contact.upsert`, in bulk. Nothing here is new
        // machinery — it is the same write the contact dialog makes, and its
        // contributions land at `manual` / `CONTACT_SOURCE_ID_MANUAL`, upserting over
        // whatever the previous upload said.
        deps.store.upsertManual(
          {
            email: entry.email,
            ...(entry.name !== undefined ? { name: entry.name } : {}),
            ...(entry.phone !== undefined ? { phone: entry.phone } : {}),
            ...(entry.company !== undefined ? { company: entry.company } : {}),
            ...(entry.title !== undefined ? { title: entry.title } : {}),
            ...(entry.photo !== undefined ? { photo: entry.photo } : {}),
            ...(entry.birthday !== undefined ? { birthday: entry.birthday } : {}),
            ...(entry.address !== undefined ? { mailing_address: entry.address } : {}),
          },
          now,
        );
      } else if (isNew) {
        // 🔑 THE DENTIST, in a vCard. No address — so `upsertManual` cannot take him
        // (`contacts.email` is the PK and it throws on a falsy one). The email-free
        // manual create already exists and already stamps `manual` /
        // `CONTACT_SOURCE_ID_MANUAL`: it was built for the chat stub ("Mom"), and a
        // phone-only vCard entry is the same shape.
        const stub = deps.store.createMentionOnlyContact(
          { name: entry.name ?? (entry.phone ?? '') },
          now,
        );
        const contact_id = stub.contact_id;
        if (contact_id === undefined) throw new Error('created contact has no contact_id');
        if (entry.phone !== undefined) {
          deps.store.upsertContactAlias({
            contact_id,
            kind: 'phone_alias',
            alias_pattern: entry.phone,
            source: 'manual',
            source_id: CONTACT_SOURCE_ID_MANUAL,
          }, now);
        }
        for (const [kind, value] of [
          ['org', entry.company],
          ['title', entry.title],
          ['photo', entry.photo],
          ['birthday', entry.birthday],
          ['address', entry.address],
        ] as const) {
          if (value === undefined) continue;
          deps.store.upsertContactAttribute({
            contact_id,
            kind,
            value,
            source: 'manual',
            source_id: CONTACT_SOURCE_ID_MANUAL,
            as_of: now,
          }, now);
        }
        // ONE materialize, after every contribution has landed — never per-write,
        // which would briefly project a half-written set.
        deps.store.materializeContactProjection(contact_id, now);
      } else {
        // An emailless entry that RESOLVED (by phone) is an update to someone we
        // already know. Contribute directly — there is no `upsertManual` without an
        // email, and re-keying their identity is not what the user asked for.
        const contact_id = contact.contact_id;
        if (contact_id === undefined) throw new Error('contact has no contact_id');
        for (const [kind, value] of [
          ['name', entry.name],
          ['org', entry.company],
          ['title', entry.title],
          ['photo', entry.photo],
          ['birthday', entry.birthday],
          ['address', entry.address],
        ] as const) {
          if (value === undefined) continue;
          deps.store.upsertContactAttribute({
            contact_id,
            kind,
            value,
            source: 'manual',
            source_id: CONTACT_SOURCE_ID_MANUAL,
            as_of: now,
          }, now);
        }
        deps.store.materializeContactProjection(contact_id, now);
      }
      if (isNew) added += 1;
      else changed += 1;
    } catch (err) {
      failures.push(
        `line ${entry.line}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { added, changed, skipped, failures };
};
