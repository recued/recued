/** SOQL string-literal escaping — the RUNTIME half of the connection-agnostic
 *  search ref-escaping seam (B1).
 *
 *  A `{{ref}}`-valued filter on a `soql`-dialect search bakes its value into the
 *  SOQL `query.q` STRING (a query-string position). Unlike a HubSpot filter value —
 *  which rides as a JSON body field, injection-safe by construction — a value spliced
 *  into SOQL CAN break out of its literal unless escaped. The search builder cannot
 *  escape the value at install (the ref resolves at runtime, AFTER the build step), so
 *  it emits the ref carrying a `soql_string` / `soql_like` escape hint; the resolver
 *  (`formatHint`) applies the escape HERE when it interpolates the resolved value into
 *  the query. So an attacker-influenced runtime value can never escape its quoted
 *  literal — the request-side analogue of the build-side literal escaping, kept as ONE
 *  rule (the build-side `soqlScalar` imports `escapeSoqlStringLiteral` too, so the
 *  install-time and runtime escapes can never drift). */

/** Escape `\` and `'` for a single-quoted SOQL string literal — the standard SOQL
 *  escaping (backslash-escape the backslash first, then the quote). Total: every input
 *  yields a safe literal body, so there is no failure channel. */
export const escapeSoqlStringLiteral = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Render a runtime-resolved value as a SOQL quoted string literal — `'…'` with `\`
 *  and `'` escaped. null/undefined → `''` (the empty SOQL string literal: syntactically
 *  valid, never a bare empty splice that would malform the query). */
export const soqlQuotedLiteral = (value: unknown): string =>
  `'${escapeSoqlStringLiteral(value == null ? '' : String(value))}'`;

/** Render a runtime-resolved value as a SOQL `LIKE` operand — `'%…%'`, escaped.
 *  Mirrors the build-side contains/not_contains wrap; `%` / `_` in the value act as
 *  wildcards (consistent with the literal path — wildcard-escaping is a separate,
 *  out-of-scope concern). */
export const soqlLikeOperand = (value: unknown): string =>
  `'%${escapeSoqlStringLiteral(value == null ? '' : String(value))}%'`;
