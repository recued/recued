/** Route-side activity disclosure — pure projections.
 *
 *  The route-side scaffold adoption (state.ts) made the in-flight
 *  turn's tool calls + transparency entries accumulate through the
 *  D-174 chat route; this module projects that data into renderable
 *  activity rows so the route can paint it (§ B.8.7: small muted
 *  read-along narrative grouped per turn, default visible).
 *
 *  Two sources, one row shape:
 *
 *    - the in-flight scaffold (`InFlightTurn`) while the turn streams —
 *      transparency narrative lines + live tool-dispatch rows;
 *    - the authoritative `ChatMessage.tool_calls` provenance after
 *      `chat.message_complete` swaps the scaffold out (§ A.5 — "the
 *      renderer surfaces them inline beneath the assistant turn").
 *      Transparency narrative is NOT persisted on the message row; the
 *      audit log (D-120) is its durable record, so narrative lines
 *      drop at the swap while tool rows carry over seamlessly.
 *
 *  Visibility discipline: raw transparency events re-apply the § B.8.9
 *  policy at paint time (the broadcast carries the raw event, no
 *  resolved tier — the per-kind default table is the tier the emitters
 *  resolve against today). FAILURE-class events are deliberately
 *  excluded here: the PB7 `TurnFailureNotice` projection is their
 *  canonical paint and rendering them in the activity block would
 *  double-paint every failure.
 *
 *  Pure — no DOM, no clock, no IO; the route renderer consumes these
 *  like `buildModelRoutingBadge`. */

import {
  applyVisibilityPolicy,
  formatToolProgress,
  classForTransparencyEventKind,
  DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
  defaultRedactionForKind,
  renderTransparencyTemplate,
  tier1CallTitle,
  validateTransparencyEvent,
  type ChatDispatchReason,
  type ChatMessage,
  type ChatToolCall,
  type ChatToolCallRecord,
  type TransparencyEvent,
  type TransparencyStreamSettings,
} from '@recued/contracts';

import type { InFlightTurn, PlanApprovalCard } from './state.js';

/** One renderable activity row. `note` rows are Recued-voiced
 *  narrative lines; `tool` rows are dispatch provenance and carry the
 *  status that drives the glyph + tone. */
export type ChatActivityRow =
  | { kind: 'note'; text: string }
  | {
      kind: 'tool';
      text: string;
      status: ChatToolCall['status'];
      /** D-259 owner addressability. Only completed persisted calls normally
       * carry these; in-flight projections simply omit them. */
      run_id?: string;
      dish_id?: string;
      /** D-348 §7.8 — a change a standing permission let the call make without
       * asking, by its receipt: its line offers Undo. */
      local_receipt_id?: string;
      /** D-402 slice F5 — the recipe a standing permission of the owner's chats ran some of
       * this call's writes for without asking: its line offers "Stop allowing". */
      stop_allowing_recipe_id?: string;
    };

/** Both the ephemeral `InFlightToolCall` and the authoritative
 *  `ChatToolCall` satisfy this — the projection reads only the
 *  fields they share. */
type ToolCallLike = Pick<
  ChatToolCall,
  | 'tool_name'
  | 'args'
  | 'recipe_name'
  | 'awaiting_plan_id'
  | 'status'
  | 'reason'
  | 'detail'
  | 'run_id'
  | 'dish_id'
  | 'stop_allowing_recipe_id'
>;

/** What a call did, in the words its card and its ask use (the owner, 2026-11-13: a line said
 *  "used calendar.update ✓"). Each chat tool's title ("Search your mail", "Add a task") in the
 *  tense the line needs: `doing` ("searching your mail"), `done` ("searched your mail"), `base`
 *  ("search your mail"). A call that names an installed recipe, by the recipe's name: a run is
 *  `title` "Weekly digest", `done` "ran “Weekly digest”"; a schedule or a stop is `title`
 *  "Schedule ‘Weekly digest’", `done` "scheduled “Weekly digest”". `undefined` for a call with
 *  neither, an app's or an inline recipe's, which keeps its name. */
interface CallWords { readonly title: string; readonly base: string; readonly doing: string; readonly done: string }

/** What names a call: its tool, the arguments that refine its title, and the recipe it ran. */
interface CallNaming { readonly tool_name: string; readonly args?: unknown; readonly recipe_name?: string | undefined }

/** The verbs the titles start with, in the two tenses a line needs. A title starting with any
 *  other keeps the call's name (a test holds every chat tool's title to this list). */
const VERB_FORMS: Readonly<Record<string, readonly [doing: string, done: string]>> = {
  add: ['adding', 'added'], ask: ['asking', 'asked'], cancel: ['cancelling', 'cancelled'],
  change: ['changing', 'changed'], edit: ['editing', 'edited'], forget: ['forgetting', 'forgot'],
  look: ['looking', 'looked'], mark: ['marking', 'marked'], move: ['moving', 'moved'],
  pause: ['pausing', 'paused'], read: ['reading', 'read'], record: ['recording', 'recorded'],
  remove: ['removing', 'removed'], resume: ['resuming', 'resumed'], run: ['running', 'ran'],
  save: ['saving', 'saved'], schedule: ['scheduling', 'scheduled'], search: ['searching', 'searched'],
  stop: ['stopping', 'stopped'], tick: ['ticking', 'ticked'],
};

/** Tools of the chat's own that are no AI tool with a card, named here. */
const CORE_TOOL_TITLES: Readonly<Record<string, string>> = {
  'tools.search': 'Look for the right tool',
};

/** What a call that names a recipe does to it; any other names a recipe it runs. */
const RECIPE_VERBS: Readonly<Record<string, 'schedule' | 'stop'>> = {
  'recipe.schedule': 'schedule', 'recipe.stop': 'stop',
};

export const callWords = (call: CallNaming): CallWords | undefined => {
  // A recipe by its name, where the line read its tool's ("used recued-core/weekly-digest ✓", or
  // "ran a recipe ✓" for `recipe.run`). The server names only an installed recipe a call names.
  const recipe = call.recipe_name?.trim();
  if (recipe) {
    const quoted = `“${recipe}”`;
    const verb = Object.hasOwn(RECIPE_VERBS, call.tool_name) ? RECIPE_VERBS[call.tool_name]! : undefined;
    if (verb === undefined) return { title: recipe, base: `run ${quoted}`, doing: `running ${quoted}`, done: `ran ${quoted}` };
    // Its title is the call, not the recipe: "“Schedule ‘Weekly digest’” has now finished".
    const [doing, done] = VERB_FORMS[verb]!;
    return { title: `${verb === 'stop' ? 'Stop' : 'Schedule'} ‘${recipe}’`, base: `${verb} ${quoted}`,
      doing: `${doing} ${quoted}`, done: `${done} ${quoted}` };
  }
  const title = tier1CallTitle(call.tool_name, call.args) ?? CORE_TOOL_TITLES[call.tool_name];
  if (title === undefined) return undefined;
  const base = title.charAt(0).toLowerCase() + title.slice(1);
  const space = base.indexOf(' ');
  const forms = VERB_FORMS[space === -1 ? base : base.slice(0, space)];
  if (forms === undefined) return undefined;
  const rest = space === -1 ? '' : base.slice(space);
  return { title, base, doing: forms[0] + rest, done: forms[1] + rest };
};

/** A call named in a sentence of its own: its title, quoted ("“Change a calendar event” has now
 *  finished"), or the recipe it ran ("“Weekly digest” has now finished"); a call with neither, its
 *  name. */
export const callName = (call: CallNaming): string => {
  const words = callWords(call);
  return words ? `“${words.title}”` : call.tool_name;
};

/** A call as a list names it, on a line of its own: "Change a calendar event", "Run “Weekly
 *  digest”", "Schedule “Weekly digest”"; a call with neither a title nor a recipe, its name. */
export const callLabel = (call: CallNaming): string => {
  const words = callWords(call);
  return words ? words.base.charAt(0).toUpperCase() + words.base.slice(1) : call.tool_name;
};

/** D-182 — a compact one-line form of a (possibly long / multi-line) error detail
 *  for the activity row: first line, ~160 chars, ellipsised. */
const ACTIVITY_DETAIL_MAX = 160;
const compactDetail = (detail: string): string => {
  const line = (detail.split('\n')[0] ?? '').trim();
  return line.length > ACTIVITY_DETAIL_MAX ? `${line.slice(0, ACTIVITY_DETAIL_MAX - 1)}…` : line;
};

/** D-346 follow-up (2026-11-08) — each closed-list reason in the owner's words. The row
 *  used to show the slug itself ("couldn't run mail.search: classification blocked"). */
const REASON_WORDS: Readonly<Record<ChatDispatchReason, string>> = {
  not_implemented: 'it is not available yet',
  unknown_tool: 'there is no such tool',
  invalid_args: 'it was asked in a way it could not use',
  identifier_evidence_missing: 'it needs the original source before using this value',
  channel_denied: 'it is not allowed here',
  kind_gated: 'it is not allowed here',
  classification_blocked: 'it is switched off',
  connection_unavailable: 'its connection is not available',
  capacity_gap: 'a limit was reached',
  execution_error: 'it failed',
  awaiting_approval: 'it is waiting for your yes',
  plan_cancelled: 'you cancelled it',
  run_cancelled: 'it was cancelled',
  not_asked_yet: 'it was left until you answer the approval before it',
  unconfirmed_attempt: 'an earlier try of it has no confirmed result, so the record is checked first',
};

/** The first sentence of a refusal, without its full stop: a switched-off call's own words
 *  say what is off ("'mail.search' is turned off for you, so it did not run"). */
const firstSentence = (detail: string): string => {
  const line = (detail.split('\n')[0] ?? '').trim();
  const end = line.indexOf('. ');
  return (end === -1 ? line.replace(/\.$/, '') : line.slice(0, end)).trim();
};

/** Lower-case stylistic per the inline-stream tone (§ B.8.5); the
 *  closed-list dispatch reason reads as words. */
const toolCallText = (call: ToolCallLike): string => {
  const words = callWords(call);
  if (call.status === 'started') return words ? `${words.doing}...` : `running ${call.tool_name}...`;
  if (call.status === 'ok') return words ? `${words.done} ✓` : `used ${call.tool_name} ✓`;
  // A switched-off call says what is off in its own refusal (D-346), which names the tool.
  // When the refusal names the call itself ("'mail.search' is turned off…") and the call has a
  // title, the title says it instead of the tool's id: "couldn't search your mail: it is switched
  // off". A refusal naming something else (an op a recipe uses) keeps its own words.
  if (call.reason === 'classification_blocked' && call.detail !== undefined && call.detail.trim().length > 0
    && !(words && call.detail.trim().startsWith(`'${call.tool_name}'`))) {
    return compactDetail(firstSentence(call.detail));
  }
  // D-182 — for a run/tool FAILURE prefer the concise underlying error line (the
  // cli `not found` message) over the reason; other reasons (awaiting_approval /
  // run_cancelled) say their reason in words — their detail is a plan id / long
  // posture message with its own UX, not an activity-row diagnostic.
  const detail = call.reason === 'execution_error' ? call.detail?.trim() : undefined;
  const why = detail !== undefined && detail.length > 0
    ? compactDetail(detail)
    : REASON_WORDS[call.reason ?? 'execution_error'] ?? (call.reason ?? 'execution_error').replace(/_/g, ' ');
  return `couldn't ${words ? words.base : `run ${call.tool_name}`}: ${why}`;
};

/** A call that stopped to wait reads as what it is NOW, not as the "✓" its
 *  turn ended on: the dispatch itself succeeded (it queued), so the persisted
 *  status is `ok` whether the run later finished, was refused or never came
 *  back. `null` ⇒ the ordinary row is already true (it finished, or nothing is
 *  known about a wait). */
const waitedCallRow = (
  call: ToolCallLike,
  record: ChatToolCallRecord | undefined,
): Pick<ChatActivityRow & { kind: 'tool' }, 'text' | 'status'> | null => {
  if (record === undefined || (record.held_at === undefined && record.state !== 'held')) return null;
  const words = callWords(call);
  const base = words ? words.base : call.tool_name;
  const ran = words ? words.base : `run ${call.tool_name}`;
  switch (record.state) {
    case 'held': return { text: `waiting to hear back: ${base}`, status: 'started' };
    case 'running': return { text: words ? `${words.doing} again...` : `running ${call.tool_name} again...`, status: 'started' };
    case 'failed': return record.denied === true
      ? { text: `didn't ${ran}: you said no`, status: 'error' }
      // D-337 slice R — its approval expired: it never ran, and no one said no.
      : record.expired === true
        ? { text: `didn't ${ran}: no one answered in time`, status: 'error' }
        : { text: `couldn't ${ran}: it did not finish`, status: 'error' };
    case 'interrupted': return {
      text: `stopped part-way: ${base}. Recued does not know what happened`, status: 'error',
    };
    case 'succeeded': return null;
  }
};

/** D-337 slice K — a call not asked because a call before it in the turn waited for the owner's
 *  approval. Nothing failed, ran or waits on it: the conversation makes it once they answer, so it
 *  is neither an error ("Needs attention") nor ongoing. */
const notAskedRow = (call: ToolCallLike): Pick<ChatActivityRow & { kind: 'tool' }, 'text' | 'status'> | null =>
  call.status === 'error' && call.reason === 'not_asked_yet'
    ? { text: `left until you answer the approval before it: ${callWords(call)?.base ?? call.tool_name}`, status: 'ok' }
    : null;

/** A plan-approval card, as a call waiting on it reads it. */
type PlanCardLike = Pick<PlanApprovalCard, 'plan_id' | 'status' | 'lapsed' | 'replaced' | 'execution'>;

/** The card a call that stopped for the owner's yes waits on: its own link, or, for a call an
 *  older server recorded, the `plan_id=<id>` its detail begins with (`chat-orchestrator.ts`). */
const awaitedPlanId = (call: ToolCallLike): string | undefined =>
  call.awaiting_plan_id ?? /^plan_id=([^\s.]+)/.exec(call.detail ?? '')?.[1];

/** D-329 — a call that stopped for the owner's yes reads as its card does. It read "couldn't
 *  change a calendar event: it is waiting for your yes" while the card waited, and still did
 *  under the card once it said the change was done (live, 2026-11-13). */
const awaitedPlanRow = (
  call: ToolCallLike,
  plans: ReadonlyArray<PlanCardLike> | undefined,
): Pick<ChatActivityRow & { kind: 'tool' }, 'text' | 'status'> | null => {
  if (call.status !== 'error' || call.reason !== 'awaiting_approval') return null;
  const words = callWords(call);
  const base = words ? words.base : call.tool_name;
  const ran = words ? words.base : `run ${call.tool_name}`;
  const id = awaitedPlanId(call);
  const card = id === undefined ? undefined : plans?.find((plan) => plan.plan_id === id);
  if (card?.status === 'cancelled') {
    return { text: `didn't ${ran}: ${card.replaced === true ? 'replaced by a newer version' : card.lapsed === true ? 'no one answered in time' : REASON_WORDS.plan_cancelled}`,
      status: 'error' };
  }
  const receipt = card?.execution;
  switch (receipt?.status) {
    case 'completed': return { text: words ? `${words.done} ✓` : `used ${call.tool_name} ✓`, status: 'ok' };
    case 'running': return { text: words ? `${words.doing}...` : `running ${call.tool_name}...`, status: 'started' };
    case 'held': return { text: `waiting to hear back: ${base}`, status: 'started' };
    case 'failed': return receipt.reason === 'run_cancelled'
      ? { text: `didn't ${ran}: it was stopped`, status: 'error' }
      : { text: `couldn't ${ran}: ${REASON_WORDS[receipt.reason]}`, status: 'error' };
    case 'unknown': return { text: `stopped part-way: ${base}. Recued does not know what happened`, status: 'error' };
    case undefined: break;
  }
  // Approved and not yet run, or still waiting (a card not loaded yet waits too): nothing failed.
  return card?.status === 'approved'
    ? { text: words ? `${words.doing}...` : `running ${call.tool_name}...`, status: 'started' }
    : { text: `waiting for your yes: ${base}`, status: 'started' };
};

const toolCallRow = (
  call: ToolCallLike,
  record?: ChatToolCallRecord,
  plans?: ReadonlyArray<PlanCardLike>,
): ChatActivityRow => {
  const waited = waitedCallRow(call, record) ?? notAskedRow(call) ?? awaitedPlanRow(call, plans);
  const progress = call.status === 'started' && record?.state === 'running' && record.progress
    ? ` · ${formatToolProgress(record.progress)}` : '';
  return {
    kind: 'tool',
    text: (waited?.text ?? toolCallText(call)) + progress,
    status: waited?.status ?? call.status,
    ...(call.run_id !== undefined ? { run_id: call.run_id } : {}),
    ...(call.dish_id !== undefined ? { dish_id: call.dish_id } : {}),
    ...(record?.state === 'succeeded' && record.local_receipt !== undefined
      ? { local_receipt_id: record.local_receipt.receipt_id } : {}),
    ...(call.stop_allowing_recipe_id !== undefined ? { stop_allowing_recipe_id: call.stop_allowing_recipe_id } : {}),
  };
};

/** Project one scaffold transparency payload into its narrative line,
 *  or null for drop cases. Three payload shapes reach the scaffold:
 *
 *    - raw `TransparencyEvent` (the orchestrator's direct emissions) —
 *      visibility-policy + template, dropping failure-class (PB7
 *      notice owns those), hidden tiers, and silent templates;
 *    - `{ kind: 'chat.channel_note', note }` (the D-160 channel sink
 *      wraps the framework out-stream's pre-rendered note) — verbatim;
 *    - anything else / malformed — null. Unlike the PB7 failure
 *      projection, a non-failure line may safely vanish on a payload
 *      quirk; nothing here is must-see.
 *
 *  `settings` is the user's § B.8.9 policy (Settings → Transparency,
 *  persisted as `ui.transparency.*` instance prefs) — defaults to the
 *  substrate default. The master toggle also gates `chat.channel_note`
 *  lines: they are pre-rendered narrative, so "Show inline thought
 *  stream" off must silence them even though they carry no event kind
 *  for the policy filter to act on. */
export const projectTransparencyNote = (
  payload: unknown,
  settings: TransparencyStreamSettings = DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
): string | null => {
  if (payload === null || typeof payload !== 'object') return null;
  const kind = (payload as { kind?: unknown }).kind;
  if (kind === 'chat.channel_note') {
    if (!settings.enabled) return null;
    const note = (payload as { note?: unknown }).note;
    return typeof note === 'string' && note.trim().length > 0 ? note : null;
  }
  // Shape gate BEFORE template substitution (the composer's own
  // discipline) — a payload that claims a valid kind but misses
  // required fields would otherwise template into visible
  // "undefined" text (codex review fold).
  if (validateTransparencyEvent(payload).length > 0) return null;
  const event = payload as TransparencyEvent;
  if (classForTransparencyEventKind(event.kind) === 'failure') return null;
  const tier = applyVisibilityPolicy(
    event,
    defaultRedactionForKind(event.kind),
    settings,
  );
  if (tier === 'hidden') return null;
  let text = '';
  try {
    text = renderTransparencyTemplate(event);
  } catch {
    return null;
  }
  return text.trim().length > 0 ? text : null;
};

/** Activity rows for the streaming scaffold: narrative lines in
 *  arrival order, then tool-dispatch rows in arrival order. The
 *  scaffold keeps the two in separate arrays (their interleave is not
 *  recorded), so the block renders as narrative + provenance groups
 *  rather than a strict chronology.
 *
 *  Plan proposals are deliberately NOT narrative: the § A.11
 *  plan-approval card (state.ts `plan_cards`) is their canonical
 *  paint — an interaction surface that, unlike the thought stream,
 *  must not be hideable behind the § B.8.9 prefs — and a narrative
 *  echo here would double-paint it (the PB7 failure-class precedent).
 *  Tool rows are § A.5 dispatch provenance, not narrative, and render
 *  regardless of the master toggle. */
export const projectInFlightActivity = (
  turn: InFlightTurn,
  settings: TransparencyStreamSettings = DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
  records?: Readonly<Record<string, ChatToolCallRecord>>,
): ChatActivityRow[] => {
  const rows: ChatActivityRow[] = [];
  for (const entry of turn.transparency) {
    const text = projectTransparencyNote(entry.payload, settings);
    if (text !== null) rows.push({ kind: 'note', text });
  }
  for (const call of turn.tool_calls) {
    const record = call.call_id ? Object.values(records ?? {}).find(row =>
      row.message_id === call.call_id && row.turn_id === turn.turn_id) : undefined;
    rows.push(toolCallRow(call, record));
  }
  return rows;
};

/** Activity rows for a completed message — the persisted `tool_calls`
 *  provenance on assistant rows. Empty for every other role and for
 *  turns that dispatched nothing. A call that waits on an approval card reads as the card does
 *  (`plans`, the conversation's cards). */
export const projectMessageActivity = (
  message: ChatMessage,
  records?: Readonly<Record<string, ChatToolCallRecord>>,
  plans?: ReadonlyArray<PlanCardLike>,
): ChatActivityRow[] => {
  if (message.role !== 'assistant') return [];
  // A call with no run (a chat's own write) is found by its own row.
  return (message.tool_calls ?? []).map((call) =>
    toolCallRow(call, call.run_id !== undefined ? records?.[call.run_id]
      : call.call_id !== undefined ? records?.[`call:${call.call_id}`]
        ?? Object.values(records ?? {}).find((record) => record.message_id === call.call_id)
        : undefined, plans));
};

/** One plain sentence per call this message made that waited and has since
 *  settled — under the answer, because the answer itself still says "queued"
 *  and nothing else on the page would say otherwise. Needs `held_at`: a call
 *  that never waited needs no update, and its ✓ is already the truth. */
export const projectSettledCallNotices = (
  message: ChatMessage,
  records: Readonly<Record<string, ChatToolCallRecord>> | undefined,
): Array<{ run_id: string; text: string }> => {
  if (message.role !== 'assistant' || records === undefined) return [];
  return (message.tool_calls ?? []).flatMap((call) => {
    const record = call.run_id !== undefined ? records[call.run_id] : undefined;
    if (call.run_id === undefined || record === undefined || record.held_at === undefined) return [];
    // A sentence of its own, so the call is named, by its title where it has one.
    const name = callName(call);
    const text = record.state === 'succeeded' ? `Update: ${name} has now finished.`
      : record.state === 'failed'
        ? record.denied === true
          ? `Update: you said no, so ${name} did not run.`
          : record.expired === true
            ? `Update: no one answered in time, so ${name} did not run.`
            : `Update: ${name} did not finish.`
        : record.state === 'interrupted'
          ? `Update: ${name} stopped part-way. Recued does not know what happened.`
          : null;
    return text === null ? [] : [{ run_id: call.run_id, text }];
  });
};
