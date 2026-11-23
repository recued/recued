import { createHash } from 'node:crypto';
import { BRIDGE_INSPECT_OUTPUT_KEYS, BRIDGE_READ_SETTLE_MAX_MS, BRIDGE_SHORT_WAIT_MAX_MS, type BridgeCapabilityProfile, type BridgeCommand,
  type BridgeReadinessCheck } from '@recued/contracts';

const READINESS_ACTIONS = new Set(['open_tab', 'navigate', 'go_back', 'reload_page', 'inspect', 'reread', 'describe', 'click', 'press', 'submit', 'pick']);

/** Negotiate per selected Bridge, without changing legacy commands or replaying
 * a receipt made under a different readiness policy. Reviewed commands stay exact. */
export const withBridgeReadiness = (command: Omit<BridgeCommand, 'command_id'>, profile: BridgeCapabilityProfile,
  options: { domReadiness?: boolean; readyClicks?: boolean }, check?: BridgeReadinessCheck): Omit<BridgeCommand, 'command_id'> => {
  if (command.args.preserve_structure === true && profile.structural_reads === true
    && ['inspect', 'reread'].includes(command.action)) {
    command = { ...command, args: { ...command.args, structure_scoped: true }, idempotency_key: `${command.idempotency_key}:structure:2`,
      expects_output_keys: [...new Set([...command.expects_output_keys, 'structure_complete', 'structure_root', 'structure_scoped'])] };
  }
  if (command.action === 'wait_for_element' && command.args.capture_read !== undefined) {
    if (profile.wait_read === true && !command.reviewed_document) {
      const hash = createHash('sha256').update(JSON.stringify(command.args.capture_read)).digest('hex').slice(0, 16);
      command = { ...command, idempotency_key: `${command.idempotency_key}:capture:${hash}`,
        expects_output_keys: [...new Set([...command.expects_output_keys, ...BRIDGE_INSPECT_OUTPUT_KEYS, 'loading'])] };
    } else {
      const { capture_read: _capture, ...args } = command.args;
      command = { ...command, args };
    }
  }
  // 2026-11-20 — a read on a Bridge that can first waits for the page to stop changing, and says whether it had
  //   (`BRIDGE_READ_QUIET_MS`). A click that loads nothing was read as the page drew; the model padded nearly every
  //   batch with a fixed wait instead.
  // 2026-11-20 (the owner: "go ahead", a wait at the Bridge) — a plain wait of seconds goes as a read that waits for the
  //   page to change, then hold still (`wait_change_ms`). A Bridge that cannot is sent a plain read, never refused: it
  //   answers no `changed`, and the server waits as it did.
  // 2026-11-21 (D-402, task H) — and one whose wait for a change stops at 10 s (no `long_waits`) is sent a plain read for a
  //   longer wait, so the server waits all of it rather than the Bridge answering "no change" at 10 s.
  if (command.args.wait_change_ms !== undefined) {
    const waitsThatLong = Number(command.args.wait_change_ms) <= BRIDGE_SHORT_WAIT_MAX_MS || profile.long_waits === true;
    if (profile.settled_waits === true && waitsThatLong && !command.reviewed_document && (command.action === 'inspect' || command.action === 'reread')) {
      command = { ...command, idempotency_key: `${command.idempotency_key}:change:1`,
        expects_output_keys: [...new Set([...command.expects_output_keys, 'settled', 'changed'])] };
    } else {
      const { wait_change_ms: _wait, ...args } = command.args;
      command = { ...command, args };
    }
  }
  if (profile.settled_reads === true && !command.reviewed_document && options.domReadiness !== false
    && (command.action === 'inspect' || command.action === 'reread') && command.args.settle_ms === undefined) {
    command = { ...command, args: { ...command.args, settle_ms: BRIDGE_READ_SETTLE_MAX_MS },
      idempotency_key: `${command.idempotency_key}:settle:1`,
      expects_output_keys: [...new Set([...command.expects_output_keys, 'settled'])] };
  }
  if (command.reviewed_document || profile.dom_readiness !== true) return command;
  const dom = options.domReadiness !== false && READINESS_ACTIONS.has(command.action);
  const ready = options.readyClicks === true && check !== undefined && ['click', 'press', 'submit'].includes(command.action);
  if (!dom && !ready) return command;
  const additions = { ...(dom ? { dom_ready: true } : {}), ...(ready ? { ready_check: check } : {}) };
  const binding = createHash('sha256').update(JSON.stringify(additions)).digest('hex').slice(0, 16);
  const loading = dom && command.expects_output_keys.includes('page');
  return { ...command, args: { ...command.args, ...additions }, idempotency_key: `${command.idempotency_key}:ready:${binding}`,
    expects_output_keys: loading ? [...new Set([...command.expects_output_keys, 'loading'])] : command.expects_output_keys };
};

/** Durations use one monotonic server clock; Bridge duration is a separate
 * elapsed measurement. No arguments, results, addresses or credentials. */
export interface BridgeDispatchTiming {
  command_id: string;
  action: BridgeCommand['action'];
  attempt: number;
  status: string;
  admission_ms: number;
  send_ms: number;
  round_trip_ms: number;
  bridge_duration_ms?: number;
  outside_bridge_ms?: number;
}
