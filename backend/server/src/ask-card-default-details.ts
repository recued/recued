/** The approval card's rows for an action whose pack declares no reviewable fields.
 *
 *  ⛔⛔ D-270 SHOWED NOTHING FOR THESE, AND THEY ARE MOST OF THE CORPUS. The card
 *  projects only the keys a pack lists in `editable_args`; measured 2026-10-04,
 *  11,687 of 12,470 actions that can be held (586 packs) list none. Their
 *  approvals named the action and never what it would change — a held unlock read
 *  "wants to run …lock.unlock" with no door named.
 *
 *  🔑 THE DECLARED INTERFACE, NEVER THE RAW HELD ARGS. D-270's fence holds: a
 *  checkpoint keeps its call's args unredacted, so nothing here enumerates them.
 *  The rows come from the action's own installed `request_schema` — the fields
 *  its pack declared, the same contract the gateway enforces — and only those the
 *  held call actually carries (an optional field it does not send commits to
 *  nothing, so leaving it out is not a partial block).
 *
 *  ⛔ A SECRET IS A ROW WITH ITS VALUE HIDDEN, NEVER A MISSING ROW. D-270 makes
 *  the block all-or-nothing — "a reader who sees three of four values has no way
 *  to know a fourth exists" — so a password field is listed and its value is
 *  not. The same names are hidden INSIDE a JSON body (`body_raw`, the commonest
 *  field in the corpus). The match is by name, so it is a display hygiene rule,
 *  not a boundary: a pack that needs exact control declares `editable_args`,
 *  which always wins.
 *
 *  ⚠ DISPLAY ONLY. This never feeds `resolveArgEditSchema`, whose allowlist is
 *  also what reception may EDIT at approve time; nothing becomes editable here. */

import type { ArgEditField, MetaFieldType } from '@recued/contracts';

/** Above this many fields a summary stops being one; the card shows no block, as
 *  before, and the payload stays in its technical details. Measured: median 2,
 *  p90 5, max 205 declared fields per action. */
export const DEFAULT_REVIEW_FIELD_MAX = 12;

export const HIDDEN_SECRET_VALUE = 'Hidden: this looks like a secret';

const SECRET_WORD =
  /(password|passphrase|passwd|secret|token|api[_-]?key|authori[sz]ation|credential|private[_-]?key|cookie)/i;
/** A field that NAMES or POINTS AT a secret is not one: `secret_name`, `token_id`. */
const NAMES_A_SECRET = /(name|id|ids|type|count|url|uri|hint|expires?(_at)?|expiry)$/i;
const TRANSPORT_PREFIX = /^(body|query|path|header|headers)\./;
/** Plumbing, not what the action changes: a retry key says nothing to approve. */
const PLUMBING = /idempotency/i;
/** Fields whose humanized key would read badly. */
const LABELS: Readonly<Record<string, string>> = { body_raw: 'Data sent' };

/** The last path segment decides: `body.client_secret` is one, `body.secret_name`
 *  is the name of one. */
export const isSecretShapedKey = (key: string): boolean => {
  const last = key.split('.').at(-1) ?? key;
  return SECRET_WORD.test(last) && !NAMES_A_SECRET.test(last);
};

const hideSecretsIn = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(hideSecretsIn);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(
    ([key, inner]) => [key, isSecretShapedKey(key) ? HIDDEN_SECRET_VALUE : hideSecretsIn(inner)],
  ));
};

/** A string that is a JSON object or array has its secret-shaped members hidden;
 *  any other value is returned as it is. */
const hideSecretsInJsonText = (text: string): string => {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
  try { return JSON.stringify(hideSecretsIn(JSON.parse(text))); } catch { return text; }
};

const readArgPath = (args: Record<string, unknown>, key: string): unknown => {
  if (Object.hasOwn(args, key)) return args[key];
  if (!key.includes('.')) return undefined;
  let cursor: unknown = args;
  for (const segment of key.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
};

const metaTypeOf = (node: unknown): MetaFieldType => {
  const type = node !== null && typeof node === 'object' ? (node as { type?: unknown }).type : undefined;
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'array' || type === 'object') return 'json';
  // ⚠ Never `datetime`: that formatter reads an epoch, and a declared string is
  // shown exactly as the call carries it.
  return 'string';
};

/** The fields to show and the values to show them with, or null when there is
 *  nothing honest to show (no declared fields, none carried, or too many). */
export const defaultReviewDetails = (
  request_schema: unknown,
  args: Record<string, unknown>,
): { readonly fields: ArgEditField[]; readonly args: Record<string, unknown> } | null => {
  const properties = request_schema !== null && typeof request_schema === 'object'
    ? (request_schema as { properties?: unknown }).properties : undefined;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return null;
  const carried = Object.keys(properties)
    .filter((key) => !PLUMBING.test(key) && readArgPath(args, key) !== undefined);
  if (carried.length === 0 || carried.length > DEFAULT_REVIEW_FIELD_MAX) return null;
  const shown: Record<string, unknown> = {};
  const fields = carried.map((key): ArgEditField => {
    const value = readArgPath(args, key);
    const secret = isSecretShapedKey(key);
    shown[key] = secret ? HIDDEN_SECRET_VALUE
      : typeof value === 'string' ? hideSecretsInJsonText(value) : hideSecretsIn(value);
    return {
      key,
      type: secret ? 'string' : metaTypeOf((properties as Record<string, unknown>)[key]),
      // The transport prefix is plumbing; the card humanizes the rest.
      label: LABELS[key] ?? key.replace(TRANSPORT_PREFIX, ''),
    };
  });
  return { fields, args: shown };
};
