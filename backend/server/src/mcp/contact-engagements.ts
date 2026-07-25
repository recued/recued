/** D-139 P5 — `recued_contactEngagementsList` MCP read.
 *
 *  External-agent surface over the contact-rooted engagement-evidence
 *  resolver. Shares the WS-rpc channel's validation + resolve core
 *  (`runContactEngagementsResolver`) but PROJECTS every row through
 *  `projectEngagementRowForMCP` — `body_inline` + `vendor_raw_timestamp`
 *  are STRIPPED by default (§ A.9.5 body-content privacy gate;
 *  `body_truncation_offset` byte-count IS exposed). The resolver-layer
 *  ids (`vendor_twins` / `mail_twin_id` / `dedupe_candidates`) project
 *  through — they're ids/match-metadata, never content.
 *
 *  Gating: the tool is default-OFF per the per-token tool checklist
 *  (`inboundTokenAuthorize`, run at the top of `handleToolCall`) — a door
 *  not granted this tool can't reach this handler. Body-content access
 *  (registry key `data.contact.engagements.body_content`) is a SEPARATE,
 *  SERVER-scoped gate (D-139 P6.B): a pack install grants the key into the
 *  `McpBodyVisibilityStore` (the `crm-commitment-tracker` pack ships it),
 *  and `mcp-server.ts` resolves `body_content_granted` from that store per
 *  call and passes it here. Default-stripped: when the option is absent /
 *  `false`, `body_inline` + `vendor_raw_timestamp` are stripped exactly as
 *  before. */

import {
  isGrantedReadAdmissible,
  projectEngagementRowForMCP,
  RpcError,
  type CoverageMetadata,
  type MCPEngagementRowProjection,
} from '@recued/contracts';
import {
  runContactEngagementsResolver,
  type ContactEngagementsResolveDeps,
} from '../contact-engagements-rpc-handler.js';
import {
  AUTHOR_DEFAULT_READ_GRANT_CHECKER,
  type ReadGrantChecker,
} from '../read-grant-checker.js';

/** D-187 slice 3b — the VERB-OP that gates the `contactEngagementsList` native tool.
 *  OWNER-default-only (sensitive): a live door must be explicitly granted it. Composed
 *  with the `data.contact` collection grant — reading a contact's engagement history
 *  needs BOTH the engagements verb AND contact-read access. */
const ENGAGEMENTS_VERB_OP = 'core.contact.engagements.read';

export interface MCPContactEngagementsResult {
  engagements: ReadonlyArray<
    MCPEngagementRowProjection & {
      body_inline?: string;
      vendor_raw_timestamp?: string;
    }
  >;
  next_cursor?: string;
  coverage: CoverageMetadata;
}

export const handleContactEngagementsList = (
  deps: ContactEngagementsResolveDeps,
  rawArgs: Record<string, unknown>,
  options: { body_content_granted?: boolean; readGrantChecker?: ReadGrantChecker } = {},
): MCPContactEngagementsResult => {
  // D-187 slice 3b read gate — `verb-op grant ∧ data.contact collection grant`
  // (`isGrantedReadAdmissible`), enforced BEFORE the resolver touches the store (no
  // existence leak). The verb-op is OWNER-default-only, so a live door reads engagement
  // evidence ONLY if explicitly granted `core.contact.engagements.read` AND `data.contact`.
  // The owner / owner's unbound MCP / contract-free callers admit by default. Absent
  // checker ⇒ the author-default checker (contract-free ⇒ admit) — the owner/test path.
  const checker = options.readGrantChecker ?? AUTHOR_DEFAULT_READ_GRANT_CHECKER;
  if (
    !isGrantedReadAdmissible(
      checker.isVerbOpGranted(ENGAGEMENTS_VERB_OP),
      checker.isCollectionReadGranted('contact'),
    )
  ) {
    throw new RpcError(
      'bad_request',
      'mcp.contact.engagements.list: not read-granted to this contract (read rejected)',
      400,
    );
  }
  const result = runContactEngagementsResolver(deps, rawArgs);
  // Body-content gate (§ A.9.5 / D-139 P6.B): inline body content ONLY when
  // the caller resolved an explicit server-scoped grant; default strip.
  const body_content_granted = options.body_content_granted === true;
  const engagements = result.engagements.map((row) =>
    projectEngagementRowForMCP(row, { body_content_granted }),
  );
  return result.next_cursor !== undefined
    ? {
        engagements,
        next_cursor: result.next_cursor,
        coverage: result.coverage,
      }
    : { engagements, coverage: result.coverage };
};
