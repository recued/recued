/** D-181 slice 6b — the messenger (Slack / Telegram) live-control surface.
 *
 *  The §8 channel matrix gives the messenger channel `LiveControlCapability:
 *  control` with two affordances: a **pull** (`/recued running` lists the
 *  active runs) and **interactive buttons** (Slack blocks / Telegram inline
 *  keyboard) that kill a running op, or cancel / promote a queued call. The
 *  webclient (slice 5b) + bridge (slice 6a) renderers stand a persistent panel;
 *  a conversational channel carries none, so messenger is ambient-pull (D-181
 *  §8: "Conversational channels carry no standing panel → ambient + pull").
 *
 *  D-186 extends the SAME pull + buttons surface to the "Active passes"
 *  (session grants): `/recued passes` lists the active `grant_kind: 'session'`
 *  rows, each with a `Revoke` button (early-expire). It rides the same prompt
 *  `correlation_id` as the run list — the press's action prefix (`revoke` vs
 *  `kill` / `cancel` / `promote`) routes it to the session-grant seam vs the
 *  in-flight registry (disjoint id-spaces) — and is gated identically
 *  (canonical row + bound conversation, owner-level). The seam projects the
 *  SAME `SessionGrantView` the `session_grant.{list,revoke}` rpc returns, so
 *  the messenger surface never drifts from the webclient "Active passes" bubble.
 *
 *  Two inbound shapes, two handlers — both consumed BEFORE the existing
 *  inbound-answer / messenger-turn paths so a command never reaches the LLM and
 *  a live-control press is never mis-routed to `block.submitAnswer`:
 *
 *    - `handleCommand` — a plain user message whose text is a `/recued …`
 *      command. Recognized + inside the bound conversation ⇒ rendered (the
 *      active list as an interactive prompt, or a usage note) and consumed
 *      (returns `true`). Anything else (not a command, or a command from
 *      outside the bound conversation) ⇒ `false`, so it falls through to the
 *      messenger turn / warehouse-bus emit exactly as before.
 *
 *    - `handleControlPress` — a vendor button-press callback whose
 *      `correlation_id` is OUR fixed `LIVE_CONTROL_CORRELATION_ID` (an ask
 *      reply carries an `ask-…` id, so the two never collide). The button's
 *      `option_id` encodes `<action>:<target_id>` → routed to the in-flight
 *      registry's `kill` / `cancel` / `promote`, with a one-line confirmation
 *      posted back. A press on another prompt (an ask reply) ⇒ `false`, so the
 *      existing `parseInboundReply` → `submitAnswer` path still runs.
 *
 *  The access boundary is identical to the messenger TURN
 *  (`wire-messenger-turn.ts`): the surface rides ONLY the canonical vendor row
 *  (`connection_name === vendor`, D-163 I-4) and a command is acted on only when
 *  it arrives in the row's bound conversation (`transport.parseConversationId`
 *  === recipient). A press inherits that boundary structurally — the buttons exist
 *  only on the prompt we posted into the bound conversation, and the
 *  confirmation is always sent to `credential.recipient`, never to wherever the
 *  press claims to originate. The registry control is owner-level regardless
 *  (the D-153 single-user-server invariant); the rpc-layer's bridge-approval
 *  gate (§8) does not apply here — messenger is `control` by the matrix, not a
 *  bridge.
 *
 *  Server-side, in-memory: this composer holds its own interactive transports
 *  and reads the live `InFlightRegistry` directly (the SAME instance the
 *  execute-handler + cli executor feed; the same one the `execution.*` rpc wraps
 *  for the webclient / bridge). It never reaches the WS rpc layer.
 *
 *  Spec: D-181 § 7 / § 8 (messenger row); D-160
 *  § A.5 (transport); D-163 § N.5 (inbound dispatch). */

import {
  type OutboundPromptOption,
  type TransportVendor,
} from '@recued/transport';
import type { RemoteChannelCredential } from '@recued/notification';
import type {
  ActiveExecutionEntry,
  ExecutionActiveResponse,
  LaneStatus,
  SessionGrantPermits,
  SessionGrantView,
} from '@recued/contracts';
import type { InFlightRegistry } from '../../execution/in-flight-registry.js';
import type { KeyManager } from '../../key-manager.js';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';
import {
  buildMessengerCredentialResolvers,
  buildMessengerTransports,
} from './messenger-transport-leaves.js';

/** The fixed `correlation_id` every active-list prompt carries. Exact-match
 *  distinguishes a live-control press from a notification ask reply (ask ids are
 *  minted as `ask-<uuid>`, never this constant), so the two never cross-classify
 *  in the inbound dispatcher. Short enough that the encoded callback payload
 *  (`<correlation_id>|<action>:<run_id>`) stays inside Telegram's 64-byte
 *  `callback_data` cap. */
export const LIVE_CONTROL_CORRELATION_ID = 'recued-live-ctl';

/** The `/recued` subcommands that render the active list (everything else,
 *  including a bare `/recued`, gets the usage note). */
const LIST_SUBCOMMANDS = new Set(['running', 'runs', 'status', 'active']);

/** The `/recued` subcommands that render the active session-grant passes
 *  (D-186 "Active passes"). Disjoint from `LIST_SUBCOMMANDS`; recognized only
 *  when the `passes` seam is wired (else they fall to the usage note). */
const PASSES_SUBCOMMANDS = new Set(['passes', 'grants', 'access']);

/** Cap on entries listed in the prompt text + buttons rendered — keeps the
 *  message bounded for both vendors (Slack puts every button in one `actions`
 *  block; an over-long list points the owner at the webclient Runs page). */
const ACTIVE_LIST_CAP = 10;
const MAX_CONTROL_BUTTONS = 10;

/** Max button-label length — a long recipe id is clipped so the label stays
 *  legible on a Slack button / Telegram keyboard row. */
const MAX_LABEL_LEN = 48;

const USAGE_TEXT =
  'Recued live control — "/recued running" lists active runs (stop / reorder); '
  + '"/recued passes" lists active access passes (revoke).';

/** The two inbound handlers the inbound-answer dispatcher consumes. Both
 *  resolve `true` when they handled (consumed) the payload and `false` to let
 *  it fall through to the existing paths; neither rejects. */
export interface MessengerLiveControl {
  /** A `/recued …` command in the bound conversation → render the active list /
   *  usage; `true` when consumed. */
  handleCommand(
    vendor: TransportVendor,
    connection_name: string,
    payload: unknown,
  ): Promise<boolean>;
  /** A live-control button press (our `LIVE_CONTROL_CORRELATION_ID`) → route to
   *  the registry + confirm; `true` when consumed. */
  handleControlPress(
    vendor: TransportVendor,
    connection_name: string,
    payload: unknown,
  ): Promise<boolean>;
}

export interface ComposeMessengerLiveControlDeps {
  /** The live in-flight registry — snapshot for the list, `kill` / `cancel` /
   *  `promote` for the presses. Absent ⇒ composer returns undefined (no list to
   *  show, nothing to control). */
  registry?: InFlightRegistry;
  /** Backs the per-vendor credential read (the SAME canonical
   *  `connection.notification.<vendor>` row the turn + notification channel
   *  resolve). Absent ⇒ undefined (no rows to resolve / gate against). */
  connectionStore?: ConnectionStoreSqlite;
  /** Optional sub-DEK source for the credential decode — re-read per call so a
   *  boot→unlock transition lands without a rebuild. */
  keys?: KeyManager;
  /** D-186 — the "Active passes" seam: list the active session grants +
   *  early-revoke one, each projected to the render-ready `SessionGrantView`
   *  (the SAME `contract-handler` helpers the `session_grant.{list,revoke}` rpc
   *  uses, so the messenger surface never drifts from the webclient bubble).
   *  Absent ⇒ the `/recued passes` subcommand is unavailable (graceful
   *  degrade, like an absent registry); the run-control half is unaffected. */
  passes?: {
    list: () => SessionGrantView[];
    revoke: (contract_id: string) => SessionGrantView | null;
  };
  /** Operator-facing diagnostics — the binding-gate refusal line is the one
   *  that matters (a `/recued` typed outside the bound conversation). */
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void;
  /** Test seams. */
  now?: () => number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const STATE_LABEL: Record<ActiveExecutionEntry['state'], string> = {
  running: 'Running',
  waiting_slot: 'Queued',
  detached: 'Detached',
  stopping: 'Stopping',
};

type ControlAction = 'kill' | 'cancel' | 'promote' | 'revoke';

/** ms → a compact `45s` / `12m` / `3h` elapsed string (mirrors the bridge /
 *  status-page formatting). */
const fmtElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
};

const clip = (label: string): string =>
  label.length > MAX_LABEL_LEN ? `${label.slice(0, MAX_LABEL_LEN - 1)}…` : label;

const entryTitle = (entry: ActiveExecutionEntry): string =>
  entry.step_id !== undefined && entry.step_id.length > 0
    ? `${entry.recipe_id} · ${entry.step_id}`
    : entry.recipe_id;

const renderEntryLine = (entry: ActiveExecutionEntry, now: number): string => {
  const since = entry.slot_acquired_at ?? entry.started_at;
  const parts = [STATE_LABEL[entry.state], entry.origin];
  if (Number.isFinite(now) && now >= since) parts.push(fmtElapsed(now - since));
  if (entry.progress.stalled === true) parts.push('stalled');
  return `• ${entryTitle(entry)} — ${parts.join(' · ')}`;
};

const renderLaneLine = (lane: LaneStatus): string => {
  const queued =
    lane.queued > 0
      ? ` · ${lane.queued} queued, oldest ${fmtElapsed(lane.oldest_wait_ms)}`
      : '';
  return `${lane.lane} ${lane.in_use}/${lane.capacity}${queued}`;
};

/** The button id targeting one entry's control action — `<action>:<target_id>`.
 *  A queued-call cancels / promotes by its `queued_call_id`; a run / detached
 *  job kills by its `run_id`. */
const controlOption = (
  action: ControlAction,
  target: string,
  recipe_id: string,
): OutboundPromptOption => ({
  id: `${action}:${target}`,
  label: clip(`${action[0]!.toUpperCase()}${action.slice(1)} ${recipe_id}`),
});

/** Build the active-list message: the rendered text + the control buttons. An
 *  empty list returns `options: []` (the caller sends it as a plain message);
 *  a non-empty list returns the buttons (capped) for an interactive prompt. */
const buildActiveListMessage = (
  snapshot: ExecutionActiveResponse,
  now: number,
): { text: string; options: OutboundPromptOption[] } => {
  const { entries, lanes } = snapshot;
  if (entries.length === 0) {
    return { text: 'Nothing running right now.', options: [] };
  }

  const shown = entries.slice(0, ACTIVE_LIST_CAP);
  const lines: string[] = [`Active runs — ${entries.length}`];
  for (const entry of shown) lines.push(renderEntryLine(entry, now));
  if (entries.length > shown.length) {
    lines.push(
      `…and ${entries.length - shown.length} more — open the webclient Runs page for the full list.`,
    );
  }
  const busyLanes = lanes.filter((lane) => lane.in_use > 0 || lane.queued > 0);
  if (busyLanes.length > 0) {
    lines.push('Lanes:');
    for (const lane of busyLanes) lines.push(`  ${renderLaneLine(lane)}`);
  }

  const candidates: OutboundPromptOption[] = [];
  for (const entry of entries) {
    if (entry.entry_kind === 'queued-call') {
      const target = entry.queued_call_id;
      if (target === undefined || target.length === 0) continue;
      candidates.push(controlOption('promote', target, entry.recipe_id));
      candidates.push(controlOption('cancel', target, entry.recipe_id));
    } else {
      const target = entry.run_id;
      if (target === undefined || target.length === 0) continue;
      candidates.push(controlOption('kill', target, entry.recipe_id));
    }
  }

  return { text: lines.join('\n'), options: candidates.slice(0, MAX_CONTROL_BUTTONS) };
};

const PASS_MODE_LABEL: Record<SessionGrantView['grant_mode'], string> = {
  exact: 'exact',
  batch: 'batch',
  open: 'open',
  scoped: 'scoped',
  raw_op: 'raw op',
};

/** A compact "what this pass permits" hint for the list line — the first
 *  op-scope axis present, by specificity (operations → ingredients →
 *  connections), or `any op` when the pass is unscoped (every axis "any"). */
const permitsSummary = (permits: SessionGrantPermits): string => {
  const ops = permits.operation_ids;
  if (ops !== undefined && ops.length > 0) {
    return ops.length === 1 ? ops[0]! : `${ops.length} ops`;
  }
  const ingredients = permits.ingredient_ids;
  if (ingredients !== undefined && ingredients.length > 0) {
    return ingredients.length === 1
      ? ingredients[0]!
      : `${ingredients.length} ingredients`;
  }
  const connections = permits.connection_names;
  if (connections !== undefined && connections.length > 0) {
    return connections.length === 1
      ? connections[0]!
      : `${connections.length} connections`;
  }
  return 'any op';
};

const renderPassLine = (grant: SessionGrantView, now: number): string => {
  const parts = [PASS_MODE_LABEL[grant.grant_mode], permitsSummary(grant.permits)];
  if (grant.expiry_at !== undefined && Number.isFinite(now)) {
    parts.push(`expires in ${fmtElapsed(Math.max(0, grant.expiry_at - now))}`);
  }
  if (grant.uses_remaining !== undefined && grant.max_uses !== undefined) {
    parts.push(`${grant.uses_remaining}/${grant.max_uses} uses`);
  }
  return `• ${clip(grant.display_name)} — ${parts.join(' · ')}`;
};

/** Build the active-passes message: the rendered text + one `Revoke` button per
 *  pass (capped). An empty list returns `options: []` (sent as a plain
 *  message). Mirrors `buildActiveListMessage`; the `revoke:<contract_id>`
 *  options ride the SAME `LIVE_CONTROL_CORRELATION_ID` prompt — the action
 *  prefix routes a press to the grant seam (revoke) vs the registry
 *  (kill / cancel / promote), and the run / call / grant id-spaces never
 *  collide. */
const buildPassesMessage = (
  grants: SessionGrantView[],
  now: number,
): { text: string; options: OutboundPromptOption[] } => {
  if (grants.length === 0) {
    return { text: 'No active passes right now.', options: [] };
  }
  const shown = grants.slice(0, ACTIVE_LIST_CAP);
  const lines: string[] = [`Active passes — ${grants.length}`];
  for (const grant of shown) lines.push(renderPassLine(grant, now));
  if (grants.length > shown.length) {
    lines.push(
      `…and ${grants.length - shown.length} more — open the webclient Runs page for the full list.`,
    );
  }

  const candidates: OutboundPromptOption[] = [];
  for (const grant of grants) {
    if (grant.contract_id.length === 0) continue;
    candidates.push(controlOption('revoke', grant.contract_id, grant.display_name));
  }

  return { text: lines.join('\n'), options: candidates.slice(0, MAX_CONTROL_BUTTONS) };
};

/** Strip a leading Slack mention (`<@U123>` / `<@U123|name>`) + a Telegram
 *  `@botname` command suffix, then recognize a `/recued <subcommand>`. Returns
 *  `recognized: false` for any text that is not a `/recued` command. */
const parseRecuedCommand = (
  raw: string,
): { recognized: boolean; subcommand: string } => {
  const stripped = raw.replace(/^\s*<@[^>]+>\s*/, '').trim();
  if (stripped.length === 0) return { recognized: false, subcommand: '' };
  const tokens = stripped.split(/\s+/);
  // Telegram appends `@botname` to a slash command in group chats.
  const head = (tokens[0] ?? '').split('@')[0]!.toLowerCase();
  if (head !== '/recued') return { recognized: false, subcommand: '' };
  return { recognized: true, subcommand: (tokens[1] ?? '').toLowerCase() };
};

// D-192 CORE #6 — the per-vendor callback-conversation-shape extraction moved
// onto `InteractiveTransport.parseCallbackConversationId` (Slack
// `container.channel_id`/`channel.id`, Telegram `callback_query.message.chat.id`);
// the press gate calls `transports[vendor].parseCallbackConversationId(payload)`.

/** Decode a live-control button's `option_id` (`<action>:<target>`). Returns
 *  null for an unrecognized action or a malformed shape. Split on the FIRST `:`
 *  — none of a run_id (`YYYYMMDDT…-rand`), a call_id (`call_N`), or a grant
 *  `contract_id` (`ct_<uuid>`) contains one. */
const parseControlOption = (
  option_id: string,
): { action: ControlAction; target: string } | null => {
  const at = option_id.indexOf(':');
  if (at <= 0 || at >= option_id.length - 1) return null;
  const action = option_id.slice(0, at);
  const target = option_id.slice(at + 1);
  if (
    action !== 'kill'
    && action !== 'cancel'
    && action !== 'promote'
    && action !== 'revoke'
  ) {
    return null;
  }
  return { action, target };
};

/** Map a control verdict to a one-line user confirmation, nested by action so
 *  the shared `not_found` reads correctly per action. */
const verdictMessage = (action: ControlAction, status: string): string => {
  if (action === 'kill') {
    if (status === 'killed') return 'Killed the running op.';
    if (status === 'already_terminal') return 'That run already finished.';
    return 'That run is no longer active.';
  }
  if (action === 'cancel') {
    if (status === 'cancelled_before_dispatch') return 'Cancelled the queued call.';
    if (status === 'already_dispatched') return 'That call already started — use Kill to stop it.';
    return 'That queued call is no longer waiting.';
  }
  if (action === 'revoke') {
    if (status === 'revoked') return 'Revoked the access pass.';
    return 'That pass is no longer active.';
  }
  if (status === 'promoted') return 'Moved the queued call to the front.';
  return 'That queued call is no longer waiting.';
};

/** Compose the messenger live-control surface. Returns `undefined` when the
 *  in-flight registry or the connection store is unwired — the dispatcher seam
 *  stays absent and messenger keeps the pre-slice posture (a `/recued running`
 *  is just another inbound message). */
export const composeMessengerLiveControl = (
  deps: ComposeMessengerLiveControlDeps,
): MessengerLiveControl | undefined => {
  const { registry, connectionStore, log, passes } = deps;
  if (!registry || !connectionStore) return undefined;
  const now = deps.now ?? Date.now;

  // D-192 CORE #6 — registry-driven maps (no hardcoded `{ slack, telegram }`);
  // the same leaves the turn composer uses, so a new chat transport flows
  // through live-control with no edit here.
  const transports = buildMessengerTransports({
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
  });
  const resolveCredential = buildMessengerCredentialResolvers({
    connectionStore,
    ...(deps.keys ? { keys: deps.keys } : {}),
  });

  /** Resolve the vendor credential, swallowing a decode throw (locked keys,
   *  AEAD failure) to null — a control surface must never 502 the webhook. */
  const resolveCredentialSafe = async (
    vendor: TransportVendor,
    stage: string,
  ): Promise<RemoteChannelCredential | null> => {
    try {
      return await resolveCredential[vendor]();
    } catch (e) {
      log?.('warn', `live-control ${stage} (${vendor}) — credential decode failed`, {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  };

  /** Best-effort plain send — a transient transport failure is logged, never
   *  thrown (the command/press was already consumed). */
  const safeSend = async (
    vendor: TransportVendor,
    credential: RemoteChannelCredential,
    text: string,
  ): Promise<void> => {
    const result = await transports[vendor].send({
      recipient: credential.recipient,
      token: credential.token,
      text,
    });
    if (!result.ok) {
      log?.('warn', `live-control send failed (${vendor})`, {
        kind: result.error.kind,
      });
    }
  };

  /** Render the active list to the bound conversation — an interactive prompt
   *  when there are controllable entries, a plain message otherwise (empty
   *  list, or entries with no targetable id). */
  const renderActiveList = async (
    vendor: TransportVendor,
    credential: RemoteChannelCredential,
  ): Promise<void> => {
    const built = buildActiveListMessage(registry.snapshot(), now());
    if (built.options.length === 0) {
      await safeSend(vendor, credential, built.text);
      return;
    }
    const result = await transports[vendor].sendPrompt({
      recipient: credential.recipient,
      token: credential.token,
      title: 'Recued',
      text: built.text,
      correlation_id: LIVE_CONTROL_CORRELATION_ID,
      options: built.options,
    });
    // A prompt that can't be sent (e.g. a callback payload over Telegram's cap
    // — practically unreachable here) falls back to the plain list so the owner
    // still sees what's running.
    if (!result.ok) {
      log?.('warn', `live-control prompt failed (${vendor}) — sent plain list`, {
        kind: result.error.kind,
      });
      await safeSend(vendor, credential, built.text);
    }
  };

  /** Render the active session-grant passes to the bound conversation — an
   *  interactive prompt with a `Revoke` button per pass, a plain message when
   *  there are none. Reached only when the `passes` seam is wired (the command
   *  handler gates on it), but `?? []` keeps it safe regardless. */
  const renderActivePasses = async (
    vendor: TransportVendor,
    credential: RemoteChannelCredential,
  ): Promise<void> => {
    const built = buildPassesMessage(passes?.list() ?? [], now());
    if (built.options.length === 0) {
      await safeSend(vendor, credential, built.text);
      return;
    }
    const result = await transports[vendor].sendPrompt({
      recipient: credential.recipient,
      token: credential.token,
      title: 'Recued',
      text: built.text,
      correlation_id: LIVE_CONTROL_CORRELATION_ID,
      options: built.options,
    });
    if (!result.ok) {
      log?.('warn', `live-control passes prompt failed (${vendor}) — sent plain list`, {
        kind: result.error.kind,
      });
      await safeSend(vendor, credential, built.text);
    }
  };

  const handleCommand: MessengerLiveControl['handleCommand'] = async (
    vendor,
    connection_name,
    payload,
  ) => {
    // Canonical vendor row only (D-163 I-4) — same lock-step as the turn.
    if (connection_name !== vendor) return false;
    let parsed;
    try {
      parsed = transports[vendor].parseInbound(payload);
    } catch {
      return false;
    }
    if (parsed === null) return false;
    const command = parseRecuedCommand(parsed.text);
    if (!command.recognized) return false;

    // It is a `/recued` command — gate on the bound conversation (the access
    // boundary the turn applies). A command from outside it falls through
    // (returns false): the turn path drops it, the warehouse bus observes it.
    const credential = await resolveCredentialSafe(vendor, 'command');
    if (credential === null) return false;
    const conversation = transports[vendor].parseConversationId(payload);
    if (conversation === null || conversation !== credential.recipient) {
      log?.('warn', `live-control command refused (${vendor}) — outside the bound conversation`, {
        connection_name,
        ...(conversation !== null ? { conversation } : {}),
      });
      return false;
    }

    // Authorized + in the bound conversation: act + consume (never fall through
    // to the LLM turn, even if the send itself fails).
    if (LIST_SUBCOMMANDS.has(command.subcommand)) {
      await renderActiveList(vendor, credential);
    } else if (passes !== undefined && PASSES_SUBCOMMANDS.has(command.subcommand)) {
      await renderActivePasses(vendor, credential);
    } else {
      await safeSend(vendor, credential, USAGE_TEXT);
    }
    return true;
  };

  const handleControlPress: MessengerLiveControl['handleControlPress'] = async (
    vendor,
    connection_name,
    payload,
  ) => {
    if (connection_name !== vendor) return false;
    let choice;
    try {
      choice = transports[vendor].parseInboundChoice(payload);
    } catch {
      return false;
    }
    if (choice === null) return false;
    // Not OUR prompt (an ask reply carries an `ask-…` correlation id) — let the
    // existing parseInboundReply → submitAnswer path handle it.
    if (choice.correlation_id !== LIVE_CONTROL_CORRELATION_ID) return false;

    // It IS our prompt's press — consume it regardless of what follows so it is
    // never double-classified as an ask reply.
    const parsed = parseControlOption(choice.option_id);
    if (parsed === null) {
      log?.('warn', `live-control press (${vendor}) — malformed option`, {
        option_id: choice.option_id,
      });
      return true;
    }

    // Re-gate on the CURRENTLY-bound conversation BEFORE mutating — mirrors the
    // turn's run-time re-gate (`wire-messenger-turn.ts`). Buttons are never
    // closed, so a stale prompt left in a previously-bound conversation must not
    // drive control after a rebind / revoke: a member of that old conversation
    // could otherwise press it. Resolve the current credential first, then
    // compare the callback's conversation to the bound recipient; fail-closed.
    const credential = await resolveCredentialSafe(vendor, 'press');
    if (credential === null) {
      log?.('warn', `live-control press refused (${vendor}) — no credential / recipient enrolled`, {
        connection_name,
      });
      return true;
    }
    const conversation = transports[vendor].parseCallbackConversationId(payload);
    if (conversation === null || conversation !== credential.recipient) {
      log?.('warn', `live-control press refused (${vendor}) — outside the bound conversation`, {
        connection_name,
        ...(conversation !== null ? { conversation } : {}),
      });
      return true;
    }

    // The control is synchronous, local, owner-level, and idempotent (a stale
    // press on an already-terminal run / an already-inert pass is a safe
    // no-op). A `revoke` targets the session-grant seam by the pass's
    // `contract_id`; `kill` / `cancel` / `promote` target the in-flight
    // registry by a run / queued-call id — disjoint id-spaces, the action
    // routes. A `revoke` press with no `passes` seam (graceful-degrade) reads
    // as `not_found`.
    let status: string;
    if (parsed.action === 'revoke') {
      status =
        passes !== undefined && passes.revoke(parsed.target) !== null
          ? 'revoked'
          : 'not_found';
    } else if (parsed.action === 'kill') status = registry.kill(parsed.target);
    else if (parsed.action === 'cancel') status = registry.cancel(parsed.target);
    else status = registry.promote(parsed.target);

    // Best-effort confirmation back to the (now verified) bound conversation.
    await safeSend(vendor, credential, verdictMessage(parsed.action, status));
    return true;
  };

  return { handleCommand, handleControlPress };
};
