/** D-157 follow-up (2026-10-20) — the Reason line of a hold that no review explains.
 *
 *  An approval's body gives the decision's `detail` as its "Reason:" line. The review
 *  branches (a send, a commitment, a customer payment) already said why in plain words;
 *  every other hold said "op '<id>' requires preflight approval under the active trust
 *  ceiling". It now says why in the owner's words: the action can't be undone, the
 *  owner's own setting asks every time, or who started the run and what they may do
 *  without asking.
 *
 *  Two halves:
 *    - named cases, one per cause, pinning the exact sentence the owner reads;
 *    - a sweep over every source × tier × ceiling × owner setting that holds, checking
 *      each sentence is one of the reviewed ones, names no id or gate, and is TRUE of
 *      the inputs that produced it (a reason that blames the owner's setting when they
 *      set none would be worse than the generic line it replaced). */

import { describe, expect, it } from 'vitest';

import {
  CONTRACTED_DEFAULT_TRUST_CEILING,
  RISK_TIERS,
  STDIO_MCP_TOKEN_ID,
  admitByOpRisk,
  admitByOpRiskWithoutQualityLifts,
  resolveTrustCeiling,
} from '../index.js';
import type {
  ExecutionSource,
  OwnerOverridePolicy,
  RiskTier,
  TrustCeiling,
} from '../index.js';

// A catalog ingredient, the shape a recipe's vendor step is probed under. Not a send,
// a peer ask, a commitment or a customer review, so only the trust hold explains it.
const SLUG = 'hubspot-catalog';

const OWNER_PAGE: ExecutionSource = {
  channel: 'user', actor: 'user_self', user_id: 'u', client_token_id: 't',
};
const OWNER_CHAT: ExecutionSource = {
  channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'u',
};
const OWNER_MESSENGER: ExecutionSource = {
  channel: 'messenger', actor: 'user_self', vendor: 'slack', from: 'U1',
};
const SELF_RESTRICTED_CHAT: ExecutionSource = {
  channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'u', contract_id: 'c-self',
};
const SCHEDULE: ExecutionSource = {
  channel: 'schedule', actor: 'system', cron: '0 9 * * *', source_recipe: 'r',
};
const REACTIVE: ExecutionSource = {
  channel: 'reactive', actor: 'system', event_kind: 'mail.created', source_recipe: 'r',
};
const HOUSEKEEPING: ExecutionSource = {
  channel: 'housekeeping', actor: 'system', cycle_id: 'c', task: 't', visible_to_user: false,
};
const MCP_DOOR: ExecutionSource = {
  channel: 'mcp', actor: 'contracted_user', agent_id: 'a', tool_call_id: 'tc',
  mcp_token_id: 'tok-door', contract_id: 'c-door',
};
const MCP_STDIO_OWNER: ExecutionSource = {
  channel: 'mcp', actor: 'contracted_user', agent_id: 'a', tool_call_id: 'tc',
  mcp_token_id: STDIO_MCP_TOKEN_ID, contract_id: STDIO_MCP_TOKEN_ID,
};
const CONTRACTED_CHAT: ExecutionSource = {
  channel: 'chat', actor: 'contracted_user', chat_session_id: 's', user_id: 'u', contract_id: 'c1',
};
const CONTRACTED_MESSENGER: ExecutionSource = {
  channel: 'messenger', actor: 'contracted_user', vendor: 'slack', from: 'U2', contract_id: 'c2',
};
const RECEPTION: ExecutionSource = {
  channel: 'reception', actor: 'anonymous', reception_id: 'rec-1',
};
const WEBHOOK: ExecutionSource = {
  channel: 'webhook', actor: 'anonymous', vendor: 'hubspot', webhook_secret_id: 'wh-1',
};

const SOURCES: readonly ExecutionSource[] = [
  OWNER_PAGE, OWNER_CHAT, OWNER_MESSENGER, SELF_RESTRICTED_CHAT, SCHEDULE, REACTIVE,
  HOUSEKEEPING, MCP_DOOR, MCP_STDIO_OWNER, CONTRACTED_CHAT, CONTRACTED_MESSENGER,
  RECEPTION, WEBHOOK,
];

const reasonFor = (
  source: ExecutionSource,
  risk_tier: RiskTier,
  options: { ceiling?: TrustCeiling; owner_override?: OwnerOverridePolicy } = {},
): string => {
  const decision = admitByOpRisk({
    slug: SLUG,
    risk_tier,
    ceiling: options.ceiling ?? resolveTrustCeiling(source),
    source,
    ...(options.owner_override !== undefined ? { owner_override: options.owner_override } : {}),
  });
  if (decision.verdict !== 'ask') throw new Error(`expected a hold, got ${decision.verdict}`);
  return decision.detail;
};

const CANNOT_UNDO = "Recued asks before anything that can't be undone, even when you start it yourself.";
const OWNER_EVERY_TIME = 'You set this action to ask you every time.';
const READ_ONLY = 'can only read without asking you.';
const WRITE_NOT_ADMIN = 'can change data, but not account settings or access, without asking you.';

describe('the Reason line of a hold no review explains', () => {
  it("names the starter of a schedule's write, and what such runs may do alone", () => {
    expect(reasonFor(SCHEDULE, 'write')).toBe(
      `Runs that start on their own, from a schedule or a trigger, ${READ_ONLY}`,
    );
    expect(reasonFor(REACTIVE, 'admin')).toBe(
      `Runs that start on their own, from a schedule or a trigger, ${READ_ONLY}`,
    );
  });

  it("names a door for an AI agent's write, in the words the ask's Started-by line uses", () => {
    expect(reasonFor(MCP_DOOR, 'write')).toBe(
      `Anything that comes in through a door you opened ${READ_ONLY}`,
    );
    expect(reasonFor(CONTRACTED_CHAT, 'admin')).toBe(
      `Anything that comes in through a door you opened ${READ_ONLY}`,
    );
  });

  it("names a request from outside for a visitor's write", () => {
    expect(reasonFor(RECEPTION, 'write')).toBe(`Requests from outside this server ${READ_ONLY}`);
  });

  it('says what a webhook door whose own ceiling allows writes may still not do', () => {
    expect(reasonFor(WEBHOOK, 'admin', { ceiling: 'write' })).toBe(
      `Requests from outside this server ${WRITE_NOT_ADMIN}`,
    );
  });

  it("explains a run limited to reading without saying who limited it", () => {
    expect(reasonFor(SELF_RESTRICTED_CHAT, 'write')).toBe(`This run ${READ_ONLY}`);
  });

  it("says an irreversible action asks whoever starts it, the owner included", () => {
    expect(reasonFor(OWNER_PAGE, 'destructive')).toBe(CANNOT_UNDO);
    expect(reasonFor(SCHEDULE, 'destructive')).toBe(CANNOT_UNDO);
    expect(reasonFor(MCP_DOOR, 'destructive')).toBe(CANNOT_UNDO);
  });

  it("blames the owner's own setting only when it is theirs", () => {
    expect(reasonFor(OWNER_PAGE, 'write', { owner_override: { approval: 'always' } }))
      .toBe(OWNER_EVERY_TIME);
    // Marking an action destructive is the owner's call too, not the pack's.
    expect(reasonFor(OWNER_CHAT, 'write', { owner_override: { risk: 'destructive' } }))
      .toBe(OWNER_EVERY_TIME);
    // The pack already calls it irreversible: that is the reason, setting or not.
    expect(reasonFor(OWNER_PAGE, 'destructive', { owner_override: { approval: 'always' } }))
      .toBe(CANNOT_UNDO);
  });

  it("gives the source-less upkeep probe's hold to the owner's rule that made it", () => {
    const decision = admitByOpRiskWithoutQualityLifts({
      slug: SLUG,
      risk_tier: 'write',
      ceiling: CONTRACTED_DEFAULT_TRUST_CEILING,
      owner_override: { approval: 'ask' },
    });
    expect(decision).toMatchObject({
      verdict: 'ask',
      detail: 'Your settings for this action make it ask you first.',
    });
  });

  it("gives a read held by the owner's own Ask setting to that setting", () => {
    // Only an approval set to ask holds a read (under a ceiling of `none`). "Can only
    // read without asking you" would contradict the very hold it explains.
    expect(reasonFor(WEBHOOK, 'read', { ceiling: 'none', owner_override: { approval: 'ask' } }))
      .toBe('Your settings for this action make it ask you first.');
  });

  it('claims nothing when the ceiling it was given is not one it knows', () => {
    expect(reasonFor(MCP_DOOR, 'write', { ceiling: 'bogus' as TrustCeiling }))
      .toBe('This needs your approval before it runs.');
  });
});

describe('every hold no review explains, swept', () => {
  const REVIEWED = new Set([
    CANNOT_UNDO,
    OWNER_EVERY_TIME,
    'This action is set to ask you every time.',
    'Your settings for this action make it ask you first.',
    'This needs your approval before it runs.',
    ...['Runs that start on their own, from a schedule or a trigger,',
      'Anything that comes in through a door you opened',
      'Requests from outside this server',
      'This run',
    ].flatMap((subject) => [`${subject} ${READ_ONLY}`, `${subject} ${WRITE_NOT_ADMIN}`]),
  ]);

  const OVERRIDES: ReadonlyArray<OwnerOverridePolicy | undefined> = [
    undefined,
    { approval: 'always' },
    { approval: 'ask' },
    { approval: 'never' },
    { risk: 'destructive' },
    { risk: 'admin' },
    { risk: 'write' },
    { risk: 'read' },
    { risk: 'read', approval: 'always' },
  ];
  const CEILINGS: readonly TrustCeiling[] = ['none', 'read', 'write', 'admin'];

  /** Is the sentence true of the inputs that produced it? Each claim, checked on its own. */
  const claimHolds = (
    reason: string,
    c: { source: ExecutionSource; risk: RiskTier; ceiling: TrustCeiling; owner?: OwnerOverridePolicy },
  ): boolean => {
    // The tier the decision judged: the owner's `risk` replaces the pack's.
    const effective = c.owner?.risk ?? c.risk;
    // The pack calls it irreversible AND the decision judged it so (an owner who
    // lowered its tier made it something else).
    if (reason === CANNOT_UNDO) return c.risk === 'destructive' && effective === 'destructive';
    if (reason === OWNER_EVERY_TIME) {
      return c.owner?.approval === 'always' || c.owner?.risk === 'destructive';
    }
    if (reason === 'Your settings for this action make it ask you first.') {
      return c.owner?.approval !== undefined || c.owner?.risk !== undefined;
    }
    const subjectHolds = reason.startsWith('Runs that start on their own')
      ? c.source.actor === 'system' && c.source.channel !== 'housekeeping'
      : reason.startsWith('Anything that comes in through a door you opened')
        ? c.source.actor === 'contracted_user'
        : reason.startsWith('Requests from outside this server')
          ? c.source.actor === 'anonymous'
          : true;
    // "Can only read" must not explain a held READ: the sentence would contradict it.
    const allowsHolds = reason.endsWith(READ_ONLY)
      ? (c.ceiling === 'read' || c.ceiling === 'none')
        && (effective === 'write' || effective === 'admin')
      : reason.endsWith(WRITE_NOT_ADMIN)
        ? c.ceiling === 'write' && effective === 'admin'
        : true;
    return subjectHolds && allowsHolds;
  };

  it('gives every hold a reviewed sentence that is true of it and names no id or gate', () => {
    const seen = new Set<string>();
    let holds = 0;
    for (const source of SOURCES) {
      for (const risk of RISK_TIERS) {
        for (const ceiling of CEILINGS) {
          for (const owner of OVERRIDES) {
            const decision = admitByOpRisk({
              slug: SLUG,
              risk_tier: risk,
              ceiling,
              source,
              ...(owner !== undefined ? { owner_override: owner } : {}),
            });
            if (decision.verdict !== 'ask') continue;
            holds += 1;
            const reason = decision.detail;
            seen.add(reason);
            const label = JSON.stringify({ source, risk, ceiling, owner });
            expect(REVIEWED.has(reason), `${label} → ${reason}`).toBe(true);
            expect(claimHolds(reason, { source, risk, ceiling, ...(owner !== undefined ? { owner } : {}) }),
              `${label} → ${reason}`).toBe(true);
            expect(reason, label).not.toContain(SLUG);
            expect(reason, label).not.toMatch(/preflight|ceiling|risk_tier|op '|contract policy|the user/i);
          }
        }
      }
    }
    // The sweep reached holds, and more than one kind of reason: a vacuous sweep
    // (every case admitted, or every case the fallback) would pass the checks above.
    expect(holds).toBeGreaterThan(100);
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });
});
