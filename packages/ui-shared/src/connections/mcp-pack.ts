/** D-225 Slice 2 — the presentation contract for the MCP generated-pack owner
 *  surfaces: the drift badge, the enrollment review screen, and the wording for
 *  a removal that also deletes a connection.
 *
 *  🔑 **This layer is where the server's care can quietly be undone**, which is
 *  why it is a pure module with its own tests rather than logic inlined into a
 *  renderer. Three things the server established and a UI could lose:
 *
 *   1. A server's `readOnlyHint` seeds a SUGGESTION, never the stored value. A
 *      form that pre-selected the suggestion would hand the third party the
 *      decision back — the exact bypass `mcpPackReviewRows` refuses to make.
 *   2. `unknown` is not `current`. A badge that renders nothing for `unknown`
 *      turns "we cannot tell" into "all clear", on exactly the connections
 *      nobody has looked at.
 *   3. Uninstalling a generated pack deletes an enrolled CREDENTIAL. Wording
 *      that says only "pack removed" is what makes that side effect silent.
 *
 *  Pure — same inputs, same output. Lives in ui-shared because the
 *  connection-detail renderer is the consumer, matching `pack-usage.ts`.
 */

import type { McpPackReviewRow } from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// The drift badge
// ────────────────────────────────────────────────────────────────

/** The `collection.connection.mcpPackStatus` result, as the page receives it. */
export interface McpPackStatusView {
  pack_slug: string;
  status: 'no_pack' | 'unknown' | 'current' | 'drifted';
  added: number;
  removed: number;
  last_probed_at?: number;
}

/** What the connection detail shows for its generated pack. */
export interface McpPackBadge {
  /** Rendering weight. `attention` is the only one that should pull the eye. */
  tone: 'neutral' | 'ok' | 'attention';
  label: string;
  /** One sentence the owner can act on. Never blank. */
  detail: string;
  /** The offer attached to the badge, if any. */
  action?: 'generate' | 'review' | 'probe';
}

/** Project a status into the badge.
 *
 *  ⛔ **`unknown` renders VISIBLY, and that is the point.** It would be easy to
 *  treat it as "nothing to say" and render nothing — but a blank badge is read
 *  as reassurance, and `unknown` means the opposite: we have not looked. The
 *  connections most likely to have drifted are precisely the ones nobody has
 *  probed, so silence there is the worst available answer.
 *
 *  ⚠ `drifted` deliberately does NOT name tools. The status carries counts,
 *  because resolving a descriptor hash back to a tool needs a live probe — that
 *  is the review screen's job. The badge exists to prompt one decision, and
 *  claiming more than it knows would be the UI inventing certainty the server
 *  refused to. */
export const mcpPackBadge = (status: McpPackStatusView): McpPackBadge => {
  switch (status.status) {
    case 'no_pack':
      return {
        tone: 'neutral',
        label: 'No pack',
        detail:
          'This server’s tools are reachable only through raw MCP calls. '
          + 'Generate a pack to grant them individually.',
        action: 'generate',
      };
    case 'unknown':
      return {
        tone: 'attention',
        label: 'Not checked',
        detail:
          'This connection has not been probed since its pack was generated, '
          + 'so whether the server’s tools still match is unknown. Probe to find out.',
        action: 'probe',
      };
    case 'current':
      return {
        tone: 'ok',
        label: 'Up to date',
        detail: 'The pack matches the tools this server published at the last probe.',
      };
    case 'drifted': {
      const parts: string[] = [];
      if (status.added > 0) parts.push(`${status.added} new or changed`);
      if (status.removed > 0) parts.push(`${status.removed} gone or replaced`);
      return {
        tone: 'attention',
        label: 'Tools changed',
        detail:
          `This server’s tools no longer match the pack (${parts.join(', ')}). `
          + 'Review them again — anything new or changed is not granted until you do.',
        action: 'review',
      };
    }
  }
};

// ────────────────────────────────────────────────────────────────
// The review screen
// ────────────────────────────────────────────────────────────────

/** One row as the review form should present it. */
export interface McpPackReviewRowView {
  op: string;
  tool: string;
  description?: string;
  /** ⛔ What the form must be PRE-SET to. Always the conservative floor. */
  selected: { risk: 'write'; approval: 'ask' };
  /** The one-click offer, when the server published a usable hint. Rendering
   *  it as a button/link is correct; rendering it as the selected value is the
   *  bypass this whole design exists to prevent. */
  offer?: { risk: string; approval: string; label: string };
  /** The server's claim, for an attributed badge — "the server says…", never
   *  presented as a fact about the tool. */
  claim?: string;
}

/** The whole review screen's model. */
export interface McpPackReviewView {
  rows: McpPackReviewRowView[];
  /** Op ids to send back as `reviewed_ops`, so the commit can refuse if the
   *  server changed while the owner was deciding. */
  reviewed_ops: string[];
  /** The disclosure above the form. */
  summary: string;
}

/** Project the server's review rows into the form model.
 *
 *  ⛔ **`selected` is the stored floor on every row, unconditionally.** The
 *  server refuses to let a `readOnlyHint` become the stored default; a form that
 *  pre-selected `offer` would hand that decision straight back to the third
 *  party, because Save-without-reading would then carry the server's own claim.
 *  The offer is a button. It requires a click, and the click is the consent.
 *
 *  ⚠ The claim is rendered as ATTRIBUTED speech — "the server says this is
 *  read-only" — not as "read-only". The distinction is the entire difference
 *  between showing evidence and laundering it. */
export const mcpPackReviewView = (rows: readonly McpPackReviewRow[]): McpPackReviewView => ({
  rows: rows.map((row): McpPackReviewRowView => {
    const view: McpPackReviewRowView = {
      op: row.op,
      tool: row.tool,
      // Never spread `row` — an added server-side field must not reach the form
      // without someone deciding it should.
      selected: { risk: 'write', approval: 'ask' },
    };
    if (row.description !== undefined) view.description = row.description;
    if (row.suggested !== undefined) {
      view.offer = {
        risk: row.suggested.risk,
        approval: row.suggested.approval,
        label: `Treat as read-only (${row.suggested.risk} / ${row.suggested.approval})`,
      };
    }
    const says = row.server_says;
    if (says !== undefined) {
      if (says.destructive === true && says.read_only === true) {
        view.claim = 'The server describes this tool as both read-only and destructive.';
      } else if (says.destructive === true) {
        view.claim = 'The server describes this tool as destructive.';
      } else if (says.read_only === true) {
        view.claim = 'The server describes this tool as read-only.';
      } else if (says.read_only === false) {
        view.claim = 'The server does not describe this tool as read-only.';
      }
    }
    return view;
  }),
  reviewed_ops: rows.map((r) => r.op),
  summary: reviewSummary(rows.length),
});

const reviewSummary = (count: number): string => {
  if (count === 0) {
    return 'This server publishes no tools. There is nothing to grant.';
  }
  const tools = count === 1 ? '1 tool' : `${count} tools`;
  return (
    `This server publishes ${tools}. Each is held for your approval and granted to nothing `
    + 'until you say so — a tool’s own description of itself is not evidence, so nothing here '
    + 'is classified for you.'
  );
};

// ────────────────────────────────────────────────────────────────
// Removal wording
// ────────────────────────────────────────────────────────────────

/** What to tell the owner after `packs.uninstall` returns.
 *
 *  ⛔ A generated pack and its connection are removed together, and the
 *  connection holds the enrolled CREDENTIAL. From a button labelled "remove
 *  pack" that reads far smaller than it is — so when the server reports a
 *  `removed_connection`, the wording SAYS SO. Omitting it is exactly what makes
 *  the side effect silent, and a silent credential deletion is the kind of
 *  thing an owner discovers later, from a failure. */
export const packRemovalMessage = (result: {
  removed_connection?: string;
}): string =>
  result.removed_connection === undefined
    ? 'Pack removed.'
    : `Pack removed, along with the “${result.removed_connection}” MCP connection `
      + 'it was generated from and the credential stored for it.';

/** The confirm shown BEFORE removing a generated pack — the same fact, before
 *  it is irreversible rather than after. `connection_name` comes from the
 *  connection whose derived slug matches the pack. */
export const packRemovalConfirm = (connection_name?: string): string =>
  connection_name === undefined
    ? 'Remove this pack?'
    : `Remove this pack? This also deletes the “${connection_name}” MCP connection `
      + 'and the credential stored for it. The tools stay reachable only if you enroll it again.';
