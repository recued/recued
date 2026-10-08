/** The approval card's rows for a held Recued built-in action.
 *
 *  ⛔⛔ THE CARD SHOWED THESE NOTHING READABLE. D-270's rows come from an
 *  operation's `editable_args`, or failing that from its INSTALLED
 *  `request_schema` (`ask-card-default-details.ts`). A kernel op is neither: its
 *  manifest is bundled with the server, never installed, so both lookups miss
 *  and the card fell back to scraping its own prose. Found on a live drive of
 *  the Calendar Invites pack (2026-10-07): a booking asked for approval as
 *  `SLOT START AT 1792256400000`, and a commitment's statement and a calendar
 *  event's title sat hidden under "The technical bits".
 *
 *  🔑 THE DECLARED INTERFACE, AS FOR AN INSTALLED ACTION. Rows are the kernel
 *  manifest's own `input` keys the held call carries, in the manifest's order —
 *  never the raw held args, so a value only shows because the kernel declares
 *  it an input. An object input (a calendar `event`, an update's `patch`)
 *  expands one level into its own rows, because a JSON blob is not a summary.
 *
 *  ⚠ A TIME READS AS A TIME, IN A NAMED ZONE. A `*_at` holding epoch
 *  milliseconds (Recued's convention for every stored instant) is typed
 *  `datetime`, so `buildAskLandingDetails` renders it in the owner's zone and
 *  names it. The millisecond range is the guard: a `*_at` in seconds stays a
 *  number rather than reading as 1970.
 *
 *  ⚠ DISPLAY ONLY, like the default rows. Nothing here reaches
 *  `resolveArgEditSchema`, whose allowlist is also what reception may EDIT. */

import {
  DAY_MS,
  allDayEventDays,
  getKernelOp,
  kernelOpBackingSlug,
  kernelOpForBackingSlug,
  type ArgEditField,
  type MetaFieldType,
} from '@recued/contracts';

import {
  DEFAULT_REVIEW_FIELD_MAX,
  HIDDEN_SECRET_VALUE,
  isSecretShapedKey,
} from './ask-card-default-details.js';
import { KERNEL_MANIFESTS } from './kernel-manifests.js';

const KERNEL_INPUTS_BY_SLUG: ReadonlyMap<string, readonly string[]> = new Map(
  KERNEL_MANIFESTS.map((m) => [m.slug, Object.keys(m.input ?? {})]),
);

/** A retry key says nothing to approve (the same rule as the default rows). */
const PLUMBING = /idempotency/i;

/** The subject of the action reads first: the card's headline was `title` only,
 *  which left a commitment and a calendar event without one. */
const HEADLINE_LEAVES = ['title', 'statement', 'summary', 'subject', 'name'] as const;

/** An object input that expands into rows, and how its rows are labelled.
 *  `event.summary` reads as "Summary"; `patch.start_at` as "New start". */
const EXPANDED_PREFIX_LABEL: Readonly<Record<string, string>> = { event: '', patch: 'new_' };

/** What a kernel op's instance `slug` names, by the entity it reaches. */
const SLUG_LABEL: Readonly<Record<string, string>> = {
  calendar: 'calendar',
  mail: 'mailbox',
  file: 'folder',
};

const INSTANT_MS_MIN = 1e11; // 1973-03-03 — epoch SECONDS for today stay below
const INSTANT_MS_MAX = 1e14;
const ZONE_BEARING_ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/i;

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const leafOf = (key: string): string => key.slice(key.lastIndexOf('.') + 1);

const isInstantKey = (leaf: string): boolean => /(?:^|_)at$/.test(leaf);

/** The value as an instant the card can render, or undefined when it is not
 *  one. A digit string is accepted — a template can hand a number on as text. */
const asInstant = (leaf: string, value: unknown): number | string | undefined => {
  if (!isInstantKey(leaf)) return undefined;
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d{11,14}$/.test(value) ? Number(value) : undefined;
  if (n !== undefined) {
    return Number.isInteger(n) && n >= INSTANT_MS_MIN && n < INSTANT_MS_MAX ? n : undefined;
  }
  return typeof value === 'string' && ZONE_BEARING_ISO.test(value.trim()) ? value : undefined;
};

const typeOf = (value: unknown): MetaFieldType => {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value) || isPlainRecord(value)) return 'json';
  return 'string';
};

interface Row { key: string; value: unknown; prefix: string | null }

const DAY_TEXT = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
});

/** ⛔ An all-day event's `start_at` / `end_at` are DAYS (`calendar-days.ts`):
 *  its first day, and the day after its last. As instants in the owner's zone
 *  a 24 December holiday read "23 Dec 2026, 16:00 PST". Shown as the days the
 *  event covers — the end as its last day. Only where the object says it is
 *  all-day: a timed event at 00:00 UTC (17:00 in Los Angeles) is a time. */
const allDayText = (args: Record<string, unknown>, row: Row): string | undefined => {
  if (row.prefix === null || typeof row.value !== 'number') return undefined;
  const leaf = leafOf(row.key);
  const container = args[row.prefix];
  if ((leaf !== 'start_at' && leaf !== 'end_at') || !isPlainRecord(container) || container.is_all_day !== true) {
    return undefined;
  }
  const start = typeof container.start_at === 'number' ? container.start_at : row.value;
  const end = typeof container.end_at === 'number' ? container.end_at : start + DAY_MS;
  const days = allDayEventDays({ start_at: start, end_at: end });
  return `${DAY_TEXT.format(new Date(`${leaf === 'start_at' ? days.first : days.last}T00:00:00Z`)).replace(/,/g, '')} (all day)`;
};

/** The kernel manifest slug behind an op id or a backing slug, or null. */
const kernelSlugOf = (operation_id: string): string | null => {
  if (KERNEL_INPUTS_BY_SLUG.has(operation_id)) return operation_id;
  const slug = kernelOpBackingSlug(operation_id);
  return slug !== undefined && KERNEL_INPUTS_BY_SLUG.has(slug) ? slug : null;
};

/** The rows for a held kernel op, or null when it is not one, carries none of
 *  its declared inputs, or carries more than a summary can hold (the payload
 *  stays in the card's technical details, as for any action). */
export const kernelReviewDetails = (
  operation_id: string,
  args: Record<string, unknown>,
): { readonly fields: ArgEditField[]; readonly args: Record<string, unknown> } | null => {
  const slug = kernelSlugOf(operation_id);
  if (slug === null) return null;
  const opId = getKernelOp(operation_id) !== undefined ? operation_id : kernelOpForBackingSlug(slug);
  const entity = opId === undefined ? undefined : getKernelOp(opId)?.entity;

  const rows: Row[] = [];
  for (const key of KERNEL_INPUTS_BY_SLUG.get(slug)!) {
    if (PLUMBING.test(key) || !Object.hasOwn(args, key)) continue;
    const value = args[key];
    if (value === undefined) continue;
    if (isPlainRecord(value) && Object.keys(value).length > 0) {
      for (const [child, inner] of Object.entries(value)) {
        if (inner !== undefined) rows.push({ key: `${key}.${child}`, value: inner, prefix: key });
      }
      continue;
    }
    rows.push({ key, value, prefix: null });
  }

  // Headline leaves first, in their own priority; everything else keeps the
  // manifest's order (a stable sort).
  const rank = (row: Row): number => {
    const at = (HEADLINE_LEAVES as readonly string[]).indexOf(leafOf(row.key));
    return at === -1 ? HEADLINE_LEAVES.length : at;
  };
  rows.sort((a, b) => rank(a) - rank(b));

  const fields: ArgEditField[] = [];
  const shown: Record<string, unknown> = {};
  const labelled = new Map<string, unknown>();
  for (const row of rows) {
    const leaf = leafOf(row.key);
    const days = allDayText(args, row);
    const instant = days === undefined ? asInstant(leaf, row.value) : undefined;
    const secret = isSecretShapedKey(row.key);
    // "Slot start", not "Slot start at": the row's value already says when.
    const base = (instant !== undefined || days !== undefined) && leaf.endsWith('_at') ? leaf.slice(0, -3) : leaf;
    // An expanded leaf drops its container's name where the container is
    // implied (`event.summary` → "Summary") and says what it is otherwise
    // (`patch.status` → "New status").
    let label = row.prefix === null
      ? (leaf === 'slug' && entity !== undefined ? SLUG_LABEL[entity] ?? leaf : base)
      : `${EXPANDED_PREFIX_LABEL[row.prefix] ?? `${row.prefix}.`}${base}`;
    if (labelled.has(label)) {
      // The same fact twice (`event.calendar_id` beside `calendar_id`) is one
      // row, decided on the RAW values; a different value under the same name
      // keeps its full path so the two stay told apart.
      if (labelled.get(label) === row.value) continue;
      label = row.prefix === null ? row.key : `${row.prefix}.${base}`;
    }
    labelled.set(label, row.value);
    shown[row.key] = secret ? HIDDEN_SECRET_VALUE : days ?? instant ?? row.value;
    fields.push({
      key: row.key,
      type: secret || days !== undefined ? 'string' : instant !== undefined ? 'datetime' : typeOf(row.value),
      label,
    });
  }
  if (fields.length === 0 || fields.length > DEFAULT_REVIEW_FIELD_MAX) return null;
  return { fields, args: shown };
};
