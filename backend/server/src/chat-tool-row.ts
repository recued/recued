// The `role: 'tool'` row body: how it is WRITTEN, how it is READ BACK, and what
// its tool name means for recall.
//
// ⛔ THE RENDERER AND THE PARSER LIVE TOGETHER ON PURPOSE. They are one
// composition — `toolNameFromRow(renderToolRow(name, …)) === name` — and a
// format change that touches only one of them is silent: the row still writes,
// the parse still returns a string, and the string is simply wrong. Split
// across modules that invariant has no single owner.
//
// They are HERE rather than in `chat-orchestrator` because the recall backend
// needs the parser and must not depend on the orchestrator to get it.

import { TIER1_CLASSIFICATIONS, type Tier1ToolName } from '@recued/contracts';

/** The searchable body of a `role: 'tool'` row.
 *
 *  ⛔ THE ARGS ARE IN IT, and they were not in the first cut. The ask is
 *  recorded in `tool_calls_blob` and in the `chat_tool_call` audit trail —
 *  but neither is SEARCHABLE, and "already recorded" is not "already findable".
 *  That is the same distinction that made the whole tool-row class necessary:
 *  the results were in `chat_egress` all along and nothing could reach them.
 *  ⚠ Cheap: args measure p50 39 bytes, p99 787, max 947 across 29,256 real
 *  dispatches — a rounding error beside the result they accompany.
 *
 *  ⛔ THE TOOL NAME LEADS, because recall is LEXICAL. A body that is only the
 *  payload is findable by the data it happened to contain and by nothing else;
 *  naming the tool makes the row findable by the ACT too.
 *  ⚠ Findable by a HUMAN reading it, and by a term inside the name — NOT by the
 *  dotted name as one query: the recall index splits on punctuation, so
 *  `mail.search` matches nothing while `mail` and `search` each match. Measured
 *  2026-09-04. Do not rely on the full name as a lookup key. */
export const renderToolRow = (
  tool_name: string,
  args: unknown,
  result: unknown | undefined,
): string => {
  const a = serializeForRow(args);
  const call = a.length > 0 && a !== '{}' ? `${tool_name}(${a})` : tool_name;
  if (result === undefined) return call;
  const body = serializeForRow(result);
  return body.length > 0 ? `${call}: ${body}` : call;
};

/** The inverse of `renderToolRow`'s NAME half. `renderToolRow` emits
 *  `<name>(<args>)`, `<name>(<args>): <result>`, or a bare `<name>` — so the
 *  name is everything up to the first `(` or `: `.
 *
 *  ⚠ Returns undefined rather than a fallback when the row does not parse. A
 *  caller that guesses a name would classify the wrong tool, and the one
 *  consumer here decides whether a row is REACHABLE — a wrong guess there
 *  silently drops a row or admits one it should not. */
export const toolNameFromRow = (content: string): string | undefined => {
  const cut = content.search(/\(|: /u);
  const name = (cut === -1 ? content : content.slice(0, cut)).trim();
  return name.length > 0 && !name.includes(' ') ? name : undefined;
};

/** Is this row's tool a READ, and therefore its stored result a snapshot?
 *
 *  ⛔⛔ READS THE SHIPPED TABLE, NEVER A COPY. The bench arm that proved this
 *  gate held its own literal set, and a closed list duplicated from a table is
 *  the drift this codebase has been bitten by repeatedly: the table gains a
 *  tool, the copy does not, and the new tool's snapshots become reachable with
 *  nothing failing. `TIER1_CLASSIFICATIONS` is the source of truth.
 *
 *  ⚠ UNKNOWN IS NOT READ, and that is deliberate but load-bearing. `recipe.run`
 *  classifies `'unknown'`, so every Tier-2 recipe — every SEND — survives this
 *  predicate by NOT being classified rather than by being classified correctly.
 *  That is right today and fragile: classifying `recipe.run` as `'read'` would
 *  silently make composed send arguments unreachable. The effect side of the
 *  vocabulary is the real gap. */
export const isReadClassifiedTool = (tool_name: string): boolean =>
  TIER1_CLASSIFICATIONS[tool_name as Tier1ToolName] === 'read';

/** True when a tool ROW holds a re-derivable snapshot and should not be served
 *  from recall. Unparseable rows are KEPT: dropping something we could not
 *  identify would silently shrink the corpus on a format change. */
export const isSnapshotToolRow = (content: string): boolean => {
  const name = toolNameFromRow(content);
  return name !== undefined && isReadClassifiedTool(name);
};

// ⛔ VERBATIM FROM ITS ORIGINAL SITE. A rewrite here changes the ROW FORMAT for
// every string argument -- the original passes strings through untouched and
// only JSON-encodes non-strings -- which would silently invalidate every stored
// row's shape and the parser that reads it back.
const serializeForRow = (value: unknown): string => {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  } catch {
    // A value that will not serialize is still worth a findable row naming the
    // tool it belongs to.
    return '';
  }
};
