/** Everything ONE approval of a held `foreach` step covers.
 *
 *  A foreach whose item hits the approval gate pauses at that item, and the
 *  approval does not stop there: "an ordinary foreach gate approves the
 *  remaining same-target aggregate" (`step-runner.ts`). Approve once, and every
 *  remaining item of the step that calls the same operation on the same account
 *  runs. The ask showed only the item it paused on — found on a live Meeting
 *  Secretary drive, where approving "send the minutes to Dana" also mailed
 *  everyone else on the list, and the Details named Dana alone.
 *
 *  So the ask now says how many calls the approval covers and lists them. Each
 *  item's arguments are resolved exactly as the gate resolved the held one —
 *  the same identity basis, vault references left as placeholders — and the
 *  result is SELF-CHECKED: the held item's preview computed here must equal the
 *  one the gate attached. If it does not, this cannot claim to show what will
 *  run, so it lists nothing and the ask states only the count.
 *
 *  ⚠ A chunked gate (`egress_bound`) covers its one item only, and a pause
 *  outside the sequential steps is not a foreach this can read: both return
 *  `undefined`, and the ask stays a single-call ask. */

import {
  hashForeachCheckpointSource,
  projectResolvedArgs,
  resolveDeep,
  summarizeArgsPreview,
  type Checkpoint,
  type ForeachCheckpointProgress,
  type IngredientManifest,
  type NamespaceStores,
  type RecipeDefinition,
} from '@recued/contracts';
import { readForeachCover } from '@recued/gateway';

import { actionIdentityBasis } from './action-identity-basis.js';

/** More than this and the ask states the count without listing. The ask body
 *  shows a handful anyway (`BATCH_ASK_RENDER_MAX_ITEMS`); this bounds what the
 *  checkpoint carries for restart recovery. */
export const FOREACH_APPROVAL_MAX_LISTED = 100;

export interface ForeachApprovalCover {
  /** Calls this approval covers: the held item and every remaining one that
   *  targets the same operation and account. */
  readonly total: number;
  /** Their arguments, in order, when they could be shown faithfully. */
  readonly items?: ReadonlyArray<{
    readonly summary: string;
    readonly args_preview: Record<string, unknown>;
  }>;
}

/** Does approving this hold run more than the one call it paused on?
 *
 *  True for a held `foreach` with items after the held one, unless the gate was
 *  chunked (`egress_bound`), which covers its one item. Whatever is decided at
 *  such a hold reaches all of them — including an EDIT: the engine applies
 *  approve-time `arg_overrides` to every remaining item of the gated step, so
 *  correcting the held item's recipient sends every item to that address. */
export const holdCoversSeveralItems = (
  checkpoint: Pick<Checkpoint, 'foreach_progress' | 'preflight_context'>,
): boolean => {
  const progress = checkpoint.foreach_progress;
  return progress !== undefined
    && checkpoint.preflight_context?.egress_bound === undefined
    && progress.source_length - progress.next_index > 1;
};

/** How many calls approving this hold runs — for a hold that covers several
 *  (`holdCoversSeveralItems`), else undefined.
 *
 *  Read from the cover the gate persisted, the way the hold's ask reads it, so
 *  the two state the same count: exact when the calls were listed, otherwise an
 *  upper bound. With no readable cover (an older hold, or one the gate could
 *  not list), the items left in the loop — also an upper bound, since an item
 *  aimed at another account is held and asked about on its own. */
export const holdApprovalCovers = (
  checkpoint: Pick<Checkpoint, 'foreach_progress' | 'preflight_context'>,
): { count: number; exact: boolean } | undefined => {
  const progress = checkpoint.foreach_progress;
  if (progress === undefined || !holdCoversSeveralItems(checkpoint)) return undefined;
  const cover = readForeachCover(checkpoint.preflight_context?.foreach_cover);
  return cover !== undefined
    ? { count: cover.total, exact: cover.items !== undefined }
    : { count: progress.source_length - progress.next_index, exact: false };
};

const sameJson = (a: unknown, b: unknown): boolean => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

export const foreachApprovalCover = (input: {
  /** The recipe the engine ran (op-steps already lowered). */
  readonly recipe: Pick<RecipeDefinition, 'steps'>;
  readonly gated_step_id: string;
  readonly execution_phase?: string;
  readonly progress: ForeachCheckpointProgress;
  /** What the gate attached to the held call. */
  readonly held: {
    readonly args_preview?: Record<string, unknown>;
    readonly connection_name?: string;
    readonly operation_id?: string;
    readonly egress_bound?: unknown;
  };
  /** The run's live stores — `item` is set and restored around each read. */
  readonly stores: NamespaceStores;
  readonly manifest: (slug: string) => IngredientManifest | undefined;
}): ForeachApprovalCover | undefined => {
  const { progress, held } = input;
  if (held.egress_bound !== undefined) return undefined;
  if (input.execution_phase !== undefined && input.execution_phase !== 'sequential') return undefined;
  if (progress.step_id !== input.gated_step_id) return undefined;
  const remaining = progress.source_length - progress.next_index;
  if (!Number.isInteger(remaining) || remaining <= 1) return undefined;

  const countOnly: ForeachApprovalCover = { total: remaining };
  const step = input.recipe.steps.find((s) => s.id === input.gated_step_id) as
    | { foreach?: unknown; ingredient?: unknown; input?: unknown }
    | undefined;
  if (step === undefined || step.foreach === undefined || typeof step.ingredient !== 'string') {
    return countOnly;
  }
  const manifest = input.manifest(step.ingredient);
  if (manifest === undefined || held.args_preview === undefined) return countOnly;
  if (remaining > FOREACH_APPROVAL_MAX_LISTED) return countOnly;

  const stores = input.stores as unknown as Record<string, unknown>;
  const hadItem = Object.prototype.hasOwnProperty.call(stores, 'item');
  const savedItem = stores.item;
  const resolve = (value: unknown): unknown => resolveDeep(value, input.stores, { deferVault: true });
  const stepInput = step.input !== null && typeof step.input === 'object' && !Array.isArray(step.input)
    ? step.input as Record<string, unknown>
    : {};
  // How the gate built its preview depends on the path it took: the commit
  // gateway hashes the whole identity basis (with or without a trusted catalog
  // surface), the catalog gate only the operation's `args`. Rather than guess,
  // each is tried on the HELD item, and the one that reproduces the gate's own
  // preview exactly is used for the rest.
  const methods: ReadonlyArray<() => Record<string, unknown>> = [
    () => actionIdentityBasis(manifest, stepInput, (merged) => resolve(merged) as Record<string, unknown>, { surfaceDispatch: false }),
    () => actionIdentityBasis(manifest, stepInput, (merged) => resolve(merged) as Record<string, unknown>, { surfaceDispatch: true }),
    () => {
      const args = resolve(stepInput.args ?? {});
      return args !== null && typeof args === 'object' && !Array.isArray(args)
        ? args as Record<string, unknown>
        : {};
    },
  ];
  const connectionOf = (): unknown => resolve(
    (step as { connection?: unknown }).connection ?? stepInput.connection,
  );
  try {
    const source = resolveDeep(step.foreach, input.stores);
    if (!Array.isArray(source) || source.length !== progress.source_length) return countOnly;
    if (hashForeachCheckpointSource(source) !== progress.source_hash) return countOnly;

    stores.item = source[progress.next_index];
    const method = methods.find((candidate) => {
      try {
        return sameJson(projectResolvedArgs(candidate()), held.args_preview);
      } catch {
        return false;
      }
    });
    // ⛔ THE SELF-CHECK. No method reproduces the held call exactly, so these
    // would not be the calls that run: say the count, list nothing.
    if (method === undefined) return countOnly;

    const items: Array<{ summary: string; args_preview: Record<string, unknown> }> = [];
    for (let index = progress.next_index; index < source.length; index += 1) {
      stores.item = source[index];
      // A different account is a different target: that item will be held and
      // asked about on its own, so this approval does not cover it.
      const connection = connectionOf();
      if (
        index !== progress.next_index
        && held.connection_name !== undefined
        && typeof connection === 'string'
        && connection !== held.connection_name
      ) continue;
      const preview = projectResolvedArgs(method());
      items.push({ summary: summarizeArgsPreview(preview), args_preview: preview });
    }
    if (items.length <= 1) return undefined;
    return { total: items.length, items };
  } catch {
    return countOnly;
  } finally {
    if (hadItem) stores.item = savedItem;
    else delete stores.item;
  }
};
