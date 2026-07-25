/** D-153 P1 — commit substrate contracts.
 *
 *  Tests the type unions + predicates + closed-list exhaustiveness for
 *  the new commit-substrate surface (`packages/contracts/src/commits.ts`).
 *  Substrate-only — engine wiring + rpc query surfaces land in later
 *  slices (P1.B+ / P2 / P3) and get their own tests.
 *
 *  Spec: D-153 § Commit substrate. */

import { describe, expect, it } from 'vitest';

import {
  ACTORS,
  CHANNELS,
  COMMIT_KINDS,
  COMMIT_STATUSES,
  TERMINAL_COMMIT_STATUSES,
  executionSourceContractId,
  executionSourceHasContract,
  isActor,
  isChannel,
  isCommitKind,
  isCommitStatus,
  isExecutionSource,
  isTerminalCommitStatus,
  renderActorLabel,
  type Actor,
  type Channel,
  type CommitKind,
  type CommitStatus,
  type ContractSnapshot,
  type ExecutionSource,
} from '../commits.js';

// ────────────────────────────────────────────────────────────────
// CommitKind
// ────────────────────────────────────────────────────────────────

describe('CommitKind', () => {
  it('closed list covers exactly the three observable categories', () => {
    expect(COMMIT_KINDS).toEqual(['action', 'query', 'cognition_output']);
  });

  it('isCommitKind narrows to the literal union for known values', () => {
    for (const kind of COMMIT_KINDS) {
      expect(isCommitKind(kind)).toBe(true);
    }
  });

  it('isCommitKind rejects strings outside the closed list', () => {
    expect(isCommitKind('write')).toBe(false);
    expect(isCommitKind('Action')).toBe(false);
    expect(isCommitKind('')).toBe(false);
  });

  it('isCommitKind rejects non-string values without throwing', () => {
    expect(isCommitKind(null)).toBe(false);
    expect(isCommitKind(undefined)).toBe(false);
    expect(isCommitKind(42)).toBe(false);
    expect(isCommitKind({})).toBe(false);
    expect(isCommitKind([])).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// CommitStatus
// ────────────────────────────────────────────────────────────────

describe('CommitStatus', () => {
  it('closed list covers exactly the seven lifecycle states (D-181 adds killed)', () => {
    expect(COMMIT_STATUSES).toEqual([
      'pending',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'killed',
      'in_doubt',
    ]);
  });

  it('isCommitStatus accepts every closed-list value', () => {
    for (const status of COMMIT_STATUSES) {
      expect(isCommitStatus(status)).toBe(true);
    }
  });

  it('isCommitStatus rejects pre-D-153 boolean / unknown strings', () => {
    expect(isCommitStatus(true)).toBe(false);
    expect(isCommitStatus(false)).toBe(false);
    expect(isCommitStatus('ok')).toBe(false);
    expect(isCommitStatus('error')).toBe(false);
    expect(isCommitStatus('SUCCEEDED')).toBe(false);
  });

  it('isTerminalCommitStatus distinguishes terminal from in-flight states', () => {
    expect(TERMINAL_COMMIT_STATUSES.size).toBe(5);
    expect(isTerminalCommitStatus('succeeded')).toBe(true);
    expect(isTerminalCommitStatus('failed')).toBe(true);
    expect(isTerminalCommitStatus('cancelled')).toBe(true);
    expect(isTerminalCommitStatus('killed')).toBe(true);
    expect(isTerminalCommitStatus('in_doubt')).toBe(true);
    expect(isTerminalCommitStatus('pending')).toBe(false);
    expect(isTerminalCommitStatus('running')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Actor + contract-scoped subset
// ────────────────────────────────────────────────────────────────

describe('Actor', () => {
  it('closed list covers exactly the four identity actors (D-161 Part A / I-1)', () => {
    expect(ACTORS).toEqual([
      'user_self',
      'contracted_user',
      'system',
      'anonymous',
    ]);
  });

  it('drops the collapsed contracted_self / mini_self / agent (D-161 I-1)', () => {
    // Identity-only: the former mode-as-identity (`contracted_self`), the
    // fuzzy synonym (`mini_self`), and the stale dead entry (`agent`) are
    // no longer `Actor` values.
    expect(isActor('contracted_self')).toBe(false);
    expect(isActor('mini_self')).toBe(false);
    expect(isActor('agent')).toBe(false);
  });

  it('isActor accepts every closed-list value', () => {
    for (const actor of ACTORS) {
      expect(isActor(actor)).toBe(true);
    }
  });

  it('isActor rejects unknown values', () => {
    expect(isActor('admin')).toBe(false);
    expect(isActor('USER_SELF')).toBe(false);
    expect(isActor(null)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// D-161 — contract-presence helpers + derived actor label. These
// replace the deleted actor-based `isContractScopedActor`: "operating
// under a contract" is now read off `contract_id` (N.4), and
// "self-restricted" is the derived label for (user_self, contract_id)
// (N.3). Codex-xhigh expands the edge coverage.
// ────────────────────────────────────────────────────────────────

describe('D-161 contract-presence + actor label', () => {
  const unrestrictedUser: ExecutionSource = {
    channel: 'user', actor: 'user_self', user_id: 'u', client_token_id: 't',
  };
  const selfRestrictedUser: ExecutionSource = {
    channel: 'user', actor: 'user_self', user_id: 'u', client_token_id: 't', contract_id: 'c-self',
  };
  const contractedUser: ExecutionSource = {
    channel: 'mcp', actor: 'contracted_user', agent_id: 'a', tool_call_id: 'tc', mcp_token_id: 'mt', contract_id: 'c-1',
  };
  const systemSource: ExecutionSource = {
    channel: 'schedule', actor: 'system', cron: '0 9 * * 1-5', source_recipe: 'r',
  };

  it('executionSourceContractId reads the id variant-agnostically (N.4)', () => {
    expect(executionSourceContractId(unrestrictedUser)).toBeUndefined();
    expect(executionSourceContractId(selfRestrictedUser)).toBe('c-self');
    expect(executionSourceContractId(contractedUser)).toBe('c-1');
    expect(executionSourceContractId(systemSource)).toBeUndefined();
  });

  it('executionSourceHasContract is true iff a contract_id is set — incl. a self-restricted user_self (N.4 / I-3)', () => {
    expect(executionSourceHasContract(unrestrictedUser)).toBe(false);
    expect(executionSourceHasContract(selfRestrictedUser)).toBe(true);
    expect(executionSourceHasContract(contractedUser)).toBe(true);
    expect(executionSourceHasContract(systemSource)).toBe(false);
  });

  it('renderActorLabel derives "self-restricted" only for user_self + contract_id (N.3 / I-2)', () => {
    expect(renderActorLabel(unrestrictedUser)).toBe('user_self');
    expect(renderActorLabel(selfRestrictedUser)).toBe('self-restricted');
    expect(renderActorLabel(contractedUser)).toBe('contracted_user');
    expect(renderActorLabel(systemSource)).toBe('system');
  });
});

// ────────────────────────────────────────────────────────────────
// Channel + messenger ExecutionSource vendor
// ────────────────────────────────────────────────────────────────

describe('Channel', () => {
  it('closed list covers exactly the nine launch channels', () => {
    expect(CHANNELS).toEqual([
      'user',
      'chat',
      'mcp',
      'messenger',
      'reception',
      'webhook',
      'schedule',
      'reactive',
      'housekeeping',
    ]);
  });

  it('isChannel accepts every closed-list value', () => {
    for (const channel of CHANNELS) {
      expect(isChannel(channel)).toBe(true);
    }
  });

  it('isChannel rejects future-candidate channels until they ship', () => {
    // Spec § (channel × actor) policy matrix names `voice` as a near-
    // term candidate; the closed-list-with-extension-protocol shape
    // requires a D-spec edit before the predicate accepts a new value.
    expect(isChannel('voice')).toBe(false);
    expect(isChannel('iot')).toBe(false);
  });
});

describe('messenger ExecutionSource vendor (D-192 CORE #6)', () => {
  // The closed `MESSENGER_VENDORS` / `MessengerVendor` / `isMessengerVendor`
  // trio was retired — the messenger channel's vendor is now a declared
  // chat-transport slug validated at runtime by `isDeclaredMessengerVendor`
  // (the registry itself is tested in d-192-m1-messenger-vendors.test.ts).
  // Here we assert that validation as `isExecutionSource` enforces it.
  it('accepts a declared chat-transport vendor', () => {
    for (const vendor of ['slack', 'telegram']) {
      expect(isExecutionSource({
        channel: 'messenger', actor: 'user_self', vendor, from: 'u',
      })).toBe(true);
    }
  });

  it('rejects `email` — a notification channel, never a chat transport (category-error fix)', () => {
    expect(isExecutionSource({
      channel: 'messenger', actor: 'user_self', vendor: 'email', from: 'u',
    })).toBe(false);
  });

  it('rejects an undeclared vendor — fails closed until a declaration lands', () => {
    expect(isExecutionSource({
      channel: 'messenger', actor: 'user_self', vendor: 'not_a_transport', from: 'u',
    })).toBe(false);
    expect(isExecutionSource({
      channel: 'messenger', actor: 'user_self', vendor: 'sms', from: 'u',
    })).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// ExecutionSource — shallow predicate
// ────────────────────────────────────────────────────────────────

describe('ExecutionSource', () => {
  it('accepts every closed-list (channel × actor) combination', () => {
    const samples: ExecutionSource[] = [
      { channel: 'user', actor: 'user_self', user_id: 'u', client_token_id: 't' },
      // self-restricted user_self — user_self carrying an optional contract_id (D-161 N.3)
      { channel: 'user', actor: 'user_self', user_id: 'u', client_token_id: 't', contract_id: 'c-self' },
      { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'u' },
      { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'u', contract_id: 'c-self' },
      { channel: 'chat', actor: 'contracted_user', chat_session_id: 's', user_id: 'u', contract_id: 'c' },
      { channel: 'mcp', actor: 'contracted_user', agent_id: 'a', tool_call_id: 'tc', mcp_token_id: 'mt', contract_id: 'c' },
      { channel: 'messenger', actor: 'user_self', vendor: 'slack', from: 'U1' },
      { channel: 'messenger', actor: 'contracted_user', vendor: 'telegram', from: 'u', contract_id: 'c' },
      { channel: 'reception', actor: 'contracted_user', reception_id: 'r', contract_id: 'c' },
      { channel: 'reception', actor: 'anonymous', reception_id: 'r' },
      // D-209 #1 W3 — webhook is an ANONYMOUS door source: door-less (unstamped
      // trigger row, floors to PUBLIC_CONTRACT_ID) and door-stamped both valid.
      { channel: 'webhook', actor: 'anonymous', vendor: 'hubspot', webhook_secret_id: 'wh' },
      { channel: 'webhook', actor: 'anonymous', vendor: 'hubspot', webhook_secret_id: 'wh', contract_id: 'door-wh' },
      { channel: 'schedule', actor: 'system', cron: '0 9 * * 1-5', source_recipe: 'standup' },
      { channel: 'reactive', actor: 'system', event_kind: 'mail.created', source_recipe: 'classifier' },
      { channel: 'housekeeping', actor: 'system', cycle_id: 'cy-1', task: 'audit-compaction', visible_to_user: false },
    ];
    for (const s of samples) expect(isExecutionSource(s)).toBe(true);
  });

  it('rejects shapes missing channel or actor', () => {
    expect(isExecutionSource(null)).toBe(false);
    expect(isExecutionSource(undefined)).toBe(false);
    expect(isExecutionSource({})).toBe(false);
    expect(isExecutionSource({ channel: 'chat' })).toBe(false);
    expect(isExecutionSource({ actor: 'user_self' })).toBe(false);
    expect(isExecutionSource({ channel: 'invalid', actor: 'user_self' })).toBe(false);
    expect(isExecutionSource({ channel: 'chat', actor: 'invalid' })).toBe(false);
    expect(isExecutionSource(['chat', 'user_self'])).toBe(false);
  });

  it('rejects actor mismatches per variant', () => {
    // mcp only admits contracted_user — never anonymous / user_self / system
    expect(isExecutionSource({
      channel: 'mcp', actor: 'anonymous',
      agent_id: 'a', tool_call_id: 'tc', mcp_token_id: 'mt', contract_id: 'c',
    })).toBe(false);
    expect(isExecutionSource({
      channel: 'mcp', actor: 'user_self',
      agent_id: 'a', tool_call_id: 'tc', mcp_token_id: 'mt', contract_id: 'c',
    })).toBe(false);
    // user admits user_self only — never contracted_user (D-161 Part A)
    expect(isExecutionSource({
      channel: 'user', actor: 'contracted_user',
      user_id: 'u', client_token_id: 't',
    })).toBe(false);
    // webhook requires actor=anonymous (D-209 #1 W3 — an external vendor's
    // dispatch under a door, never the server's own system or the owner)
    expect(isExecutionSource({
      channel: 'webhook', actor: 'user_self',
      vendor: 'hubspot', webhook_secret_id: 'wh',
    })).toBe(false);
    expect(isExecutionSource({
      channel: 'webhook', actor: 'system',
      vendor: 'hubspot', webhook_secret_id: 'wh',
    })).toBe(false);
    // schedule / reactive / housekeeping require actor=system
    expect(isExecutionSource({
      channel: 'housekeeping', actor: 'user_self',
      cycle_id: 'cy', task: 'audit-compaction', visible_to_user: false,
    })).toBe(false);
    // reception admits contracted_user / anonymous — never user_self
    expect(isExecutionSource({
      channel: 'reception', actor: 'user_self', reception_id: 'r',
    })).toBe(false);
  });

  it('rejects shapes missing per-variant required fields', () => {
    // mcp requires contract_id (not optional unlike other contracts)
    expect(isExecutionSource({
      channel: 'mcp', actor: 'contracted_user',
      agent_id: 'a', tool_call_id: 'tc', mcp_token_id: 'mt',
    })).toBe(false);
    // mcp partial — actor + channel only, no required fields
    expect(isExecutionSource({ channel: 'mcp', actor: 'contracted_user' })).toBe(false);
    // user missing user_id
    expect(isExecutionSource({
      channel: 'user', actor: 'user_self', client_token_id: 't',
    })).toBe(false);
    // chat missing chat_session_id
    expect(isExecutionSource({
      channel: 'chat', actor: 'user_self', user_id: 'u',
    })).toBe(false);
    // webhook missing webhook_secret_id
    expect(isExecutionSource({
      channel: 'webhook', actor: 'anonymous', vendor: 'hubspot',
    })).toBe(false);
    // schedule missing source_recipe
    expect(isExecutionSource({
      channel: 'schedule', actor: 'system', cron: '0 9 * * 1-5',
    })).toBe(false);
  });

  it('requires contract_id on every contracted_user variant (D-153 (channel × actor × contract_id) policy key; D-161 O-6)', () => {
    // `contract_id` stays structurally REQUIRED wherever the actor is
    // `contracted_user` — the tightening D-161 O-6 keeps over the looser
    // channel-keyed form. (A self-restricted user_self carries an
    // OPTIONAL contract_id — covered by the accepts test above.)
    expect(isExecutionSource({
      channel: 'chat', actor: 'contracted_user',
      chat_session_id: 's', user_id: 'u',
    })).toBe(false);
    expect(isExecutionSource({
      channel: 'messenger', actor: 'contracted_user',
      vendor: 'slack', from: 'u',
    })).toBe(false);
    expect(isExecutionSource({
      channel: 'reception', actor: 'contracted_user',
      reception_id: 'r',
    })).toBe(false);
    expect(isExecutionSource({
      channel: 'mcp', actor: 'contracted_user',
      agent_id: 'a', tool_call_id: 'tc', mcp_token_id: 'mt',
    })).toBe(false);
  });

  it('still accepts non-contracted variants without contract_id (split-union invariant)', () => {
    // The split must not regress the non-contracted side — these
    // shapes intentionally carry no contract_id field at all.
    expect(isExecutionSource({
      channel: 'user', actor: 'user_self',
      user_id: 'u', client_token_id: 't',
    })).toBe(true);
    expect(isExecutionSource({
      channel: 'chat', actor: 'user_self',
      chat_session_id: 's', user_id: 'u',
    })).toBe(true);
    expect(isExecutionSource({
      channel: 'messenger', actor: 'user_self',
      vendor: 'slack', from: 'u',
    })).toBe(true);
    expect(isExecutionSource({
      channel: 'reception', actor: 'anonymous',
      reception_id: 'r',
    })).toBe(true);
  });

  it('rejects per-variant fields with wrong primitive type', () => {
    // messenger.vendor must be a declared messenger vendor (discord is undeclared)
    expect(isExecutionSource({
      channel: 'messenger', actor: 'user_self', vendor: 'not_a_transport', from: 'u',
    })).toBe(false);
    // housekeeping.visible_to_user must be the literal `false`
    expect(isExecutionSource({
      channel: 'housekeeping', actor: 'system',
      cycle_id: 'cy', task: 'audit-compaction', visible_to_user: true,
    })).toBe(false);
    expect(isExecutionSource({
      channel: 'housekeeping', actor: 'system',
      cycle_id: 'cy', task: 'audit-compaction',
    })).toBe(false);
    // user.client_token_id must be a string, not a number
    expect(isExecutionSource({
      channel: 'user', actor: 'user_self', user_id: 'u', client_token_id: 42,
    })).toBe(false);
    // reception.visitor_id, when present, must be a string (optional)
    expect(isExecutionSource({
      channel: 'reception', actor: 'contracted_user',
      reception_id: 'r', visitor_id: 42, contract_id: 'c',
    })).toBe(false);
    // chat.contract_id, when present, must be a string (optional)
    expect(isExecutionSource({
      channel: 'chat', actor: 'contracted_user',
      chat_session_id: 's', user_id: 'u', contract_id: 42,
    })).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// ContractSnapshot — structural shape only (no behavioral checks)
// ────────────────────────────────────────────────────────────────

describe('ContractSnapshot', () => {
  it('accepts the minimum required fields with empty allow-lists', () => {
    // Compile-time assertion only — if the interface ever drops a
    // required field this assignment surfaces it.
    const snapshot: ContractSnapshot = {
      contract_id: 'c-1',
      contract_version: '1',
      allowed_tools: [],
      approval_required: [],
      scope_restrictions: [],
      resolved_at: 1_700_000_000_000,
    };
    expect(snapshot.contract_id).toBe('c-1');
    expect(snapshot.allowed_tools).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Exhaustiveness — compile-time assertions that each closed list
// matches its derived literal-union arity. If the list grows but the
// union doesn't (or vice versa) these assignments fail to compile.
// ────────────────────────────────────────────────────────────────

describe('closed-list exhaustiveness', () => {
  it('every CommitKind literal appears in COMMIT_KINDS', () => {
    const sample: Record<CommitKind, true> = {
      action: true,
      query: true,
      cognition_output: true,
    };
    expect(Object.keys(sample).length).toBe(COMMIT_KINDS.length);
  });

  it('every CommitStatus literal appears in COMMIT_STATUSES', () => {
    const sample: Record<CommitStatus, true> = {
      pending: true,
      running: true,
      succeeded: true,
      failed: true,
      cancelled: true,
      killed: true,
      in_doubt: true,
    };
    expect(Object.keys(sample).length).toBe(COMMIT_STATUSES.length);
  });

  it('every Actor literal appears in ACTORS', () => {
    const sample: Record<Actor, true> = {
      user_self: true,
      contracted_user: true,
      system: true,
      anonymous: true,
    };
    expect(Object.keys(sample).length).toBe(ACTORS.length);
  });

  it('every Channel literal appears in CHANNELS', () => {
    const sample: Record<Channel, true> = {
      user: true,
      chat: true,
      mcp: true,
      messenger: true,
      reception: true,
      webhook: true,
      schedule: true,
      reactive: true,
      housekeeping: true,
    };
    expect(Object.keys(sample).length).toBe(CHANNELS.length);
  });
});
