/** A WRITE refusal must not become a refusal to READ.
 *
 *  ⛔ This pins a regression that shipped.
 *
 *  `on_approve_action_unsupported` was added to stop minting `mark_resolved`
 *  approval links whose answers reach nobody. The change was described — in its
 *  own commit message and its own code comment — as *"existing rows still PARSE
 *  (the enum keeps both members); only new writes are refused."*
 *
 *  That was wrong. `parseApprovalLinkConfig` calls the SAME shared validator and
 *  returns `null` on any failure, so every already-stored `mark_resolved` row
 *  stopped parsing. And these rows were not rare: `mark_resolved` was the
 *  authoring DEFAULT, and two shipped Foundation templates used it. The drain
 *  processor moved them from *pending* to *failed* and spent budget doing it —
 *  a behaviour nobody designed, in a change whose whole point was that it
 *  DIDN'T touch existing rows.
 *
 *  🔑 The general shape: a validator shared by a write gate and a read parser
 *  will silently apply every new POLICY rule retroactively to stored data. A row
 *  is not made malformed by a later decision. The fix is an explicit
 *  write-only set the read path drops — and this file is what keeps it honest,
 *  because a future refusal added without thinking about the read path is the
 *  same bug again.
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_LINK_WRITE_ONLY_REFUSAL_CODES,
  validateApprovalLinkConfig,
} from '@recued/contracts';

import { parseApprovalLinkConfig } from '../ports/reception/transformations/approval-link.js';

const config = (onApprove: string): Record<string, unknown> => ({
  display_name: 'Mary',
  action_kind: 'pick_time',
  prompt: 'Pick a slot',
  options: [
    { id: 'opt_a', label: '9am Mon' },
    { id: 'opt_b', label: '2pm Tue' },
  ],
  visitor_field_constraints: { name: 'required', email: 'required' },
  expiry_days: 7,
  context_raw: { summary: 'A proposal.' },
  on_action: { target_id: 'proposal-1', on_approve_action: onApprove },
});

describe('approval_link — write-only refusals do not fail the read path', () => {
  it('the WRITE path still refuses a mark_resolved config', () => {
    // The gate is intact. If this ever passes, the refusal was lost and the
    // read-path exemption below is exempting nothing.
    const failures = validateApprovalLinkConfig(config('mark_resolved'));
    expect(failures.map((f) => f.code)).toContain('on_approve_action_unsupported');
  });

  it('the READ path still parses a stored mark_resolved row', () => {
    // The row exists in the wild. Reading it must keep working.
    const parsed = parseApprovalLinkConfig(config('mark_resolved'));
    expect(parsed).not.toBeNull();
    expect(parsed?.on_action?.on_approve_action).toBe('mark_resolved');
  });

  it('the READ path still parses a stored fire_recipe row', () => {
    expect(parseApprovalLinkConfig(config('fire_recipe'))).not.toBeNull();
  });

  it('the READ path still parses the supported action', () => {
    // The permitting baseline — proves the two above pass because the exemption
    // works, not because parse stopped rejecting anything.
    expect(parseApprovalLinkConfig(config('create_commitment'))).not.toBeNull();
  });

  it('the READ path still REJECTS a genuinely malformed row', () => {
    // ⛔ The line the exemption must not cross. Only POLICY codes are dropped;
    // a shape failure must still null the parse, or the exemption has quietly
    // turned the parser off.
    expect(parseApprovalLinkConfig({ action_kind: 'pick_time' })).toBeNull();
    expect(parseApprovalLinkConfig(null)).toBeNull();
    expect(parseApprovalLinkConfig({ ...config('create_commitment'), prompt: '' })).toBeNull();
    // An UNKNOWN action is a shape failure, not a policy one — it is not on the
    // write-only list and must still fail to parse.
    expect(parseApprovalLinkConfig(config('teleport'))).toBeNull();
  });

  it('every write-only code is a real validation code, and the list is narrow', () => {
    // A list that grew to cover shape codes would disable the parser one entry
    // at a time. `on_approve_action_unknown` in particular must NEVER appear
    // here — it is the shape sibling of the policy code, and the two are
    // deliberately distinct.
    expect(APPROVAL_LINK_WRITE_ONLY_REFUSAL_CODES).toEqual(['on_approve_action_unsupported']);
    expect(APPROVAL_LINK_WRITE_ONLY_REFUSAL_CODES as readonly string[])
      .not.toContain('on_approve_action_unknown');
  });
});
