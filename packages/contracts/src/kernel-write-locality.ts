/** Does a held write change ONLY what Recued itself stores?
 *
 *  The approval ask says why an action was held. For the write tier it said
 *  *"Write actions change data outside Recued"* on every write — including a
 *  booking, a commitment and an event on Recued's own local calendar, none of
 *  which leave the server. Found on a live drive of the Calendar Invites pack
 *  (2026-10-07): three approvals in a row told the owner something false about
 *  where their yes would land.
 *
 *  ⛔ A FALSE REASSURANCE IS WORSE THAN A FALSE WARNING. So this answers `true`
 *  only when the write is PROVABLY local, from facts that cannot be wrong:
 *
 *    - a store that has no outside half at all (`shared`, `memory`,
 *      `enrichment`);
 *    - a `booking` or `commitment`, which no pack may ever back with an outside
 *      Source (`WORK_ENTITY_SOURCE_LANDING_CONTRACTS` leaves them out on
 *      purpose, and the build fails if a declarable kind lacks a landing);
 *    - a task / note / project the call itself pins to Recued's built-in
 *      Source — a create naming no `source_id` (the built-in is the only
 *      fallback, D-187) or a qualified `we1:` id naming the built-in. A bare
 *      row id says nothing about which Source the row lives on, so it is not
 *      proof;
 *    - an event on the `local` calendar. That slug is RESERVED for the built-in
 *      calendar: the server refuses to enroll any outside calendar under it
 *      (`RESERVED_CALENDAR_SLUGS`, `collections/calendar/enroll.ts`);
 *    - a saved draft (`mail-draft-create` / `-update`), which the kernel
 *      manifest documents as touching nothing outside Recued.
 *
 *  Everything else answers `false`, and the ask keeps its outside wording. That
 *  is sometimes a false warning (a contact upsert, a local file); it is never a
 *  false reassurance.
 *
 *  Every call the approval covers must be local: a batch holding one event for
 *  the local calendar and one for Google is not a local write. An empty list
 *  means the calls' arguments are unknown, so only the kinds that are local
 *  whatever their arguments qualify. */

import { getKernelOp, kernelOpForBackingSlug } from './kernel-op-registry.js';
import { RECUED_BUILTIN_SOURCE_ID } from './source-primitive.js';
import { isWorkEntityKind, type WorkEntityKind } from './work-entities.js';
import { parseQualifiedWorkEntityId } from './work-entity-qualified-id.js';
import { isWorkEntitySourceDeclarableKind } from './work-entity-sources.js';

/** The ask's write clause when this proof holds. Shared, not spelled twice: the
 *  composer writes it and the approval card recognises it to drop the warning
 *  colour the outside clause keeps. */
export const WRITE_STAYS_IN_RECUED_CLAUSE = 'Write actions change your data in Recued';

/** The built-in local calendar's reserved instance slug. Mirrors the server's
 *  `DEFAULT_LOCAL_CALENDAR_SLUG`; it is a proof of locality only because the
 *  server refuses to enroll any other calendar under it. */
export const RESERVED_LOCAL_CALENDAR_SLUG = 'local';

/** Kernel stores with no outside half. */
const ALWAYS_LOCAL_ENTITIES: ReadonlySet<string> = new Set(['shared', 'memory', 'enrichment']);

/** Calendar writes whose target is the named instance. `rsvp` is left out on
 *  purpose: a reply is addressed to the organizer. */
const CALENDAR_INSTANCE_WRITES: ReadonlySet<string> = new Set([
  'core.data.calendar.create',
  'core.data.calendar.update',
  'core.data.calendar.delete',
]);

/** Saved drafts. `save-to-mailbox` is not here: it writes into the mailbox. */
const LOCAL_MAIL_WRITES: ReadonlySet<string> = new Set([
  'core.mail.draft.create',
  'core.mail.draft.update',
]);

const nonBlankString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** One task / note / project call pinned to the built-in Source by its own args. */
const pinnedToBuiltinSource = (
  kind: WorkEntityKind,
  verb: string,
  args: Readonly<Record<string, unknown>>,
): boolean => {
  const builtin = RECUED_BUILTIN_SOURCE_ID(kind);
  if (verb === 'create') {
    const source = args.source_id;
    return source === undefined || source === null || source === '' || source === builtin;
  }
  const id = args.id;
  if (!nonBlankString(id)) return false;
  try {
    const qualified = parseQualifiedWorkEntityId(id);
    return qualified !== null && qualified.kind === kind && qualified.source_id === builtin;
  } catch {
    return false;
  }
};

/** `idOrSlug` is a `core.*` op id or its backing ingredient slug (a simple-form
 *  kernel step is held under the slug). `calls` holds each covered call's
 *  arguments. */
export const kernelWriteStaysInRecued = (
  idOrSlug: string,
  calls: ReadonlyArray<Readonly<Record<string, unknown>>>,
): boolean => {
  const opId = getKernelOp(idOrSlug) !== undefined ? idOrSlug : kernelOpForBackingSlug(idOrSlug);
  const entry = opId === undefined ? undefined : getKernelOp(opId);
  if (entry === undefined || opId === undefined) return false;

  if (ALWAYS_LOCAL_ENTITIES.has(entry.entity)) return true;
  if (LOCAL_MAIL_WRITES.has(opId)) return true;

  if (entry.entity === 'work') {
    // `core.work-entity.<kind>.<verb>`; `list` / `get` / `read` name no kind.
    const [, , kind, verb] = opId.split('.');
    if (kind === undefined || verb === undefined || !isWorkEntityKind(kind)) return false;
    if (!isWorkEntitySourceDeclarableKind(kind)) return true;
    return calls.length > 0 && calls.every((args) => pinnedToBuiltinSource(kind, verb, args));
  }

  if (CALENDAR_INSTANCE_WRITES.has(opId)) {
    return calls.length > 0
      && calls.every((args) => args.slug === RESERVED_LOCAL_CALENDAR_SLUG);
  }

  return false;
};
