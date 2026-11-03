/** D-121 Phase 1 — rpc handlers for `contact.*`.
 *
 *  Nine methods:
 *    - search.local: paired-owner saved-identifier search
 *    - upsert / list / get / delete: warehouse CRUD (D-121 P1)
 *    - resolve: identifier → contact_id resolver (D-145 PA8 follow-on)
 *    - contributions: the per-source value view (D-205 merge-review item 3) — every
 *      source's assertion behind each projected field, not just the winner
 *    - create_by_name: a contact from a name alone (D-336 slice H)
 *    - add_email: a contact with no address gets its email (D-336 slice I)
 *
 *  The mail / calendar derivation paths populate `data.contact`
 *  automatically; this surface covers manual UI entry plus convenience
 *  reads for the warehouse explorer + chat. The handler validates
 *  input + routes to the shared `ContactStore`; full canonicalization
 *  happens inside the store. */

import {
  MEMORY_CLAIM_PART_MAX,
  RpcError,
  isContactAliasPlatform,
  resolveContributionsByKind,
  sanitizeNetworkDomains,
  normalizeAliasPattern,
  canonicalizeEmail,
  isMailboxAddress,
} from '@recued/contracts';
import type {
  Actor,
  HandlerSlice,
  ServerRpcRegistry,
  ContactContributionView,
  ContactRecord,
  ContactSearchLocalRequest,
  ContactSearchLocalResponse,
  ContactAdditionalIdentifiers,
  ContactSource,
  MailingAddress,
  NetworkDomain,
  ContactAliasPlatform,
  OriginSurface,
  TimelineRollup,
} from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import { isMentionOnlyEmail, type ContactStore } from './storage/contact-store.js';

export interface ContactRpcDeps {
  store: ContactStore;
  now?: () => number;
  /** D-161 P2 — origin provenance facet for the manual `contact.upsert`
   *  write, SERVER-INJECTED (never read from `args`). Two injection sites:
   *   - direct paired-client `contact.upsert` rpc (`makeContactHandlers`)
   *     → `'user_self'` (the `user` channel by construction);
   *   - the recipe `contact-upsert` kernel ingredient (D-122 graph-builder)
   *     → `wire-executor-config.ts` lifts the engine `stepMeta.actor` off
   *     the trusted kernel dispatch input, so an MCP-run recipe's contact
   *     write carries `contracted_user`, a cron/reactive recipe `system`.
   *  D-177 N.11 rule 1: stamped on EVERY write — the store re-stamps the
   *  facets on update too (last-writer semantics for the
   *  stored-cleanliness gate). Absent → the store defaults to
   *  `'system'`. A client payload can never spoof it (I-6 / A.5). */
  origin_actor?: Actor;
  /** D-161 P2 — contract in force on the writing execution; paired with
   *  `origin_actor`, present iff contracted. */
  origin_contract_id?: string;
  /** D-177 N.11 rule 1 — the write SURFACE, same injection boundary as
   *  `origin_actor`: `'client_rpc'` from `makeContactHandlers` (the
   *  human's own paired client), `'engine'` from the recipe kernel path
   *  in `wire-executor-config.ts`. Absent → `'system'`. */
  origin_surface?: OriginSurface;
  /** D-226 — a BATCHED root read for a page of contacts. Optional: unwired,
   *  `contact.list` simply never carries rollups and the list renders without
   *  the columns. ⚠ It must stay batched — the obvious "just loop
   *  `readRootProjections`" is the N+1 this exists to avoid, and it would look
   *  identical from here. */
  rollupsForKeys?: (emails: readonly string[]) => Record<string, TimelineRollup[]>;
  /** D-336 slice R — what follows a contact to its new address outside the contact store,
   *  once `contact.change_email` has re-keyed it. Best-effort: the old address stays the
   *  contact's alias, so anything this misses still finds the contact. */
  onEmailChanged?: (change: { contact_id: string; from_email: string; to_email: string }) => Promise<void> | void;
}

const isValidSource = (s: unknown): s is ContactSource =>
  s === 'email_from' ||
  s === 'email_to' ||
  s === 'calendar_attendee' ||
  s === 'manual';

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((entry) => typeof entry === 'string');

/** D-336 slice H — `contact.create_by_name`: the owner adds a contact from a name alone,
 *  where a relationship's "Link to a contact" found nobody (§3.6, "the picker can make the
 *  contact"). A mention-only contact (`createMentionOnlyContact`): its name at the owner's
 *  rank, its origin the paired client's from `deps`, never `args`. A name never merges into
 *  a contact already there; two contacts for one person are left to the merge suggestions. */
export const handleContactCreateByName = async (
  deps: ContactRpcDeps,
  args: { name: string },
): Promise<{ contact: ContactRecord }> => {
  const name = typeof args?.name === 'string' ? args.name.trim() : '';
  if (name === '') throw new RpcError('bad_request', 'Write the name first.', 400);
  if (name.length > MEMORY_CLAIM_PART_MAX) {
    throw new RpcError('bad_request', `A name can be at most ${MEMORY_CLAIM_PART_MAX} characters.`, 400);
  }
  const contact = deps.store.createMentionOnlyContact({ name }, deps.now?.(), {
    ...(deps.origin_actor !== undefined ? { origin_actor: deps.origin_actor } : {}),
    ...(deps.origin_actor !== undefined && deps.origin_contract_id !== undefined
      ? { origin_contract_id: deps.origin_contract_id }
      : {}),
    ...(deps.origin_surface !== undefined ? { origin_surface: deps.origin_surface } : {}),
  });
  return { contact };
};

/** D-336 slice I — `contact.add_email`: the owner gives a contact with no address its
 *  email, from the contact's Edit form. The store's promotion re-keys it, the step a
 *  contact import and a contact book's sync take: the contact keeps its id, so its notes,
 *  relationships and fields stay, and the placeholder stays its alias, so a reference
 *  that holds it still reaches the contact. An address already another contact's is
 *  refused with their name: one address is one contact, and two for one person are a
 *  merge. */
export const handleContactAddEmail = async (
  deps: ContactRpcDeps,
  args: { contact_id: string; email: string },
): Promise<{ contact: ContactRecord }> => {
  const contactId = typeof args?.contact_id === 'string' ? args.contact_id.trim() : '';
  if (contactId === '') throw new RpcError('bad_request', 'contact.add_email: contact_id is required', 400);
  const typed = typeof args?.email === 'string' ? args.email.trim() : '';
  if (typed === '') throw new RpcError('bad_request', 'Write the email address first.', 400);
  const email = canonicalizeEmail(typed);
  // `canonicalizeEmail` is no address parser: it keeps a display name and angle brackets,
  // and a contact keyed on "mia<mia@…>" cannot be put right (audit 2026-11-01).
  if (!isMailboxAddress(email)) {
    throw new RpcError('bad_request', 'Write the email address alone, like dana@example.com.', 400);
  }
  const contact = deps.store.getByContactId(contactId);
  if (contact === null) throw new RpcError('not_found', 'This contact is no longer there.', 404);
  if (contact.merged_into !== undefined) {
    throw new RpcError('conflict', 'This contact was merged into another. Add the address there.', 409);
  }
  if (!isMentionOnlyEmail(contact.email)) {
    // The same address again (a retried save) is the contact as it is.
    if (contact.email === email) return { contact };
    throw new RpcError('conflict', 'This contact already has an email address.', 409);
  }
  let promoted: ContactRecord;
  try {
    promoted = deps.store.promoteMentionOnlyToVerified({ contact_id: contactId, email }, deps.now?.());
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('promote_email_already_attached')) throw err;
    throw addressTaken(deps, email);
  }
  // D-336 slice R — and what was keyed on the placeholder outside the store, as a change carries it.
  await carryOutsideTheStore(deps, contactId, contact.email, promoted.email);
  return { contact: promoted };
};

const carryOutsideTheStore = async (deps: ContactRpcDeps, contact_id: string, from_email: string, to_email: string) => {
  try {
    await deps.onEmailChanged?.({ contact_id, from_email, to_email });
  } catch (err) {
    console.warn('[contact] a changed address was not carried to every record that held the old one', err);
  }
};

/** D-336 slice R — `contact.change_email`: the owner changes a contact's saved email, from the
 *  contact's Edit form. The store re-keys the contact onto the new address
 *  (`changeVerifiedEmail`): it keeps its id, so its notes, relationships and fields stay, and
 *  the old address stays its second address, so mail from it still finds the contact (the
 *  owner: "Keep as second address"). The owner's only: `contact.write` refuses an AI (the
 *  owner: "You only"). */
export const handleContactChangeEmail = async (
  deps: ContactRpcDeps,
  args: { contact_id: string; email: string },
): Promise<{ contact: ContactRecord }> => {
  const contactId = typeof args?.contact_id === 'string' ? args.contact_id.trim() : '';
  if (contactId === '') throw new RpcError('bad_request', 'contact.change_email: contact_id is required', 400);
  const typed = typeof args?.email === 'string' ? args.email.trim() : '';
  if (typed === '') throw new RpcError('bad_request', 'Write the email address first.', 400);
  const email = canonicalizeEmail(typed);
  if (!isMailboxAddress(email)) {
    throw new RpcError('bad_request', 'Write the email address alone, like dana@example.com.', 400);
  }
  const contact = deps.store.getByContactId(contactId);
  if (contact === null) throw new RpcError('not_found', 'This contact is no longer there.', 404);
  if (contact.merged_into !== undefined) {
    throw new RpcError('conflict', 'This contact was merged into another. Change the address there.', 409);
  }
  if (isMentionOnlyEmail(contact.email)) {
    throw new RpcError('conflict', 'This contact has no email address yet. Add one instead.', 409);
  }
  // The same address again (a retried save) is the contact as it is.
  if (contact.email === email) return { contact };
  let changed: ContactRecord;
  try {
    changed = deps.store.changeVerifiedEmail({ contact_id: contactId, email }, deps.now?.(), {
      ...(deps.origin_actor !== undefined ? { origin_actor: deps.origin_actor } : {}),
      ...(deps.origin_surface !== undefined ? { origin_surface: deps.origin_surface } : {}),
    });
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('change_email_already_attached')) throw err;
    throw addressTaken(deps, email);
  }
  await carryOutsideTheStore(deps, contactId, contact.email, changed.email);
  return { contact: changed };
};

/** An address another contact has, refused with their name: one address is one contact. */
const addressTaken = (deps: ContactRpcDeps, email: string): RpcError => {
  let owner: ContactRecord | null = null;
  try { owner = deps.store.get(deps.store.resolveCanonicalEmail(email).canonical_email); } catch { /* named by its address alone */ }
  const whose = owner?.name?.trim() ? `${owner.name.trim()}'s` : "another contact's";
  // D-336 slice P — and which contact it is, so the form can offer to merge the two.
  const details = owner === null || owner.merged_into !== undefined
    ? { reason: 'address_taken' }
    : { reason: 'address_taken', contact_email: owner.email, ...(owner.name?.trim() ? { contact_name: owner.name.trim() } : {}) };
  return new RpcError('conflict', `“${email}” is already ${whose} address.`, 409, undefined, details);
};

/** Audit 2026-11-01 (second) — a contact a paired client adds is keyed on its address for good,
 *  so it must be one mailbox address alone, as `contact.add_email` and `contact.write` take one:
 *  the New contact form took `Mia <mia@example.test>` whole. An address that is a contact's
 *  already (its own, or a second one) is an edit of that contact, whatever it holds. The
 *  recipe and booking doors (`handleContactUpsert` called directly) are not changed here. */
export const requireMailboxForNewContact = (store: ContactStore, raw: unknown): void => {
  const email = typeof raw === 'string' ? canonicalizeEmail(raw) : '';
  if (email === '') return; // `handleContactUpsert` refuses it.
  let known = email;
  try { known = store.resolveCanonicalEmail(email).canonical_email; } catch { /* a broken chain: as new */ }
  if (store.get(known) !== null) return;
  if (!isMailboxAddress(email)) {
    throw new RpcError('bad_request', 'Write the email address alone, like dana@example.com.', 400);
  }
};

export const handleContactUpsert = async (
  deps: ContactRpcDeps,
  args: {
    email: string;
    name?: string;
    last_interaction?: number;
    first_seen?: number;
    phone?: string;
    mailing_address?: MailingAddress;
    company?: string;
    title?: string;
    birthday?: string | null;
    anniversary?: string | null;
    relationship?: import('@recued/contracts').ContactRelationship | null;
    privacy_marks?: import('@recued/contracts').ContactPrivacyMark[];
    network_domain?: NetworkDomain[];
  },
  /** D-210 audit finding 5 — TRUSTED, server-internal write options.
   *
   *  ⛔ DELIBERATELY A SEPARATE PARAMETER, NOT A FIELD ON `args`. `args` is the
   *  `contact.upsert` rpc payload; a caller able to set its own provenance rung
   *  there could park an unverified value at the top of the contribution ladder,
   *  which is precisely what the ladder exists to prevent. Only a server-internal
   *  caller that KNOWS its values were not hand-typed by the owner passes this,
   *  and the rpc path never passes it at all. ⇒ [[separate_authorization_axes]] */
  internal?: { readonly attribution_source?: 'derived' },
): Promise<{ contact: ContactRecord }> => {
  if (typeof args.email !== 'string' || !args.email.trim()) {
    throw new RpcError('bad_request', 'contact.upsert: email is required');
  }
  if ((args.relationship !== undefined || args.privacy_marks !== undefined)
    && (deps.origin_actor !== 'user_self' || deps.origin_surface !== 'client_rpc')) throw new RpcError('unauthorized', 'Contact relationship and privacy marks are owner controls.', 403);
  if (args.network_domain !== undefined && !isStringArray(args.network_domain)) {
    throw new RpcError(
      'bad_request',
      'contact.upsert: network_domain must be an array of strings',
    );
  }
  let networkDomain: NetworkDomain[] | undefined;
  if (args.network_domain !== undefined) {
    try {
      networkDomain = sanitizeNetworkDomains(args.network_domain);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RpcError('bad_request', `contact.upsert: ${msg}`);
    }
  }
  try {
    const contact = deps.store.upsertManual(
      {
        email: args.email,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.last_interaction !== undefined
          ? { last_interaction: args.last_interaction }
          : {}),
        ...(args.first_seen !== undefined ? { first_seen: args.first_seen } : {}),
        ...(args.phone !== undefined ? { phone: args.phone } : {}),
        ...(args.mailing_address !== undefined
          ? { mailing_address: args.mailing_address }
          : {}),
        ...(args.company !== undefined ? { company: args.company } : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.birthday !== undefined ? { birthday: args.birthday } : {}),
        ...(args.anniversary !== undefined ? { anniversary: args.anniversary } : {}),
        ...(args.relationship !== undefined ? { relationship: args.relationship } : {}),
        ...(args.privacy_marks !== undefined ? { privacy_marks: args.privacy_marks } : {}),
      },
      deps.now?.(),
      // D-161 P2 — stamp the SERVER-INJECTED write-actor (from `deps`,
      // never `args` — the spoofing boundary). The direct paired-client
      // `contact.upsert` rpc injects `'user_self'` + `'client_rpc'` (the
      // `user` channel); the recipe `contact-upsert` kernel ingredient
      // injects the run's `stepMeta.actor` + `'engine'` (an MCP recipe →
      // `contracted_user`, cron → `system`). Absent → the store defaults
      // to `'system'`. D-177 N.11 rule 1: the store re-stamps the facets
      // on EVERY write (create and update) — last-writer semantics for
      // the stored-cleanliness gate.
      {
        ...(deps.origin_actor !== undefined
          ? { origin_actor: deps.origin_actor }
          : {}),
        ...(deps.origin_actor !== undefined && deps.origin_contract_id !== undefined
          ? { origin_contract_id: deps.origin_contract_id }
          : {}),
        ...(deps.origin_surface !== undefined
          ? { origin_surface: deps.origin_surface }
          : {}),
        // D-210 audit finding 5 — read ONLY from the trusted `internal`
        // parameter, never from `args`.
        ...(internal?.attribution_source !== undefined
          ? { attribution_source: internal.attribution_source }
          : {}),
      },
    );
    if (networkDomain !== undefined && contact.contact_id) {
      const updated = deps.store.setNetworkDomain(
        contact.contact_id,
        networkDomain,
        deps.now?.(),
      );
      return { contact: updated };
    }
    return { contact };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('contact_invalid_email')) {
      throw new RpcError('bad_request', msg);
    }
    throw err;
  }
};

export const handleContactList = async (
  deps: ContactRpcDeps,
  args: {
    name_contains?: string;
    source?: ContactSource;
    since?: number;
    phone_exact?: string;
    limit?: number;
    offset?: number;
    with_rollups?: boolean;
  },
): Promise<{
  contacts: ContactRecord[]; total: number;
  rollups?: Record<string, TimelineRollup[]>;
}> => {
  if (args.source !== undefined && !isValidSource(args.source)) {
    throw new RpcError('bad_request', `contact.list: invalid source '${String(args.source)}'`);
  }
  // The FILTER the page + its total both apply — `limit`/`offset` page the rows
  // but must not narrow the count (else the UI's "of M" over-counts and its
  // load-more never reaches the end under a search).
  const filter = {
    ...(args.name_contains !== undefined ? { name_contains: args.name_contains } : {}),
    ...(args.source !== undefined ? { source: args.source } : {}),
    ...(args.since !== undefined ? { since: args.since } : {}),
    ...(args.phone_exact !== undefined ? { phone_exact: args.phone_exact } : {}),
  };
  const contacts = deps.store.list({
    ...filter,
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.offset !== undefined ? { offset: args.offset } : {}),
  });
  // D-226 — one batched read for the whole page, never one per row. The
  // per-contact path costs `1 + 2 × packs` queries EACH; at 50 rows and 20
  // packs that is 2,050 against 41. ⚠ Scoped to the page deliberately: the
  // rollups are for the rows being rendered, so paging pays for what it shows.
  const rollups = args.with_rollups === true && deps.rollupsForKeys !== undefined
    ? deps.rollupsForKeys(contacts.map((contact) => contact.email))
    : undefined;
  return {
    contacts, total: deps.store.count(filter),
    ...(rollups === undefined ? {} : { rollups }),
  };
};

/** Owner search shares the list/count predicate, including canonical merge redirects. */
export const handleContactSearchLocal = async (
  deps: ContactRpcDeps, args: ContactSearchLocalRequest,
): Promise<ContactSearchLocalResponse> => {
  if (!args || typeof args.query !== 'string' || args.query.length > 512 || args.query.includes('\0')
    || args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100)
    || args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)
    || args.source !== undefined && !isValidSource(args.source)
    || args.since !== undefined && !Number.isSafeInteger(args.since)
    || args.phone_exact !== undefined && (typeof args.phone_exact !== 'string' || args.phone_exact.length > 128)
    || args.with_rollups !== undefined && typeof args.with_rollups !== 'boolean') {
    throw new RpcError('bad_request', 'Enter a contact search and a valid page of up to 100 results.');
  }
  const query = args.query.trim();
  if (!query) return { contacts: [], total: 0 };
  const filter = { search: query,
    ...(args.source !== undefined ? { source: args.source } : {}),
    ...(args.since !== undefined ? { since: args.since } : {}),
    ...(args.phone_exact !== undefined ? { phone_exact: args.phone_exact } : {}),
  };
  const contacts = deps.store.list({ ...filter, limit: args.limit ?? 50, offset: args.offset ?? 0 });
  const total = deps.store.count(filter);
  const rollups = args.with_rollups === true && deps.rollupsForKeys
    ? deps.rollupsForKeys(contacts.map(contact => contact.email)) : undefined;
  return { contacts, total, ...(rollups !== undefined ? { rollups } : {}) };
};

/** D-336 slice I — the contact a placeholder named before it got an address. Promotion
 *  keeps the placeholder as the contact's alias, and no vendor owns a `_recued.invalid`
 *  mailbox, so it names that one contact for good: a page or a chat that holds it still
 *  opens the contact. Any other address reads its own row only. */
const retiredPlaceholder = (store: ContactStore, email: string): ContactRecord | null => {
  if (!isMentionOnlyEmail(canonicalizeEmail(email))) return null;
  try {
    const { canonical_email } = store.resolveCanonicalEmail(email);
    return canonical_email === canonicalizeEmail(email) ? null : store.get(canonical_email);
  } catch {
    return null;
  }
};

export const handleContactGet = async (
  deps: ContactRpcDeps,
  args: { email: string },
): Promise<{ contact: ContactRecord | null; identifiers?: ContactAdditionalIdentifiers }> => {
  if (typeof args.email !== 'string' || !args.email.trim()) {
    throw new RpcError('bad_request', 'contact.get: email is required');
  }
  // D-325 — a reference by contact id (Today, an occasion) reads the same
  // record as one by email.
  const contact = !args.email.includes('@') ? deps.store.getByContactIdResolved(args.email.trim()) ?? deps.store.get(args.email)
    : deps.store.get(args.email) ?? retiredPlaceholder(deps.store, args.email);
  const aliases = contact?.contact_id ? deps.store.listResolvedContactAliases(contact.contact_id) : [];
  const identifiers = {
    emails: [...new Map(aliases.filter(row => row.kind === 'email_alias' && !isMentionOnlyEmail(row.alias_pattern)
      && row.alias_pattern_normalized !== canonicalizeEmail(contact?.email ?? '')).map(row => [row.alias_pattern_normalized, row.alias_pattern])).values()],
    phones: [...new Map(aliases.filter(row => row.kind === 'phone_alias' && row.alias_pattern_normalized !== normalizeAliasPattern(contact?.phone ?? ''))
      .map(row => [row.alias_pattern_normalized, row.alias_pattern])).values()],
  };
  return { contact, ...(identifiers.emails.length || identifiers.phones.length ? { identifiers } : {}) };
};

/** D-205 merge-review item 3 — the PER-SOURCE value view.
 *
 *  The projection materializes only the WINNER onto the contact row, so until this
 *  existed a client could see what a field holds and (since #2a) who asserted it —
 *  but never what the OTHER sources said. The ladder was legible only in its
 *  outcome. This returns the rows it resolved OVER, so a surface can finally render
 *  *"Company — Acme Inc., from HubSpot (kept) · Acme Corp, from Google Contacts"*.
 *
 *  🔑 **The row set comes from `listProjectionContributions`, NOT
 *  `listContactAttributes`.** The latter is one contact and one store; the
 *  projection resolves over the merge GROUP × both stores. Using it would drop the
 *  absorbed contact's rows (a merge moves nothing — and an absorbed row can be the
 *  one that WON) and every phone row (a phone is an alias, not an attribute). A view
 *  whose row set does not contain the winner is worse than no view at all.
 *
 *  🔑 **`winner` is stamped here, by the SAME resolver the projection runs**, so no
 *  client ever re-ranks. A client-side ladder is exactly the bug item 1 fixed.
 *  Reference identity, not a field-by-field join: `resolveContributionsByKind` hands
 *  back the winning ELEMENT.
 *
 *  ⚠ **A kind whose winner the projection DROPPED is marked by nobody.** The
 *  materializer discards a winner whose value has the wrong shape (an object where a
 *  scalar belongs) rather than writing `"[object Object]"`, and then deliberately
 *  claims NO provenance for that field. The record holds nothing for it — so calling
 *  the resolver's pick "kept" would be a lie about what the user is looking at.
 *  Hence the `projection_provenance` cross-check: it is the projection's own record
 *  of which fields actually projected, so this reads its OUTPUT rather than
 *  duplicating its shape guard.
 *
 *  ⚠ **Both halves must resolve through the merge chain, or they answer about
 *  DIFFERENT contacts.** `store.get` is a plain PK lookup — it hands back a TOMBSTONE
 *  for a merged-away address, and a tombstone's columns are deliberately blanked. So
 *  reading the rows from the survivor's group (which `listProjectionContributions`
 *  does) while reading `projection_provenance` off the tombstone yields the right
 *  evidence with NOTHING marked as kept: every value rendered as a loser, the record's
 *  actual value shown as nobody's. Resolve ONCE, up front, and use that contact for
 *  both — the same rule the projection follows ("materializing a tombstone
 *  materializes the survivor"). */
export const handleContactContributions = async (
  deps: ContactRpcDeps,
  args: { email: string },
): Promise<{ contributions: ContactContributionView[] }> => {
  if (typeof args.email !== 'string' || !args.email.trim()) {
    throw new RpcError('bad_request', 'contact.contributions: email is required');
  }
  const addressed = deps.store.get(args.email);
  if (!addressed?.contact_id) return { contributions: [] };
  // Follows `merged_into` to the TERMINAL survivor; identity for a live contact.
  const contact = deps.store.getByContactIdResolved(addressed.contact_id);
  if (!contact?.contact_id) return { contributions: [] };

  const rows = deps.store.listProjectionContributions(contact.contact_id);
  const winners = resolveContributionsByKind(rows);
  const projected = contact.projection_provenance;

  const winning = new Set<unknown>();
  for (const [kind, row] of winners) {
    if (projected?.[kind] !== undefined) winning.add(row);
  }

  return {
    contributions: rows.map((row) => ({ ...row, winner: winning.has(row) })),
  };
};

export const handleContactDelete = async (
  deps: ContactRpcDeps,
  args: { email: string },
): Promise<{ ok: true; deleted: boolean }> => {
  if (typeof args.email !== 'string' || !args.email.trim()) {
    throw new RpcError('bad_request', 'contact.delete: email is required');
  }
  const deleted = deps.store.delete(args.email);
  return { ok: true, deleted };
};

/** D-145 PA8 follow-on — identifier-keyed resolver. Exactly one of
 *  `email` / `phone` / `alias` / `platform_id` is required; supplying
 *  zero or more than one is `bad_request`. The handler routes each
 *  kind to its store helper + projects the result into the shared
 *  shape (`{contact_id, confidence, alternatives, contact?}`). */
export const handleContactResolve = async (
  deps: ContactRpcDeps,
  args: {
    email?: string;
    phone?: string;
    alias?: string;
    platform_id?: { platform: ContactAliasPlatform; id: string };
  },
): Promise<{
  contact_id: string | null;
  confidence: number;
  alternatives: string[];
  contact?: ContactRecord;
}> => {
  const provided: Array<'email' | 'phone' | 'alias' | 'platform_id'> = [];
  if (typeof args.email === 'string' && args.email.trim().length) provided.push('email');
  if (typeof args.phone === 'string' && args.phone.length) provided.push('phone');
  if (typeof args.alias === 'string' && args.alias.length) provided.push('alias');
  if (args.platform_id && typeof args.platform_id === 'object') provided.push('platform_id');
  if (provided.length === 0) {
    throw new RpcError(
      'bad_request',
      'contact.resolve: one of email / phone / alias / platform_id is required',
    );
  }
  if (provided.length > 1) {
    throw new RpcError(
      'bad_request',
      `contact.resolve: exactly one identifier required, got ${provided.join(', ')}`,
    );
  }
  const kind = provided[0];
  if (kind === 'email') {
    // Walk the D-138 merged_into chain so a stale post-merge email
    // surfaces the canonical survivor's contact_id (Codex P1 fold —
    // store.get does not follow merge redirects on its own).
    let canonical: string;
    try {
      canonical = deps.store.resolveCanonicalEmail(args.email!).canonical_email;
    } catch {
      return { contact_id: null, confidence: 0, alternatives: [] };
    }
    const contact = deps.store.get(canonical);
    if (!contact || !contact.contact_id) {
      return { contact_id: null, confidence: 0, alternatives: [] };
    }
    return {
      contact_id: contact.contact_id,
      confidence: 1.0,
      alternatives: [],
      contact,
    };
  }
  if (kind === 'phone') {
    const result = deps.store.findByPhone(args.phone!);
    if (result.contact && result.contact.contact_id) {
      return {
        contact_id: result.contact.contact_id,
        confidence: result.confidence,
        alternatives: [],
        contact: result.contact,
      };
    }
    return {
      contact_id: null,
      confidence: 0,
      alternatives: result.alternatives
        .map((c) => c.contact_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    };
  }
  if (kind === 'platform_id') {
    const pid = args.platform_id!;
    if (typeof pid.platform !== 'string' || !isContactAliasPlatform(pid.platform)) {
      throw new RpcError(
        'bad_request',
        `contact.resolve: platform_id.platform '${String(pid.platform)}' is not a supported platform`,
      );
    }
    if (typeof pid.id !== 'string' || !pid.id.length) {
      throw new RpcError('bad_request', 'contact.resolve: platform_id.id is required');
    }
    const result = deps.store.findByAlias({
      alias_pattern: pid.id,
      platform: pid.platform,
    });
    if (!result.contact || !result.contact.contact_id) {
      return { contact_id: null, confidence: 0, alternatives: [] };
    }
    return {
      contact_id: result.contact.contact_id,
      confidence: result.confidence,
      alternatives: [],
      contact: result.contact,
    };
  }
  // kind === 'alias' — chat_alias branch, may surface alternatives.
  const result = deps.store.findByAlias({ alias_pattern: args.alias! });
  if (result.contact && result.contact.contact_id) {
    return {
      contact_id: result.contact.contact_id,
      confidence: result.confidence,
      alternatives: [],
      contact: result.contact,
    };
  }
  return {
    contact_id: null,
    confidence: 0,
    alternatives: result.alternatives
      .map((c) => c.contact_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  };
};

type ContactMethods =
  | 'contact.upsert'
  | 'contact.create_by_name'
  | 'contact.add_email'
  | 'contact.change_email'
  | 'contact.search.local'
  | 'contact.list'
  | 'contact.get'
  | 'contact.contributions'
  | 'contact.delete'
  | 'contact.resolve';

export const makeContactHandlers = (
  deps: ContactRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ContactMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  // D-161 P2 — a direct paired-client `contact.upsert` rpc arrives on the
  // `user` channel by construction, so the write-actor is `'user_self'`.
  // Inject it SERVER-SIDE here (not from `args`). The recipe `contact-upsert`
  // kernel path injects its own origin via the wire-executor instead.
  // D-177 N.11 rule 1 — this is the ONE surface whose writes read
  // user-clean at the open-grant gate: the human typing into their own
  // paired client. Every engine-run write (chat / messenger / mcp /
  // manual recipe runs alike) stamps 'engine' instead.
  const upsertDeps: ContactRpcDeps = {
    ...deps,
    origin_actor: 'user_self',
    origin_surface: 'client_rpc',
  };
  return {
    methods: [
      'contact.upsert',
      'contact.create_by_name',
      'contact.add_email',
      'contact.change_email',
      'contact.list',
      'contact.search.local',
      'contact.get',
      'contact.contributions',
      'contact.delete',
      'contact.resolve',
    ],
    handlers: {
      'contact.search.local': async (args, client) => {
        if (!client.instance_id) throw new RpcError('unauthorized', 'Searching saved contacts requires a paired client.', 401);
        return handleContactSearchLocal(deps, args);
      },
      'contact.upsert': async (args) => {
        // Audit 2026-11-01 (second) — the New contact form keys a contact on what it was given.
        requireMailboxForNewContact(deps.store, (args as { email?: unknown }).email);
        return handleContactUpsert(upsertDeps, args as Parameters<typeof handleContactUpsert>[1]);
      },
      // D-336 slice H — the owner's paired client too, so the same origin.
      'contact.create_by_name': async (args) =>
        handleContactCreateByName(upsertDeps, args as Parameters<typeof handleContactCreateByName>[1]),
      // D-336 slice I — the owner's Edit form, so the owner's paired client.
      'contact.add_email': async (args) =>
        handleContactAddEmail(upsertDeps, args as Parameters<typeof handleContactAddEmail>[1]),
      // D-336 slice R — the owner's Edit form too.
      'contact.change_email': async (args) =>
        handleContactChangeEmail(upsertDeps, args as Parameters<typeof handleContactChangeEmail>[1]),
      'contact.list': async (args) =>
        handleContactList(deps, args as Parameters<typeof handleContactList>[1]),
      'contact.get': async (args) =>
        handleContactGet(deps, args as Parameters<typeof handleContactGet>[1]),
      'contact.contributions': async (args) =>
        handleContactContributions(
          deps,
          args as Parameters<typeof handleContactContributions>[1],
        ),
      'contact.delete': async (args) =>
        handleContactDelete(deps, args as Parameters<typeof handleContactDelete>[1]),
      'contact.resolve': async (args) =>
        handleContactResolve(deps, args as Parameters<typeof handleContactResolve>[1]),
    },
  };
};
