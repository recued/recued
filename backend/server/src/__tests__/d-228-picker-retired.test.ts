/** D-228 slice 5 — THE MCP SCOPE-PICKER IS RETIRED, AND STAYS RETIRED.
 *
 *  What was here (`d-137-phase-4-picker.test.ts`, ~500 lines) exercised a
 *  per-conversation scope switch: `Self` / `Bob (data)`, where selecting a peer
 *  swapped the chat catalog wholesale to that peer's tools. It covered
 *  `buildPickerEntries`' visibility gates, the version-delta hint,
 *  `isValidPickerTarget`, and the `chat.picker.{entries,refresh}` rpcs.
 *
 *  ⛔⛔ ALL OF IT IS GONE, and a suite deleted in silence is how a surface comes
 *  back without anyone deciding to. So what replaces it is the claim that the
 *  retirement HOLDS:
 *
 *    - the rpcs are not claimed by the chat handler;
 *    - a peer picker target is REFUSED rather than quietly coerced to `'self'`.
 *
 *  It was safe to delete because it was dead on BOTH ends — no client in `apps/`
 *  consumed `chat.picker.entries` or `chat.picker_entries_changed`, and
 *  `PeerDispatcher` had ZERO implementors, so a peer selection would have
 *  produced an empty catalog even if something had rendered the dropdown. Its
 *  purpose is subsumed: a peer's tools are minted into a LOCAL pack and reach
 *  chat as ordinary `recued_op_*` operations governed by the contract.
 */
import { describe, expect, it } from 'vitest';
import { makeChatHandlers } from '../chat-handler.js';
import type { ChatRpcDeps } from '../chat-handler.js';

const deps = {} as unknown as ChatRpcDeps;

describe('D-228 slice 5 — the picker rpcs are gone', () => {
  it('⛔ the chat handler claims NEITHER picker method', () => {
    const slice = makeChatHandlers(deps);
    expect(slice).toBeDefined();
    const claimed = new Set<string>(slice!.methods as readonly string[]);

    expect(claimed.has('chat.picker.entries')).toBe(false);
    expect(claimed.has('chat.picker.refresh')).toBe(false);
    // ⚠ THE KNOWN POSITIVE. Without it, "neither is claimed" passes just as well
    // for a handler slice that claims nothing at all.
    expect(claimed.has('chat.connection_mcp.set')).toBe(true);
  });
});
