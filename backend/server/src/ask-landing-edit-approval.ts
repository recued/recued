/** D-210 A.8 slice 3d-2c — the `/ask` landing page's EDIT-then-APPROVE leg.
 *
 *  3d-2b made the page show what the approval commits to. This makes the
 *  submit BE the approval, per the owner's design:
 *
 *    > "the reschedule_link is a url + standard approval buttons … the UI
 *    >  allows changing the detail → submit is approve, which then saves to
 *    >  the booking table. In Recued's view: an approval (in reschedule or
 *    >  in the message) is a confirmation of the booking record."
 *
 *  Read (3d-2b) and write (here) are separate modules on purpose: this side
 *  carries the authority decision and the coercion, and both deserve to be
 *  read without the rendering around them.
 *
 *  ── WHAT THE PAGE IS ALLOWED TO DO ──────────────────────────────────
 *
 *  The bearer capability is the unguessable `ask_id` in the URL, and the
 *  owner ruled it carries the edit (2026-07-19): *the link is the owner's
 *  private link travelling over public transport, and the owner should have
 *  the exact info.* Possession already lets you approve, which already
 *  creates the booking; the delta is "at the asked time" vs "at a time you
 *  type", the blast radius is one held reservation either way, and every
 *  edit is schema-validated server-side by the same funnel the rpc uses.
 *
 *  🔑 THE HOLD IS NEVER NAMED BY THE CALLER. `hold_id` is derived from the
 *  ask's own `handler_payload.checkpoint_id`, so possession of ONE ask can
 *  only ever edit-and-approve the operation THAT ask was raised for. A form
 *  field naming the hold would turn a capability for one decision into a
 *  handle on every held operation on the server.
 *
 *  ⛔ It does NOT fabricate an `instance_id` to satisfy the rpc's admin
 *  predicate. That would launder a URL bearer into the audit trail as a
 *  paired admin client. The approver is a distinct, named authority
 *  (`ReceptionInboxApprover`) and the audit row says which one acted.
 *
 *  Spec: docs/d-210-spec.md § A.8 slice 3d. */

import { PREFLIGHT_HANDLER_KIND } from '@recued/gateway';
import type { ArgEditField, InboxItem } from '@recued/contracts';
import type { PendingAsk } from '@recued/notification';
import { zonedWallClockToEpochMs } from './ports/reception/processors/intake-destination-mapping.js';

/** The approve option id on a `gateway.preflight` ask. Edits only mean
 *  anything alongside it — see `submitEditedApproval`. */
const ASK_APPROVE_OPTION = 'approve';

export interface AskLandingEditApprovalResult {
  ok: boolean;
  /** Owner-facing refusal, rendered on the re-served form. Present iff
   *  `ok` is false. Written to be actionable on a phone: it names the
   *  field and what was wrong with it. */
  message?: string;
}

/** Coerce one submitted form STRING to the typed value
 *  `enforceFieldShape` requires (`datetime`/`number` → a finite number,
 *  `boolean` → a boolean, `json` → a parsed object/array).
 *
 *  ⚠ THE ZONE IS THE WHOLE GAME for `datetime`. An
 *  `<input type="datetime-local">` submits a ZONE-LESS wall clock, and
 *  `Date.parse` would read it in the SERVER's zone. `zonedWallClockToEpochMs`
 *  resolves it in the SAME zone `epochMsToZonedWallClock` rendered the
 *  control's value in — the two are inverses living in one module precisely
 *  so this round trip cannot drift. Get it wrong and the approval moves a
 *  real appointment by the offset, at `success: true`. */
export const coerceSubmittedEdit = (
  field: ArgEditField,
  raw: string | undefined,
  timeZone: string,
): { ok: true; value: unknown } | { ok: false; message: string } => {
  const label = field.label !== undefined && field.label.length > 0 ? field.label : field.key;
  // An unchecked checkbox submits NOTHING — that is the browser's encoding
  // of `false`, not of "unspecified", and it is the same reading the
  // webclient inbox and the projection already use.
  if (field.type === 'boolean') return { ok: true, value: raw !== undefined };
  if (raw === undefined) return { ok: true, value: undefined };

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    // Empty on a non-required field clears it; on a required one the funnel
    // refuses, and saying so here names the field instead of failing deeper
    // with a less specific message.
    if (field.required === true) return { ok: false, message: `${label} is required.` };
    return { ok: true, value: undefined };
  }

  switch (field.type) {
    case 'string':
      // Un-trimmed on purpose: leading / trailing whitespace inside a body
      // is the owner's text, not noise for this layer to edit.
      return { ok: true, value: raw };
    case 'number': {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return { ok: false, message: `${label} must be a number.` };
      return { ok: true, value: n };
    }
    case 'datetime': {
      const ms = zonedWallClockToEpochMs(trimmed, timeZone);
      if (ms === null) {
        return {
          ok: false,
          message: `${label} must be a date and time (in ${timeZone}).`,
        };
      }
      return { ok: true, value: ms };
    }
    case 'json':
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || parsed === null) {
          return { ok: false, message: `${label} must be a JSON object or array.` };
        }
        return { ok: true, value: parsed };
      } catch {
        return { ok: false, message: `${label} must be valid JSON.` };
      }
  }
};

const sameValue = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/** Read an arg by declared key — literal-first, then a dotted walk. Mirrors
 *  `readArgPath` in the read half; kept in step with it deliberately, since
 *  a changed value is decided by comparing against exactly what that side
 *  rendered. */
const readArgPath = (args: Record<string, unknown>, key: string): unknown => {
  if (Object.hasOwn(args, key)) return args[key];
  if (!key.includes('.')) return undefined;
  let cursor: unknown = args;
  for (const segment of key.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
};

/** Turn the raw submitted strings into the `edits` payload the approve
 *  funnel takes — CHANGED FIELDS ONLY.
 *
 *  Unchanged fields are dropped rather than echoed back: `edited_keys` and
 *  the audit diff are then a record of what the owner actually altered, and
 *  approving an untouched form writes no overrides at all — the same shape
 *  the webclient inbox submits.
 *
 *  ⛔ A submitted key the schema does not declare is REFUSED, not ignored.
 *  Ignoring it would let a tampered body look accepted; and the funnel's
 *  own `validateEditsAgainstSchema` refuses it anyway — this just refuses it
 *  with a message the owner can read. */
export const buildEditsFromSubmission = (
  item: InboxItem,
  rawEdits: Record<string, string>,
  timeZone: string,
): { ok: true; edits: Record<string, unknown> } | { ok: false; message: string } => {
  const byKey = new Map<string, ArgEditField>(
    item.arg_schema.fields.map((f) => [f.key, f]),
  );
  for (const key of Object.keys(rawEdits)) {
    if (!byKey.has(key)) {
      return { ok: false, message: `'${key}' is not an editable field of this request.` };
    }
  }
  const edits: Record<string, unknown> = {};
  for (const field of item.arg_schema.fields) {
    // A field the page rendered read-only (a picker with no resolver) is
    // absent from the body by construction; skipping it here keeps its
    // authored value, rather than clearing it as an "empty submission".
    const control = field.options_source !== undefined && field.options_source.length > 0;
    if (control) continue;
    const raw = Object.hasOwn(rawEdits, field.key) ? rawEdits[field.key] : undefined;
    // A non-boolean field absent from the body was not rendered — leave it
    // alone. (A boolean absent from the body IS the false answer.)
    if (raw === undefined && field.type !== 'boolean') continue;
    const coerced = coerceSubmittedEdit(field, raw, timeZone);
    if (!coerced.ok) return { ok: false, message: coerced.message };
    // ⚠ Compare against the prefill AS THE FIELD'S TYPE READS IT. For a
    // boolean, an ABSENT arg and `false` are the same fact — the projection
    // reads `=== true` and the page renders an unchecked box for both. A raw
    // `undefined` vs `false` comparison would record an override, an
    // `edited_keys` entry, and an audit diff line every time an owner
    // approved an untouched form. Same equivalence the read half states.
    const prefill = readArgPath(item.args, field.key);
    const normalized = field.type === 'boolean' ? prefill === true : prefill;
    if (sameValue(coerced.value, normalized)) continue;
    edits[field.key] = coerced.value;
  }
  return { ok: true, edits };
};

export interface AskLandingEditApprovalDeps {
  /** Read the held reception op by `hold_id` — the same
   *  `findReceptionHoldItem` the read half uses, so the schema the page
   *  rendered and the schema the edits are checked against are one schema. */
  readonly findHoldItem: (hold_id: string) => Promise<InboxItem | null>;
  /** The approve funnel — `handleReceptionInboxApprove` pre-bound to the
   *  composed inbox deps. It re-derives the hold server-side, scan-gates,
   *  validates against the allowlist, writes through the NARROW
   *  `setArgOverrides`, audits old→new, and releases. This module supplies
   *  authority + coercion and nothing else. */
  readonly approve: (input: {
    hold_id: string;
    edits: Record<string, unknown>;
    ask_id: string;
  }) => Promise<{ released: boolean; reason?: string }>;
  readonly timeZone?: string;
}

const resolveDefaultTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** Build the `/ask` port's `submitEditedApproval` closure.
 *
 *  Every refusal is an owner-readable sentence, because the page IS the
 *  surface: a bare `bad_request` on a phone is a dead end. */
export const createAskLandingEditApproval = (
  deps: AskLandingEditApprovalDeps,
): ((input: {
  ask: PendingAsk;
  option: string;
  rawEdits: Record<string, string>;
}) => Promise<AskLandingEditApprovalResult>) => {
  const timeZone = deps.timeZone ?? resolveDefaultTimeZone();

  return async ({ ask, option, rawEdits }): Promise<AskLandingEditApprovalResult> => {
    // Edits ride ONLY an approve. `deny` with edits is incoherent (there is
    // nothing to commit), and `allow_session` with edits is refused by the
    // funnel itself (D-177 N.14 — an edited approval is proof the pipe's
    // output wasn't right, so it earns no standing trust). Saying that here
    // turns a 400 into an instruction.
    if (option !== ASK_APPROVE_OPTION) {
      return {
        ok: false,
        message:
          option === 'allow_session'
            ? 'Changing a value cannot be combined with allowing this session — approve the edited request instead.'
            : 'Changes can only be submitted with Approve.',
      };
    }
    if (ask.handler_kind !== PREFLIGHT_HANDLER_KIND) {
      return { ok: false, message: 'This request cannot be edited.' };
    }
    // A batched ask covers N members behind ONE checkpoint_id — the same
    // fence the read half applies. It renders no controls there, so reaching
    // this is a tampered body.
    if (ask.handler_payload.batch_id !== undefined) {
      return { ok: false, message: 'This request cannot be edited.' };
    }
    // 🔑 The hold is DERIVED from the ask, never accepted from the body.
    const hold_id = ask.handler_payload.checkpoint_id;
    if (typeof hold_id !== 'string' || hold_id.length === 0) {
      return { ok: false, message: 'This request cannot be edited.' };
    }

    const item = await deps.findHoldItem(hold_id);
    if (item === null) {
      return {
        ok: false,
        message: 'This request is no longer waiting for a decision.',
      };
    }

    const built = buildEditsFromSubmission(item, rawEdits, timeZone);
    if (!built.ok) return { ok: false, message: built.message };

    const result = await deps.approve({ hold_id, edits: built.edits, ask_id: ask.ask_id });
    if (!result.released) {
      return {
        ok: false,
        message:
          result.reason === 'not_configured'
            ? 'This server cannot release the request right now.'
            : 'The request could not be approved.',
      };
    }
    return { ok: true };
  };
};
