/** Dotted-path glob matcher.
 *
 *  Rules:
 *    - `*`   matches exactly one dotted segment.
 *    - `**`  matches zero or more dotted segments.
 *    - Everything else is a literal segment.
 *
 *  Designed for the warehouse-event path convention
 *  `data.{platform}.{slug}.{entity_type}.{event_kind}`. */

/** D-179 P4 — reserved platform for run-outcome events. Paths in this
 *  family drop the `data.` prefix: `run.{slug}.{entity_type}.{kind}`
 *  = `run.<recipe_id>.<dish_id>.<completed|failed>` — a dedicated
 *  non-`data` bus family (fork (d)), so handler dishes subscribe to
 *  outcomes (`run.my-sweeper.*.failed`) without widening the `data.*`
 *  trigger grammar past collections. Server-internal emit only. */
export const RUN_OUTCOME_PLATFORM = 'run';

export const eventPath = (
  platform: string,
  slug: string,
  entityType: string,
  kind: string,
): string =>
  platform === RUN_OUTCOME_PLATFORM
    ? `run.${slug}.${entityType}.${kind}`
    : `data.${platform}.${slug}.${entityType}.${kind}`;

export const matchesPattern = (pattern: string, path: string): boolean => {
  const pParts = pattern.split('.');
  const qParts = path.split('.');
  return matchSegments(pParts, qParts, 0, 0);
};

/** Returns true when `pattern` parses as a valid subscribe expression.
 *  A valid pattern is a non-empty, dot-delimited set of segments where
 *  each segment is either a `*` / `**` wildcard or a non-empty literal
 *  of `[a-zA-Z0-9_-]+`. Empty segments (`data..email`) and pure
 *  whitespace reject — those would match nothing anyway and usually
 *  indicate a user typo. Used by the triggers rpc to validate
 *  user input before persisting. */
export const isValidPattern = (pattern: string): boolean => {
  if (typeof pattern !== 'string' || pattern.length === 0) return false;
  const parts = pattern.split('.');
  for (const seg of parts) {
    if (seg === '*' || seg === '**') continue;
    if (seg.length === 0) return false;
    if (!/^[A-Za-z0-9_-]+$/.test(seg)) return false;
  }
  return true;
};

const matchSegments = (
  p: readonly string[],
  q: readonly string[],
  pi: number,
  qi: number,
): boolean => {
  while (pi < p.length) {
    const seg = p[pi];
    if (seg === '**') {
      if (pi === p.length - 1) return true;
      for (let k = qi; k <= q.length; k++) {
        if (matchSegments(p, q, pi + 1, k)) return true;
      }
      return false;
    }
    if (qi >= q.length) return false;
    if (seg === '*' || seg === q[qi]) { pi++; qi++; continue; }
    return false;
  }
  return qi === q.length;
};
