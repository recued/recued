/** D-205 #5 — selective CRM promotion: `contact.import.{candidates, promote}`.
 *
 *  ## The cliff this exists to close
 *
 *  A CRM is `hydrate_on_match`: a record that matches no local contact is SKIPPED,
 *  never created. That is the right posture and it is the whole reason the posture
 *  exists — a 10k-row CRM is your COMPANY's list, mostly people you have never met,
 *  and importing them all would drown the personal contact graph.
 *
 *  But on an EMPTY graph it means a CRM mints **zero** contacts. Connect HubSpot
 *  with ten thousand records, open `#data/contact`, and it is empty. Correct, and it
 *  reads as broken.
 *
 *  ## What this is NOT
 *
 *  It is not an import. The strangers are ALREADY ON DISK — the D-129/D-130/D-190
 *  reconcilers mirror every CRM contact into `crm_record_mirror` regardless of
 *  whether Recued knows the person — and the contact sync already COUNTS them
 *  (`last_cycle.skipped`, which the Sources health strip renders). So this is a
 *  PICKER over data Recued already holds. The user reaches in and says *"this one is
 *  mine"*, and the promotion mints an IDENTITY.
 *
 *  It does not mint a fact. `createImportedContact` writes the row and **no
 *  contributions**; the Source's next sync cycle now MATCHES the person and hydrates
 *  them properly — every field at `vendor_meta`, carrying the Source's own id, with
 *  the platform link and the blob. That is the same discipline #4 established: this
 *  path has no `source_id` to offer, so anything it wrote would have to lie about
 *  where it came from.
 *
 *  ## ⛔ MCP-RESERVED, and not incidentally
 *
 *  Deciding that a stranger belongs in your personal contact graph is a judgement
 *  about WHO YOU KNOW — the same class of decision as a merge, and the exact
 *  judgement `hydrate_on_match` refuses to make on your behalf. An agent may READ
 *  the graph (subject to `data.contact`); it may not decide who is in it. */

import {
  CONNECTION_SOURCE_ID,
  canonicalizeEmail,
  composeConnectionTargetIdPrefix,
  composeVendorEntityScope,
  getContactSourceDeclaration,
  type ContactImportCandidate,
  type EnrichmentMeta,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';

import type { WsClient } from './ws-server.js';
import type { ContactStore } from './storage/contact-store.js';
import type { CrmRecordMirrorStore } from './storage/crm-record-mirror-store.js';
import {
  applyContactFileImport,
  planContactFileImport,
} from './contact-import-file.js';

export interface ContactImportRpcDeps {
  store: ContactStore;
  /** The CRM mirror the reconcilers maintain — where the strangers already live. */
  mirror: CrmRecordMirrorStore;
  now?: () => number;
}

/** Default page size. The stranger list is routinely in the thousands; the surface is
 *  a search box, not a scroll. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const metaString = (meta: EnrichmentMeta, key: string): string | undefined => {
  const raw = (meta as Record<string, unknown>)[key];
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
};

/** Resolve a Source id back to the mirror scope + target-id prefix its records live
 *  under. Returns null when the id names no declared CRM contact Source — which is
 *  also the fence: a `full_import` contact book has `vendor_entity: null`, has no
 *  mirror, and has no strangers by construction (it imported everyone). Offering to
 *  "promote" from one would be incoherent. */
const resolveMirrorScope = (
  source_id: string,
): { scope: string; prefix: string } | null => {
  // `CONNECTION_SOURCE_ID(vendor, connection_name, 'contact')` → `<vendor>.<name>.contact`.
  const parts = source_id.split('.');
  if (parts.length !== 3 || parts[2] !== 'contact') return null;
  const [vendor, connection_name] = parts as [string, string, string];

  const declaration = getContactSourceDeclaration(vendor);
  if (declaration === null) return null;
  // A contact book has no platform record — it IS the record. No mirror, no strangers.
  if (declaration.vendor_entity === null) return null;
  // Round-trip the id so a malformed one cannot address a scope it does not name.
  if (CONNECTION_SOURCE_ID(vendor, connection_name, 'contact') !== source_id) return null;

  return {
    scope: composeVendorEntityScope(vendor, declaration.vendor_entity),
    prefix: composeConnectionTargetIdPrefix(
      vendor,
      declaration.vendor_entity,
      connection_name,
    ),
  };
};

/** Every mirrored record for the Source that matches NO local contact.
 *
 *  ⚠ **`listForConnection`, NOT `list`.** `mirror.list()` clamps to 200 (it feeds a
 *  bounded chat surface). Using it here would silently hide every stranger past the
 *  200th — and this surface's entire job is to be COMPLETE about who Recued does not
 *  know. A picker that shows you a fifth of the list is worse than no picker, because
 *  you would conclude the person is not there.
 *  [[feedback_bounded_read_is_a_leak_for_security_seed_sets]]
 *
 *  Deterministically ordered (by `target_id`) so a page offset means the same thing
 *  across two calls. */
const strangersOf = (
  deps: ContactImportRpcDeps,
  scope: string,
  prefix: string,
): { strangers: ContactImportCandidate[]; mirrored: number } => {
  const rows = deps.mirror.listForConnection(scope as never, prefix);
  const strangers: ContactImportCandidate[] = [];

  for (const row of rows) {
    const rawEmail = metaString(row.meta, 'email');
    if (rawEmail === undefined) continue;
    const email = canonicalizeEmail(rawEmail);
    // ⚠ `!== ''`, not `!== null` — `canonicalizeEmail` returns the EMPTY STRING for
    // an unparseable address, never null, so the null form was vacuous and this
    // filter never ran. The `resolveCanonicalEmail` throw below caught the fallout
    // by accident and logged it as a corrupt redirect chain.
    // No usable address ⇒ not a candidate. Identity resolves through the address
    // space, and the CRM mirror carries no phone-keyed identity to fall back on. We
    // filter rather than offer-then-refuse: a row you cannot act on does not belong
    // in a picker.
    if (email === '') continue;

    // 🔑 THE STRANGER TEST, and it must ride the SAME address space the sync's match
    // does — `resolveCanonicalEmail` resolves any known address (primary, secondary
    // alias, through any merge chain) to the contact that OWNS it. A naive
    // `store.get(email)` would call someone a stranger because Recued knows them
    // under a different address, and offer to create their duplicate.
    let canonical: string;
    try {
      canonical = deps.store.resolveCanonicalEmail(email).canonical_email;
    } catch {
      continue; // corrupt redirect chain — not a candidate
    }
    if (deps.store.get(canonical) !== null) continue; // already someone we know

    strangers.push({
      target_id: row.target_id,
      email,
      ...(metaString(row.meta, 'name') !== undefined
        ? { name: metaString(row.meta, 'name')! }
        : {}),
      ...(metaString(row.meta, 'company') !== undefined
        ? { company: metaString(row.meta, 'company')! }
        : {}),
      ...(metaString(row.meta, 'phone') !== undefined
        ? { phone: metaString(row.meta, 'phone')! }
        : {}),
    });
  }

  strangers.sort((a, b) => (a.target_id < b.target_id ? -1 : a.target_id > b.target_id ? 1 : 0));
  return { strangers, mirrored: rows.length };
};

const matchesQuery = (c: ContactImportCandidate, q: string): boolean =>
  c.email.includes(q)
  || (c.name?.toLowerCase().includes(q) ?? false)
  || (c.company?.toLowerCase().includes(q) ?? false);


// ────────────────────────────────────────────────────────────────
// The rpcs
// ────────────────────────────────────────────────────────────────

interface CandidatesArgs {
  source_id: string;
  query?: string;
  offset?: number;
  limit?: number;
}

const handleCandidates = (
  deps: ContactImportRpcDeps,
  args: CandidatesArgs,
): { candidates: ReadonlyArray<ContactImportCandidate>; total: number; mirrored: number } => {
  const resolved = resolveMirrorScope(args.source_id);
  // A contact book has no strangers BY CONSTRUCTION — `full_import` already took
  // everyone. An empty list here is the honest answer to a question that does not
  // apply, and the surface never offers the affordance for one.
  if (resolved === null) return { candidates: [], total: 0, mirrored: 0 };

  const { strangers, mirrored } = strangersOf(deps, resolved.scope, resolved.prefix);

  const q = args.query?.trim().toLowerCase() ?? '';
  const filtered = q.length > 0 ? strangers.filter((c) => matchesQuery(c, q)) : strangers;

  const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(args.offset ?? 0, 0);

  return {
    candidates: filtered.slice(offset, offset + limit),
    total: filtered.length,
    // ⚠ EVERY mirrored record, not the filtered count. `(total, mirrored)` is the pair
    // that makes the cliff legible — "10,000 records, 9,988 of whom you have never
    // corresponded with" — and it is the whole reason `#data/contact` looked empty
    // after connecting a CRM.
    mirrored,
  };
};

interface PromoteArgs {
  source_id: string;
  target_ids: ReadonlyArray<string>;
}

const handlePromote = (
  deps: ContactImportRpcDeps,
  args: PromoteArgs,
): { created: number; already_known: number; failures: ReadonlyArray<string> } => {
  const resolved = resolveMirrorScope(args.source_id);
  if (resolved === null) {
    return {
      created: 0,
      already_known: 0,
      failures: [`'${args.source_id}' is not a CRM contact Source — nothing to promote from`],
    };
  }

  const now = deps.now?.() ?? Date.now();
  let created = 0;
  let already_known = 0;
  const failures: string[] = [];

  // Re-read the mirror rather than trusting a payload the client built from a list it
  // fetched some time ago. **The client sends an ID; the SERVER decides what that id
  // means.** A client-supplied name/email would let a caller mint a contact that
  // exists in no CRM at all — and it would land stamped `crm_import`, carrying the
  // CRM's authority.
  //
  // ONE uncapped read, indexed — not a scan per id. (`listForConnection`, never
  // `list()`: that clamps to 200 and would make every record past the 200th
  // un-promotable, silently.)
  const byTargetId = new Map(
    deps.mirror
      .listForConnection(resolved.scope as never, resolved.prefix)
      .map((r) => [r.target_id, r] as const),
  );

  for (const target_id of args.target_ids) {
    const row = byTargetId.get(target_id);
    if (row === undefined) {
      failures.push(`${target_id}: no such record in this Source's mirror`);
      continue;
    }

    const rawEmail = metaString(row.meta, 'email');
    // ⚠ Two ways to have no address and they are NOT the same check: the column
    // is absent (`undefined`) or it is present and unparseable (`''`). The null
    // form only covered the first, so `a@b@c.com` reached `resolveCanonicalEmail`
    // and surfaced as "corrupt redirect chain" — a true sentence about the wrong
    // thing, since the message one line down was already right.
    const email = rawEmail === undefined ? '' : canonicalizeEmail(rawEmail);
    if (email === '') {
      failures.push(`${target_id}: no usable email — identity resolves on the address space`);
      continue;
    }

    // Re-check the stranger test at the ACT site, over the same address space. The list
    // the user picked from is a snapshot; the sync may have matched this person between
    // then and now (they emailed you), and re-creating them would mint a duplicate of
    // someone Recued already knows. Benign, and COUNTED — not an error.
    // [[feedback_close_toctou_by_rederiving_at_act_site]]
    let canonical: string;
    try {
      canonical = deps.store.resolveCanonicalEmail(email).canonical_email;
    } catch {
      failures.push(`${target_id}: '${email}' has a corrupt redirect chain`);
      continue;
    }
    if (deps.store.get(canonical) !== null) {
      already_known += 1;
      continue;
    }

    try {
      deps.store.createImportedContact(
        {
          email,
          // The CRM's name, or the address itself — a person you deliberately pulled in
          // deserves a row even if their CRM record is nameless. The Source's next cycle
          // overwrites it with whatever the CRM actually says.
          name: metaString(row.meta, 'name') ?? email,
          // 🔑 `crm_import`, NOT `manual`. The user chose the PERSON; they did not type
          // the person's phone number. Stamping `manual` would park the CRM's assertions
          // at the TOP of the C-2a ladder where the user's own typing could never
          // correct them — and `createImportedContact` refuses it outright for exactly
          // that reason.
          source: 'crm_import',
        },
        now,
      );
      created += 1;
    } catch (err) {
      failures.push(`${target_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ⚠ NO CONTRIBUTIONS ARE WRITTEN HERE, and no projection is materialized.
  //
  // The promotion mints an IDENTITY. The Source's next sync cycle now MATCHES these
  // people (their address is in the graph) and hydrates them properly — every field at
  // `vendor_meta` carrying the Source's own id, plus the platform link and the blob.
  // Writing anything here would have to attribute it, and this path has no `source_id`
  // to attribute it TO.
  //
  // Until then the contact carries a name and an address: exactly what the user asked
  // for, and no more than Recued can honestly claim.
  return { created, already_known, failures };
};

export type ContactImportMethods =
  | 'contact.import.candidates'
  | 'contact.import.promote'
  | 'contact.import.file_preview'
  | 'contact.import.file_apply';

export const makeContactImportHandlers = (
  deps: ContactImportRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ContactImportMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  const fileDeps = { store: deps.store, ...(deps.now !== undefined ? { now: deps.now } : {}) };
  return {
    methods: [
      'contact.import.candidates',
      'contact.import.promote',
      'contact.import.file_preview',
      'contact.import.file_apply',
    ],
    handlers: {
      'contact.import.candidates': async (args) => handleCandidates(deps, args),
      'contact.import.promote': async (args) => handlePromote(deps, args),
      // D-205 #5c — the manual vCard / CSV import. A BATCH `contact.upsert`, not a
      // Source. `apply` re-parses the SAME bytes `preview` did, so there is no server
      // state between the two rpcs and a client cannot hand back a plan it edited —
      // the client sends the FILE; the SERVER decides what it means.
      'contact.import.file_preview': async (args) =>
        planContactFileImport(fileDeps, args.text),
      'contact.import.file_apply': async (args) =>
        applyContactFileImport(fileDeps, args.text, args.apply_changes),
    },
  };
};
