/** D-336 slice F (§3.7) — `contact.write`: an AI adds a contact to the owner's address book,
 *  or changes a contact's name, phone, company, birthday or anniversary.
 *
 *  🔑 A SIMPLE STORE AT THE OWNER'S RANK (owner, 2026-10-31: *"since user approve then it
 *  should be counted as yours"*). Every call is a `write`, so it runs only once the owner
 *  says yes or under a standing rule they accepted, and what it writes goes through the
 *  owner's own path (`upsertManual`, at `manual`): a later CRM or contact-book import cannot
 *  replace it. A call nobody but its own conversation approved (a chat under a contract) is
 *  refused before it is asked, and again at run without `owner_approved`.
 *
 *  ⛔ ONLY WHAT CHANGES IS WRITTEN. A field written at the owner's rank locks out every
 *  later sync, so re-sending a company the CRM keeps would freeze it. A field the call names
 *  with the value the contact already holds is refused before the owner is asked, and
 *  dropped if it became equal by the time the write runs.
 *
 *  ⛔ THE OWNER'S FORM'S FIELDS, LESS ITS CONTROLS. A contact's relationship decides which
 *  sphere its records are in (`createSphereStore`), so it is an access boundary and stays the
 *  owner's, as its privacy marks do (`upsertManual` refuses both from anyone else). A title
 *  or an address is left out too: the owner's form cannot change either, so a value at the
 *  owner's rank there could be corrected by nobody.
 *
 *  ⚠ A NAME ALONE ALWAYS ADDS A CONTACT (§3.7: "a create never merges by name"). Two
 *  contacts for one person are left to the merge suggestions (D-138). The description tells
 *  the agent to search first. ⚠ Model-facing — `chat-prompt-optimization-log.md`. */

import {
  canonicalizeEmail,
  isMailboxAddress,
  executionSourceContractId,
  isContactAnnualDate,
  ownerApprovesCallsOf,
  type ApprovalValueLabels,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type ContactRecord,
  type ExecutionSource,
} from '@recued/contracts';
import { recordMade } from './claim-link.js';
import type { Tier1Handler } from '@recued/middleware/internal-tool-registry/index.js';

import {
  isAiToolPrincipal,
  isCollectionReadGrantedForDispatch,
  type ChatToolHandlerDeps,
} from './chat-tool-handlers.js';
import { conversationWords, crmRecordGivenAsContact, namedInPart } from './named-in-part.js';
import { createReadScope } from './situations/read-scope.js';
import { isMentionOnlyEmail, type ContactStore } from './storage/contact-store.js';

/** The grant op the contract governs: owner-on, door-off (`OWNER_DEFAULT_ONLY_GRANT_ENTRIES`). */
export const CONTACT_WRITE_OP_ID = 'core.contact.write';

/** What an AI may write on a contact, in the order a refusal lists them. */
const FIELDS = ['name', 'phone', 'company', 'birthday', 'anniversary'] as const;
type Field = typeof FIELDS[number];
const ARGS: ReadonlySet<string> = new Set(['target_id', 'email', ...FIELDS]);
/** The owner's own controls on a contact. */
const OWNER_CONTROLS: ReadonlySet<string> = new Set(['relationship', 'privacy_marks']);
/** The longest value kept, as for a claim's part. */
const VALUE_MAX = 200;

type Values = Partial<Record<Field, string>>;

const refuse = (detail: string): ChatDispatchResult => ({ ok: false, reason: 'invalid_args', detail });
const blocked = (detail: string): ChatDispatchResult => ({ ok: false, reason: 'classification_blocked', detail });

const andList = (items: readonly string[]): string =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const named = (keys: readonly string[]): string => andList(keys.map((key) => `\`${key}\``));

/** The contract grants the write, and the caller is an AI tool's principal. */
const admitted = (deps: ChatToolHandlerDeps, source: ExecutionSource | undefined): boolean => {
  const gate = deps.getOpAdmissionGate?.();
  return gate !== undefined && source !== undefined && isAiToolPrincipal(gate, source)
    && gate.isOpGranted(source, CONTACT_WRITE_OP_ID);
};

/** The caller may read the contacts it writes: the contact collection, and not held to
 *  spheres (the fence `contact.read` and a claim's linked end meet). */
const readsContacts = (deps: ChatToolHandlerDeps, ctx: ChatDispatchContext): boolean => {
  if (!isCollectionReadGrantedForDispatch(deps, ctx, 'contact')) return false;
  const access = deps.getSituationAccess?.();
  if (!access) return true;
  try {
    return !createReadScope(access, ctx.execution_source).limited;
  } catch {
    return false;
  }
};

/** The contact a `target_id` names, as `contact.read` reads it: an email through any merge,
 *  anything else as a contact id. A merged-away row is never written. */
const contactOf = (store: ContactStore, target: string): ContactRecord | null => {
  let row: ContactRecord | null;
  if (target.includes('@')) {
    let canonical = target;
    try { canonical = store.resolveCanonicalEmail(target).canonical_email; } catch { /* a broken chain: read the row itself */ }
    row = store.get(canonical);
  } else {
    row = store.getByContactIdResolved(target);
  }
  return row === null || row.merged_into !== undefined ? null : row;
};

/** How the agent is told which contact it named. */
const nameOf = (row: ContactRecord): string => {
  const name = row.name?.trim();
  if (name) return name;
  return isMentionOnlyEmail(row.email) ? 'this contact' : row.email;
};

/** Whether a field already holds the value: a phone by its digits, the rest as written. */
const holds = (field: Field, current: string | undefined, value: string): boolean => {
  if (current === undefined) return false;
  if (field === 'phone') {
    const digits = (phone: string): string => phone.replace(/[^\d+]/gu, '');
    return digits(current) !== '' && digits(current) === digits(value);
  }
  return current.trim().replace(/\s+/gu, ' ') === value;
};

/** The fields a call passes, checked; or why they cannot be written. */
const readValues = (args: Record<string, unknown>): Values | string => {
  const values: Values = {};
  for (const field of FIELDS) {
    const value = args[field];
    if (value === undefined) continue;
    if (value === null) {
      return `contact.write: \`${field}\` is null. Leave out a field you are not changing; an AI cannot remove one`;
    }
    if (typeof value !== 'string') return `contact.write: \`${field}\` must be text`;
    const text = value.trim().replace(/\s+/gu, ' ');
    if (text === '') return `contact.write: \`${field}\` is empty. Leave out a field you are not changing`;
    if (text.length > VALUE_MAX) return `contact.write: \`${field}\` is longer than ${VALUE_MAX} characters`;
    if ((field === 'birthday' || field === 'anniversary') && !isContactAnnualDate(text)) {
      return `contact.write: \`${field}\` must be a date as YYYY-MM-DD, or --MM-DD when the year is not known`;
    }
    if (field === 'phone' && !/\d/u.test(text)) return 'contact.write: `phone` must be a phone number';
    values[field] = text;
  }
  return values;
};

/** The origin a write is stamped with: the AI's turn, through the engine surface, so the
 *  row never reads as typed by the owner into their own client (D-177 N.11 rule 1). */
const writeOrigin = (source: ExecutionSource) => {
  const contract = executionSourceContractId(source);
  return {
    origin_actor: source.actor,
    ...(contract !== undefined ? { origin_contract_id: contract } : {}),
    origin_surface: 'engine' as const,
  };
};

/** An address that is not one mailbox address alone (audit 2026-11-01). */
const EMAIL_ALONE = 'contact.write: `email` must be one email address on its own, like dana@example.com, with no name or angle brackets around it';
/** D-336 slice M — the address another contact has: two contacts may be one person, which the
 *  owner settles by merging them. */
const takenAddress = (email: string, owner: ContactRecord, row: ContactRecord): string =>
  `contact.write: ${email} is already the contact ${nameOf(owner)}, so ${nameOf(row)} cannot take it. `
  + 'If they are one person, tell the user they can merge them in Contacts';
const NOT_FOUND = "contact.write: no contact in the user's address book has this target_id. Pass the "
  + '`target_id` contact.search returns, or leave it out to add a contact';

/** One `contact.write` call, or its check (`check`), which makes every check the write makes
 *  and stops before it writes: `null` there when it would run. */
export const runContactWrite = async (
  deps: ChatToolHandlerDeps,
  raw: unknown,
  ctx: ChatDispatchContext,
  check: boolean,
): Promise<ChatDispatchResult | null> => {
  const args = raw === undefined || raw === null
    ? {}
    : typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (args === null) return refuse('args must be an object');
  const controls = Object.keys(args).filter((key) => OWNER_CONTROLS.has(key) && args[key] !== undefined);
  if (controls.length > 0) {
    return refuse(`contact.write: a contact's relationship and privacy marks are the user's to set, in Contacts. Leave ${named(controls)} out`);
  }
  const other = Object.keys(args).filter((key) => !ARGS.has(key) && args[key] !== undefined);
  if (other.length > 0) {
    return refuse(`contact.write takes ${named(['target_id', 'email', ...FIELDS])}, not ${named(other)}`);
  }
  const source = ctx.execution_source;
  if (!admitted(deps, source)) return blocked('contact.write is not granted to this contract (write rejected)');
  if (!readsContacts(deps, ctx)) return blocked('contact.write: this contract cannot read contacts, so it cannot write them');
  // Only the owner's yes makes what is written theirs. A check asks whether that yes is the
  // one this call will get; the run, whether it got it.
  if (check ? !ownerApprovesCallsOf(source!) : ctx.owner_approved !== true) {
    return refuse("contact.write: only the owner can approve a change to their contacts, and this conversation's "
      + 'approvals are its own. Tell the user the owner can make the change in Contacts');
  }
  const values = readValues(args);
  if (typeof values === 'string') return refuse(values);
  const store = deps.getContactStore();
  if (!store) return { ok: false, reason: 'execution_error', detail: 'contact store unavailable' };
  const now = (deps.now ?? Date.now)();

  if (args.target_id !== undefined) {
    if (typeof args.target_id !== 'string' || args.target_id.trim() === '') {
      return refuse('contact.write: `target_id` must be a contact.search target_id; leave it out to add a contact');
    }
    const row = contactOf(store, args.target_id.trim());
    // D-336 (spec §49) — a CRM record's id is not an address book contact's: say whose it is.
    if (row === null) return refuse(crmRecordGivenAsContact(deps, args.target_id.trim()) ?? NOT_FOUND);
    // D-336 slice U — a contact the user named only in part may be someone else: the model
    // asks once, before the owner is. Never at run: the owner's yes named the contact.
    if (check) {
      const words = await conversationWords(deps, ctx);
      if (words !== undefined && namedInPart(row.name, words)) {
        // The name reaches the model as an alias and the user as the full name, so the question
        // writes it as given: live, half the questions said only "a contact named Mia".
        return refuse(`contact.write: the user named only part of ${nameOf(row)}'s name, so they may mean someone else. `
          + `Ask them whether they mean ${nameOf(row)}, writing it as it is here so that they see the full name, before `
          + 'changing this contact; call again once they say so. If they mean someone else, leave target_id out to add that person');
      }
    }
    // D-336 slice M — an email goes only to a contact that has none (`email: null` to the
    // agent). The contact is then keyed on it, and keeps its notes and links: the slice I
    // promotion. A saved address is changed by the owner only, on the contact's Edit form
    // (slice R, the owner: "You only"): it redirects the mail sent to that person.
    const given = args.email === undefined ? undefined : typeof args.email === 'string' ? canonicalizeEmail(args.email) : '';
    if (given !== undefined) {
      if (!isMentionOnlyEmail(row.email)) {
        if (given !== row.email) {
          return refuse(`contact.write: ${nameOf(row)} has an email address already. Only the user can change a saved one, `
            + "on the contact's Edit form in Contacts: tell them they can change it there. Leave `email` out to change the rest");
        }
      } else {
        if (!isMailboxAddress(given)) return refuse(EMAIL_ALONE);
        const owner = contactOf(store, given);
        if (owner !== null) return refuse(takenAddress(given, owner, row));
      }
    }
    const email = given !== undefined && isMentionOnlyEmail(row.email) ? given : undefined;
    const passed = Object.keys(values) as Field[];
    if (passed.length === 0 && given === undefined) {
      return refuse(`contact.write: name what to change on ${nameOf(row)}: its ${andList([...FIELDS])}`);
    }
    const same = passed.filter((field) => holds(field, row[field], values[field]!));
    // The address it has, sent again, is a value it already holds.
    const sameNames: string[] = [...same, ...(given !== undefined && email === undefined ? ['email'] : [])];
    if (check && sameNames.length > 0) {
      const rest = sameNames.length === passed.length + (given !== undefined ? 1 : 0)
        ? 'There is nothing to change'
        : `Leave ${sameNames.length > 1 ? 'them' : 'it'} out, to change the rest`;
      return refuse(`contact.write: ${nameOf(row)} already has this ${andList(sameNames)}. ${rest}`);
    }
    if (check) return null;
    const changes: Values = {};
    for (const field of passed) if (!same.includes(field)) changes[field] = values[field]!;
    const changed = Object.keys(changes);
    if (changed.length === 0 && email === undefined) {
      return { ok: true, result: { target_id: row.email, name: nameOf(row), changed: [], note: 'It already said that; nothing was changed.' } };
    }
    try {
      let current = row;
      if (email !== undefined) {
        if (row.contact_id === undefined) return refuse(NOT_FOUND);
        // The check above looks the address up as the promotion does, so it refuses first.
        current = store.promoteMentionOnlyToVerified({ contact_id: row.contact_id, email }, now, writeOrigin(source!));
      }
      // The contact's last interaction stays as it was: a detail told to an AI is not one.
      // It runs after a promotion alone too, which stamps no origin, so the row names this
      // write as its last (D-177 N.11 rule 1).
      const saved = store.upsertManual(
        { email: current.email, ...changes, last_interaction: current.last_interaction },
        now,
        writeOrigin(source!),
      );
      return { ok: true, result: { target_id: saved.email, name: nameOf(saved), changed: [...(email !== undefined ? ['email'] : []), ...changed] } };
    } catch (e) {
      return { ok: false, reason: 'execution_error', detail: e instanceof Error ? e.message : String(e) };
    }
  }

  if (args.email !== undefined) {
    const email = typeof args.email === 'string' ? canonicalizeEmail(args.email) : '';
    // D-336 audit 2026-11-01 — the address alone: a contact keyed on "mia <mia@…>" cannot be put right.
    if (!isMailboxAddress(email)) return refuse(EMAIL_ALONE);
    const existing = contactOf(store, email);
    if (existing !== null) {
      return refuse(`contact.write: ${email} is already the contact ${nameOf(existing)}. To change it, pass target_id "${existing.email}"`);
    }
    if (check) return null;
    try {
      const saved = store.upsertManual({ email, ...values }, now, writeOrigin(source!));
      // D-336 slice Q — a save of its turn or its app naming them is linked to them.
      await recordMade(deps, { kind: 'contact', target_id: saved.email, name: nameOf(saved) }, ctx);
      return { ok: true, result: { target_id: saved.email, name: nameOf(saved), added: true } };
    } catch (e) {
      return { ok: false, reason: 'execution_error', detail: e instanceof Error ? e.message : String(e) };
    }
  }

  if (values.name === undefined) {
    return refuse('contact.write: to add a contact, pass its `email`, or its `name` for someone with no email '
      + 'address. To change one, pass its `target_id` from contact.search');
  }
  if (check) return null;
  try {
    // A name alone is a mention-only contact (§2): no address anyone can reach, keyed by a
    // placeholder until a real one is known. Its other details go on as a change does.
    const { name, ...rest } = values;
    const created = store.createMentionOnlyContact({ name }, now, writeOrigin(source!));
    const saved = Object.keys(rest).length === 0
      ? created
      : store.upsertManual({ email: created.email, ...rest, last_interaction: created.last_interaction }, now, writeOrigin(source!));
    // D-336 slice Q — a save of its turn or its app naming them is linked to them.
    await recordMade(deps, { kind: 'contact', target_id: saved.email, name: nameOf(saved) }, ctx);
    return { ok: true, result: { target_id: saved.email, name: nameOf(saved), added: true } };
  } catch (e) {
    return { ok: false, reason: 'execution_error', detail: e instanceof Error ? e.message : String(e) };
  }
};

export const createContactWriteHandler = (deps: ChatToolHandlerDeps): Tier1Handler =>
  async (raw, ctx) => (await runContactWrite(deps, raw, ctx, false))!;

/** D-329 — the check asked before the owner is: `null` when the call would run. */
export const checkContactWrite = (
  deps: ChatToolHandlerDeps,
  raw: unknown,
  ctx: ChatDispatchContext,
): Promise<ChatDispatchResult | null> => runContactWrite(deps, raw, ctx, true);

/** How the owner knows the contact a held change names: by its name, on the ask and the
 *  card (`value_labels`), never shown to the AI. A mention-only contact's `target_id` is a
 *  placeholder address, which would mean nothing to them. */
export const contactAskLabels = async (
  deps: ChatToolHandlerDeps,
  raw: unknown,
  ctx: ChatDispatchContext,
): Promise<ApprovalValueLabels | undefined> => {
  const target = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).target_id : undefined;
  if (typeof target !== 'string' || target.trim() === '' || !readsContacts(deps, ctx)) return undefined;
  const store = deps.getContactStore();
  const row = store === undefined ? null : contactOf(store, target.trim());
  const name = row?.name?.trim();
  return row === null || !name ? undefined : { target_id: { [target]: name } };
};
