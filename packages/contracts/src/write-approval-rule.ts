/** D-329 §3.4 — the write rules an AI's approvals teach: the PURE vocabulary.
 *
 *  Every Tier-1 write an AI proposes is held behind an approval (D-329 §3.1). The owner who
 *  says yes to the same kind of write again and again is asking for a standing rule, so
 *  each answer is kept against the write's rule key, and three approvals on three
 *  occasions within 30 days, with no refusal among them, suggest one. Only the owner mints
 *  it (accept), bounded to 30 days and 100 uses and tighter if they choose; a held write the
 *  rule matches then runs without asking and spends one use. Dismissing a suggestion, or
 *  revoking a rule, ends that key's suggestions for good.
 *
 *  ⛔ NOT D-177'S DELEGATION RULE. That one is recipe-bound (its key names a recipe, its
 *  hash and an ingredient) and is matched by the Gateway's preflight. A Tier-1 write is held
 *  by the chat's and the MCP door's own gate and never reaches that matcher, so its rule is
 *  its own row, matched by those two gates.
 *
 *  🔑 THE KEY IS WHO × WHAT × WHAT ON. Who: the owner's own chats (the app's and the
 *  messengers', one key, since they are one person) or one AI app (its contract), so one
 *  app's approvals never teach another, nor the owner's chat. What: the tool. What on: the
 *  kind of thing it writes (a task, a passport), the calendar it writes to, or nothing for
 *  a tool with one target. Anything else derives no key and so learns nothing: an unknown
 *  tool fails closed, never into a wider rule.
 *
 *  🔑 AN OCCASION IS A CONVERSATION ON A DAY. Three yeses in one sitting are one occasion:
 *  repetition across time is the pain a standing rule removes. A messenger chat is one long
 *  conversation, so its days count; so are an AI app's.
 *
 *  Everything here is pure: no I/O, no clock (callers pass `now`). */

import { canonicalJSONStringify } from '@recued/crypto/canonical-json';
import { sha256Hex } from '@recued/crypto/hash';

import { TIER1_TOOL_GUIDE } from './grant-switch-guide.js';
import type { ExecutionSource } from './commits.js';
import { executionSourceContractId } from './commits.js';

/** Approvals, on distinct occasions, before a rule is suggested (D-177's threshold). */
export const WRITE_RULE_SUGGEST_THRESHOLD = 3;
/** The window approvals count in, and a refusal suppresses in. */
export const WRITE_RULE_LOOKBACK_MS = 30 * 86_400_000;
/** A minted rule's ceilings; the owner may tighten both, never widen them. */
export const WRITE_RULE_TTL_MS = 30 * 86_400_000;
export const WRITE_RULE_MAX_USES = 100;

/** The Tier-1 writes a rule can be learned for, each with what its scope names. */
export const WRITE_RULE_TOOLS = [
  'work.create',
  'work.update',
  'calendar.create',
  'calendar.update',
  'recipe.stop',
  'recipe.schedule',
  'memory.write',
  'memory.forget',
] as const;
export type WriteRuleTool = (typeof WRITE_RULE_TOOLS)[number];
const WRITE_RULE_TOOL_SET: ReadonlySet<string> = new Set(WRITE_RULE_TOOLS);
export const isWriteRuleTool = (tool: unknown): tool is WriteRuleTool =>
  typeof tool === 'string' && WRITE_RULE_TOOL_SET.has(tool);

/** Who learns: the owner's own chats, or one AI app by its contract. */
export type WriteRulePrincipal =
  | { readonly kind: 'owner_chat' }
  | { readonly kind: 'ai_app'; readonly contract_id: string };

export interface WriteRuleKey {
  readonly principal: WriteRulePrincipal;
  readonly tool: WriteRuleTool;
  /** What the tool writes on: a work kind (`task`, `asset:passport`), a calendar id
   *  (`local` for Recued's own), the recipe a schedule runs, or `''` for a tool with one
   *  target (the memory tools, `recipe.stop`). */
  readonly scope: string;
}

/** The principal a source learns as, or none: a chat under a contract (a household
 *  member's, a customer's, the owner's own self-restricted one) and every other channel
 *  hold no Tier-1 write that a rule could stand in for. */
export const writeRulePrincipalOf = (source: ExecutionSource): WriteRulePrincipal | undefined => {
  if (source.channel === 'mcp') return { kind: 'ai_app', contract_id: source.contract_id };
  if ((source.channel === 'chat' || source.channel === 'messenger')
    && source.actor === 'user_self' && executionSourceContractId(source) === undefined) {
    return { kind: 'owner_chat' };
  }
  return undefined;
};

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** What a call writes on, as its rule scope; `undefined` when the call says too little to
 *  be learned from (no kind, an unknown tool). */
export const writeRuleScopeOf = (tool: string, args: unknown): string | undefined => {
  const record = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
  switch (tool) {
    case 'work.create':
    case 'work.update': {
      if (!nonEmpty(record.kind)) return undefined;
      if (record.kind !== 'asset' || tool === 'work.update') return record.kind;
      return nonEmpty(record.type) ? `asset:${record.type}` : undefined;
    }
    case 'calendar.create':
    case 'calendar.update':
      return nonEmpty(record.calendar_id) ? record.calendar_id : 'local';
    // One schedule rule per recipe: "schedule the weekly report without asking" is not
    // "schedule anything".
    case 'recipe.schedule':
      return nonEmpty(record.recipe_id) ? record.recipe_id : undefined;
    case 'recipe.stop':
    case 'memory.write':
    case 'memory.forget':
      return '';
    default:
      return undefined;
  }
};

export const writeRuleKeyOf = (
  source: ExecutionSource,
  tool: string,
  args: unknown,
): WriteRuleKey | undefined => {
  if (!isWriteRuleTool(tool)) return undefined;
  const principal = writeRulePrincipalOf(source);
  const scope = writeRuleScopeOf(tool, args);
  return principal === undefined || scope === undefined ? undefined : { principal, tool, scope };
};

export const writeRuleKeyHash = (key: WriteRuleKey): string => sha256Hex(canonicalJSONStringify({
  principal: key.principal.kind === 'ai_app'
    ? { kind: 'ai_app', contract_id: key.principal.contract_id }
    : { kind: 'owner_chat' },
  tool: key.tool,
  scope: key.scope,
}));

/** The occasion an answer counts on: the conversation it came from, and its (UTC) day. */
export const writeRuleOccasionOf = (source: ExecutionSource, at: number): string => {
  const day = Math.floor(at / 86_400_000);
  const conversation = source.channel === 'chat'
    ? `chat:${source.chat_session_id}`
    : source.channel === 'messenger'
      ? `messenger:${source.vendor}:${source.from}`
      : source.channel === 'mcp'
        ? `mcp:${source.mcp_token_id}`
        : source.channel;
  return `${conversation}|${day}`;
};

export interface WriteRuleAnswer {
  readonly outcome: 'approved' | 'refused';
  readonly occasion: string;
  readonly at: number;
}

export interface WriteRuleEvidence {
  /** Approvals in the window. */
  readonly approvals: number;
  /** Distinct occasions among them. */
  readonly occasions: number;
  /** A refusal in the window: suppresses the suggestion until it ages out. */
  readonly refused: boolean;
  readonly first_at?: number;
  readonly last_at?: number;
  readonly suggest: boolean;
}

export const evaluateWriteRuleEvidence = (
  answers: readonly WriteRuleAnswer[],
  now: number,
): WriteRuleEvidence => {
  const recent = answers.filter((answer) => answer.at >= now - WRITE_RULE_LOOKBACK_MS && answer.at <= now);
  const approved = recent.filter((answer) => answer.outcome === 'approved');
  const refused = recent.some((answer) => answer.outcome === 'refused');
  const occasions = new Set(approved.map((answer) => answer.occasion)).size;
  const times = approved.map((answer) => answer.at);
  return {
    approvals: approved.length,
    occasions,
    refused,
    ...(times.length > 0 ? { first_at: Math.min(...times), last_at: Math.max(...times) } : {}),
    suggest: !refused && occasions >= WRITE_RULE_SUGGEST_THRESHOLD,
  };
};

/** An open suggestion, as the owner's Contracts page lists it. */
export interface WriteRuleSuggestionRow {
  readonly key_hash: string;
  readonly key: WriteRuleKey;
  readonly evidence: WriteRuleEvidence;
  readonly suggested_at: number;
}

/** A minted rule. `uses_remaining` reaches 0, `expires_at` passes, or `revoked_at` is set:
 *  any of the three ends it. */
export interface WriteRuleRow {
  readonly rule_id: string;
  readonly key_hash: string;
  readonly key: WriteRuleKey;
  readonly created_at: number;
  readonly expires_at: number;
  readonly max_uses: number;
  readonly uses_remaining: number;
  readonly revoked_at?: number;
}

export const isWriteRuleLive = (rule: WriteRuleRow, now: number): boolean =>
  rule.revoked_at === undefined && rule.uses_remaining > 0 && rule.expires_at > now;

/** A rule in the owner's words: what it lets happen, and what on. */
export const describeWriteRule = (key: WriteRuleKey): { readonly action: string; readonly on?: string } => {
  const action = TIER1_TOOL_GUIDE[key.tool].title;
  if (key.tool === 'calendar.create' || key.tool === 'calendar.update') {
    return { action, on: key.scope === 'local' ? 'your Recued calendar' : `the calendar ${key.scope}` };
  }
  if (key.tool === 'work.create' || key.tool === 'work.update') {
    const [kind, type] = key.scope.split(':');
    return { action, on: type !== undefined ? `${kind} (${type})` : kind! };
  }
  if (key.tool === 'recipe.schedule') return { action, on: `the recipe ${key.scope}` };
  return { action };
};
