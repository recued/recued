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
  classForTransparencyEventKind,
  DEFAULT_TRANSPARENCY_STREAM_SETTINGS,
  defaultRedactionForKind,
  renderTransparencyTemplate,
  validateTransparencyEvent,
  type ChatMessage,
  type ChatToolCall,
  type ChatToolCallRecord,
  type TransparencyEvent,
  type TransparencyStreamSettings,
} from '@recued/contracts';

import type { InFlightTurn } from './state.js';

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
    };

/** Both the ephemeral `InFlightToolCall` and the authoritative
 *  `ChatToolCall` satisfy this — the projection reads only the
 *  fields they share. */
type ToolCallLike = Pick<
  ChatToolCall,
  | 'tool_name'
  | 'status'
  | 'reason'
  | 'detail'
  | 'run_id'
  | 'dish_id'
>;

/** D-182 — a compact one-line form of a (possibly long / multi-line) error detail
 *  for the activity row: first line, ~160 chars, ellipsised. */
const ACTIVITY_DETAIL_MAX = 160;
const compactDetail = (detail: string): string => {
  const line = (detail.split('\n')[0] ?? '').trim();
  return line.length > ACTIVITY_DETAIL_MAX ? `${line.slice(0, ACTIVITY_DETAIL_MAX - 1)}…` : line;
};

/** Lower-case stylistic per the inline-stream tone (§ B.8.5); the
 *  closed-list dispatch reason slug reads as words. */
const toolCallText = (call: ToolCallLike): string => {
  if (call.status === 'started') return `running ${call.tool_name}...`;
  if (call.status === 'ok') return `used ${call.tool_name} ✓`;
  // D-182 — for a run/tool FAILURE prefer the concise underlying error line (the
  // cli `not found` message) over the bare reason slug; other reasons
  // (awaiting_approval / run_cancelled) keep their slug — their detail is a plan
  // id / long posture message with its own UX, not an activity-row diagnostic.
  const detail = call.reason === 'execution_error' ? call.detail?.trim() : undefined;
  const why = detail !== undefined && detail.length > 0
    ? compactDetail(detail)
    : (call.reason ?? 'execution_error').replace(/_/g, ' ');
  return `couldn't run ${call.tool_name}: ${why}`;
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
  switch (record.state) {
    case 'held': return { text: `waiting to hear back: ${call.tool_name}`, status: 'started' };
    case 'running': return { text: `running ${call.tool_name} again...`, status: 'started' };
    case 'failed': return record.denied === true
      ? { text: `didn't run ${call.tool_name}: you said no`, status: 'error' }
      : { text: `couldn't run ${call.tool_name}: it did not finish`, status: 'error' };
    case 'interrupted': return {
      text: `stopped part-way: ${call.tool_name}. Recued does not know what happened`, status: 'error',
    };
    case 'succeeded': return null;
  }
};

const toolCallRow = (call: ToolCallLike, record?: ChatToolCallRecord): ChatActivityRow => {
  const waited = waitedCallRow(call, record);
  return {
    kind: 'tool',
    text: waited?.text ?? toolCallText(call),
    status: waited?.status ?? call.status,
    ...(call.run_id !== undefined ? { run_id: call.run_id } : {}),
    ...(call.dish_id !== undefined ? { dish_id: call.dish_id } : {}),
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
): ChatActivityRow[] => {
  const rows: ChatActivityRow[] = [];
  for (const entry of turn.transparency) {
    const text = projectTransparencyNote(entry.payload, settings);
    if (text !== null) rows.push({ kind: 'note', text });
  }
  for (const call of turn.tool_calls) rows.push(toolCallRow(call));
  return rows;
};

/** Activity rows for a completed message — the persisted `tool_calls`
 *  provenance on assistant rows. Empty for every other role and for
 *  turns that dispatched nothing. */
export const projectMessageActivity = (
  message: ChatMessage,
  records?: Readonly<Record<string, ChatToolCallRecord>>,
): ChatActivityRow[] => {
  if (message.role !== 'assistant') return [];
  return (message.tool_calls ?? []).map((call) =>
    toolCallRow(call, call.run_id !== undefined ? records?.[call.run_id] : undefined));
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
    const text = record.state === 'succeeded' ? `Update: ${call.tool_name} has now finished.`
      : record.state === 'failed'
        ? record.denied === true
          ? `Update: you said no, so ${call.tool_name} did not run.`
          : `Update: ${call.tool_name} did not finish.`
        : record.state === 'interrupted'
          ? `Update: ${call.tool_name} stopped part-way. Recued does not know what happened.`
          : null;
    return text === null ? [] : [{ run_id: call.run_id, text }];
  });
};
