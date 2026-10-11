/** A client and a server that know different broadcast kinds still agree on
 *  the kinds they share (D-148 P12 follow-up, 2026-10-10).
 *
 *  ⛔ ONE UNKNOWN KIND COST A CLIENT EVERY KIND. From 2026-05-07 (D-148 P12)
 *  `events.subscribe` refused the whole call when it named a kind the server
 *  does not send. A webclient cached from before a kind was retired, or a
 *  hosted webclient newer than a self-hosted server, got no live updates at
 *  all and retried the same list forever; 31 commits have added a kind since.
 *  Found live: after `service` was retired, a Chat turn showed "Preparing your
 *  answer…" for five minutes while the server had finished it.
 *
 *  A server now leaves such a kind out and names it in the ack
 *  (`unknown_kinds`). A server from before still refuses, and it never
 *  changes, so a client recognises that refusal by its exact text and asks
 *  again without the kind (`subscribeToKnownKinds`). */

import type { SubscribeAck, SubscribeRequest } from './events.js';

/** The refusal's text, exactly as every server since 2026-05-07 sends it.
 *  Those servers are frozen, so this is a fact about the wire rather than a
 *  choice: a server still sends it for a call that names no kind it knows. */
export const eventsSubscribeUnknownKindMessage = (kind: string): string =>
  `events.subscribe: unknown kind '${kind}' (not in BROADCAST_EVENT_KIND_SET)`;

const UNKNOWN_KIND_REFUSAL =
  /^events\.subscribe: unknown kind '([^']*)' \(not in BROADCAST_EVENT_KIND_SET\)$/;

/** The kind a refused `events.subscribe` named, or null for any other error. */
export const eventsSubscribeRefusedKind = (err: unknown): string | null => {
  if (err === null || typeof err !== 'object') return null;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code !== 'bad_request' || typeof message !== 'string') return null;
  return UNKNOWN_KIND_REFUSAL.exec(message)?.[1] ?? null;
};

/** Subscribe to the kinds this server sends, asking again without each kind
 *  an older server refuses. Resolves with the ack and every kind left out
 *  (refused, or named in the ack's `unknown_kinds`). Any other error is
 *  thrown, and so is the refusal of the last kind left. */
export const subscribeToKnownKinds = async (
  call: (req: SubscribeRequest) => Promise<SubscribeAck>,
  req: SubscribeRequest,
): Promise<{ ack: SubscribeAck; left_out: string[] }> => {
  let kinds = [...req.kinds];
  const refused: string[] = [];
  for (;;) {
    try {
      const ack = await call({ ...req, kinds });
      return { ack, left_out: [...refused, ...(ack.unknown_kinds ?? [])] };
    } catch (err) {
      const kind = eventsSubscribeRefusedKind(err);
      // Each pass drops one named kind, so the loop ends.
      if (kind === null || kinds.length <= 1 || !kinds.some((k) => k === kind)) throw err;
      kinds = kinds.filter((k) => k !== kind);
      refused.push(kind);
    }
  }
};
