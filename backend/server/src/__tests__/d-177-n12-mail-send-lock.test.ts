/** D-177 N.12 — `collection.mail.send` envelope-unification ratchet.
 *
 *  The N.12 finding: outbound mail send is a side-effecting action, and
 *  D-177's whole thesis is that every action is gated at ONE enforcement
 *  boundary (the gateway, via the contract's per-entity_action policy). A
 *  directly-reachable `collection.mail.send` wire rpc would be a
 *  trust-bypass around that boundary — its `to[]` is a PER-CALL arbitrary
 *  recipient (never pre-authorized), so the rpc-layer checks instead of
 *  the gateway verdict + no held-action machinery (an attachment's
 *  `data-file-read` `ask` degrades to deny) is exactly the exfiltration
 *  vector.
 *
 *  The fix is structural, not a second gate: `collection.mail.send` is NOT
 *  a wire method. The sole entry point to an arbitrary-recipient mail send
 *  is the `recued/mail-send` kernel ingredient, which rides the gateway's
 *  outbound-send escalation (`preflight-gate.ts` lifts it to `ask`);
 *  `handleCollectionMailSend` is the gateway's INTERNAL executor, called by
 *  the kernel `mailSend` dispatcher AFTER the verdict — never over the wire.
 *
 *  NOT in scope (deliberately): `notification.send` STAYS a wire method —
 *  its authorization is the deliberate endpoint setup (enroll + assign +
 *  switch on), it carries NO per-call recipient (`text` → the switched-on
 *  channels, destination from the enrolled config), so it cannot be aimed
 *  at an arbitrary target. The arbitrary-recipient path (`mail-post` with
 *  `to[]`) is the gated kernel ingredient. (An earlier draft over-locked
 *  `notification.send` on a codex false-positive; reverted.)
 *
 *  This ratchet pins BOTH halves so a future change can't silently re-open
 *  the bypass OR sever the gated path:
 *    A. the bypass is closed   — not a wire method, not wired by the
 *       collection slice, not MCP-reachable;
 *    B. the gated path is intact — the executor still exists, and
 *       `mail-send` still rides the outbound-send escalation.
 *
 *  Spec: docs/d-177-spec.md § N.12. */

import { describe, expect, it } from 'vitest';
import {
  SERVER_RPC_METHOD_SET,
  MCP_TOOL_CATALOG_SET,
  isMcpToolName,
  isOutboundSendSlug,
} from '@recued/contracts';
import {
  makeCollectionHandlers,
  handleCollectionMailSend,
  type CollectionHandlerDeps,
} from '../collections/collection-handler.js';

const WIRE_METHOD = 'collection.mail.send';
const KERNEL_SLUG = 'mail-send';

describe('D-177 N.12 — collection.mail.send is gateway-executor-only (bypass closed)', () => {
  it('is NOT a wire rpc method (absent from SERVER_RPC_METHOD_SET)', () => {
    // The strongest single guard: ws-server validates every wired method
    // is in SERVER_RPC_METHOD_SET, so absence here means NO handler slice
    // can wire it without first re-adding it to the registry (which this
    // assertion then catches). Re-adding the registry spec re-opens the
    // bypass — fail loudly.
    expect(SERVER_RPC_METHOD_SET.has(WIRE_METHOD)).toBe(false);
  });

  it('is NOT wired by the collection handler slice', () => {
    // `makeCollectionHandlers` builds a static methods array independent of
    // deps contents; a truthy stub is enough to read it.
    const slice = makeCollectionHandlers({} as CollectionHandlerDeps);
    expect(slice).toBeDefined();
    expect(slice?.methods).not.toContain(WIRE_METHOD);
    // The handler map must not carry it either (belt + suspenders — a
    // method absent from the array but present in `handlers` would still
    // be reachable through a permissive dispatcher).
    expect(
      Object.prototype.hasOwnProperty.call(slice?.handlers ?? {}, WIRE_METHOD),
    ).toBe(false);
  });

  it('is NOT reachable by MCP-channel agents', () => {
    // collection.* is never MCP-exposed (MCP reaches only MCP_TOOL_CATALOG
    // + the dynamic recued_ingredient_* tools); pin it so the invariant is
    // explicit at the mail-send surface.
    expect(isMcpToolName(WIRE_METHOD)).toBe(false);
    expect(MCP_TOOL_CATALOG_SET.has(WIRE_METHOD)).toBe(false);
    // The dynamic per-ingredient tool for mail-send IS catalogable (it
    // routes through run-ingredient → handleExecute → the GATE), which is
    // the legitimate, gated MCP path — distinct from the raw wire rpc.
  });
});

describe('D-177 N.12 — notification.send STAYS a wire method (setup-authorized)', () => {
  it('is a wire rpc method — authorization is endpoint setup, not the contract', () => {
    // `notification.send` carries no per-call recipient — `text` fans out to
    // the user's switched-on channels (destination from the enrolled
    // config), so it cannot be aimed at an arbitrary target the way
    // `collection.mail.send`'s `to[]` can. It is NOT a trust-bypass and is
    // deliberately retained on the wire. (Guards against re-removing it on
    // the same codex false-positive that briefly over-locked it: the email
    // channel reaching `handleCollectionMailSend` is reachability, not an
    // arbitrary send — the recipient is `config.default_recipient`.)
    expect(SERVER_RPC_METHOD_SET.has('notification.send')).toBe(true);
  });
});

describe('D-177 N.12 — the gated send path stays intact', () => {
  it('keeps handleCollectionMailSend exported as the internal executor', () => {
    // The lock removes the WIRE surface, not the executor: the kernel
    // `mailSend` dispatcher calls this directly, post-gate.
    expect(typeof handleCollectionMailSend).toBe('function');
  });

  it('keeps mail-send on the outbound-send escalation (gated entry point)', () => {
    // The one entry point to an outbound mail send — the `recued/mail-send`
    // kernel ingredient — must still ride the gateway's outbound-send
    // escalation so an attended send holds for approval (ask). If this
    // flips false, the lock would have closed the bypass while leaving the
    // sanctioned path ungated — the opposite failure.
    expect(isOutboundSendSlug(KERNEL_SLUG)).toBe(true);
  });
});
