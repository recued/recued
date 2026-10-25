/** D-329 §3.4 — where the write rules meet the holds.
 *
 *  An answered Tier-1 hold teaches its rule key (`recordWriteRuleAnswer`, called by the
 *  resumer on approve and on deny), and the gates that hold a Tier-1 write — the chat's and
 *  the MCP door's — let a live rule stand in for the ask (`useWriteRule`), spending one use.
 *  The store and the evidence rule are in `storage/write-rule-store.ts` and
 *  `@recued/contracts`'s `write-approval-rule.ts`.
 *
 *  ⚠ LEARNING NEVER COSTS THE ANSWER. A store that fails is logged, and the write's own
 *  outcome is untouched: a rule not learned is friction (the next one asks), never harm. */

import {
  describeWriteRule,
  writeRuleKeyOf,
  writeRuleOccasionOf,
  type Checkpoint,
  type ExecutionSource,
  type WriteRuleKey,
  type WriteRuleRow,
} from '@recued/contracts';
import type { PreflightNotifier } from '@recued/gateway';

import type { WriteRuleStore } from './storage/write-rule-store.js';

/** The owner, told once, when a key's suggestion opens. */
export const writeRuleSuggestedNotice = (key: WriteRuleKey): { title: string; text: string } => {
  const { action, on } = describeWriteRule(key);
  const who = key.principal.kind === 'owner_chat' ? 'your chats' : 'an AI app';
  return {
    title: `A rule Recued suggests: ${action}`,
    text: `You have approved "${action}"${on !== undefined ? ` for ${on}` : ''}, asked by ${who}, `
      + 'again and again this month. You can let it happen without asking, for up to 30 days: '
      + 'see Rules Recued suggests, under Contracts. Until you do, it keeps asking.',
  };
};

/** Teach a held Tier-1 write's key the owner's answer. A hold that is not a Tier-1 write, or
 *  one whose call names no key (a chat under a contract, an unknown tool), teaches nothing. */
export const recordWriteRuleAnswer = (
  deps: {
    readonly writeRules?: WriteRuleStore;
    readonly preflightNotifier?: Pick<PreflightNotifier, 'notify'>;
    /** The raw-op seam's clock (`RawOpDispatchDeps.now`), when a test pins one. */
    readonly now?: () => number;
  } | undefined,
  checkpoint: Checkpoint,
  outcome: 'approved' | 'refused',
): void => {
  const raw = checkpoint.raw_op;
  const tool = raw?.tier1_tool;
  if (raw === undefined || tool === undefined || deps?.writeRules === undefined) return;
  const now = (deps.now ?? Date.now)();
  const key = writeRuleKeyOf(raw.execution_source, tool, raw.op_args);
  if (key === undefined) return;
  let suggested = false;
  try {
    suggested = deps.writeRules.recordAnswer({
      run_id: checkpoint.run_id,
      key,
      outcome,
      occasion: writeRuleOccasionOf(raw.execution_source, now),
      at: now,
    }).suggested;
  } catch (error) {
    console.warn(`[write-rules] the answer to '${tool}' was not kept: `
      + (error instanceof Error ? error.message : String(error)));
    return;
  }
  if (suggested && deps.preflightNotifier !== undefined) {
    void deps.preflightNotifier.notify(writeRuleSuggestedNotice(key)).catch(() => undefined);
  }
};

/** Spend one use of the live rule that stands in for this held write's ask, if one does. */
export const useWriteRule = (
  store: WriteRuleStore | undefined,
  source: ExecutionSource,
  tool: string,
  args: unknown,
  now: number = Date.now(),
): WriteRuleRow | undefined => {
  if (store === undefined) return undefined;
  const key = writeRuleKeyOf(source, tool, args);
  if (key === undefined) return undefined;
  try {
    return store.use(key, now);
  } catch (error) {
    // Unknown is "ask": a rule that cannot be read never admits a write.
    console.warn(`[write-rules] the rule for '${tool}' could not be read: `
      + (error instanceof Error ? error.message : String(error)));
    return undefined;
  }
};
