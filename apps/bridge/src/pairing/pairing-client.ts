/** The side panel's client for the worker's pairing session
 *  (`worker-pairing.ts`). Every call is one `recued.bridge.pair` message;
 *  the worker posts `/auth/pair`, holds the accepted reply, finishes setup
 *  and starts its paired runtime. None of that depends on the panel staying
 *  open (the host's DD#7). */

import type { BridgePairingClient } from './pair-code-input-host.js';
import {
  BRIDGE_PAIR_MESSAGE_TYPE,
  type BridgePairOutcome,
  type BridgePairRequest,
  type BridgePairStatus,
} from './worker-pairing.js';

/** The `chrome.runtime` surface the client needs. */
export interface BridgePairingRuntime {
  sendMessage(message: unknown): Promise<unknown>;
}

const UNUSABLE_ANSWER = "Recued's background service sent back an answer it couldn't use";

const PAIR_STATES: ReadonlySet<string> = new Set(['unpaired', 'pairing', 'accepted', 'paired']);
const OUTCOME_KINDS: ReadonlySet<string> = new Set([
  'refused',
  'accepted',
  'final',
  'busy',
  'paired',
  'nothing_to_finish',
  'error',
]);

/** Reads a worker answer as an outcome. The worker's start-up queue answers
 *  `{ ok: false, error: 'bridge_boot_failed', detail }` when it could not
 *  boot, so anything else unrecognised is reported as unusable. */
const asOutcome = (raw: unknown): BridgePairOutcome => {
  if (raw && typeof raw === 'object') {
    const r = raw as { ok?: unknown; kind?: unknown; serverUrl?: unknown; detail?: unknown; error?: unknown };
    if (r.ok === true && typeof r.serverUrl === 'string') return raw as BridgePairOutcome;
    if (r.ok === false && typeof r.kind === 'string' && OUTCOME_KINDS.has(r.kind)) {
      return raw as BridgePairOutcome;
    }
    if (r.ok === false && typeof r.error === 'string') {
      return {
        ok: false,
        kind: 'error',
        detail: typeof r.detail === 'string' && r.detail.length > 0 ? r.detail : r.error,
      };
    }
  }
  return { ok: false, kind: 'error', detail: UNUSABLE_ANSWER };
};

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const createRuntimePairingClient = (runtime: BridgePairingRuntime): BridgePairingClient => {
  const ask = (request: BridgePairRequest): Promise<unknown> => runtime.sendMessage(request);
  const askOutcome = async (request: BridgePairRequest): Promise<BridgePairOutcome> => {
    try {
      return asOutcome(await ask(request));
    } catch (err) {
      return { ok: false, kind: 'error', detail: describe(err) };
    }
  };

  return {
    async status() {
      const raw = (await ask({ type: BRIDGE_PAIR_MESSAGE_TYPE, op: 'status' })) as {
        state?: unknown;
      } | null;
      if (!raw || typeof raw.state !== 'string' || !PAIR_STATES.has(raw.state)) {
        throw new Error(UNUSABLE_ANSWER);
      }
      if (raw.state === 'unpaired') {
        // The refusal is shown and its address typed into the form: only a usable one passes.
        const refused = (raw as { refused?: { serverUrl?: unknown } }).refused;
        const disconnected = (raw as { disconnected?: { serverUrl?: unknown } }).disconnected;
        return typeof refused?.serverUrl === 'string' && refused.serverUrl.length > 0
          ? { state: 'unpaired', refused: { serverUrl: refused.serverUrl } }
          : typeof disconnected?.serverUrl === 'string' && disconnected.serverUrl.length > 0
            ? { state: 'unpaired', disconnected: { serverUrl: disconnected.serverUrl } }
            : { state: 'unpaired' };
      }
      return raw as BridgePairStatus;
    },
    async wait() {
      try {
        const raw = await ask({ type: BRIDGE_PAIR_MESSAGE_TYPE, op: 'wait' });
        return raw === null || raw === undefined ? null : asOutcome(raw);
      } catch (err) {
        return { ok: false, kind: 'error', detail: describe(err) };
      }
    },
    start: (input) => askOutcome({ type: BRIDGE_PAIR_MESSAGE_TYPE, op: 'start', input }),
    finish: () => askOutcome({ type: BRIDGE_PAIR_MESSAGE_TYPE, op: 'finish' }),
    async abandon() {
      const raw = (await ask({ type: BRIDGE_PAIR_MESSAGE_TYPE, op: 'abandon' })) as { ok?: unknown } | null;
      if (!raw || typeof raw.ok !== 'boolean') throw new Error(UNUSABLE_ANSWER);
      return { ok: raw.ok };
    },
  };
};

/** Minimal user-agent → label parser. Closed-list browser × OS table
 *  per spec § A.6 ("Default label is assembled at pair time as
 *  `Bridge${N} ${user_agent_class}`"). The server stamps the ordinal
 *  separately; this is a hint for the `displayName` post-body. */
export const deriveBridgeDeviceLabel = (ua: string): string => {
  let browser = 'Browser';
  if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('Chrome/')) browser = 'Chrome';
  else if (ua.includes('Firefox/')) browser = 'Firefox';
  else if (ua.includes('Safari/')) browser = 'Safari';
  let os = 'Device';
  if (ua.includes('Mac OS') || ua.includes('macOS')) os = 'macOS';
  else if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Linux')) os = 'Linux';
  else if (ua.includes('CrOS')) os = 'ChromeOS';
  return `${browser} on ${os}`;
};
