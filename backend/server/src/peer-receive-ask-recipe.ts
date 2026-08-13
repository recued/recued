/** D-234 § 234.4 — the wire name of the inbound peer-ask door.
 *
 *  ⛔⛔ THIS FILE ONCE HELD A KERNEL RECIPE, AND THE LIVE DRIVE DELETED IT.
 *  `mcp-server` resolves an incoming tool name through `recipeStore`, and bundled
 *  kernel recipes are deliberately never in it — so a peer's call could never
 *  resolve, on any server, and the failure was silent on both sides.
 *
 *  🔑 The deeper reason it was wrong: if the receiver's whole job is to raise an
 *  ask and answer it, a recipe makes the door CONDITIONAL ON AN INSTALL. The
 *  point of core is that every Recued server can answer a peer out of the box. A
 *  recipe earns its place only when the receiver DOES something — and that is
 *  `peer.run`, not `peer.ask`.
 *
 *  ⇒ The door is now a NATIVE verb-op (`recued_peerAsk`). Nothing is installed,
 *  nothing is bundled, and the § 234.1 admission ceiling does not apply at all —
 *  exposure is the only gate.
 *
 *  ⚠ ONE CONSTANT, IN ONE PLACE. `resolveExchangeFireTarget` matches an installed
 *  binding's `tool` against this string; a literal copy in the fire call would
 *  drift and delivery would resolve to nothing while reporting an uninstalled
 *  binding — which reads as a misconfigured install rather than a defect. */
export const PEER_RECEIVE_ASK_TOOL = 'recued_peerAsk';

/** D-234 § 234.4 return leg — the door the peer's ANSWER comes back through.
 *  Named beside its sibling so the two halves of one conversation cannot drift
 *  apart in the places that reference them by literal. */
export const PEER_RECEIVE_ANSWER_TOOL = 'recued_peerAnswer';


