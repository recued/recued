/** D-164 P4e — deterministic gate orchestrator.
 *
 *  `runGate(ctx, deps?)` composes the four-step deterministic
 *  short-circuit (design § 3): NER over a chosen input text, template
 *  lookup, warehouse data-presence probe, render. The gate calls
 *  `ctx.resolve(text)` on a successful short-circuit; any uncertainty
 *  along the way drops to pass-through (the framework then makes the
 *  main LLM call as usual). Both paths return a `GateOutcome` for
 *  caller diagnostics + test assertions.
 *
 *  Input-text rule. The orchestrator picks NER's input from the
 *  intention router's `IntentionResult` (`../intention/`):
 *    - **anaphora + referent** — the TWO-TEXT path (P9 / P11): the
 *      referent (`referent.entry.text`, the prior assistant turn)
 *      supplies the entity, the current prompt supplies the attribute /
 *      intent. `rewriteAnaphoricPrompt` binds the prompt's single
 *      reference — a pronoun to the referent's unique certainty-gated
 *      name (P9), an ordinal / demonstrative to the selected item of the
 *      referent's parsed list shape (P11) — and the REWRITTEN prompt
 *      re-enters the normal pipeline below — every family whitelist
 *      applies to it verbatim. Any unmodeled shape (no unique referent
 *      name, no closed-shape list, a prompt-side name, multiple
 *      references, an unsubstitutable position, a residual anaphor)
 *      passes through (`anaphora-unresolved`).
 *    - **anaphora + null referent** — pass through (`anaphora-without-
 *      referent`). The user said `they` / `the second one` against an
 *      empty assistant history; there's nothing in-session to resolve
 *      against, so cross-session memory recall (LLM-driven) takes over.
 *    - **no anaphora** — use the latest user turn text.
 *
 *  Two-way 100% rule (design § 3). The gate fires only when NER is
 *  100% certain (`extract` returns non-null) AND the probe returns a
 *  snapshot. Either uncertainty → pass through. There is no probability
 *  threshold to tune; the binary certainty gate + warehouse presence
 *  check are the only knobs.
 *
 *  Render-snapshot freeze (design § 3 Invariant 6). The probe captures
 *  warehouse rows at call time; the renderer consumes that snapshot.
 *  Subsequent writes never race the render because the snapshot is a
 *  by-value copy held by the gate until `renderTemplate` returns.
 *
 *  Dependency injection. The three callbacks (`matchTemplate` /
 *  `probeData` / `renderTemplate`) all default to "never fires":
 *  matcher returns `null`, probe returns `null`, renderer returns the
 *  empty string. P4e ships the orchestration shape with the defaults
 *  wired; P4f / P5 swap in the real template library + warehouse probe
 *  + renderer at boot. The gate's pass-through semantics mean a
 *  production deployment with default deps behaves identically to a
 *  pre-P4e deployment (every turn falls through to the LLM).
 *
 *  Idempotence + side effects. `runGate` reads `ctx.state`, `ctx.history`,
 *  and (on short-circuit) calls `ctx.resolve` exactly once. It never
 *  writes to `ctx.state`. Re-running over the same context with no
 *  resolve happening is a no-op; re-running after a successful
 *  short-circuit throws (the framework's `resolve` enforces "first
 *  call wins; a second call throws").
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md
 *  § 1 gate / § 3 the deterministic gate. */

import type { SurfaceTag } from '@recued/chat';
import type { ExecutionSource } from '@recued/contracts';
import type { TurnContext } from '@recued/middleware';

import {
  INTENTION_RESULT_STATE_KEY,
  type AnaphoraSignal,
  type IntentionResult,
} from '../intention/index.js';
import { extract, type SlotValue } from '../ner/index.js';
import type { RenderTemplate, Template } from '../types.js';

import { rewriteAnaphoricPrompt } from './anaphora-rewrite.js';
import {
  noopDataPresenceProbe,
  type DataPresenceProbe,
  type DataPresenceQuery,
  type DataSnapshot,
} from './data-presence.js';

export {
  rewriteAnaphoricPrompt,
  type AnaphoraRewriteInput,
} from './anaphora-rewrite.js';
export { parseInlineNameList } from './referent-inline-list.js';
export { containsListMarkerLine, parseReferentList } from './referent-list.js';
export {
  noopDataPresenceProbe,
  createContactAttributePresenceProbe,
  createCalendarNextMeetingProbe,
  createContactHasEmailProbe,
  createMailFromCountProbe,
  resolveUniqueExactContact,
  type CalendarNextMeeting,
  type CalendarNextMeetingLookup,
  type ContactAttributeLookup,
  type ContactAttributeRow,
  type DataPresenceProbe,
  type DataPresenceQuery,
  type DataSnapshot,
  type HasCrmContactSource,
  type MailFromCountLookup,
} from './data-presence.js';

// ── Dependency contracts ───────────────────────────────────────────

/** Query the unified template library (bundle + audit-grown pool).
 *  Returns the matched `Template` or `null` for no match. Sync OR
 *  async — the gate awaits either form uniformly.
 *
 *  Inputs:
 *    - `text` — the source text NER scanned (referent text on
 *      anaphora, latest user text otherwise). The matcher uses this
 *      to derive verb / action expectation per design § 3 Invariant 3
 *      (action-class gate). NER only emits closed-vocabulary slots
 *      (name / email / date / time) — verb / intent classification
 *      is the matcher's responsibility.
 *    - `slots` — the certainty-gated NER slots.
 *    - `locale` — the resolved locale tag for slot grammar.
 *
 *  The matcher returns `null` whenever ANY criterion rejects (no
 *  template for this slot grammar, action-class mismatch, etc.); the
 *  gate cannot distinguish reasons and treats every `null` as
 *  pass-through. */
export type TemplateMatcher = (query: {
  readonly text: string;
  readonly slots: ReadonlyArray<SlotValue>;
  readonly locale: string;
}) => Promise<Template | null> | Template | null;

/** Render a matched template using the warehouse snapshot. Returns
 *  the final assistant-facing text. An empty string is interpreted as
 *  "render declined" and pass-through fires. */
export type TemplateRenderer = (
  template: Template,
  snapshot: DataSnapshot,
) => Promise<string> | string;

/** The orchestrator's three dependencies. All callbacks default to
 *  "never fires" so the gate is safe to register without a wired
 *  template library / warehouse probe / renderer. */
export interface GateDeps {
  readonly matchTemplate: TemplateMatcher;
  readonly probeData: DataPresenceProbe;
  readonly renderTemplate: TemplateRenderer;
  /** The READ-PERMISSION seam (P10 / P12): may the deterministic
   *  short-circuit fire on this surface? The gate's probes read the
   *  warehouse DIRECTLY, bypassing the per-token-gated `contact.search` /
   *  `calendar.search` tools — so on any surface beyond the owner's
   *  internal `chat` the render is admissible only where an equivalent
   *  `kind: 'storage'`, `risk_tier: 'read'` dispatch would be admitted for
   *  that surface's identity. The backend owns that judgment
   *  (`createPromptCacheGateDeps` injects the op-risk read authorization —
   *  a read is never-class, so it admits the owner's own identity and gates
   *  a contracted door's read); the package only consumes the boolean.
   *
   *  `source` (P12) is the turn's REAL channel-minted `ExecutionSource`
   *  (`TurnContext.source` — threaded from `ChannelInbound.source` by
   *  `runStream`). When present the backend evaluates THAT identity's
   *  policy cell — so a turn whose actor is NOT the unrestricted owner
   *  (a contracted messenger turn, if one ever exists) is judged as
   *  itself, never as the surface's static `user_self` stand-in. When
   *  absent (bare harness contexts) the backend falls back to the P10
   *  surface→source map.
   *
   *  ABSENT seam → the middleware falls back to the proven chat-only
   *  scope (`surface === 'chat'`), so legacy callers and dbless
   *  harnesses keep the pre-P10 behavior exactly. A `false`, a
   *  non-`true` value, or a THROW all fail closed to pass-through — the
   *  LLM path is policy-gated on its own, so deferring never widens
   *  anything. Sync OR async. */
  readonly authorizeShortCircuitRead?: (
    surface: SurfaceTag,
    source?: ExecutionSource,
  ) => Promise<boolean> | boolean;
}

const NOOP_MATCH_TEMPLATE: TemplateMatcher = () => null;
const NOOP_RENDER_TEMPLATE: TemplateRenderer = () => '';

/** The default deps the middleware uses when no real wiring is
 *  provided — every turn passes through. Exported so callers can
 *  partially override (`{ ...DEFAULT_GATE_DEPS, matchTemplate: realMatcher }`)
 *  without re-stating every field. */
export const DEFAULT_GATE_DEPS: GateDeps = {
  matchTemplate: NOOP_MATCH_TEMPLATE,
  probeData: noopDataPresenceProbe,
  renderTemplate: NOOP_RENDER_TEMPLATE,
};

// ── Multi-family composition ───────────────────────────────────────

/** A short-circuit "family": one query class's intent-aware matcher, its
 *  warehouse data-presence probe, and the set of `template_hash`es its
 *  matcher can return. Families are the extension seam for widening the
 *  deterministic gate to new classes (contact attribute, calendar
 *  next-meeting, …) without `runGate` or the backend wiring needing to
 *  know how many exist.
 *
 *  `matchTemplate` / `probeData` are SEPARATE callbacks on `GateDeps`
 *  (the gate matches, then probes), so the probe must independently
 *  recover WHICH family owns the matched template — it does that by
 *  `template_hash` membership in `templateHashes`. The sets MUST be
 *  disjoint across families; a hash claimed by two families routes to the
 *  first one registered.
 *
 *  `overrideTemplates` is the family's AUTHORIZATION list for the
 *  snapshot's `render_template_override` seam: the CANONICAL sibling
 *  bodies its probe may select at probe time (the has-email family's
 *  negative). Authorization is by canonical OBJECT, keyed on hash: the
 *  composed probe looks the override's hash up here and REPLACES the
 *  probe-supplied object with the declared one before the renderer sees
 *  it — so a buggy or cast-happy probe returning a declared hash with a
 *  DIFFERENT body still renders only the reviewed canonical body. An
 *  undeclared hash REJECTS — fails closed to pass-through; the default
 *  (absent) authorizes none. Override hashes are NOT probe-routing
 *  hashes (a matcher never returns them), so they don't participate in
 *  the disjointness rule above. */
export interface ShortCircuitFamily {
  readonly match: TemplateMatcher;
  readonly probe: DataPresenceProbe;
  readonly templateHashes: ReadonlySet<string>;
  readonly overrideTemplates?: readonly RenderTemplate[];
}

/** Compose N families into the `{ matchTemplate, probeData }` half of
 *  `GateDeps` (the caller supplies the shared `renderTemplate`). The
 *  composed matcher tries each family in registration order, first
 *  non-null template wins; the composed probe routes the matched template
 *  to its owning family by `template_hash`. A template no family claims
 *  yields a `null` probe result (pass-through) — defensive, since the
 *  composed matcher only ever returns a claimed template.
 *
 *  Override containment: a snapshot carrying a `render_template_override`
 *  whose hash the owning family did not declare in `overrideTemplates` is
 *  DROPPED to `null` (pass-through); a DECLARED hash renders the family's
 *  canonical object, never the probe-supplied one (see the interface doc).
 *  A probe producing an unauthorized override is buggy by definition, and
 *  rendering an unvetted body is the one outcome the deterministic gate
 *  must never allow — fail closed. */
export const composeShortCircuitFamilies = (
  families: readonly ShortCircuitFamily[],
): Pick<GateDeps, 'matchTemplate' | 'probeData'> => {
  const canonicalOverrides = families.map(
    (family) =>
      new Map((family.overrideTemplates ?? []).map((t) => [t.template_hash, t])),
  );
  const matchTemplate: TemplateMatcher = async (query) => {
    for (const family of families) {
      const template = await family.match(query);
      if (template !== null) return template;
    }
    return null;
  };
  const probeData: DataPresenceProbe = async (query) => {
    for (let i = 0; i < families.length; i += 1) {
      const family = families[i]!;
      if (family.templateHashes.has(query.template.template_hash)) {
        const snapshot = await family.probe(query);
        if (snapshot === null || snapshot.render_template_override === undefined) {
          return snapshot;
        }
        const canonical = canonicalOverrides[i]!.get(
          snapshot.render_template_override.template_hash,
        );
        if (canonical === undefined) return null;
        return { ...snapshot, render_template_override: canonical };
      }
    }
    return null;
  };
  return { matchTemplate, probeData };
};

// ── Outcome discriminator ──────────────────────────────────────────

/** Why the gate did not short-circuit this turn. The discriminator is
 *  load-bearing for test assertions — each step has a distinct reason
 *  so a failing test can identify which step rejected.
 *
 *  `not-short-circuit-eligible` fires after a template match when the
 *  matched template's `short_circuit_eligible` flag is false (the
 *  structural-plan case — design O-6). The gate skips probe + render
 *  and passes through; the structural plan would replay through the
 *  main executor path instead (P5+ behavior). Keeping it as a distinct
 *  reason (not folded into `empty-render`) so diagnostics + tests
 *  cleanly separate "render produced nothing" from "render was never
 *  attempted." */
export type GatePassThroughReason =
  | 'anaphora-without-referent'
  | 'anaphora-unresolved'
  | 'empty-text'
  | 'no-extraction'
  | 'no-template'
  | 'not-short-circuit-eligible'
  | 'no-data-presence'
  | 'empty-render';

/** What `runGate` returns. `short-circuit` means `ctx.resolve(text)`
 *  has been called; `pass-through` means the framework should run the
 *  main LLM call. Callers (the middleware adapter) do not need to act
 *  on either case — the outcome is purely diagnostic. */
export type GateOutcome =
  | { readonly kind: 'short-circuit'; readonly text: string }
  | { readonly kind: 'pass-through'; readonly reason: GatePassThroughReason };

// ── Input-text selection ───────────────────────────────────────────

/** The discriminator the orchestrator uses to pick NER's input text.
 *  `kind: 'text'` is the direct-prompt path; `kind: 'two-text'` is the
 *  anaphora path (the rewrite resolves it to a single text before the
 *  pipeline runs); `kind: 'pass-through'` short-circuits the gate
 *  before NER even runs. */
type NerInputSelection =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'two-text';
      readonly promptText: string;
      readonly referentText: string;
      readonly signal: AnaphoraSignal;
    }
  | { readonly kind: 'pass-through'; readonly reason: GatePassThroughReason };

/** Walk `history` backward and return the latest user turn's text;
 *  `''` for an empty history or a history with no user entry. */
const latestUserText = (history: TurnContext['history']): string => {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.role === 'user') return entry.text;
  }
  return '';
};

/** Apply the input-text rule: an anaphoric turn with a referent takes
 *  the two-text path (the rewrite binds prompt + referent), anaphora
 *  without a referent passes through, anything else falls back to the
 *  latest user text. Reads `ctx.state` but never writes. */
const selectNerInput = (ctx: TurnContext): NerInputSelection => {
  const raw = ctx.state.get(INTENTION_RESULT_STATE_KEY);
  const intention = raw as IntentionResult | undefined;
  if (intention !== undefined) {
    if (intention.referent === null) {
      return { kind: 'pass-through', reason: 'anaphora-without-referent' };
    }
    return {
      kind: 'two-text',
      promptText: latestUserText(ctx.history),
      referentText: intention.referent.entry.text,
      signal: intention.signal,
    };
  }
  return { kind: 'text', text: latestUserText(ctx.history) };
};

// ── The orchestrator ───────────────────────────────────────────────

/** Run the deterministic gate over a turn. See file header for the
 *  full contract. The default `deps` (`DEFAULT_GATE_DEPS`) make the
 *  gate a no-op that always passes through; production deployments
 *  override the deps at registration time. */
export const runGate = async (
  ctx: TurnContext,
  deps: GateDeps = DEFAULT_GATE_DEPS,
): Promise<GateOutcome> => {
  const input = selectNerInput(ctx);
  if (input.kind === 'pass-through') {
    return { kind: 'pass-through', reason: input.reason };
  }

  // The two-text path (P9 / P11): bind the prompt's single reference — a
  // pronoun to the referent's unique name, an ordinal / demonstrative to
  // the selected item of the referent's parsed list — and feed the
  // REWRITTEN prompt through the normal pipeline below — the family
  // whitelists (which derive both entity position and intent from one
  // text) apply to it verbatim. The rewrite is a closed rule set that
  // defers on anything unmodeled (`anaphora-unresolved`); see
  // `./anaphora-rewrite.ts` for the rule-by-rule rationale.
  let inputText: string;
  if (input.kind === 'two-text') {
    const rewritten = rewriteAnaphoricPrompt(input);
    if (rewritten === null) {
      return { kind: 'pass-through', reason: 'anaphora-unresolved' };
    }
    inputText = rewritten;
  } else {
    inputText = input.text;
  }
  if (inputText.length === 0) {
    return { kind: 'pass-through', reason: 'empty-text' };
  }

  const extraction = extract(inputText);
  if (extraction === null) {
    return { kind: 'pass-through', reason: 'no-extraction' };
  }

  const template = await deps.matchTemplate({
    text: inputText,
    slots: extraction.slots,
    locale: extraction.locale,
  });
  if (template === null) {
    return { kind: 'pass-through', reason: 'no-template' };
  }
  if (template.short_circuit_eligible === false) {
    return { kind: 'pass-through', reason: 'not-short-circuit-eligible' };
  }

  const query: DataPresenceQuery = { template, slots: extraction.slots };
  const snapshot = await deps.probeData(query);
  if (snapshot === null) {
    return { kind: 'pass-through', reason: 'no-data-presence' };
  }

  // Data-dependent variant selection (see `DataSnapshot.render_template_override`):
  // a probe may pick a sibling RENDER body the lexical matcher couldn't choose
  // (the has-email family's yes/no split). Family containment is enforced in
  // `composeShortCircuitFamilies` (an undeclared override drops the snapshot);
  // here the gate re-verifies the render-only shape AT RUNTIME — the field is
  // typed `RenderTemplate`, but a cast-happy probe must still not be able to
  // route a structural plan (or a not-eligible template) into the renderer.
  const override = snapshot.render_template_override;
  if (
    override !== undefined
    && (override.kind !== 'render_template' || override.short_circuit_eligible !== true)
  ) {
    return { kind: 'pass-through', reason: 'no-data-presence' };
  }
  const text = await deps.renderTemplate(override ?? template, snapshot);
  if (text.length === 0) {
    return { kind: 'pass-through', reason: 'empty-render' };
  }

  ctx.resolve(text);
  return { kind: 'short-circuit', text };
};
