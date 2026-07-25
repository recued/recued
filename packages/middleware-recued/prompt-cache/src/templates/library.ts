/** D-164 P4f — unified template library.
 *
 *  `createTemplateLibrary({ pools })` returns a library whose
 *  `match({ text, slots, locale })` looks for a template whose slot
 *  grammar matches the extracted slots' kinds, scanned across one-or-
 *  more pools in registration order. The library is a thin orchestrator;
 *  the pools are the actual sources (`./bundle/*` for recued.com
 *  hash-pinned templates, `./audit-grow/*` for user-promoted templates).
 *  Both pools land in later slices (P4g / P4h); this slice ships the
 *  matcher with empty / synthetic pools to validate the contract.
 *
 *  Match rule (P4f scope — narrow, will widen in later slices):
 *    - **Slot grammar multiset equality.** The bag (multiset) of slot
 *      kinds the template declares — *with duplicates preserved* — must
 *      equal the bag of kinds extracted. A template needing
 *      `['entity.email']` matches a prompt with exactly one email slot
 *      (NOT two); a template needing `['entity.name', 'entity.name']`
 *      matches a prompt with exactly two name slots. The keying sorts
 *      both bags by kind name so NER discovery order doesn't matter,
 *      but duplicates are NOT deduplicated — `[name]` and `[name, name]`
 *      produce distinct keys and never cross-match.
 *    - **Locale equality.** Template locale must equal extraction locale.
 *    - **First-match wins across pools.** Pools are tried in array
 *      order; the first template that matches is returned. Bundle-first /
 *      audit-grown-second is the production ordering (canonical templates
 *      take precedence over user-grown).
 *
 *  Out of scope for P4f (deferred):
 *    - **Verb / action-class matching.** The matcher receives `text` but
 *      doesn't yet inspect verbs. Future slices add a verb-extraction
 *      pass + an action-class compare per design § 3 Invariant 3.
 *    - **Multi-match disambiguation.** When two templates have the same
 *      slot grammar + locale (e.g., "show contact <name>" vs "email
 *      <name>"), today's matcher takes the first. The verb-extraction
 *      slice resolves this.
 *
 *  Why pluggable pools rather than a built-in registry: bundle and
 *  audit-grown templates have different lifecycle, persistence, and
 *  validation paths. Modelling each as an injectable `TemplatePool`
 *  keeps the library agnostic + lets tests supply synthetic pools
 *  without touching production wiring.
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md
 *  § 1 templates (library / bundle / audit-grow folder layout) /
 *  § 3 the deterministic gate (template lookup is one of the four
 *  steps). */

import type { SlotValue } from '../ner/index.js';

import type { SlotName, Template } from '../types.js';

/** What the gate hands the library at match time. Matches the
 *  `TemplateMatcher` signature in `../gate/index.ts` — the library's
 *  `match` method satisfies the gate's `matchTemplate` dep directly. */
export interface TemplateMatchQuery {
  /** The source text NER scanned (referent text on anaphora, latest
   *  user text otherwise). Reserved for verb / action-class matching
   *  in future slices — P4f's matcher does not read it. */
  readonly text: string;
  readonly slots: ReadonlyArray<SlotValue>;
  readonly locale: string;
}

/** A template registered with the library. The pool stores templates +
 *  their declared locale; the library compares against the query's
 *  locale at match time. */
export interface RegisteredTemplate {
  readonly template: Template;
  readonly locale: string;
}

/** A pool of templates the library scans. Pools are *iterators of
 *  registered templates*; the library calls `list()` once per `match`.
 *  Production pools (bundle / audit-grown) implement the same shape
 *  with their own backing store (recued.com cache / per-server SQLite). */
export interface TemplatePool {
  /** Stable identifier for diagnostics — `'bundle'` / `'audit-grown'` /
   *  whatever a test supplies. */
  readonly name: string;
  /** Snapshot the current pool contents. The library does not memoise;
   *  pools may return a different list per call (e.g., audit-grown
   *  pool refreshes after a promotion). */
  list(): ReadonlyArray<RegisteredTemplate>;
}

/** Public library interface. The library exposes only `match` —
 *  registration + invalidation are pool-owned (the library is a
 *  read-side aggregator). */
export interface TemplateLibrary {
  match(query: TemplateMatchQuery): Template | null;
}

export interface CreateTemplateLibraryOptions {
  /** Pools the library scans on each `match` call. Iteration order is
   *  preserved — bundle-first / audit-grown-second is the production
   *  ordering. Empty array is valid: the matcher always returns null. */
  readonly pools: ReadonlyArray<TemplatePool>;
}

/** Build the comma-joined sorted slot-kind key for a slot array. Stable
 *  string identity for the multiset-equality compare; sorted so the
 *  order of NER slot discovery doesn't matter, duplicates preserved so
 *  `[name]` and `[name, name]` produce distinct keys (the match rule
 *  is multiset equality, not set equality — see file header). Empty
 *  slots → empty key (matches templates with empty slot grammar — a
 *  degenerate but valid case). */
const slotKindKey = (slots: ReadonlyArray<{ readonly kind: SlotName }>): string => {
  const kinds: SlotName[] = [];
  for (const slot of slots) kinds.push(slot.kind);
  kinds.sort();
  return kinds.join(',');
};

export const createTemplateLibrary = (
  options: CreateTemplateLibraryOptions,
): TemplateLibrary => {
  const { pools } = options;

  return {
    match(query: TemplateMatchQuery): Template | null {
      const wantedKey = slotKindKey(query.slots);
      for (const pool of pools) {
        for (const entry of pool.list()) {
          if (entry.locale !== query.locale) continue;
          if (slotKindKey(entry.template.slot_grammar.map((kind) => ({ kind }))) !== wantedKey) {
            continue;
          }
          return entry.template;
        }
      }
      return null;
    },
  };
};
