/** D-192 file SOURCE family (slice 6) — the `import_scope` escape hatch (Fork A).
 *
 *  A file mirror defaults to FULL (Fork A: meta is tiny, so there's no reason
 *  to window by recency the way mail's `backfill_days` does). The *cost* is
 *  list-API call volume + rate limits, not storage — so a Source may carry an
 *  OPTIONAL user-declared path glob/prefix that scopes the mirror to a subtree
 *  (a pathological 1M-object bucket, an enterprise SharePoint, or just to
 *  exclude a giant folder). Default full; glob available.
 *
 *  This is the pure, vendor-agnostic half of the escape hatch — the §0
 *  "generalizing part" written ONCE:
 *
 *   - {@link deriveScopePrefix} — the literal leading prefix of the glob (every
 *     char up to the first wildcard). A SAFE under-approximation: every path
 *     the glob can match starts with it, so a vendor whose list API takes a
 *     server-side prefix (`FileScope.supports_prefix`) can push it down (S3
 *     `Prefix`; Dropbox translates it to a parent folder) and NEVER drop an
 *     in-scope file — the client-side matcher below narrows the rest.
 *   - {@link compileImportScope} — the client-side matcher. A glob with no
 *     wildcard is a prefix/exact match (a bare folder or file path); a glob
 *     with wildcards matches segment-by-segment, ROOT-ANCHORED (a `Work/**`
 *     scope must match `Work/a` but NOT `Other/Work/a`), via a LINEAR two-
 *     pointer (no regex → no ReDoS on an adversarial glob). The reconcile
 *     runner filters each walked row's path through it, so the mirror holds
 *     exactly the in-scope subtree regardless of whether the vendor honored
 *     the pushdown.
 *   - {@link normalizeScopePath} — strips a single leading `/` so a user glob
 *     matches BOTH an S3 `Key` (no leading `/`: `Work/a.pdf`) and a Dropbox
 *     `path_display` (leading `/`: `/Work/a.pdf`) uniformly.
 *
 *  The per-vendor "what can't generalize" half — translating the derived
 *  literal prefix into the vendor's own list-API scope param — lives in the
 *  adapter leaf (`backend/server/src/file-source-adapters/`). Bytes are NEVER
 *  fetched (North star); this only bounds which metadata rows are mirrored.
 *
 *  Design: `docs/d-192-file-source-family.md` (Fork A); taxonomy §0. */

/** Cap on a raw `import_scope` glob — aligned with `FILE_META_PATH_MAX` (a
 *  full vendor-tree path can be deep). Over-cap fails closed (a malformed
 *  scope must not silently mirror everything). */
export const IMPORT_SCOPE_GLOB_MAX = 1024;

/** The glob metacharacters the {@link compileImportScope} matcher treats
 *  specially — `*` (any run within a segment / `**` across whole segments) and
 *  `?` (one char within a segment). `[` is deliberately NOT a wildcard here (it
 *  matches literally), so it neither triggers the wildcard path nor cuts the
 *  derived prefix — keeping prefix derivation and matching in lock step. */
const SCOPE_WILDCARD_RE = /[*?]/;

export interface ImportScope {
  /** The user's glob, normalized (a single leading `/` stripped; `/`-separated).
   *  Empty is never stored — an empty/whitespace config resolves to `null`
   *  (no scope) at {@link parseImportScopeConfig}. */
  glob: string;
  /** The literal leading path prefix — every character up to (not including)
   *  the first wildcard. A safe under-approximation of the glob, pushed to a
   *  prefix-capable vendor list API. `''` = root (no pushdown). */
  prefix: string;
}

/** Strip a single leading `/` so an S3 `Key` and a Dropbox `path_display`
 *  compare against the same user glob. Idempotent on an already-relative path. */
export const normalizeScopePath = (p: string): string => (p.startsWith('/') ? p.slice(1) : p);

/** The literal leading prefix of a glob — every char up to the first `*`/`?`.
 *  A no-wildcard glob is entirely literal, so the whole (normalized) string is
 *  the prefix. Every path the glob matches starts with this, so it is a safe
 *  server-side-prefix pushdown (never excludes an in-scope file). */
export const deriveScopePrefix = (glob: string): string => {
  const g = normalizeScopePath(glob);
  const m = SCOPE_WILDCARD_RE.exec(g);
  return m ? g.slice(0, m.index) : g;
};

/** Build an {@link ImportScope} from a raw user glob (normalizing + deriving
 *  the prefix). Callers that already have a validated glob string. */
export const buildImportScope = (glob: string): ImportScope => {
  const g = normalizeScopePath(glob);
  return { glob: g, prefix: deriveScopePrefix(g) };
};

/** Parse a connection config's `import_scope` field into an {@link ImportScope}
 *  or `null` (no scope → full mirror). Fail-closed: a non-string or over-cap
 *  value is an ERROR (the leaf surfaces it as a stable `config` outcome), never
 *  a silent full mirror. Absent / empty / whitespace-only → `{ scope: null }`. */
export const parseImportScopeConfig = (
  raw: unknown,
): { ok: true; scope: ImportScope | null } | { ok: false; reason: string } => {
  if (raw === undefined || raw === null) return { ok: true, scope: null };
  if (typeof raw !== 'string') return { ok: false, reason: 'import_scope must be a string glob' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, scope: null };
  if (trimmed.length > IMPORT_SCOPE_GLOB_MAX) {
    return { ok: false, reason: `import_scope exceeds ${IMPORT_SCOPE_GLOB_MAX} chars` };
  }
  return { ok: true, scope: buildImportScope(trimmed) };
};

/** Match one path SEGMENT (no `/`) against one pattern segment with `*` (any
 *  run) + `?` (one char). The classic two-pointer wildcard match: linear —
 *  `starIdx`/`starJ` advance MONOTONICALLY, so there is NO catastrophic
 *  backtracking (a `*a*a*a…` pattern can't blow up the way a naive regex does).
 *  Runs per walked row, so worst-case matters. */
const matchOneSegment = (pat: string, seg: string): boolean => {
  let i = 0;
  let j = 0;
  let star = -1;
  let starJ = 0;
  while (j < seg.length) {
    if (i < pat.length && (pat[i] === '?' || pat[i] === seg[j])) {
      i += 1;
      j += 1;
    } else if (i < pat.length && pat[i] === '*') {
      star = i;
      starJ = j;
      i += 1; // try `*` = empty first
    } else if (star !== -1) {
      i = star + 1; // backtrack: let the last `*` absorb one more char
      j = starJ + 1;
      starJ += 1;
    } else {
      return false;
    }
  }
  while (i < pat.length && pat[i] === '*') i += 1;
  return i === pat.length;
};

/** Match a `/`-split path against a `/`-split glob. A `**` segment matches ZERO
 *  or more path segments (the globstar); every other segment matches EXACTLY
 *  one path segment via {@link matchOneSegment}. Root-anchored by construction
 *  (both fully consumed). Segment-level two-pointer — `starPath` advances
 *  monotonically, so this is O(patternSegs × pathSegs), never exponential. */
const matchSegments = (patternSegs: readonly string[], pathSegs: readonly string[]): boolean => {
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = 0;
  while (s < pathSegs.length) {
    if (p < patternSegs.length && patternSegs[p] === '**') {
      starP = p; // remember the globstar (matches zero segments first)
      starS = s;
      p += 1;
    } else if (p < patternSegs.length && patternSegs[p] !== '**' && matchOneSegment(patternSegs[p], pathSegs[s])) {
      p += 1;
      s += 1;
    } else if (starP !== -1) {
      p = starP + 1; // backtrack: let the globstar absorb one more segment
      s = starS + 1;
      starS += 1;
    } else {
      return false;
    }
  }
  // The path is consumed. A TERMINAL `**` scopes to a NON-EMPTY subtree ("under
  // this folder"), so it must have absorbed ≥1 segment via the bookmark above —
  // a `**` still sitting FRESH at `p` here matched ZERO segments (the bare-prefix
  // case: `Work/**` vs the sibling `Work`) and is REJECTED. This keeps the
  // matcher consistent with the `scope.prefix` (`Work/`) that the API pushdown +
  // the stored-path delete diff use, so a path is in the matcher's scope iff its
  // key is under the walked prefix.
  return p === patternSegs.length;
};

export interface CompiledImportScope {
  readonly scope: ImportScope;
  /** True when a (raw, un-normalized) path is within the scope. Normalizes the
   *  path internally, so callers pass the vendor's path verbatim. */
  matches(path: string): boolean;
}

/** Compile an {@link ImportScope} into a reusable matcher — the pattern is
 *  split ONCE, so the reconcile runner filters a whole walk cheaply. Every form
 *  agrees on the FOLDER boundary the `scope.prefix` (hence the API pushdown +
 *  delete diff) uses, so a path is in the matcher's scope iff its key is under
 *  the walked prefix:
 *   - a bare name (`Work`) — directory-prefix OR exact match: `Work` itself or
 *     anything under `Work/`;
 *   - a trailing-slash / `**` form (`Work/`, `Work/**`) — STRICTLY under
 *     `Work/` (the sibling file `Work` is out of scope);
 *   - a wildcard glob matches segment-by-segment (`**` = any depth, `*`/`?`
 *     within a segment), always root-anchored (`Work/**` matches `Work/a`, not
 *     `Other/Work/a`).
 *  Linear (no regex → no ReDoS on an adversarial glob). */
export const compileImportScope = (scope: ImportScope): CompiledImportScope => {
  const g = normalizeScopePath(scope.glob);
  if (!SCOPE_WILDCARD_RE.test(g)) {
    if (g.length === 0) return { scope, matches: () => true }; // empty ⇒ match all
    if (g.endsWith('/')) {
      // Trailing slash ⇒ STRICTLY under the folder (matches `startsWith(prefix)`
      // — the sibling file named exactly `base` is out of scope).
      return { scope, matches: (path: string): boolean => normalizeScopePath(path).startsWith(g) };
    }
    // No slash ⇒ the exact path OR anything under it (`Work` = the file `Work`
    // or the `Work/` subtree).
    return {
      scope,
      matches: (path: string): boolean => {
        const p = normalizeScopePath(path);
        return p === g || p.startsWith(`${g}/`);
      },
    };
  }
  // Drop a trailing `/` (`Work/**/` → `Work/**`) so it never yields a trailing
  // empty segment that a real file path can't match.
  const trimmed = g.endsWith('/') ? g.slice(0, -1) : g;
  const patternSegs = trimmed.split('/');
  return {
    scope,
    matches: (path: string): boolean =>
      matchSegments(patternSegs, normalizeScopePath(path).split('/')),
  };
};
