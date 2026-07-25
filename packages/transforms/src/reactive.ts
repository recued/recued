/** D-115 Phase 7 — Tier 2 transforms for reactive recipes.
 *
 *  Narrow convenience wrappers over common delta patterns — each is
 *  reachable via the same infrastructure as every other transform
 *  (registered in `TRANSFORMS`, schema-checked by the validator). The
 *  underlying logic is deliberately simple: authors can compose the
 *  same effect out of `filter` + `compare` + `date_diff`, but the
 *  reactive-idiom-specific names read more naturally at the trigger
 *  layer ("`mail_received` when any mail matches this filter").
 *
 *  All Tier 2 transforms are pure — no I/O, no clock lookups beyond
 *  the `now` param passed in by the caller (recipes supply
 *  `{{context.now}}` or similar; the engine pre-populates `context`
 *  from the run context, which the runtime sets to `Date.now()` at
 *  dispatch time). Keeping `now` explicit means the unit tests can
 *  drive the clock deterministically.
 *
 *  Spec: D-115 §"Tier 2 transforms (starter set)".
 */

import type { TransformFn } from './types.js';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Test a single mail record against a metadata filter. Every provided
 *  filter field must match (AND); absent fields don't constrain. */
const mailMatches = (
  mail: Record<string, unknown>,
  filter: { from?: string; subject?: string; label?: string },
): boolean => {
  if (filter.from !== undefined) {
    const from = String(mail.from ?? '').toLowerCase();
    if (!from.includes(filter.from.toLowerCase())) return false;
  }
  if (filter.subject !== undefined) {
    const subject = String(mail.subject ?? '').toLowerCase();
    if (!subject.includes(filter.subject.toLowerCase())) return false;
  }
  if (filter.label !== undefined) {
    const labels = mail.labels;
    const needle = filter.label.toLowerCase();
    if (!Array.isArray(labels) || !labels.some((l) => String(l).toLowerCase() === needle)) {
      return false;
    }
  }
  return true;
};

/** Truthy if any mail in the list matches the filter (from /
 *  subject substring, label exact). Watcher-side pattern: run against
 *  `{{trigger.mail.items}}` to decide `should_run` downstream; also
 *  works against any list of mail-shaped records. */
export const mail_received: TransformFn = (p) => {
  const mails = p.mails as unknown;
  if (!Array.isArray(mails)) return false;
  const filter = {
    ...(p.from !== undefined ? { from: String(p.from) } : {}),
    ...(p.subject !== undefined ? { subject: String(p.subject) } : {}),
    ...(p.label !== undefined ? { label: String(p.label) } : {}),
  };
  return mails.some((m) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
    return mailMatches(m as Record<string, unknown>, filter);
  });
};

/** Narrow a list of file records to those modified after `since_ms`,
 *  optionally constrained by path prefix and extension. Extensions are
 *  matched case-insensitively and with or without the leading `.`. */
export const file_changed: TransformFn = (p) => {
  const files = p.files as unknown;
  if (!Array.isArray(files)) return [];
  const since = Number(p.since_ms);
  if (!Number.isFinite(since)) return [];
  const prefix = p.path_prefix !== undefined ? String(p.path_prefix) : null;
  const ext = p.extension !== undefined
    ? String(p.extension).toLowerCase().replace(/^\./, '')
    : null;
  return files.filter((f) => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
    const rec = f as Record<string, unknown>;
    const modified = Number(rec.modified_at ?? rec.updated_at ?? rec.mtime);
    if (!Number.isFinite(modified) || modified <= since) return false;
    if (prefix !== null) {
      const path = String(rec.path ?? '');
      if (!path.startsWith(prefix)) return false;
    }
    if (ext !== null) {
      const path = String(rec.path ?? '');
      const dot = path.lastIndexOf('.');
      const actual = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
      if (actual !== ext) return false;
    }
    return true;
  });
};

/** Filter calendar events down to those starting in the next
 *  `minutes_ahead` window from `now` (inclusive of `now`, exclusive
 *  of the upper bound). Events without a `start_at` are dropped. */
export const calendar_starting_soon: TransformFn = (p) => {
  const events = p.events as unknown;
  if (!Array.isArray(events)) return [];
  const now = Number(p.now);
  const window = Number(p.minutes_ahead);
  if (!Number.isFinite(now) || !Number.isFinite(window)) return [];
  const upper = now + window * 60_000;
  return events.filter((e) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
    const start = Number((e as Record<string, unknown>).start_at);
    return Number.isFinite(start) && start > now && start <= upper;
  });
};

/** Filter calendar events down to those whose adapter-reported
 *  `updated_at` (or equivalent) is strictly greater than `since_ms`.
 *  Mirrors `file_changed` for calendar rows — recipes pair this with
 *  `{{trigger.cal.items}}` + a `shared.*` cursor when they need to
 *  fan out per-change-touch instead of per-tick. Falls back to
 *  `modified_at` / `mtime` for legacy shapes. */
export const calendar_changed_since: TransformFn = (p) => {
  const events = p.events as unknown;
  if (!Array.isArray(events)) return [];
  const since = Number(p.since_ms);
  if (!Number.isFinite(since)) return [];
  return events.filter((e) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
    const rec = e as Record<string, unknown>;
    const modified = Number(rec.updated_at ?? rec.modified_at ?? rec.mtime);
    return Number.isFinite(modified) && modified > since;
  });
};

/** Filter calendar events down to those whose `created_at` is strictly
 *  greater than `since_ms`. Distinct from `calendar_changed_since` —
 *  reacts only on the event's first-ever appearance in the warehouse,
 *  not on subsequent edits. Authors who want "brand-new meetings since
 *  I last checked" reach for this; anyone wanting "any change" reaches
 *  for `calendar_changed_since`. */
export const calendar_new_since: TransformFn = (p) => {
  const events = p.events as unknown;
  if (!Array.isArray(events)) return [];
  const since = Number(p.since_ms);
  if (!Number.isFinite(since)) return [];
  return events.filter((e) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
    const created = Number((e as Record<string, unknown>).created_at);
    return Number.isFinite(created) && created > since;
  });
};

interface AttendeeLike {
  email?: unknown;
  display_name?: unknown;
  response_status?: unknown;
  is_self?: unknown;
}

interface NormalizedAttendee {
  email: string;
  display_name?: string;
  response_status?: string;
  is_self?: boolean;
}

const normalizeAttendee = (a: unknown): NormalizedAttendee | null => {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const rec = a as AttendeeLike;
  const email = typeof rec.email === 'string' ? rec.email.toLowerCase() : '';
  if (email === '') return null;
  const out: NormalizedAttendee = { email };
  if (typeof rec.display_name === 'string') out.display_name = rec.display_name;
  if (typeof rec.response_status === 'string') out.response_status = rec.response_status;
  if (typeof rec.is_self === 'boolean') out.is_self = rec.is_self;
  return out;
};

const collectAttendees = (source: unknown): Map<string, NormalizedAttendee> => {
  const out = new Map<string, NormalizedAttendee>();
  if (!source || typeof source !== 'object') return out;
  const list = Array.isArray(source)
    ? source
    : Array.isArray((source as { attendees?: unknown }).attendees)
      ? ((source as { attendees: unknown[] }).attendees)
      : [];
  for (const entry of list) {
    const norm = normalizeAttendee(entry);
    if (norm) out.set(norm.email, norm);
  }
  return out;
};

/** Diff two attendee lists (or two events carrying attendees) and
 *  report added / removed / response-changed entries. Matches
 *  attendees by email (case-insensitive). When `prior` is null or
 *  missing attendees, every current attendee lands in `added`; when
 *  `current` is null, every prior attendee lands in `removed`. The
 *  canonical pairing from the `calendar-watcher` output is
 *  `{{item.prior}}` + `{{item.attendees}}` — which fits both argument
 *  shapes: passing the full events works, or passing the two
 *  attendees arrays directly works. */
export const attendee_diff: TransformFn = (p) => {
  const priorMap = collectAttendees(p.prior ?? p.prior_attendees ?? null);
  const currentMap = collectAttendees(
    p.current ?? p.current_attendees ?? p.attendees ?? null,
  );
  const added: NormalizedAttendee[] = [];
  const removed: NormalizedAttendee[] = [];
  const response_changed: Array<{ email: string; from: string; to: string }> = [];
  for (const [email, curr] of currentMap) {
    const prev = priorMap.get(email);
    if (!prev) {
      added.push(curr);
      continue;
    }
    const from = prev.response_status ?? '';
    const to = curr.response_status ?? '';
    if (from !== to) response_changed.push({ email, from, to });
  }
  for (const [email, prev] of priorMap) {
    if (!currentMap.has(email)) removed.push(prev);
  }
  return { added, removed, response_changed };
};

/** Filter audit entries down to successful runs of a specific recipe
 *  since `since_ms`. Paired with the `recipe-watcher` ingredient for
 *  "fire when recipe X succeeded" semantics.
 *
 *  D-153 P1 — predicate reads `commit_status === 'succeeded'` (the new
 *  lifecycle enum) directly. The pre-D-153 `outcome ?? status ??
 *  success` defensive fallback was retired with the substrate
 *  replacement; audit rows now carry exactly one `commit_status`
 *  field. */
export const recipe_succeeded_since: TransformFn = (p) => {
  const entries = p.entries as unknown;
  if (!Array.isArray(entries)) return [];
  const since = Number(p.since_ms);
  if (!Number.isFinite(since)) return [];
  const recipe_id = p.recipe_id !== undefined ? String(p.recipe_id) : null;
  return entries.filter((e) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
    const rec = e as Record<string, unknown>;
    if (recipe_id !== null && rec.recipe_id !== recipe_id) return false;
    if (rec.commit_status !== 'succeeded') return false;
    const finished = Number(rec.finished_at ?? rec.completed_at);
    return Number.isFinite(finished) && finished > since;
  });
};

/** Calendar-aware business-hours gate. True iff `now` falls inside
 *  the declared window:
 *    - `weekdays`  — array of 0 (Sunday) - 6 (Saturday). Absent = any day.
 *    - `start_hour`, `end_hour` — 0-23 range in the host's local TZ.
 *                                 Absent = any time of day.
 *
 *  Explicit TZ handling is out of scope for this pure transform —
 *  recipes that need cross-TZ gating pre-compute `now` in the target
 *  TZ and hand it in. */
export const time_within_window: TransformFn = (p) => {
  const now = Number(p.now);
  if (!Number.isFinite(now)) return false;
  const d = new Date(now);
  if (Array.isArray(p.weekdays)) {
    const allowed = p.weekdays.map((n) => Number(n));
    if (!allowed.includes(d.getDay())) return false;
  }
  if (isNum(p.start_hour) || isNum(p.end_hour)) {
    const h = d.getHours();
    const start = isNum(p.start_hour) ? p.start_hour : 0;
    const end = isNum(p.end_hour) ? p.end_hour : 24;
    if (h < start || h >= end) return false;
  }
  return true;
};

/** Elapsed-ms predicate. True iff (`now` - `since_ms`) >= `window_ms`.
 *  Used as "fire at most every N ms" throttle on reactive recipes,
 *  paired with a `shared.*` cursor the recipe advances on each fire. */
export const time_elapsed_since: TransformFn = (p) => {
  const now = Number(p.now);
  const since = Number(p.since_ms);
  const window = Number(p.window_ms);
  if (!Number.isFinite(now) || !Number.isFinite(window)) return false;
  // A missing `since_ms` (first tick after install) counts as "elapsed".
  if (!Number.isFinite(since)) return true;
  return now - since >= window;
};

/** Etag-or-hash diff check. True iff the current snapshot differs
 *  from the prior one. Accepts both `current_etag` / `previous_etag`
 *  and `current_hash` / `previous_hash` pairings; missing prior
 *  (first tick) counts as "changed". */
export const http_changed: TransformFn = (p) => {
  const prevEtag = p.previous_etag !== undefined ? String(p.previous_etag) : null;
  const curEtag = p.current_etag !== undefined ? String(p.current_etag) : null;
  if (curEtag !== null) {
    if (prevEtag === null) return true;
    return curEtag !== prevEtag;
  }
  const prevHash = p.previous_hash !== undefined ? String(p.previous_hash) : null;
  const curHash = p.current_hash !== undefined ? String(p.current_hash) : null;
  if (curHash !== null) {
    if (prevHash === null) return true;
    return curHash !== prevHash;
  }
  // No comparable fields supplied — treat as "unchanged" (safer
  // default than "fire every tick").
  return false;
};
