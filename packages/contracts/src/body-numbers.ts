/** D-339 slice 12a (D-339 §5.6) — who may read a Body's numbers: the read held at
 *  `always` (a Body's daily readings, every measurement and source), with one switch for the owner's
 *  chats on every Body page: Off · Ask · Allow.
 *
 *  - **Off** is the read's recipe switched off in the owner's own contract (Self (you) → Recipes on the
 *    Contracts page): it leaves their chats' tool list, and a call by name is refused. The first gate is
 *    the tool's grant. The recipe is the only way a chat reaches the read: a Records action is never
 *    offered to a model on its own (D-221 §3.3), and a granted recipe covers its own steps however the
 *    action's switch is set, so that switch is left alone. The pack has one such recipe.
 *  - **Ask** is the recipe switched on, and each read asks, as the hold says.
 *  - **Allow** is the recipe switched on, and the owner's chats read without asking: a standing
 *    permission for that caller alone, never an override of the hold for every caller (an AI app keeps
 *    asking).
 *
 *  It is about the owner's chats only: the app's own chat and the messengers (`writeRulePrincipalOf`'s
 *  `owner_chat`). The owner's own clicks are no AI's and are outside the owner's contract; an AI app
 *  has its contract's switches (slice 12c). */

export const BODY_NUMBERS_MODES = ['off', 'ask', 'allow'] as const;
export type BodyNumbersMode = (typeof BODY_NUMBERS_MODES)[number];
export const isBodyNumbersMode = (value: unknown): value is BodyNumbersMode =>
  typeof value === 'string' && (BODY_NUMBERS_MODES as readonly string[]).includes(value);

/** A new server: every read asks. The pack's install switches its recipe on for the owner. */
export const BODY_NUMBERS_DEFAULT_MODE: BodyNumbersMode = 'ask';

/** The held read, as the gate and the owner's switches name it. */
export const BODY_NUMBERS_OPERATION_ID = 'recued-core.body-signals.daily_metric.history';

/** The recipe the owner's chats read it through: its publisher and id, its tool name being
 *  `<publisher>/<recipe_id>`. */
export const BODY_NUMBERS_RECIPE = { publisher_id: 'recued-core', recipe_id: 'read-body-signals' } as const;

/** Where the owner changes it, as a model tells them. */
export const BODY_NUMBERS_TURN_ON_UNDER = 'Body numbers, on any Body\'s page in Yours';

/** D-339 slice 12a — the catalog gate's question for a read held at its own `always`: does the owner
 *  let this run's caller make it without asking? Asked in the ask branch only, after no session grant,
 *  trigger pre-approval or chain rule stood in (none of them covers an `always` hold), for a read the
 *  op declares `approval: 'always'` and no review lifted. The host answers from the run, never the
 *  call: who is calling from the run's source, and the op from the gate. `true` lets the read through;
 *  `false` or a throw leaves the ask standing (fail closed). Absent ⇒ every such read asks. */
export interface HeldReadHooks {
  admit: (call: { readonly slug: string; readonly operation_id: string }) => boolean;
}
