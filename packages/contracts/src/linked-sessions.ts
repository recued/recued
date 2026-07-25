/** D-153 P5 — Linked sessions + reverse index.
 *
 *  A user's work on one topic crosses surfaces: they ask a question in
 *  a Slack thread, continue it in the WebClient that evening, branch a
 *  side-question into a third conversation. D-153's three-tier session
 *  IDs (channel / cognition / correlation) name each of those windows;
 *  P5 names the *links between* them.
 *
 *  Every session — at either the channel layer (a Slack thread, a chat
 *  conversation, an MCP token lifetime) or the cognition layer (one
 *  context window / cognition component) — carries an optional
 *  `predecessor_session_id`:
 *
 *    - **Linked session** — `predecessor_session_id` set. The new
 *      session continues from a prior one; a cognition component (when
 *      one is plugged in) walks the predecessor chain to recover the
 *      prior session's working state.
 *    - **Fresh session** — `predecessor_session_id` absent. A cold
 *      start with no prior context.
 *
 *  *What* a linked session recovers — full K/V transfer, summary
 *  handoff, or cold replay from commits + memory — is an availability
 *  outcome decided by cognition, not a substrate mode (spec line 523).
 *  The substrate models exactly one thing: the predecessor edge.
 *
 *  **Forking tree, single parent.** A session has at most one
 *  predecessor — the type carries one optional id, never an array.
 *  Sessions therefore form a forking *tree* (a forest, across roots),
 *  not a general DAG: a topic can branch (one predecessor, many
 *  descendants — parallel conversations across Slack + WebClient) but
 *  two histories never *merge* into one session. Merging two
 *  predecessors would imply substrate-level synthesis of two
 *  histories; that is an orchestrator concern (a cognition session
 *  that *reads* both predecessors and emits fresh commits referencing
 *  each), not a substrate one. Single-parent keeps the predecessor
 *  walk unambiguous — one chain to follow up, one tree to fan out
 *  down.
 *
 *  **Reverse index → descendant discovery.** The headline use case:
 *  the user returns to Slack thread A days after they continued it in
 *  the WebClient (session B, predecessor A). Before the engine opens a
 *  new session for the thread it asks the reverse index "what forked
 *  off A?", finds B, and prompts: "you continued this in the WebClient
 *  earlier — pick up from there, or start fresh?" `buildSessionReverse-
 *  Index` + `discoverDescendants` are that lookup.
 *
 *  **Both layers, one substrate.** The substrate treats the channel
 *  and cognition layers identically — a session link is pure graph
 *  data; building a tree of cognition-session ids needs no cognition
 *  *component*. The `layer` discriminator only keeps the two trees
 *  from cross-linking (`predecessor_layer_mismatch`). What the
 *  2026-05-19 cognition downscope defers is the *consumer* of
 *  cognition-layer links — `read_chain()` K/V transfer along the
 *  predecessor chain (D-153 P4 / cognition substrate). The
 *  channel-layer tree has a live consumer today: the descendant-
 *  discovery prompt above. So nothing here is gated or stubbed; the
 *  substrate is layer-agnostic and the cognition consumer simply
 *  arrives later.
 *
 *  P5 ships substrate-only — the types, the validator, the reverse
 *  index, and the discovery composition land here. Deferred:
 *
 *    - **The session store.** Where `predecessor_session_id` is
 *      persisted is the Engine's session lifecycle (D-145). The
 *      substrate operates on a `SessionNode` list the caller already
 *      has; `SessionNode` is a minimal projection, decoupled from the
 *      Engine's eventual session row (a structural supertype the engine
 *      wiring passes straight through).
 *    - **The descendant-discovery rpc.** A storage-backed
 *      `WHERE predecessor_session_id = ?` query + its rpc handler are
 *      engine + rpc work. `buildSessionReverseIndex` is the in-memory
 *      stand-in + the reference semantics that query must match;
 *      `discoverDescendants` is the shape that rpc returns.
 *
 *  Cognition-independent. Matches the P1 / P2 / P3 / P8 substrate-first
 *  pattern.
 *
 *  Spec: D-153 § Linked sessions — one primitive covers
 *  swap / transfer / continuation (lines 507-533). */

// ────────────────────────────────────────────────────────────────
// Session layer — which of the two tiers a session belongs to
// ────────────────────────────────────────────────────────────────

/** Closed enumeration of session layers. D-153's three-tier session
 *  IDs nest channel ⊃ cognition ⊃ correlation; only the outer two are
 *  *sessions* that carry a `predecessor_session_id`. `correlation_id`
 *  is an intent-burst grouping key, not a linkable session.
 *
 *  - `'channel'`   — the channel's own boundary (a Slack thread, a
 *    chat conversation, an MCP token lifetime). Its predecessor tree
 *    drives the descendant-discovery prompt.
 *  - `'cognition'` — one engine-assigned cognition window (same
 *    context window / system prompt / cognition component). Its
 *    predecessor chain is what a cognition `read_chain()` walks for
 *    K/V state transfer (D-153 P4, deferred).
 *
 *  The two layers have independent id spaces; a predecessor must
 *  share its descendant's layer (`predecessor_layer_mismatch`). */
export const SESSION_LAYERS = ['channel', 'cognition'] as const;

/** String-literal union derived from `SESSION_LAYERS`. */
export type SessionLayer = (typeof SESSION_LAYERS)[number];

/** Predicate — true when `value` is a known `SessionLayer`. */
export const isSessionLayer = (value: unknown): value is SessionLayer =>
  typeof value === 'string'
  && (SESSION_LAYERS as readonly string[]).includes(value);

// ────────────────────────────────────────────────────────────────
// SessionNode — the minimal session projection the graph reads
// ────────────────────────────────────────────────────────────────

/** The minimal projection of a session record the linked-session graph
 *  needs. The substrate takes this rather than a full session row so it
 *  stays decoupled from the Engine's session lifecycle (D-145), which
 *  owns where `predecessor_session_id` is persisted — that row is a
 *  structural supertype of this shape, so the engine wiring passes its
 *  rows straight through.
 *
 *  Every field is load-bearing for the validator or the index:
 *    - `session_id` — identity; the node's own id and what descendants
 *      point at via `predecessor_session_id`.
 *    - `layer` — `'channel'` / `'cognition'`; keeps the two trees from
 *      cross-linking (`predecessor_layer_mismatch`).
 *    - `predecessor_session_id` — the single parent edge. Absent on a
 *      fresh session and on a root; present on a linked session.
 *    - `created_at` — unix-ms; orders sibling branches and selects the
 *      `latest_leaf` recency default. */
export interface SessionNode {
  readonly session_id: string;
  readonly layer: SessionLayer;
  readonly predecessor_session_id?: string;
  readonly created_at: number;
}

/** Structural predicate — true when `value` matches `SessionNode`
 *  exactly. The descendant-discovery rpc / engine wiring receives
 *  session rows from the D-145 store as untyped JSON; this narrows them
 *  before the validator + index trust the shape. `predecessor_session_id`,
 *  when present, must be a non-empty string — an empty id is malformed,
 *  not an absent predecessor. */
export const isSessionNode = (value: unknown): value is SessionNode => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.session_id !== 'string' || v.session_id.length === 0) {
    return false;
  }
  if (!isSessionLayer(v.layer)) return false;
  if (
    v.predecessor_session_id !== undefined
    && (typeof v.predecessor_session_id !== 'string'
      || v.predecessor_session_id.length === 0)
  ) {
    return false;
  }
  return typeof v.created_at === 'number' && Number.isFinite(v.created_at);
};

/** True when a session is *linked* — it carries a non-empty
 *  `predecessor_session_id` and therefore continues from a prior
 *  session. A *fresh* session is the complement (no predecessor) — a
 *  cold start. The substrate's only mode distinction; what a linked
 *  session actually recovers is cognition's call (spec line 523). */
export const isLinkedSession = (
  node: Pick<SessionNode, 'predecessor_session_id'>,
): boolean =>
  typeof node.predecessor_session_id === 'string'
  && node.predecessor_session_id.length > 0;

// ────────────────────────────────────────────────────────────────
// Session-link validation — pure graph validator
// ────────────────────────────────────────────────────────────────

/** Closed enumeration of `validateSessionLinks` issue codes.
 *
 *  - `'duplicate_session_id'`        — two nodes share a `session_id`;
 *    the graph's identity invariant is broken.
 *  - `'predecessor_self_reference'`  — a node lists itself as its own
 *    predecessor; a session cannot continue from itself.
 *  - `'predecessor_layer_mismatch'`  — a node links to a predecessor of
 *    the other layer; channel and cognition trees never cross-link.
 *  - `'predecessor_cycle'`           — the predecessor chain loops; a
 *    forking tree is acyclic by construction.
 *
 *  A predecessor id that points outside the validated node set is NOT
 *  an issue — predecessors legitimately fall outside a partial query
 *  window (an archived session), and the spec's "cold start" handoff
 *  outcome is exactly that case. The validator only judges links it
 *  can fully see. */
export const SESSION_LINK_ISSUE_CODES = [
  'duplicate_session_id',
  'predecessor_self_reference',
  'predecessor_layer_mismatch',
  'predecessor_cycle',
] as const;

/** String-literal union derived from `SESSION_LINK_ISSUE_CODES`. */
export type SessionLinkIssueCode = (typeof SESSION_LINK_ISSUE_CODES)[number];

/** Predicate — true when `value` is a known `SessionLinkIssueCode`. */
export const isSessionLinkIssueCode = (
  value: unknown,
): value is SessionLinkIssueCode =>
  typeof value === 'string'
  && (SESSION_LINK_ISSUE_CODES as readonly string[]).includes(value);

/** One issue surfaced by `validateSessionLinks`. */
export interface SessionLinkIssue {
  /** Which rule the node broke. */
  readonly code: SessionLinkIssueCode;
  /** The offending node's `session_id`. */
  readonly session_id: string;
  /** The other session the issue implicates — the predecessor for
   *  `predecessor_layer_mismatch` and `predecessor_cycle`. Absent for
   *  `duplicate_session_id` and `predecessor_self_reference`, which
   *  concern a single session. */
  readonly related_session_id?: string;
  /** Human-readable explanation for the Kitchen / Settings surface. */
  readonly message: string;
}

/** Pure graph validator over a set of session nodes. Confirms the set
 *  forms a valid forking forest. Returns the empty array when valid.
 *  Never throws, never mutates the input.
 *
 *  Assumes well-formed `SessionNode`s — shape validation is
 *  `isSessionNode`'s job; this validator judges the *graph*. When the
 *  caller holds untyped rows, narrow with `isSessionNode` first.
 *
 *  Rules (all hard errors — pre-launch zero installs posture):
 *    - no two nodes share a `session_id`;
 *    - no node is its own predecessor;
 *    - a predecessor present in the set shares its descendant's layer;
 *    - the predecessor graph is acyclic.
 *
 *  A self-referential node is reported as `predecessor_self_reference`
 *  only — it is excluded from cycle detection so it does not also
 *  surface a redundant single-node `predecessor_cycle`. */
export const validateSessionLinks = (
  nodes: ReadonlyArray<SessionNode>,
): SessionLinkIssue[] => {
  const issues: SessionLinkIssue[] = [];

  // ── duplicate_session_id — reported once per repeated id ──
  const seen = new Set<string>();
  const dupReported = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.session_id)) {
      if (!dupReported.has(n.session_id)) {
        issues.push({
          code: 'duplicate_session_id',
          session_id: n.session_id,
          message: `session_id "${n.session_id}" appears more than once`,
        });
        dupReported.add(n.session_id);
      }
    } else {
      seen.add(n.session_id);
    }
  }

  // Deduped lookup (last occurrence wins) — mirrors what
  // `buildSessionReverseIndex` does, so the two agree on a malformed
  // input.
  const byId = new Map<string, SessionNode>();
  for (const n of nodes) byId.set(n.session_id, n);

  // ── predecessor_self_reference ──
  const selfRefs = new Set<string>();
  for (const n of byId.values()) {
    if (n.predecessor_session_id === n.session_id) {
      selfRefs.add(n.session_id);
      issues.push({
        code: 'predecessor_self_reference',
        session_id: n.session_id,
        message: `session "${n.session_id}" lists itself as its predecessor`,
      });
    }
  }

  // ── predecessor_layer_mismatch ──
  for (const n of byId.values()) {
    const predId = n.predecessor_session_id;
    if (predId === undefined || selfRefs.has(n.session_id)) continue;
    const pred = byId.get(predId);
    // An absent predecessor is not an issue (see the issue-code doc).
    if (pred && pred.layer !== n.layer) {
      issues.push({
        code: 'predecessor_layer_mismatch',
        session_id: n.session_id,
        related_session_id: predId,
        message:
          `${n.layer} session "${n.session_id}" links to ${pred.layer} `
          + `session "${predId}" — a predecessor must share the layer`,
      });
    }
  }

  // ── predecessor_cycle ──
  const cyclic = collectCyclicSessions(byId, selfRefs);
  for (const id of byId.keys()) {
    if (!cyclic.has(id)) continue;
    issues.push({
      code: 'predecessor_cycle',
      session_id: id,
      related_session_id: byId.get(id)?.predecessor_session_id,
      message: `session "${id}" sits on a predecessor cycle`,
    });
  }

  return issues;
};

/** Collect every `session_id` that sits on a predecessor cycle.
 *
 *  The predecessor graph is a *functional graph* — each node has at
 *  most one outgoing edge (its single predecessor) — so each component
 *  contains at most one cycle. Detection follows predecessor pointers
 *  from each unvisited node, colouring nodes `1` (on the current walk)
 *  then `2` (settled); reaching a node still coloured `1` closes a
 *  cycle, and the tail of the walk from that node onward is the cycle.
 *
 *  Self-referential nodes are skipped (their predecessor edge is not
 *  followed) — they carry the clearer `predecessor_self_reference`
 *  diagnostic and must not also appear here. */
const collectCyclicSessions = (
  byId: ReadonlyMap<string, SessionNode>,
  selfRefs: ReadonlySet<string>,
): Set<string> => {
  const cyclic = new Set<string>();
  const color = new Map<string, 1 | 2>();

  for (const start of byId.keys()) {
    if (color.has(start)) continue;
    const path: string[] = [];
    let cur: string | undefined = start;
    while (
      cur !== undefined
      && byId.has(cur)
      && !color.has(cur)
      && !selfRefs.has(cur)
    ) {
      color.set(cur, 1);
      path.push(cur);
      cur = byId.get(cur)!.predecessor_session_id;
    }
    // Stopped on a node still on the current walk → a cycle; the walk
    // tail from that node onward is its membership.
    if (cur !== undefined && color.get(cur) === 1) {
      const cycleStart = path.indexOf(cur);
      for (let i = cycleStart; i < path.length; i += 1) {
        cyclic.add(path[i]);
      }
    }
    for (const id of path) color.set(id, 2);
  }

  return cyclic;
};

// ────────────────────────────────────────────────────────────────
// Reverse index — predecessor → descendants
// ────────────────────────────────────────────────────────────────

/** Total order over session nodes — `created_at` ascending, ties
 *  broken by `session_id` code-point ascending. Deterministic across
 *  environments (no locale-sensitive `localeCompare`). */
const compareSessionNodes = (a: SessionNode, b: SessionNode): number => {
  if (a.created_at !== b.created_at) return a.created_at - b.created_at;
  if (a.session_id < b.session_id) return -1;
  if (a.session_id > b.session_id) return 1;
  return 0;
};

/** A queryable view over a set of session nodes — the predecessor edge
 *  read in both directions. Built once by `buildSessionReverseIndex`,
 *  then queried many times.
 *
 *  Every walk is cycle-safe: a malformed input containing a predecessor
 *  cycle terminates each walk via a visited set rather than looping
 *  forever, so a corrupt graph degrades gracefully instead of hanging
 *  the engine. `descendants` / `directChildren` / `leaves` results are
 *  totally ordered (`created_at`, then `session_id`); `ancestors`
 *  preserves chain order (nearest-first). */
export interface SessionReverseIndex {
  /** The node for `session_id`, or `undefined` when it is not in the
   *  indexed set. */
  node(session_id: string): SessionNode | undefined;
  /** Count of indexed nodes (deduped by `session_id`). */
  size(): number;
  /** Direct children — nodes whose `predecessor_session_id` equals
   *  `session_id`. Sorted. Empty when no node names `session_id` as
   *  its predecessor; the queried `session_id` need not itself be an
   *  indexed node — an archived predecessor outside the set still
   *  resolves its in-set children. */
  directChildren(session_id: string): SessionNode[];
  /** All transitive descendants — children, their children, and so on.
   *  Excludes `session_id` itself even when a cycle would make it
   *  reachable. Sorted. */
  descendants(session_id: string): SessionNode[];
  /** The predecessor chain — `session_id`'s predecessor, then *its*
   *  predecessor, and so on, nearest-first, up to a root or the edge
   *  of the indexed set (an archived predecessor outside the set ends
   *  the walk). Excludes `session_id` itself. This is the chain a
   *  cognition `read_chain()` (D-153 P4, deferred) walks K/V state
   *  along. */
  ancestors(session_id: string): SessionNode[];
  /** Descendant *leaves* — descendants that have no children of their
   *  own. The pick-up-from-here candidates the descendant-discovery
   *  prompt offers. Sorted. */
  leaves(session_id: string): SessionNode[];
}

/** Build a `SessionReverseIndex` over a session-node list. Pure — the
 *  in-memory stand-in for the storage-backed
 *  `WHERE predecessor_session_id = ?` query (engine + rpc work,
 *  deferred) and the reference semantics that query must match.
 *
 *  A malformed input with a repeated `session_id` is tolerated, not
 *  rejected: the index dedups by `session_id` (last occurrence wins) so
 *  the adjacency it builds is never corrupt. `validateSessionLinks`
 *  flags the duplicate; the index simply does not depend on the input
 *  being valid. Self-referential predecessor edges are dropped from the
 *  adjacency (a node is never its own child). */
export const buildSessionReverseIndex = (
  nodes: ReadonlyArray<SessionNode>,
): SessionReverseIndex => {
  const byId = new Map<string, SessionNode>();
  for (const n of nodes) byId.set(n.session_id, n);

  // predecessor_session_id → direct children, built from the deduped
  // node set. A self-referential edge is skipped.
  const childrenOf = new Map<string, SessionNode[]>();
  for (const n of byId.values()) {
    const predId = n.predecessor_session_id;
    if (predId === undefined || predId === n.session_id) continue;
    const bucket = childrenOf.get(predId);
    if (bucket) bucket.push(n);
    else childrenOf.set(predId, [n]);
  }

  const sortedCopy = (list: ReadonlyArray<SessionNode>): SessionNode[] =>
    [...list].sort(compareSessionNodes);

  const directChildren = (session_id: string): SessionNode[] =>
    sortedCopy(childrenOf.get(session_id) ?? []);

  const descendants = (session_id: string): SessionNode[] => {
    const out: SessionNode[] = [];
    // Seed `visited` with the root so a cycle back to it is ignored and
    // the root itself never appears among its own descendants.
    const visited = new Set<string>([session_id]);
    const queue: string[] = [session_id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const child of childrenOf.get(cur) ?? []) {
        if (visited.has(child.session_id)) continue;
        visited.add(child.session_id);
        out.push(child);
        queue.push(child.session_id);
      }
    }
    return out.sort(compareSessionNodes);
  };

  const ancestors = (session_id: string): SessionNode[] => {
    const out: SessionNode[] = [];
    const visited = new Set<string>([session_id]);
    let cur = byId.get(session_id)?.predecessor_session_id;
    while (cur !== undefined && !visited.has(cur)) {
      const node = byId.get(cur);
      if (!node) break; // predecessor outside the indexed set
      visited.add(cur);
      out.push(node);
      cur = node.predecessor_session_id;
    }
    return out;
  };

  const leaves = (session_id: string): SessionNode[] =>
    descendants(session_id).filter(
      (d) => (childrenOf.get(d.session_id) ?? []).length === 0,
    );

  return {
    node: (session_id: string): SessionNode | undefined =>
      byId.get(session_id),
    size: (): number => byId.size,
    directChildren,
    descendants,
    ancestors,
    leaves,
  };
};

// ────────────────────────────────────────────────────────────────
// Descendant discovery — the reactivation-prompt primitive
// ────────────────────────────────────────────────────────────────

/** Result of `discoverDescendants` — everything the engine needs to
 *  decide whether, and how, to prompt a returning user. */
export interface DescendantDiscovery {
  /** The session whose descendants were discovered — the one the user
   *  is reactivating. */
  readonly session_id: string;
  /** True when at least one session forked off `session_id`. The
   *  engine prompts the user only when this is true; otherwise it
   *  opens a plain continuation with no reconciliation. */
  readonly has_descendants: boolean;
  /** Direct children, sorted — the branch heads. `direct_children.length`
   *  is the count of conversations that forked directly off this
   *  session. */
  readonly direct_children: SessionNode[];
  /** Descendant leaves, sorted — the pick-up-from-here candidates the
   *  prompt offers (the tip of each branch, not its mid-points). */
  readonly leaves: SessionNode[];
  /** The most recent descendant leaf by `created_at` (ties broken by
   *  lowest `session_id`). The "auto-link to latest leaf" default
   *  (spec open question #15) reads this. Absent when there are no
   *  descendant leaves — including the pathological case of a
   *  descendant set that is wholly inside a predecessor cycle (every
   *  node has a child, so none is a leaf). */
  readonly latest_leaf?: SessionNode;
}

/** Discover the descendant tree of a reactivated session. The headline
 *  P5 primitive: when the user returns to a session, the engine calls
 *  this to learn whether the topic continued elsewhere and to gather
 *  the pick-up candidates for the reconciliation prompt (spec lines
 *  525-530).
 *
 *  Discovery keys off the predecessor edge, not index membership: the
 *  reactivated `session_id` need not itself be an indexed node. An
 *  archived session outside the loaded set still surfaces its in-set
 *  descendants — that *is* the spec scenario (the user reactivates an
 *  old, archived session; what forked off it is what is recent and
 *  loaded). A `session_id` that nothing in the index names as a
 *  predecessor yields an empty discovery (`has_descendants: false`),
 *  whether or not it is itself an indexed node.
 *
 *  Pure — never throws. The substrate stops at surfacing the
 *  candidates; whether the engine prompts or auto-links to
 *  `latest_leaf` is Engine policy + UX (spec open question #15). */
export const discoverDescendants = (
  index: SessionReverseIndex,
  session_id: string,
): DescendantDiscovery => {
  const direct_children = index.directChildren(session_id);
  const leaves = index.leaves(session_id);

  // The most-recent leaf by `created_at`. The `session_id` tie-break is
  // purely a stable-result rule — it keeps the choice deterministic
  // when two leaves share a timestamp; it is not a semantic ranking of
  // the leaves. The spec leaves the auto-link mechanism open (open
  // question #15), so determinism is the only constraint that binds.
  let latest_leaf: SessionNode | undefined;
  for (const leaf of leaves) {
    if (
      latest_leaf === undefined
      || leaf.created_at > latest_leaf.created_at
      || (leaf.created_at === latest_leaf.created_at
        && leaf.session_id < latest_leaf.session_id)
    ) {
      latest_leaf = leaf;
    }
  }

  // `has_descendants` keys off direct children: a session has
  // descendants iff it has at least one direct child. Reported even
  // when `leaves` is empty (a wholly-cyclic descendant set) so the
  // engine can fall back honestly rather than read "no descendants".
  const base = {
    session_id,
    has_descendants: direct_children.length > 0,
    direct_children,
    leaves,
  };
  // Build conditionally so `latest_leaf` stays `readonly` and is simply
  // absent — not `undefined` — when there is no leaf.
  return latest_leaf !== undefined ? { ...base, latest_leaf } : base;
};
