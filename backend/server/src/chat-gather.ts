/** D-177 §N.15.9 — a round of the owner's chat gathers its held calls of one op, and asks once
 *  (Q7; the owner, 2026-11-10: *"After each round"*).
 *
 *  A round gathers only when it repeats a call (`gatherCallKey`: the same tool, recipe or op more
 *  than once). There, a held call's ask is not raised: the hold (checkpoint, anchor, receipt) joins
 *  the round's gather (`deferToRound`), keyed on its op as its gate names it, and its recipe. When
 *  the round ends (`raiseRoundGather`), each op's members are asked once: one member as its hold
 *  would have, two or more in one approval (`raiseGatheredPreflightAsk`). A round with one held call
 *  never comes here: its ask goes out at once, as before.
 *
 *  Ordering is slice K's (D-337): a call of the round that would ask on another op is not asked,
 *  and once one is not asked the gather takes no more members (`closeRoundGather`), so nothing put
 *  to the owner jumps ahead of a call held back.
 *
 *  The round's scratch lives in the turn's `turn_state` (process-local, never stored or sent). A
 *  member is never stranded without an ask: the next round's start and the turn's end raise what a
 *  round left, and a stopped server's boot sweep raises each hold's own ask.
 *
 *  A kept call's result is formed before its ask exists, so it cannot say where the ask went
 *  (D-329: "on Telegram, where this conversation is"). Its handler leaves how it reads once that is
 *  known (`readsOnceAsked`), and the round's end gives it that (`heldOnceAsked`), so the model is
 *  told what a single held call's result tells it. */

import { TIER1_HOLD_CATALOG_SLUG, triggerPreapprovalTier1Op, type ChatDispatchResult } from '@recued/contracts';
import {
  raiseGatheredPreflightAsk,
  raisePreflightAsk,
  type GatheredHoldAsk,
  type PreflightNotifier,
} from '@recued/gateway';

import { conversationCarriesOn, earlierCallWaits, ROUND_GATHER_STATE } from './chat-carries-on.js';
import { isRunQuestionGatherKey, raiseGatheredRunQuestionAsk } from './run-question.js';

/** One held call kept for its round's end. */
export interface DeferredHold extends GatheredHoldAsk {
  readonly run_id: string;
  /** The op as its gate names it (ingredient, operation, connection) and the recipe that made the
   *  call, if any: what the members of one approval share. */
  readonly op_key: string;
  /** The notification block the hold would have asked through. */
  readonly notifier: PreflightNotifier;
  /** Record a raised ask's id on the hold (its anchor, its receipt), as its own raise would. */
  readonly link: (ask_id: string) => Promise<void>;
  /** Where a raised ask went (D-329), read as the hold's own raise reads it. */
  readonly askChannels?: (ask_id: string) => Promise<readonly string[] | undefined>;
}

/** A kept hold, as its round knows it: the call that made it. */
export interface RoundMember extends DeferredHold {
  readonly tool_name: string;
  readonly call_key: string;
  /** The call's result once its ask is out, told where the ask went as a single held call's is.
   *  Its handler sets it when the run returns (`readsOnceAsked`). */
  onceAsked?: (approval_channels: readonly string[]) => ChatDispatchResult;
}

/** A kept hold whose ask went out: the ask's id, and where it went, when that could be read. */
export interface RaisedMember extends RoundMember {
  readonly ask_id: string;
  readonly approval_channels?: readonly string[];
}

interface RoundGather {
  readonly round_index: number;
  /** The call keys that appear more than once in the round. */
  readonly repeats: ReadonlySet<string>;
  readonly members: RoundMember[];
  /** A call of the round was not asked: no more members. */
  closed: boolean;
}

/** The key the members of one gathered approval share: the op as its gate names it (ingredient,
 *  operation, connection) and the recipe that made the call, if any, so the approval's words (its
 *  recipe's title, its op, its account) are every member's. */
export const gatherOpKey = (op: {
  readonly ingredient_slug: string;
  readonly operation_id?: string;
  readonly connection_name?: string;
  readonly recipe_id?: string;
}): string => JSON.stringify([op.ingredient_slug, op.operation_id ?? '', op.connection_name ?? '', op.recipe_id ?? '']);

/** D-177 §N.15.9 (1c-b) — what a chat's own held write is gathered by: the kind its "Allow in this
 *  chat" names (`triggerPreapprovalTier1Op`: `work.create:task`), so one answer to the round's
 *  approval covers every member; a write no kind names, by its tool. */
export const tier1GatherOpKey = (tool: string, args: unknown): string =>
  gatherOpKey({ ingredient_slug: TIER1_HOLD_CATALOG_SLUG, operation_id: triggerPreapprovalTier1Op(tool, args) ?? tool });

/** The key a round's repeated calls are found by: `recipe.run` by its recipe (its id, or one written
 *  in the call); any other tool by its name, which already says which recipe, pack op or
 *  vendor-neutral op it is. */
export const gatherCallKey = (tool_name: string, args: unknown): string => {
  if (tool_name !== 'recipe.run') return tool_name;
  const given = args !== null && typeof args === 'object' ? args as { recipe_id?: unknown; recipe?: unknown } : {};
  const which = typeof given.recipe_id === 'string' ? given.recipe_id : given.recipe !== undefined ? '(written)' : '';
  return `recipe.run:${which}`;
};

const roundOf = (turn_state: Map<string, unknown> | undefined): RoundGather | undefined => {
  const round = turn_state?.get(ROUND_GATHER_STATE);
  return round !== undefined && round !== null && typeof round === 'object' ? round as RoundGather : undefined;
};

/** A round starts: note which of its calls repeat. Returns what an earlier round left ungathered,
 *  to be raised before this one runs (`raiseRoundGather`). */
export const beginRoundGather = (
  turn_state: Map<string, unknown> | undefined,
  round_index: number,
  calls: ReadonlyArray<{ readonly tool: string; readonly args: unknown }>,
): ReadonlyArray<RoundMember> => {
  if (turn_state === undefined) return [];
  const left = roundOf(turn_state)?.members ?? [];
  const counts = new Map<string, number>();
  for (const call of calls) {
    const key = gatherCallKey(call.tool, call.args);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeats = new Set([...counts].filter(([, n]) => n > 1).map(([key]) => key));
  turn_state.set(ROUND_GATHER_STATE, { round_index, repeats, members: [], closed: false } satisfies RoundGather);
  return [...left];
};

/** The round's kept holds, taken for raising; the round keeps none after. */
export const takeRoundGather = (turn_state: Map<string, unknown> | undefined): ReadonlyArray<RoundMember> => {
  const round = roundOf(turn_state);
  if (round === undefined) return [];
  const members = [...round.members];
  round.members.length = 0;
  return members;
};

/** Does this call's hold wait for its round's end? Only in a conversation that carries on (the
 *  owner's own), for a call the round repeats, while the round still gathers. */
export const gathersInRound = (
  turn_state: Map<string, unknown> | undefined,
  source: unknown,
  tool_name: string,
  args: unknown,
): boolean => {
  if (!conversationCarriesOn(source)) return false;
  const round = roundOf(turn_state);
  return round !== undefined && !round.closed && round.repeats.has(gatherCallKey(tool_name, args));
};

/** May a call the round repeats go ahead and hold, to be gathered? Only while the round gathers, no
 *  call of an earlier round waits (slice K holds it back then), and the round holds nothing yet or
 *  holds this call's own kind (its call key; its op, when known). */
export const roundAccepts = (
  turn_state: Map<string, unknown> | undefined,
  call_key: string,
  op_key?: string,
): boolean => {
  const round = roundOf(turn_state);
  if (round === undefined || round.closed || earlierCallWaits(turn_state)) return false;
  const [first] = round.members;
  return first === undefined || (first.call_key === call_key && (op_key === undefined || first.op_key === op_key));
};

/** Keep a hold for its round's end. `false` when the round takes it no longer (closed, or another
 *  op's): its own ask is raised then, as before, and the round takes no more. */
export const deferToRound = (turn_state: Map<string, unknown> | undefined, member: RoundMember): boolean => {
  const round = roundOf(turn_state);
  if (round === undefined || round.closed) return false;
  const [first] = round.members;
  if (first !== undefined && (first.op_key !== member.op_key || first.call_key !== member.call_key)) {
    round.closed = true;
    return false;
  }
  round.members.push(member);
  return true;
};

/** Was this run's hold kept for its round's end? */
export const keptForRound = (turn_state: Map<string, unknown> | undefined, run_id: string | undefined): boolean =>
  run_id !== undefined && (roundOf(turn_state)?.members.some((member) => member.run_id === run_id) ?? false);

/** How a kept call's held result reads once the round's ask is out and where it went is known: as
 *  its handler would have formed it had the call asked on its own (D-329). */
export const readsOnceAsked = (
  turn_state: Map<string, unknown> | undefined,
  run_id: string,
  onceAsked: (approval_channels: readonly string[]) => ChatDispatchResult,
): void => {
  const member = roundOf(turn_state)?.members.find((kept) => kept.run_id === run_id);
  if (member !== undefined) member.onceAsked = onceAsked;
};

/** The held result a raised member's call reads on with: told where its ask went, when that is
 *  known; else as it was. */
export const heldOnceAsked = (member: RaisedMember, held: ChatDispatchResult): ChatDispatchResult =>
  member.onceAsked !== undefined && member.approval_channels !== undefined && member.approval_channels.length > 0
    ? member.onceAsked(member.approval_channels)
    : held;

/** The round's key among its turn's rounds (`round-<n>`): the cards of the chat's own writes it
 *  gathers share it, with their turn (`ChatPlanProposal.hold.group`). `undefined` outside a round. */
export const roundGroupKey = (turn_state: Map<string, unknown> | undefined): string | undefined => {
  const round = roundOf(turn_state);
  return round === undefined ? undefined : `round-${String(round.round_index)}`;
};

/** A chat's own held write names its plan on its result, not its run. The run it was held as is
 *  kept beside the result here, host-internal (a symbol key, so it is never sent or shown to the
 *  model), for the round's end to find the result of each hold it raised (`heldRunOf`). */
const HELD_RUN: unique symbol = Symbol('recued.chat_gather.held_run');

export const withHeldRun = (result: ChatDispatchResult, run_id: string): ChatDispatchResult =>
  Object.assign(result, { [HELD_RUN]: run_id });

/** The run a round's held call was held as: kept beside a chat's own write (`withHeldRun`), else the
 *  result's own. */
export const heldRunOf = (result: ChatDispatchResult | undefined): string | undefined => {
  if (result === undefined) return undefined;
  const kept = (result as { [HELD_RUN]?: unknown })[HELD_RUN];
  return typeof kept === 'string' ? kept : result.run_id;
};

/** A call of the round was not asked: the round takes no more members. */
export const closeRoundGather = (turn_state: Map<string, unknown> | undefined): void => {
  const round = roundOf(turn_state);
  if (round !== undefined) round.closed = true;
};

/** The call the round holds first, while it holds any: a further call that would ask waits after
 *  it (slice K), as after a call held in an earlier round. */
export const roundHoldsFirst = (turn_state: Map<string, unknown> | undefined): string | undefined =>
  roundOf(turn_state)?.members[0]?.tool_name;

/** Raise the asks of a round's kept holds: one approval per op (and recipe), its members in the
 *  order they held; one member asks as its hold would have. Each hold records the ask's id. A raise
 *  that fails leaves its holds to the boot sweep, which raises each one's own ask. Returns the
 *  members whose ask went out, each with the ask's id and where it went (best effort, as a hold's
 *  own raise reads it). */
export const raiseRoundGather = async (members: ReadonlyArray<RoundMember>): Promise<ReadonlyArray<RaisedMember>> => {
  const groups = new Map<string, RoundMember[]>();
  for (const member of members) {
    const group = groups.get(member.op_key);
    if (group === undefined) groups.set(member.op_key, [member]);
    else group.push(member);
  }
  const raised: RaisedMember[] = [];
  for (const group of groups.values()) {
    const [lead] = group;
    if (lead === undefined) continue;
    try {
      // D-402 ruling 13 — the runs of one recipe the round held for the question before a run: one
      // question for them all ("Run “…” 3 times?"), never an approval of a held call.
      const { ask_id } = isRunQuestionGatherKey(lead.op_key)
        ? await raiseGatheredRunQuestionAsk(lead.notifier, group.map((member) => member.checkpoint))
        : group.length === 1
          ? await raisePreflightAsk(lead.notifier, { checkpoint: lead.checkpoint, context: lead.context })
          : await raiseGatheredPreflightAsk(lead.notifier, group);
      for (const member of group) {
        await member.link(ask_id).catch((error: unknown) => {
          console.warn(`[chat-gather] the ask of run ${member.run_id} was not recorded on its hold`, error);
        });
      }
      const approval_channels = await Promise.resolve()
        .then(() => lead.askChannels?.(ask_id))
        .catch(() => undefined);
      raised.push(...group.map((member) => ({
        ...member, ask_id, ...(approval_channels !== undefined ? { approval_channels } : {}),
      })));
    } catch (error) {
      console.warn(`[chat-gather] the gathered ask for ${String(group.length)} held call(s) was not raised; `
        + 'the boot sweep raises each one\'s own', error);
    }
  }
  return raised;
};
