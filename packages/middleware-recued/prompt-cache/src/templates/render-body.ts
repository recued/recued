/** D-164 P4f — template body interpolation.
 *
 *  Pure deterministic substitution of `{{path}}` placeholders against a
 *  `DataSnapshot`. The renderer is strict by design (design § 3
 *  Invariant 7 — safe small gains): any missing path / non-string value
 *  throws synchronously. The caller-facing seam (`../index.ts`'s
 *  `TemplateRenderer` adapter) catches those throws and translates to
 *  the gate's `empty-render` pass-through; runtime throws are a
 *  validator bug, never user-visible.
 *
 *  Body grammar:
 *    - Placeholder syntax: `{{path}}` — two opening braces, a dot-path,
 *      two closing braces. Whitespace inside is trimmed (`{{ contact.name }}`
 *      resolves identically to `{{contact.name}}`).
 *    - Path: one-or-more dot-separated segments. Each segment matches
 *      `[A-Za-z_][A-Za-z0-9_]*`. Array indices are NOT supported (out
 *      of scope for this slice — adding `[N]` syntax is additive).
 *    - Anything else is literal text, copied through verbatim. The body
 *      may contain newlines, leading/trailing whitespace, etc.
 *
 *  Resolution:
 *    - `extractPlaceholderPaths(body)` is a pure utility — returns each
 *      `{{path}}` occurrence in order, with its trimmed path. Library /
 *      store code uses it to pre-validate templates at registration.
 *    - `renderRenderTemplate(template, snapshot)` walks the body, looks
 *      up each placeholder's path in `snapshot.data`, and emits the
 *      rendered string. Throws `TemplateRenderError` on any failure
 *      (missing path, non-string value, malformed placeholder) — the
 *      `template_hash` rides on the error so callers can correlate.
 *
 *  Why throw-on-failure rather than silent skip: silent placeholder
 *  drop would surface as a degraded answer (`"Bob's email is "` instead
 *  of `"Bob's email is bob@example.com"`) — exactly the kind of
 *  false-positive the design's safe-small-gains rule blocks. Throwing
 *  forces the caller-seam adapter to fall back to LLM via pass-through;
 *  the user gets a correct answer one turn later instead of a wrong one
 *  immediately.
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md
 *  § 1 templates / § 3 Invariant 6 (render-snapshot freeze) / § 3
 *  Invariant 7 (safe small gains). */

import type { DataSnapshot } from '../gate/data-presence.js';
import type { RenderTemplate } from '../types.js';

/** Matches `{{path}}` with whitespace allowed inside. Each segment of
 *  `path` (between dots) must be a JS-identifier-shaped token. The
 *  global flag drives the replacement loop. */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g;

/** Forbidden path segments that would otherwise expose JavaScript's
 *  prototype chain via dot-walk. The grammar's `[A-Za-z_]` lead would
 *  admit `__proto__` / `constructor` / `prototype` as valid identifier
 *  tokens; the resolver blocks them explicitly so `{{__proto__.X}}`
 *  can't reach `Object.prototype.X`.
 *
 *  Exported so the bundle validator (`./bundle/validate.ts`) can
 *  reject placeholders containing these segments at registration time
 *  — a stronger guarantee than relying on runtime resolver guards. */
export const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** Error thrown when the renderer can't produce a clean rendered string.
 *  Carries `template_hash` + the placeholder path that failed so the
 *  caller can log + drop the template from its cache. */
export class TemplateRenderError extends Error {
  readonly template_hash: string;
  readonly path: string;
  readonly reason: 'missing_path' | 'non_string_value' | 'malformed_placeholder';

  constructor(opts: {
    readonly template_hash: string;
    readonly path: string;
    readonly reason: 'missing_path' | 'non_string_value' | 'malformed_placeholder';
    readonly message: string;
  }) {
    super(opts.message);
    this.name = 'TemplateRenderError';
    this.template_hash = opts.template_hash;
    this.path = opts.path;
    this.reason = opts.reason;
  }
}

/** Resolve a dot-path against `data`, returning the value at that path
 *  or `undefined` when any segment is missing / non-object / forbidden.
 *  Pure; no array-index handling (out of scope this slice — `paths[0]`
 *  doesn't parse as a valid placeholder anyway).
 *
 *  Prototype-pollution guards (defense in depth):
 *    - Each segment is checked against `FORBIDDEN_SEGMENTS` first; any
 *      hit returns undefined immediately (`{{__proto__.X}}` can't even
 *      reach the prototype chain).
 *    - Each lookup uses `Object.prototype.hasOwnProperty.call` so
 *      inherited keys (set via prototype manipulation upstream) are not
 *      readable through the placeholder grammar. */
const resolvePath = (
  data: Readonly<Record<string, unknown>>,
  path: string,
): unknown => {
  const segments = path.split('.');
  let cursor: unknown = data;
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return undefined;
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
};

/** Enumerate every `{{path}}` placeholder in `body` in source order.
 *  Returns the trimmed path per occurrence (duplicates preserved). Pure
 *  utility — library / store code uses this to pre-validate templates
 *  at registration without running the full renderer. */
export const extractPlaceholderPaths = (body: string): ReadonlyArray<string> => {
  PLACEHOLDER_RE.lastIndex = 0;
  const paths: string[] = [];
  let match = PLACEHOLDER_RE.exec(body);
  while (match !== null) {
    const path = match[1];
    if (path !== undefined) paths.push(path);
    if (match.index === PLACEHOLDER_RE.lastIndex) PLACEHOLDER_RE.lastIndex += 1;
    match = PLACEHOLDER_RE.exec(body);
  }
  return paths;
};

/** Detect a `{{...}}` substring that the strict placeholder regex
 *  REJECTS — empty path, dashes, leading digits, array indices, nested
 *  braces, unclosed openers. Returns the first malformed occurrence as
 *  raw text + position, or `null` when every `{{...}}` span is well-
 *  formed.
 *
 *  Algorithm (character-level scanner, NOT regex-based):
 *    1. Walk `body` character by character.
 *    2. On `{{`, enter "in-placeholder" mode and scan forward for the
 *       matching `}}`. Any `{` encountered before `}}` marks the
 *       whole placeholder span as MALFORMED (covers `{{{{foo}}}}` /
 *       `{{a{b}}` — earlier regex-only check wrongly accepted these
 *       by skipping outer brace runs).
 *    3. No matching `}}` before end-of-string → MALFORMED. A body
 *       ending in a lone `{` is also MALFORMED; that shape is almost
 *       certainly an attempted placeholder typo, not useful literal
 *       output.
 *    4. On finding `}}`, validate the FULL `{{...}}` span against
 *       `PLACEHOLDER_RE`. If the strict regex's `[0]` doesn't cover
 *       the entire span → MALFORMED.
 *    5. Otherwise advance past `}}` and continue.
 *
 *  The scanner is the only correctness gate for malformed placeholders;
 *  `renderRenderTemplate` calls it once before the strict-regex
 *  replacement loop. */
const findMalformedPlaceholder = (
  body: string,
): { readonly raw: string; readonly position: number } | null => {
  let i = 0;
  const end = body.length;
  while (i < end) {
    if (body[i] !== '{') {
      i += 1;
      continue;
    }
    if (i + 1 >= end) {
      return { raw: body.slice(i), position: i };
    }
    if (body[i + 1] !== '{') {
      i += 1;
      continue;
    }
    const start = i;
    i += 2;
    let closeIdx = -1;
    let sawNestedOpen = false;
    while (i < end - 1) {
      if (body[i] === '{') {
        sawNestedOpen = true;
      }
      if (body[i] === '}' && body[i + 1] === '}') {
        closeIdx = i;
        break;
      }
      i += 1;
    }
    if (closeIdx === -1) {
      return { raw: body.slice(start), position: start };
    }
    if (sawNestedOpen) {
      let rawEnd = closeIdx + 2;
      while (rawEnd < end && body[rawEnd] === '}') rawEnd += 1;
      return { raw: body.slice(start, rawEnd), position: start };
    }
    const span = body.slice(start, closeIdx + 2);
    PLACEHOLDER_RE.lastIndex = 0;
    const strict = PLACEHOLDER_RE.exec(span);
    if (strict === null || strict[0] !== span) {
      return { raw: span, position: start };
    }
    i = closeIdx + 2;
  }
  return null;
};

/** Render a `RenderTemplate` against a `DataSnapshot`. Pure function —
 *  same inputs → same output. Throws `TemplateRenderError` on:
 *    - a malformed `{{...}}` placeholder (path didn't match the strict
 *      grammar);
 *    - a placeholder whose path doesn't resolve in `snapshot.data`;
 *    - a placeholder whose path resolves to a non-string value.
 *
 *  The caller-facing seam (`../index.ts` `TemplateRenderer` adapter)
 *  catches these to drive the gate's pass-through; this function itself
 *  reports failures loudly so tests + audit logs can spot a bad template. */
export const renderRenderTemplate = (
  template: RenderTemplate,
  snapshot: DataSnapshot,
): string => {
  const malformed = findMalformedPlaceholder(template.body);
  if (malformed !== null) {
    throw new TemplateRenderError({
      template_hash: template.template_hash,
      path: malformed.raw,
      reason: 'malformed_placeholder',
      message: `template ${template.template_hash}: malformed placeholder ${JSON.stringify(malformed.raw)} at position ${malformed.position}`,
    });
  }
  return template.body.replace(PLACEHOLDER_RE, (_full, rawPath: string) => {
    const path = rawPath;
    const value = resolvePath(snapshot.data, path);
    if (value === undefined) {
      throw new TemplateRenderError({
        template_hash: template.template_hash,
        path,
        reason: 'missing_path',
        message: `template ${template.template_hash}: path ${JSON.stringify(path)} missing from snapshot`,
      });
    }
    if (typeof value !== 'string') {
      throw new TemplateRenderError({
        template_hash: template.template_hash,
        path,
        reason: 'non_string_value',
        message: `template ${template.template_hash}: path ${JSON.stringify(path)} resolved to ${typeof value}, expected string`,
      });
    }
    return value;
  });
};
