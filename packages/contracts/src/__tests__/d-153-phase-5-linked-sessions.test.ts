/** D-153 P5 — Linked sessions + reverse index.
 *
 *  Pins the pure contracts from packages/contracts/src/linked-sessions.ts:
 *  session-layer narrowing, session-node shape validation, graph validation,
 *  reverse-index traversal, and descendant discovery.
 *
 *  Spec: D-153 lines 507-533. */

import { describe, expect, it } from 'vitest';

import {
  SESSION_LAYERS,
  SESSION_LINK_ISSUE_CODES,
  buildSessionReverseIndex,
  discoverDescendants,
  isLinkedSession,
  isSessionLayer,
  isSessionLinkIssueCode,
  isSessionNode,
  validateSessionLinks,
  type SessionLayer,
  type SessionLinkIssueCode,
  type SessionNode,
} from '@recued/contracts';

const EXPECTED_SESSION_LAYERS: readonly SessionLayer[] = [
  'channel',
  'cognition',
] as const;

const EXPECTED_SESSION_LINK_ISSUE_CODES: readonly SessionLinkIssueCode[] = [
  'duplicate_session_id',
  'predecessor_self_reference',
  'predecessor_layer_mismatch',
  'predecessor_cycle',
] as const;

const makeNode = (
  overrides: Partial<SessionNode> = {},
): SessionNode => ({
  session_id: 'session-1',
  layer: 'channel',
  created_at: 1_000,
  ...overrides,
});

const withoutField = (
  node: SessionNode,
  field: keyof SessionNode,
): Record<string, unknown> => {
  const copy = { ...node } as Record<string, unknown>;
  delete copy[field];
  return copy;
};

const issueCodesFor = (
  nodes: ReadonlyArray<SessionNode>,
): SessionLinkIssueCode[] =>
  validateSessionLinks(nodes).map((issue) => issue.code);

const idsOf = (entries: readonly { session_id: string }[]): string[] =>
  entries.map((entry) => entry.session_id);

const makeTreeNodes = (): SessionNode[] => [
  makeNode({
    session_id: 'root',
    predecessor_session_id: 'archived-root',
    created_at: 100,
  }),
  makeNode({
    session_id: 'child-b',
    predecessor_session_id: 'root',
    created_at: 300,
  }),
  makeNode({
    session_id: 'child-a',
    predecessor_session_id: 'root',
    created_at: 300,
  }),
  makeNode({
    session_id: 'grandchild-early',
    predecessor_session_id: 'child-b',
    created_at: 200,
  }),
  makeNode({
    session_id: 'grandchild-late',
    predecessor_session_id: 'child-a',
    created_at: 500,
  }),
  makeNode({
    session_id: 'great-grandchild',
    predecessor_session_id: 'grandchild-late',
    created_at: 700,
  }),
];

describe('D-153 P5 — SESSION_LAYERS / isSessionLayer', () => {
  it('SESSION_LAYERS is the exact two-layer closed list', () => {
    // This would fail if correlation_id was incorrectly made linkable.
    expect(SESSION_LAYERS).toEqual(EXPECTED_SESSION_LAYERS);
  });

  it('isSessionLayer accepts every closed-list value', () => {
    // This would fail if the predicate drifted from the exported constant.
    for (const layer of SESSION_LAYERS) {
      expect(isSessionLayer(layer)).toBe(true);
    }
  });

  it('isSessionLayer rejects non-member strings and non-strings', () => {
    // This would fail if arbitrary strings or JSON values were accepted as layers.
    for (const value of ['correlation', 'unknown', '', 42, null, undefined, {}, []]) {
      expect(isSessionLayer(value)).toBe(false);
    }
  });
});

describe('D-153 P5 — isSessionNode', () => {
  it('accepts fresh nodes with absent or undefined predecessor_session_id', () => {
    const node = makeNode();

    // This would fail if absent predecessors were treated as malformed linked sessions.
    expect(isSessionNode(withoutField(node, 'predecessor_session_id'))).toBe(true);
    // This would fail if an explicit undefined predecessor was rejected.
    expect(isSessionNode({ ...node, predecessor_session_id: undefined })).toBe(true);
  });

  it('accepts nodes with a valid predecessor_session_id string', () => {
    // This would fail if linked sessions were narrowed as fresh-only nodes.
    expect(isSessionNode(makeNode({
      predecessor_session_id: 'prior-session',
    }))).toBe(true);
  });

  it('rejects missing or empty session_id values', () => {
    const node = makeNode();

    // This would fail if identity-less rows could enter the graph.
    expect(isSessionNode(withoutField(node, 'session_id'))).toBe(false);
    // This would fail if empty-string session ids were accepted as real nodes.
    expect(isSessionNode({ ...node, session_id: '' })).toBe(false);
  });

  it('rejects bad layer values', () => {
    // This would fail if channel and cognition trees could cross via arbitrary layers.
    expect(isSessionNode({
      ...makeNode(),
      layer: 'correlation',
    })).toBe(false);
  });

  it('rejects empty-string or null predecessor_session_id values', () => {
    // This would fail if empty-string predecessor was accepted as valid.
    expect(isSessionNode(makeNode({
      predecessor_session_id: '',
    }))).toBe(false);
    // `null` is not a `string | undefined` — narrowing a null-bearing
    // object to SessionNode would be unsound (the contract field is an
    // optional string, never null).
    expect(isSessionNode({
      ...makeNode(),
      predecessor_session_id: null,
    })).toBe(false);
  });

  it('rejects non-finite created_at values', () => {
    for (const created_at of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      // This would fail if ordering used timestamps that cannot be sorted safely.
      expect(isSessionNode({ ...makeNode(), created_at })).toBe(false);
    }
  });

  it('rejects array and null inputs', () => {
    // This would fail if array-like JSON accidentally passed object narrowing.
    expect(isSessionNode([])).toBe(false);
    // This would fail if null passed the object guard.
    expect(isSessionNode(null)).toBe(false);
  });
});

describe('D-153 P5 — isLinkedSession', () => {
  it('returns true when predecessor_session_id is a non-empty string', () => {
    // This would fail if linked sessions ignored the predecessor edge.
    expect(isLinkedSession({ predecessor_session_id: 'prior-session' })).toBe(true);
  });

  it('returns false when predecessor_session_id is absent', () => {
    // This would fail if fresh sessions were treated as linked by default.
    expect(isLinkedSession({})).toBe(false);
  });

  it('returns false when predecessor_session_id is an empty string', () => {
    // This would fail if empty-string predecessor was accepted as linked.
    expect(isLinkedSession({ predecessor_session_id: '' })).toBe(false);
  });
});

describe('D-153 P5 — SESSION_LINK_ISSUE_CODES / isSessionLinkIssueCode', () => {
  it('SESSION_LINK_ISSUE_CODES is the exact four-code closed list', () => {
    // This would fail if graph validators introduced unreviewed issue modes.
    expect(SESSION_LINK_ISSUE_CODES).toEqual(EXPECTED_SESSION_LINK_ISSUE_CODES);
  });

  it('isSessionLinkIssueCode accepts every closed-list value', () => {
    // This would fail if the issue-code predicate drifted from the exported constant.
    for (const code of SESSION_LINK_ISSUE_CODES) {
      expect(isSessionLinkIssueCode(code)).toBe(true);
    }
  });

  it('isSessionLinkIssueCode rejects unknown strings and non-strings', () => {
    // This would fail if arbitrary validator strings were accepted as known issues.
    for (const value of ['unknown', '', 42, null, undefined, {}, []]) {
      expect(isSessionLinkIssueCode(value)).toBe(false);
    }
  });
});

describe('D-153 P5 — validateSessionLinks', () => {
  it('emits duplicate_session_id once per repeated id', () => {
    const issues = validateSessionLinks([
      makeNode({ session_id: 'dupe', created_at: 100 }),
      makeNode({ session_id: 'dupe', created_at: 200 }),
    ]);

    // This would fail if duplicates were missed or reported more than once per id.
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'duplicate_session_id',
      session_id: 'dupe',
    });
  });

  it('emits predecessor_self_reference without also emitting predecessor_cycle', () => {
    const issues = validateSessionLinks([
      makeNode({
        session_id: 'self',
        predecessor_session_id: 'self',
      }),
    ]);

    // This would fail if self-reference was double-reported as a cycle.
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'predecessor_self_reference',
      session_id: 'self',
    });
  });

  it('emits predecessor_layer_mismatch when the predecessor is in-set with another layer', () => {
    const issues = validateSessionLinks([
      makeNode({ session_id: 'channel-root', layer: 'channel' }),
      makeNode({
        session_id: 'cognition-child',
        layer: 'cognition',
        predecessor_session_id: 'channel-root',
      }),
    ]);

    // This would fail if channel and cognition predecessor trees could cross-link.
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'predecessor_layer_mismatch',
      session_id: 'cognition-child',
      related_session_id: 'channel-root',
    });
  });

  it('emits predecessor_cycle for every node on a three-node cycle', () => {
    const issues = validateSessionLinks([
      makeNode({ session_id: 'A', predecessor_session_id: 'C' }),
      makeNode({ session_id: 'B', predecessor_session_id: 'A' }),
      makeNode({ session_id: 'C', predecessor_session_id: 'B' }),
    ]);

    // This would fail if a 3-node cycle escaped detection or only reported the walk start.
    expect(issueCodesFor([
      makeNode({ session_id: 'A', predecessor_session_id: 'C' }),
      makeNode({ session_id: 'B', predecessor_session_id: 'A' }),
      makeNode({ session_id: 'C', predecessor_session_id: 'B' }),
    ])).toEqual([
      'predecessor_cycle',
      'predecessor_cycle',
      'predecessor_cycle',
    ]);
    expect(idsOf(issues)).toEqual(['A', 'B', 'C']);
  });

  it('allows predecessor_session_id values outside the node set', () => {
    // This would fail if archived predecessors were incorrectly treated as broken links.
    expect(validateSessionLinks([
      makeNode({
        session_id: 'continued',
        predecessor_session_id: 'archived-session',
      }),
    ])).toEqual([]);
  });

  it('allows a valid forking tree with multiple children sharing one predecessor', () => {
    // This would fail if valid forks were rejected as merges or DAG violations.
    expect(validateSessionLinks([
      makeNode({ session_id: 'root' }),
      makeNode({
        session_id: 'slack-branch',
        predecessor_session_id: 'root',
      }),
      makeNode({
        session_id: 'webclient-branch',
        predecessor_session_id: 'root',
      }),
      makeNode({
        session_id: 'webclient-leaf',
        predecessor_session_id: 'webclient-branch',
      }),
    ])).toEqual([]);
  });
});

describe('D-153 P5 — buildSessionReverseIndex', () => {
  it('returns the indexed node map and deduped size', () => {
    const nodes = makeTreeNodes();
    const index = buildSessionReverseIndex(nodes);

    // This would fail if the reverse index lost nodes while building adjacency.
    expect(index.size()).toBe(nodes.length);
    expect(index.node('root')).toEqual(nodes[0]);
    expect(index.node('missing')).toBeUndefined();
  });

  it('directChildren returns immediate children only', () => {
    const index = buildSessionReverseIndex(makeTreeNodes());

    // This would fail if grandchildren were mixed into the direct-child lookup.
    expect(idsOf(index.directChildren('root'))).toEqual(['child-a', 'child-b']);
  });

  it('descendants returns all generations, excludes the root, and sorts by created_at then session_id', () => {
    const index = buildSessionReverseIndex(makeTreeNodes());

    // This would fail if descendants() included the root or preserved traversal order.
    expect(idsOf(index.descendants('root'))).toEqual([
      'grandchild-early',
      'child-a',
      'child-b',
      'grandchild-late',
      'great-grandchild',
    ]);
  });

  it('ancestors returns the nearest-first chain and stops at the edge of the set', () => {
    const index = buildSessionReverseIndex(makeTreeNodes());

    // This would fail if archived predecessors outside the set were included.
    expect(idsOf(index.ancestors('great-grandchild'))).toEqual([
      'grandchild-late',
      'child-a',
      'root',
    ]);
  });

  it('leaves returns descendant leaves only', () => {
    const index = buildSessionReverseIndex(makeTreeNodes());

    // This would fail if internal descendants or the queried root were returned as leaves.
    expect(idsOf(index.leaves('root'))).toEqual([
      'grandchild-early',
      'great-grandchild',
    ]);
  });

  it('descendants and ancestors terminate on cyclic input without including the queried root', () => {
    const index = buildSessionReverseIndex([
      makeNode({ session_id: 'cycle-a', predecessor_session_id: 'cycle-b' }),
      makeNode({ session_id: 'cycle-b', predecessor_session_id: 'cycle-a' }),
    ]);

    // This would fail by timeout if descendants() did not guard cycles.
    expect(idsOf(index.descendants('cycle-a'))).toEqual(['cycle-b']);
    // This would fail by timeout if ancestors() did not guard cycles.
    expect(idsOf(index.ancestors('cycle-a'))).toEqual(['cycle-b']);
    // This would fail if descendants() included the root when a cycle made it reachable.
    expect(idsOf(index.descendants('cycle-a'))).not.toContain('cycle-a');
  });

  it('uses last-wins semantics for duplicate session_id values', () => {
    const root = makeNode({ session_id: 'root' });
    const first = makeNode({
      session_id: 'dupe',
      predecessor_session_id: 'old-parent',
      created_at: 100,
    });
    const last = makeNode({
      session_id: 'dupe',
      predecessor_session_id: 'root',
      created_at: 200,
    });
    const index = buildSessionReverseIndex([root, first, last]);

    // This would fail if duplicate ids were first-wins or adjacency was built before deduping.
    expect(index.size()).toBe(2);
    expect(index.node('dupe')).toEqual(last);
    expect(idsOf(index.directChildren('root'))).toEqual(['dupe']);
    expect(index.directChildren('old-parent')).toEqual([]);
  });
});

describe('D-153 P5 — discoverDescendants', () => {
  it('reports descendants, direct children, leaves, and deterministic latest_leaf', () => {
    const leafOld = makeNode({
      session_id: 'leaf-old',
      predecessor_session_id: 'root',
      created_at: 400,
    });
    const leafZ = makeNode({
      session_id: 'leaf-z',
      predecessor_session_id: 'root',
      created_at: 900,
    });
    const leafA = makeNode({
      session_id: 'leaf-a',
      predecessor_session_id: 'root',
      created_at: 900,
    });
    const index = buildSessionReverseIndex([
      makeNode({ session_id: 'root' }),
      leafOld,
      leafZ,
      leafA,
    ]);

    const discovery = discoverDescendants(index, 'root');

    // This would fail if descendant discovery keyed off all nodes instead of real children.
    expect(discovery.has_descendants).toBe(true);
    expect(idsOf(discovery.direct_children)).toEqual(['leaf-old', 'leaf-a', 'leaf-z']);
    expect(idsOf(discovery.leaves)).toEqual(['leaf-old', 'leaf-a', 'leaf-z']);
    // This would fail if latest_leaf ignored created_at or broke ties by highest id.
    expect(discovery.latest_leaf).toEqual(leafA);
  });

  it('omits latest_leaf when there are no descendant leaves', () => {
    const index = buildSessionReverseIndex([
      makeNode({ session_id: 'lonely-root' }),
    ]);

    const discovery = discoverDescendants(index, 'lonely-root');

    // This would fail if empty discoveries exposed latest_leaf: undefined.
    expect(discovery).toEqual({
      session_id: 'lonely-root',
      has_descendants: false,
      direct_children: [],
      leaves: [],
    });
    expect(discovery).not.toHaveProperty('latest_leaf');
  });

  it('discovers in-set descendants of an archived predecessor outside the node set', () => {
    // The headline spec scenario (lines 525-528): the reactivated session
    // is archived — not in the recently-loaded set — but its descendants
    // are. Discovery keys off the predecessor edge, so it still surfaces
    // them. `makeTreeNodes()`'s `root` declares `archived-root` (not a
    // node) as its predecessor.
    const index = buildSessionReverseIndex(makeTreeNodes());

    const discovery = discoverDescendants(index, 'archived-root');

    // This would fail if discovery required the queried session to be indexed.
    expect(discovery.session_id).toBe('archived-root');
    expect(discovery.has_descendants).toBe(true);
    expect(idsOf(discovery.direct_children)).toEqual(['root']);
    expect(idsOf(discovery.leaves)).toEqual([
      'grandchild-early',
      'great-grandchild',
    ]);
    expect(discovery.latest_leaf?.session_id).toBe('great-grandchild');
  });

  it('returns an empty discovery for a session_id nothing links to', () => {
    const index = buildSessionReverseIndex(makeTreeNodes());

    // `never-existed` is neither an indexed node nor any node's
    // predecessor — the genuine "no descendants" case.
    const discovery = discoverDescendants(index, 'never-existed');

    // This would fail if discovery confused "is a node" with "has descendants".
    expect(discovery).toEqual({
      session_id: 'never-existed',
      has_descendants: false,
      direct_children: [],
      leaves: [],
    });
    expect(discovery).not.toHaveProperty('latest_leaf');
  });
});
