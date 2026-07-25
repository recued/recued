/** D-160 P1 — `Capacity`, the framework's capability + cost-ceiling
 *  envelope primitive (§ N.4).
 *
 *  `Capacity` is the envelope a stream — or a middleware's `config`
 *  hook — declares. P1 firms it (D-160 O-1 left the exact shape open):
 *  a hard turn ceiling, an optional token-spend ceiling, and an
 *  optional capability set. The pipeline enforces the two cost
 *  ceilings — it refuses to start a turn the envelope can no longer
 *  afford; the capability set is carried + combined here and consumed
 *  by middlewares / the gateway, not gated by the turn loop itself.
 *
 *  A middleware may only ever *narrow* the envelope (`narrowCapacity`
 *  takes the element-wise minimum / set intersection); it can never
 *  widen what the stream or another middleware already declared. A
 *  ceiling is a floor on caution, not a knob a later contributor can
 *  relax — the pipeline re-narrows a `config` hook's result against
 *  the request envelope so the guarantee holds even for a buggy hook.
 *
 *  Naming note — this `Capacity` envelope is distinct from the D-145
 *  recipe `capacity_spec` walker in `./capacity/` (the per-recipe
 *  prerequisite-probe subsystem, exported from the barrel as the
 *  `capacity` namespace). The two coexist deliberately: the walker
 *  answers "is this recipe's prerequisite met?"; this envelope answers
 *  "how much may this stream spend, and what may it use?".
 *
 *  Spec: docs/d-160-spec.md § N.4 / A.1 / A.2 / O-1.
 */

/** The capability + cost-ceiling envelope a stream runs within. */
export interface Capacity {
  /** Hard ceiling on turns in one stream. The pipeline runs at most
   *  this many turns, then ends the stream as `capacity_exhausted`.
   *  Always ≥ 1 — at least one turn is always attempted. */
  readonly max_turns: number;
  /** Optional ceiling on total tokens spent across the stream. When
   *  set, the pipeline will not start a turn once cumulative spend has
   *  reached it. Omitted ⇒ no token ceiling. */
  readonly token_ceiling?: number;
  /** Optional capability set — the closed list of capability tags the
   *  stream is allowed to use (§ N.4's "capability" half). `undefined`
   *  ⇒ no capability restriction declared; an explicit array ⇒ exactly
   *  those tags (an empty array ⇒ nothing). The turn loop does not gate
   *  on this — capability *consumption* is a middleware / gateway
   *  concern; the envelope carries the set and `narrowCapacity`
   *  combines it. */
  readonly capabilities?: readonly string[];
}

/** Default turn ceiling when a stream declares no `max_turns`. Sized
 *  for an ordinary tool-calling conversation — generous enough that a
 *  multi-round loop completes, tight enough to bound a runaway. */
export const DEFAULT_MAX_TURNS = 8;

/** Running spend a `Capacity` is checked against. */
export interface CapacityUsage {
  /** Turns already completed in the stream. */
  readonly turns: number;
  /** Tokens already spent, if the turn executor reports them. */
  readonly tokens?: number;
}

/** Which ceiling a usage breached — or `null` when within envelope. */
export type CapacityBreach = 'max_turns' | 'token_ceiling' | null;

const isPositiveInt = (n: number): boolean =>
  Number.isInteger(n) && n >= 1;

const isCapabilityList = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((c) => typeof c === 'string');

/** Stable dedupe — first-seen order preserved. */
const dedupe = (list: readonly string[]): readonly string[] => [
  ...new Set(list),
];

/** Intersect two capability sets. `undefined` means "no restriction
 *  declared" — intersecting it with a defined set adopts that set;
 *  intersecting two defined sets keeps only the tags present in both,
 *  so a contributor can only ever *remove* a capability, never add
 *  one. */
const intersectCapabilities = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): readonly string[] | undefined => {
  if (a === undefined) return b === undefined ? undefined : dedupe(b);
  if (b === undefined) return dedupe(a);
  const bSet = new Set(b);
  return dedupe(a).filter((c) => bSet.has(c));
};

/** Build a validated `Capacity` from a partial declaration. Missing
 *  `max_turns` falls back to `DEFAULT_MAX_TURNS`; an invalid ceiling or
 *  capability list throws rather than silently clamping — a malformed
 *  envelope is a caller bug, not something to paper over. */
export const createCapacity = (partial?: Partial<Capacity>): Capacity => {
  const max_turns = partial?.max_turns ?? DEFAULT_MAX_TURNS;
  if (!isPositiveInt(max_turns)) {
    throw new RangeError(
      `Capacity.max_turns must be a positive integer; got ${String(max_turns)}`,
    );
  }
  const token_ceiling = partial?.token_ceiling;
  if (token_ceiling !== undefined && !isPositiveInt(token_ceiling)) {
    throw new RangeError(
      `Capacity.token_ceiling must be a positive integer when set; got ${String(
        token_ceiling,
      )}`,
    );
  }
  const capabilities = partial?.capabilities;
  if (capabilities !== undefined && !isCapabilityList(capabilities)) {
    throw new TypeError(
      'Capacity.capabilities must be an array of strings when set',
    );
  }
  return {
    max_turns,
    ...(token_ceiling !== undefined ? { token_ceiling } : {}),
    ...(capabilities !== undefined
      ? { capabilities: dedupe(capabilities) }
      : {}),
  };
};

/** Narrow an envelope by a contribution — element-wise minimum for the
 *  cost ceilings, set intersection for capabilities. A middleware's
 *  `config` hook tightens the stream's `Capacity` through this; it can
 *  never loosen it. An absent cost field in the contribution leaves
 *  that dimension unchanged; a present one wins only when smaller. A
 *  narrowed cost ceiling that is no longer a positive integer throws —
 *  the validation `createCapacity` applies holds for the result of a
 *  narrow too. */
export const narrowCapacity = (
  base: Capacity,
  contribution: Partial<Capacity>,
): Capacity => {
  const max_turns =
    contribution.max_turns === undefined
      ? base.max_turns
      : Math.min(base.max_turns, contribution.max_turns);
  if (!isPositiveInt(max_turns)) {
    throw new RangeError(
      `narrowCapacity produced an invalid max_turns (${String(max_turns)}) — ` +
        'a contribution must narrow to a positive integer',
    );
  }
  const ceilings = [base.token_ceiling, contribution.token_ceiling].filter(
    (c): c is number => c !== undefined,
  );
  const token_ceiling = ceilings.length > 0 ? Math.min(...ceilings) : undefined;
  if (token_ceiling !== undefined && !isPositiveInt(token_ceiling)) {
    throw new RangeError(
      `narrowCapacity produced an invalid token_ceiling (${String(
        token_ceiling,
      )}) — a contribution must narrow to a positive integer`,
    );
  }
  const capabilities = intersectCapabilities(
    base.capabilities,
    contribution.capabilities,
  );
  return {
    max_turns,
    ...(token_ceiling !== undefined ? { token_ceiling } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
  };
};

/** The ceiling a usage has reached, or `null` when still within the
 *  envelope. The pipeline calls this after a turn, once a middleware
 *  has requested another — a non-null result means the envelope cannot
 *  afford the next turn and the stream ends `capacity_exhausted`. `>=`
 *  not `>`: reaching a ceiling refuses the *next* turn (the
 *  just-completed turn was started within the envelope). */
export const capacityBreach = (
  usage: CapacityUsage,
  capacity: Capacity,
): CapacityBreach => {
  if (usage.turns >= capacity.max_turns) return 'max_turns';
  if (
    capacity.token_ceiling !== undefined &&
    usage.tokens !== undefined &&
    usage.tokens >= capacity.token_ceiling
  ) {
    return 'token_ceiling';
  }
  return null;
};
