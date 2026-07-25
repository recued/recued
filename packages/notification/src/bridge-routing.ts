/** D-169 P2 Slice 4 — per-bridge notification fan-out routing.
 *
 *  The block holds exactly ONE `'bridge'` Channel adapter (D-163 N.4)
 *  but the user pairs N bridges, each with its own
 *  `BridgeModeSettings { notification, approval }` (D-169 P1, keyed on
 *  `client_tokens.token_id`). These pure helpers map ONE bridge's modes
 *  to how the bridge surface should treat a given dispatch — the per-
 *  bridge routing decision the block enumerates over `describeBridges()`
 *  per ask raise (N.6 / I-10 / TR-12: decided at raise time so a toggle
 *  takes effect on the next ask).
 *
 *  Kept as standalone pure functions (not block closures) so the
 *  decision table is unit-testable in isolation and the block's fan-out
 *  loop reads as a thin map over them.
 *
 *  Spec: D-169 § A.6 / N.6 / I-10. */

import type { BridgeModeSettings } from './types.js';

/** How a single bridge's modes route an `ask`:
 *   - `'ask'`            — approval mode ON: the bridge surface receives
 *                          the interactive ask (treated as `'inline'`
 *                          capability for this bridge, D-163 N.3 / D-169
 *                          N.6). Approval wins when both modes are on.
 *   - `'passive_notify'` — approval OFF but notification ON: a passive
 *                          `deliverNotify` carrying "approval pending"
 *                          (D-163 N.3 / I-3 — same posture as any
 *                          notify-only surface).
 *   - `'skip'`           — both modes OFF: the bridge is skipped entirely
 *                          (TR-8 — both default off, opt-in not opt-out). */
export type BridgeAskDisposition = 'ask' | 'passive_notify' | 'skip';

/** Route one bridge's modes for an `ask` raise. Approval takes
 *  precedence over notification (an approval-capable bridge renders the
 *  interactive card; the passive notify is the lesser surface). */
export const routeBridgeAsk = (
  modes: BridgeModeSettings,
): BridgeAskDisposition =>
  modes.approval ? 'ask' : modes.notification ? 'passive_notify' : 'skip';

/** Route one bridge's modes for a `notify` (one-way) dispatch — every
 *  bridge with notification mode ON receives the notify, regardless of
 *  approval mode (a one-way notification has no interactive contract, so
 *  approval mode is irrelevant to it). Both off → not delivered. */
export const routeBridgeNotify = (modes: BridgeModeSettings): boolean =>
  modes.notification;
