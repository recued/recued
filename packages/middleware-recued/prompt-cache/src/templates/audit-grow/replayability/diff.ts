/** D-164 P4h-3 — audit-grow replayability: LLM input vs output diff.
 *
 *  Classifies one recorded `ai-*` step invocation's input/output pair
 *  as `'stable_replay'` (the output is a deterministic projection of
 *  the input — every substantial token in the output appears verbatim
 *  in the input) or `'freeform_hole'` (the LLM contributed novel text
 *  not present in the input — the step can't be safely replayed from
 *  the cached output alone).
 *
 *  Sibling to `./structural.ts`. Together they detect whether an
 *  audit-grow candidate is render_template-eligible:
 *
 *    - `structural.ts` ── step-sequence shape check (any non-
 *      deterministic step kind disqualifies)
 *    - `diff.ts`       ── per-`ai-*`-step output reproducibility check
 *
 *  A sequence whose structural check passes can short-circuit at gate
 *  time (no LLM call needed). The diff check is **not** a cache-
 *  eligibility gate for `structural_plan` — per design O-6, structural
 *  plans always replay through the main executor / gateway / audit /
 *  approval path and cache only the PLAN (the routing decision), not
 *  the LLM output. The diff signal exists for the promotion UX and
 *  future drift-detection tooling:
 *
 *    - **Promotion-UX hint.** When the audit-grow promotion dialog
 *      surfaces a candidate with `ai-*` steps, every `ai-*` step
 *      that classifies as `'stable_replay'` is a candidate for
 *      manual rewrite into a deterministic `transform` step ("this
 *      LLM call is purely extractive — consider replacing it"). The
 *      user makes the call; the classifier just surfaces the signal.
 *    - **Drift detection.** A previously-stable step that begins
 *      classifying as `'freeform_hole'` over a rolling window is a
 *      model-behavior change worth flagging (the prompt may be
 *      fragile, or the model may have updated).
 *
 *  The check is intentionally a SIGNAL, not a proof. False stables
 *  (output happens to share tokens with input by coincidence) and
 *  false freeforms (LLM paraphrased the input — semantically stable
 *  but textually divergent) both occur. The replayability folder is
 *  the audit-grow promotion UI's input, not the gate's hard
 *  predicate; the validator's job is enforcing the render_template
 *  contract at registration time (lands with P4h-4 store + validator).
 *
 *  Algorithm:
 *
 *    1. Canonicalize input + output via `canonicalJSONStringify` —
 *       same source-of-truth canonicalizer the bundle hash + audit
 *       signing pipelines use. Key-sorted, no whitespace, stable
 *       byte sequence.
 *    2. Tokenize the canonical OUTPUT on whitespace + JSON-structural
 *       chars (`{ } [ ] , :`). Double-quote chars are NOT delimiters
 *       — a quoted string literal canonicalizes to a single token
 *       like `"john@example.com"` and matches input occurrences
 *       verbatim.
 *    3. Filter output tokens by length ≥ `novel_token_min_length`
 *       (default 3). Length here is the POST-TOKENIZATION token's own
 *       length, not the length of the source value — a JSON-canonical
 *       2-char string like `"ab"` is a 4-char token (the surrounding
 *       quotes survive tokenization) and passes the filter. The
 *       filter skips bare 1-2 char tokens like `0` / `1` / 2-char
 *       numeric ids that coincide too easily across unrelated inputs.
 *    4. For each remaining token, check `canonicalInput.includes(token)`.
 *       If every token appears in the canonical input → stable_replay.
 *       Otherwise the unmatched tokens are reported as `novel_tokens`
 *       and the kind is `freeform_hole`.
 *
 *  Caller contracts:
 *
 *  - **`input` + `output` must be JSON-clean.** `canonicalJSONStringify`
 *    throws on top-level `undefined`; we propagate. BigInt values
 *    throw downstream (the lenient canonicalizer surfaces the platform
 *    error). For top-level **function / symbol** values the lenient
 *    canonicalizer returns the raw `undefined` value (mirrors
 *    `JSON.stringify`'s behavior) — the classifier defends against
 *    that by re-raising a `TypeError` if either side canonicalizes to
 *    a non-string, so the audit-grow flow surfaces the upstream bug
 *    instead of silently classifying a function-value input as
 *    `'stable_replay'` (a worst-case false stable). Callers handing
 *    arbitrary JS values must pre-clean or expect a throw.
 *
 *  - **`novel_token_min_length` must be a positive integer.** Values
 *    `<= 0` or non-integers throw `RangeError`. The default is 3 —
 *    enough to skip JSON noise without missing typical extracted
 *    values (emails, dates, names). Power callers can tighten to 1
 *    for full-fidelity matching or loosen to a larger value for
 *    longer-token-only signal.
 *
 *  - **Dedup + first-seen order on `novel_tokens`.** Mirrors
 *    `structural.ts`'s `disqualifying_step_kinds` contract so the
 *    Kitchen UI can render a deterministic explanation ("LLM produced
 *    novel tokens: Hello, world"). Repeated tokens collapse to one
 *    entry.
 *
 *  - **Single-pair primitive.** Multi-observation stability (across
 *    repeated calls with the same input) is a higher-level concern.
 *    Callers wanting that compose this primitive: hash the canonical
 *    input, bucket observations, run the diff over each bucket's
 *    representative pair, aggregate.
 *
 *  Known limitations (documented; not bugs):
 *
 *  - **Paraphrase blindness.** An LLM that semantically preserves
 *    input but rewords the output ("john@example.com" → "the email
 *    is john@example.com") will be flagged freeform_hole by the
 *    substring check. The substring check is a CONSERVATIVE signal —
 *    false freeforms are safer than false stables (the worst outcome
 *    of a false freeform is the user doesn't get a promotion suggestion;
 *    the worst outcome of a false stable is a Kitchen UI suggestion
 *    that wouldn't actually replay correctly).
 *
 *  - **String-vs-object input asymmetry.** A raw string input that
 *    contains JSON escapes inside (e.g. `'"{\\"name\\":\\"John\\"}"'`)
 *    canonicalizes differently from the equivalent object input
 *    (`'{"name":"John"}'`). The token `"John"` IS a substring of the
 *    second but NOT a contiguous substring of the first (the
 *    intervening `\` breaks the run). This is rare in practice —
 *    audit-grow captures live function-argument shapes, not their
 *    JSON-string forms — but flagged here as a known sharp edge.
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md
 *  § 1 templates/audit-grow/replayability + § 3 Invariant 2 + O-6. */

import { canonicalJSONStringify } from '@recued/crypto';

/** Default minimum token length the classifier considers "novel". A
 *  token shorter than this is treated as JSON-noise / coincidence-
 *  prone and skipped from the novel-token check. Three is a
 *  conservative default — long enough to skip `0` / `1` / 2-char ids,
 *  short enough to surface typical extracted values (3-char domains,
 *  short identifiers). Power callers can override per-call. */
export const DEFAULT_NOVEL_TOKEN_MIN_LENGTH = 3;

/** Regex matching one-or-more delimiter characters. Whitespace +
 *  JSON-structural chars (`{ } [ ] , :`). Double-quote chars are NOT
 *  delimiters so quoted string literals (`"john@example.com"`)
 *  survive as one token and match canonical-input occurrences
 *  verbatim. Escape chars (`\\`) likewise not delimited — a string
 *  with an escape mid-content stays one token. */
const TOKEN_DELIMITER_REGEX = /[\s{}[\],:]+/u;

/** Discriminator on `DiffClassification.kind`.
 *
 *  - `'stable_replay'` — every output token of length >= threshold is
 *    a substring of the canonical input. The audit-grow consumer can
 *    treat the captured output as replay-safe (cache it; replay
 *    without re-calling the LLM).
 *  - `'freeform_hole'` — the LLM produced at least one substantial
 *    token not present in the canonical input. Replay must go through
 *    the real LLM path; the captured output is a one-shot. */
export type DiffKind = 'stable_replay' | 'freeform_hole';

/** Input to `classifyReplayDiff`. Wrapping shape so the option set
 *  can grow additively (semantic-equivalence mode, paraphrase
 *  tolerance, etc.) without breaking callers. */
export interface ClassifyDiffInput {
  /** The recorded LLM call's input argument (canonicalized via
   *  `canonicalJSONStringify` before tokenization). */
  readonly input: unknown;
  /** The recorded LLM call's output value (canonicalized + tokenized
   *  + checked against the canonical input). */
  readonly output: unknown;
  /** Override the default minimum token length. See
   *  `DEFAULT_NOVEL_TOKEN_MIN_LENGTH`. */
  readonly novel_token_min_length?: number;
}

/** Output of `classifyReplayDiff`. Discriminated on `kind`. */
export interface DiffClassification {
  readonly kind: DiffKind;
  /** Tokens of length >= threshold that appear in the canonical
   *  output but NOT in the canonical input. Deduplicated, first-seen
   *  order. Empty when `kind === 'stable_replay'`. */
  readonly novel_tokens: ReadonlyArray<string>;
}

/** Shared frozen empty array for the stable_replay happy path so the
 *  classifier doesn't allocate a fresh empty list per call. Mirrors
 *  `structural.ts`'s `EMPTY_DISQUALIFYING` pattern. */
const EMPTY_NOVEL_TOKENS: ReadonlyArray<string> = Object.freeze(
  [] as readonly string[],
);

/** Classify a single (input, output) pair's replay-diff. See module
 *  header for the algorithm, caller contracts, and known limitations. */
export const classifyReplayDiff = (
  input: ClassifyDiffInput,
): DiffClassification => {
  const minLen =
    input.novel_token_min_length ?? DEFAULT_NOVEL_TOKEN_MIN_LENGTH;
  if (!Number.isInteger(minLen) || minLen < 1) {
    throw new RangeError(
      `classifyReplayDiff: novel_token_min_length must be a positive integer, got ${JSON.stringify(
        input.novel_token_min_length,
      )}`,
    );
  }

  const canonInput = canonicalJSONStringify(input.input);
  const canonOutput = canonicalJSONStringify(input.output);

  if (typeof canonInput !== 'string') {
    throw new TypeError(
      `classifyReplayDiff: input canonicalized to non-string (typeof = ${typeof canonInput}); top-level function/symbol values cannot be classified`,
    );
  }
  if (typeof canonOutput !== 'string') {
    throw new TypeError(
      `classifyReplayDiff: output canonicalized to non-string (typeof = ${typeof canonOutput}); top-level function/symbol values cannot be classified`,
    );
  }

  const outputTokens = canonOutput.split(TOKEN_DELIMITER_REGEX);

  const seen = new Set<string>();
  const novel: string[] = [];
  for (const token of outputTokens) {
    if (token.length < minLen) continue;
    if (canonInput.includes(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    novel.push(token);
  }

  if (novel.length === 0) {
    return Object.freeze({
      kind: 'stable_replay' as const,
      novel_tokens: EMPTY_NOVEL_TOKENS,
    });
  }

  return Object.freeze({
    kind: 'freeform_hole' as const,
    novel_tokens: Object.freeze(novel as readonly string[]),
  });
};
