/** D-210 A.8 slice 3d-2b — the `/ask` landing page's held-operation details.
 *
 *  The owner taps the approval link from Slack / Telegram / WhatsApp (3d-2a
 *  put it there) and lands on `/ask/<ask_id>`. Until this slice that page
 *  showed the ask PROSE and two radio buttons — and for a single,
 *  non-batched hold the prose enumerates nothing: `buildPreflightAsk`
 *  renders its items block only for a BATCH. So the one surface reachable
 *  from a phone said "Recipe X wants to run scheduling.materialize (step
 *  S). Approve?" and never said what was being booked, for whom, or when.
 *
 *  This module resolves that: `PendingAsk` → the held `InboxItem` → a
 *  label→value list the landing page renders above the options. Read-only
 *  here by design. These are exactly the args slice 3d-2c will turn into
 *  form inputs, so landing them first is the additive half — the page gains
 *  information and its POST path is untouched (the `ALLOWED_SUBMISSION_KEYS`
 *  allowlist stays closed, so nothing new is submittable and nothing
 *  submitted can be silently dropped).
 *
 *  WHICH ARGS. The `arg_schema` allowlist, not the raw `args` bag: the pack
 *  author declared exactly these as the reviewable surface, each with a
 *  label and a type, and they are the set 3d-2c makes editable. An op with
 *  no `editable_args` — or a `form_response` acceptance, which the inbox
 *  hard-suppresses to `{fields: []}` — yields nothing, and the page renders
 *  no block rather than an empty one.
 *
 *  FORMATTING LIVES HERE, not in the notification leaf. Every one of these
 *  is a claim about the held operation, and the leaf cannot check any of
 *  them: which zone a `datetime` reads in, whether a zone-less wall clock
 *  may be shifted at all, what an absent boolean means, where a long value
 *  is cut. The leaf escapes and lays out; this side decides what is true.
 *
 *  Spec: docs/d-210-spec.md § A.8 slice 3d. */

import { PREFLIGHT_HANDLER_KIND } from '@recued/gateway';
import type { ArgEditField, InboxItem, MetaFieldType } from '@recued/contracts';
import type {
  AskLandingDetail,
  AskLandingEditControl,
  PendingAsk,
} from '@recued/notification';
import { epochMsToZonedWallClock } from './ports/reception/processors/intake-destination-mapping.js';

/** What the landing page renders for one held op. `heading` is the item's
 *  own human summary of the effect ("Create a booking"). */
export interface AskLandingHeldOpDetails {
  heading?: string;
  details: readonly AskLandingDetail[];
}

/** A value longer than this is cut, with the cut made VISIBLE by the
 *  ellipsis. A held `body` arg has no schema-level ceiling, and an
 *  un-capped one turns a phone-sized decision page into an unreadable
 *  wall — but a silent cut would misreport what the operation carries, so
 *  the mark is not optional. */
const MAX_VALUE_CHARS = 400;

/** Rendered for an arg the held op does not carry. Distinguishable from a
 *  present-but-empty string, which reads `(empty)` — "the pack declared
 *  this and nothing filled it" and "this is deliberately blank" are
 *  different facts about what approve will commit. */
const ABSENT_VALUE = '(not set)';
const EMPTY_VALUE = '(empty)';

/** A datetime STRING already carrying a zone designator (`Z`, `+02:00`,
 *  `-0500`) is an instant and may be re-expressed in the display zone. One
 *  without is a WALL CLOCK, and `Date.parse` would read it in the SERVER's
 *  zone — so a `19:30` typed in Paris, parsed on a UTC host and rendered
 *  back in Paris, becomes `21:30`. A zone-less string is therefore printed
 *  VERBATIM: showing what the operation literally holds cannot be wrong,
 *  and shifting it silently can. */
const ZONE_BEARING = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Read an arg by its `ArgEditField.key`. Literal-first: `edits` are keyed
 *  by the declared key verbatim (`validateEditsAgainstSchema` matches
 *  `arg_schema.fields[].key` against the flat override object), so a
 *  dotted key that exists literally IS the value the operation dispatches
 *  with. Only when there is no literal hit does a dotted key walk nested
 *  objects, matching how `resolveSchemaProperty` reads the request schema. */
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

const truncate = (value: string): string =>
  value.length <= MAX_VALUE_CHARS ? value : `${value.slice(0, MAX_VALUE_CHARS)}…`;

/** Format an absolute instant in a NAMED zone. The zone name is not
 *  decoration: this page is read on a phone that may be nowhere near the
 *  server, and an unlabelled wall clock is how a booking is missed. An
 *  unknown / malformed IANA zone makes the `Intl` constructor throw
 *  `RangeError` — fall back to UTC (still named) rather than lose the row. */
const formatInstant = (ms: number, timeZone: string): string => {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).format(
      new Date(ms),
    );
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(
      new Date(ms),
    );
  }
};

/** `datetime` → display text, or null when the value is not a usable
 *  instant (the caller then falls through to the generic rendering, which
 *  never invents a date). */
const formatDateTimeValue = (value: unknown, timeZone: string): string | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? formatInstant(value, timeZone) : null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const raw = value.trim();
  // Wall clock — print as held. See ZONE_BEARING.
  if (!ZONE_BEARING.test(raw)) return raw;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? formatInstant(parsed, timeZone) : raw;
};

/** Render one arg value for display, dispatching on the field's resolved
 *  `MetaFieldType`. */
const formatValue = (
  type: MetaFieldType,
  value: unknown,
  timeZone: string,
): string => {
  // A boolean arg is binary in this form context, and absent means
  // unchecked: the webclient inbox renders `field.value === true` into a
  // checkbox, and the projection reads `input.notify_visitor === true`.
  // Rendering `(not set)` here would contradict both — and contradict the
  // unchecked box 3d-2c puts on this very page.
  if (type === 'boolean') return value === true ? 'Yes' : 'No';

  // Absence and emptiness are decided ONCE, before the type dispatch — an
  // empty `datetime` and an empty `string` are the same fact about the held
  // operation and must not read differently because of their declared type.
  if (value === undefined || value === null) return ABSENT_VALUE;
  if (typeof value === 'string' && value.length === 0) return EMPTY_VALUE;

  // Only a number or a string can name an instant. An unformattable one
  // echoes its raw value rather than falling through, where
  // `JSON.stringify(NaN)` would print the word `null` — a value the
  // operation does not hold.
  if (type === 'datetime' && (typeof value === 'number' || typeof value === 'string')) {
    return truncate(formatDateTimeValue(value, timeZone) ?? String(value));
  }

  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  try {
    return truncate(JSON.stringify(value) ?? String(value));
  } catch {
    // A cyclic / unserialisable value. Say so rather than throw the page
    // away or print `[object Object]`, which reads as a real value.
    return '(unreadable value)';
  }
};

/** A `string`/`json` value wide or multi-line enough to deserve a textarea
 *  rather than a one-line input. */
const NEEDS_TEXTAREA_CHARS = 120;

/** Resolve one field's form control (3d-2c), or null when the field must
 *  stay read-only on this page.
 *
 *  ⛔ `options_source` fields are NOT editable here. They are pickers over a
 *  live list (calendar list, destination Source list) and this page has no
 *  resolver for one — a `<select>` with no options is a control that cannot
 *  express a valid answer, and the webclient's own fallback for the same
 *  case renders a DISABLED "picker unavailable" select. Offering an empty
 *  picker would be worse than not offering the field. */
const resolveEditControl = (
  field: ArgEditField,
  value: unknown,
  timeZone: string,
): AskLandingEditControl | null => {
  if (field.options_source !== undefined && field.options_source.length > 0) {
    return null;
  }
  const base = {
    key: field.key,
    ...(field.required === true ? { required: true } : {}),
  };
  switch (field.type) {
    case 'boolean':
      return { ...base, control: 'checkbox', value: 'on', checked: value === true };
    case 'datetime': {
      // The value attribute is the wall clock IN `timeZone` — the same zone
      // the read-only row names and the same zone the submitted value is
      // parsed back in. An ISO/UTC value here would move the booking by the
      // offset on every approve.
      const wall =
        typeof value === 'number' ? epochMsToZonedWallClock(value, timeZone) : null;
      return { ...base, control: 'datetime-local', value: wall ?? '' };
    }
    case 'number':
      return {
        ...base,
        control: 'number',
        value: typeof value === 'number' && Number.isFinite(value) ? String(value) : '',
        ...(field.validation?.min !== undefined ? { min: field.validation.min } : {}),
        ...(field.validation?.max !== undefined ? { max: field.validation.max } : {}),
      };
    case 'json': {
      let text = '';
      try {
        text = value === undefined || value === null ? '' : (JSON.stringify(value) ?? '');
      } catch {
        // Unserialisable — the read-only row already says so; an editable
        // control pre-filled with nothing would invite overwriting a value
        // the page could not show.
        return null;
      }
      return { ...base, control: 'textarea', value: text };
    }
    case 'string': {
      const text = typeof value === 'string' ? value : '';
      const multiline = text.includes('\n') || text.length > NEEDS_TEXTAREA_CHARS;
      return {
        ...base,
        control: multiline ? 'textarea' : 'text',
        value: text,
        ...(field.validation?.pattern !== undefined && !multiline
          ? { pattern: field.validation.pattern }
          : {}),
      };
    }
  }
};

/** Project one held `InboxItem` to the landing page's detail rows. Pure.
 *
 *  `editable` adds the 3d-2c form controls. Off ⇒ the 3d-2b read-only rows,
 *  which is still the honest rendering for any page that cannot accept a
 *  submission for this hold. */
export const buildAskLandingDetails = (
  item: InboxItem,
  opts: { readonly timeZone: string; readonly editable?: boolean },
): AskLandingHeldOpDetails => {
  const details: AskLandingDetail[] = [];
  for (const field of item.arg_schema.fields) {
    if (typeof field.key !== 'string' || field.key.length === 0) continue;
    const label =
      typeof field.label === 'string' && field.label.length > 0
        ? field.label
        : field.key;
    const raw = readArgPath(item.args, field.key);
    const edit =
      opts.editable === true ? resolveEditControl(field, raw, opts.timeZone) : null;
    details.push({
      label,
      ...(edit !== null ? { edit } : {}),
      // `ArgEditField.type` is REQUIRED on the contract and
      // `resolveArgEditSchema` always resolves one, so there is no display
      // default to fall back to — a `?? 'string'` here would be dead code
      // hiding a contract change behind a cast.
      value: formatValue(field.type, raw, opts.timeZone),
    });
  }
  return {
    ...(item.proposed_action.length > 0 ? { heading: item.proposed_action } : {}),
    details,
  };
};

export interface AskLandingDetailResolverDeps {
  /** Read the held reception op by `hold_id` (= `checkpoint_id`) —
   *  `findReceptionHoldItem` over the composed inbox deps. Returns null for
   *  an unknown / consumed / NON-RECEPTION hold, which is the fence that
   *  keeps an AI agent's held MCP write off a URL-bearer page. */
  readonly findHoldItem: (hold_id: string) => Promise<InboxItem | null>;
  /** IANA zone every `datetime` renders in and NAMES. Defaults to the
   *  server's own resolved zone — on a self-hosted box that is the owner's
   *  zone — but injected so it is pinnable, and so tests can prove a
   *  non-UTC host renders correctly. */
  readonly timeZone?: string;
  /** D-210 A.8 3d-2c — render form controls instead of static rows.
   *
   *  ⚠ MUST be true only when the POST side can actually accept an edited
   *  submission for this hold. An editable control the submit path cannot
   *  honour is the worst of both: the owner retimes the slot, approves, and
   *  the original value lands. The composer binds this together with the
   *  approve closure, off the same bundle, so they cannot come apart. */
  readonly editable?: boolean;
}

const resolveDefaultTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** Build the `/ask` port's `resolveDetails` closure.
 *
 *  Returns null — no block — for every ask whose details cannot honestly be
 *  resolved, and each null is a distinct fact rather than a fallback:
 *
 *    - not a `gateway.preflight` ask: it holds no operation at all;
 *    - a BATCHED preflight ask: `buildPreflightAsk` stamps ONE
 *      `checkpoint_id` on a payload covering N members, so rendering "the"
 *      args would show one member's values as if they were the whole
 *      approval. The prose already enumerates a batch's items;
 *    - no `checkpoint_id`, or a hold that is unknown / consumed / not
 *      reception-origin. */
export const createAskLandingDetailResolver = (
  deps: AskLandingDetailResolverDeps,
): ((ask: PendingAsk) => Promise<AskLandingHeldOpDetails | null>) => {
  const timeZone = deps.timeZone ?? resolveDefaultTimeZone();
  return async (ask: PendingAsk): Promise<AskLandingHeldOpDetails | null> => {
    if (ask.handler_kind !== PREFLIGHT_HANDLER_KIND) return null;
    if (ask.handler_payload.batch_id !== undefined) return null;
    const hold_id = ask.handler_payload.checkpoint_id;
    if (typeof hold_id !== 'string' || hold_id.length === 0) return null;
    const item = await deps.findHoldItem(hold_id);
    if (item === null) return null;
    const built = buildAskLandingDetails(item, {
      timeZone,
      ...(deps.editable === true ? { editable: true } : {}),
    });
    return built.details.length > 0 ? built : null;
  };
};
