/** D-137 W2.3 § A.1.1 + § A.10 — Tier 3 (connection.mcp.*) catalog
 *  substrate. Contracts-layer ratchets:
 *
 *    - Closed-list `TIER3_TOOL_CLASSIFICATIONS` (3 entries; read /
 *      write / unknown) + `isTier3ToolClassification` membership.
 *    - `formatTier3ToolName` formatting + `<connection>.<tool>` shape.
 *    - `buildTier3ToolEntry` projection — surfaces iff enabled &&
 *      classified; passes through `destructive_hint` from descriptor;
 *      per-tool `custom_topic_tags` overrides connection-level
 *      `topic_tags`; classification surfaces verbatim.
 *    - `buildTier3Catalog` — flat-map across annotations + descriptors;
 *      sorted by name asc; empty when no annotations.
 *    - `computeConnectionMcpDisabledTier3Names` — every cached
 *      descriptor that does NOT pass the gates surfaces as a member of
 *      the disabled set; tools that survive the gates are absent.
 *    - `buildDefaultConnectionMcpAnnotation` empty shape.
 *    - `validateConnectionMcpAnnotationInput` exhaustive shape rejection
 *      + canonicalization. */

import { describe, it, expect } from 'vitest';
import {
  TIER3_TOOL_CLASSIFICATIONS,
  TIER3_TOOL_CLASSIFICATION_SET,
  isTier3ToolClassification,
  buildDefaultConnectionMcpAnnotation,
  formatTier3ToolName,
  buildTier3ToolEntry,
  buildTier3Catalog,
  computeConnectionMcpDisabledTier3Names,
  CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES,
  validateConnectionMcpAnnotationInput,
  type ConnectionMcpAnnotationState,
  type McpToolDescriptor,
} from '../chat.js';

const baseAnnotation = (
  connection_name: string,
  overrides: Partial<ConnectionMcpAnnotationState> = {},
): ConnectionMcpAnnotationState => ({
  connection_name,
  topic_tags: [],
  tool_overrides: {},
  tools_list_cache: { tools: [], cached_at: 0 },
  updated_at: 0,
  ...overrides,
});

describe('D-137 W2.3 — TIER3_TOOL_CLASSIFICATIONS closed list', () => {
  it('lists exactly read / write / unknown in canonical order', () => {
    expect([...TIER3_TOOL_CLASSIFICATIONS]).toEqual([
      'read',
      'write',
      'unknown',
    ]);
    expect(TIER3_TOOL_CLASSIFICATION_SET.size).toBe(3);
  });

  it('isTier3ToolClassification accepts every member + rejects off-list', () => {
    for (const c of TIER3_TOOL_CLASSIFICATIONS) {
      expect(isTier3ToolClassification(c)).toBe(true);
    }
    expect(isTier3ToolClassification('execute')).toBe(false);
    expect(isTier3ToolClassification(null)).toBe(false);
    expect(isTier3ToolClassification(0)).toBe(false);
    expect(isTier3ToolClassification(undefined)).toBe(false);
  });
});

describe('D-137 W2.3 — formatTier3ToolName', () => {
  it('joins connection + tool with a dot', () => {
    expect(formatTier3ToolName('exa', 'search')).toBe('exa.search');
    expect(formatTier3ToolName('github', 'list_issues')).toBe('github.list_issues');
  });
});

describe('D-137 W2.3 — buildDefaultConnectionMcpAnnotation', () => {
  it('returns an empty annotation shape for a fresh connection', () => {
    const def = buildDefaultConnectionMcpAnnotation('exa');
    expect(def.connection_name).toBe('exa');
    expect([...def.topic_tags]).toEqual([]);
    expect(Object.keys(def.tool_overrides)).toEqual([]);
    expect(def.tools_list_cache.tools.length).toBe(0);
    expect(def.tools_list_cache.cached_at).toBe(0);
    expect(def.updated_at).toBe(0);
  });
});

describe('D-137 W2.3 — buildTier3ToolEntry projection (both gates)', () => {
  const descriptor: McpToolDescriptor = {
    name: 'search',
    description: 'Search the exa index for relevant web pages',
    destructive_hint: false,
  };
  const annotation = baseAnnotation('exa', {
    topic_tags: ['web', 'research'],
    tool_overrides: {
      search: { enabled: true, classification: 'read' },
    },
    tools_list_cache: { tools: [descriptor], cached_at: 100 },
  });

  it('surfaces when enabled + classified (read / write)', () => {
    const entry = buildTier3ToolEntry(annotation, descriptor);
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe('exa.search');
    expect(entry!.tier).toBe(3);
    expect(entry!.classification).toBe('read');
    expect(entry!.description).toBe(
      'Search the exa index for relevant web pages',
    );
    expect([...entry!.topic_tags]).toEqual(['web', 'research']);
    expect(entry!.destructive_hint).toBe(false);
  });

  // D-164 § 6 — Tier 3 vendor APIs are sealed sequential. External
  // services carry their own rate-limit budgets; concurrent dispatch
  // corrupts the budget without per-vendor knowledge. A future
  // override hook on `ConnectionMcpToolOverride` (or upstream
  // `tools/list` metadata) flips known-safe entries.
  it('emits concurrency_safe: false on every projected Tier 3 entry (sealed sequential)', () => {
    const entry = buildTier3ToolEntry(annotation, descriptor);
    expect(entry?.concurrency_safe).toBe(false);
  });

  it('emits concurrency_safe: false even for read-classified Tier 3 entries', () => {
    // Defensive — a read-classification Tier 3 entry could be mistaken
    // for "safe to batch" by symmetry with Tier 1 reads. The sealed-
    // false rule applies to ALL Tier 3 projections regardless of
    // classification.
    const readDescriptor: McpToolDescriptor = {
      name: 'fetch',
      destructive_hint: false,
    };
    const ann = baseAnnotation('exa', {
      tool_overrides: {
        fetch: { enabled: true, classification: 'read' },
      },
      tools_list_cache: { tools: [readDescriptor], cached_at: 100 },
    });
    const entry = buildTier3ToolEntry(ann, readDescriptor);
    expect(entry?.concurrency_safe).toBe(false);
  });

  it('returns null when the override is missing entirely', () => {
    const ann = baseAnnotation('exa', {
      tools_list_cache: { tools: [descriptor], cached_at: 100 },
    });
    expect(buildTier3ToolEntry(ann, descriptor)).toBeNull();
  });

  it('returns null when override is disabled', () => {
    const ann = baseAnnotation('exa', {
      tool_overrides: {
        search: { enabled: false, classification: 'read' },
      },
      tools_list_cache: { tools: [descriptor], cached_at: 100 },
    });
    expect(buildTier3ToolEntry(ann, descriptor)).toBeNull();
  });

  it('returns null when classification is unknown', () => {
    const ann = baseAnnotation('exa', {
      tool_overrides: {
        search: { enabled: true, classification: 'unknown' },
      },
      tools_list_cache: { tools: [descriptor], cached_at: 100 },
    });
    expect(buildTier3ToolEntry(ann, descriptor)).toBeNull();
  });

  it('per-tool custom_topic_tags override connection-level topic_tags', () => {
    const ann = baseAnnotation('exa', {
      topic_tags: ['web', 'research'],
      tool_overrides: {
        search: {
          enabled: true,
          classification: 'read',
          custom_topic_tags: ['search', 'lookup'],
        },
      },
      tools_list_cache: { tools: [descriptor], cached_at: 100 },
    });
    const entry = buildTier3ToolEntry(ann, descriptor);
    expect([...entry!.topic_tags]).toEqual(['search', 'lookup']);
  });

  it('falls back to connection-level topic_tags when no per-tool override', () => {
    const entry = buildTier3ToolEntry(annotation, descriptor);
    expect([...entry!.topic_tags]).toEqual(['web', 'research']);
  });

  it('surfaces destructive_hint from upstream descriptor', () => {
    const writeDescriptor: McpToolDescriptor = {
      name: 'delete_index',
      destructive_hint: true,
    };
    const ann = baseAnnotation('exa', {
      tool_overrides: {
        delete_index: { enabled: true, classification: 'write' },
      },
      tools_list_cache: { tools: [writeDescriptor], cached_at: 100 },
    });
    const entry = buildTier3ToolEntry(ann, writeDescriptor);
    expect(entry!.destructive_hint).toBe(true);
    expect(entry!.classification).toBe('write');
  });

  it('synthesizes a fallback description when upstream omits one', () => {
    const sparse: McpToolDescriptor = { name: 'search' };
    const ann = baseAnnotation('exa', {
      tool_overrides: {
        search: { enabled: true, classification: 'read' },
      },
      tools_list_cache: { tools: [sparse], cached_at: 100 },
    });
    const entry = buildTier3ToolEntry(ann, sparse);
    expect(entry!.description).toMatch(/^exa MCP tool/);
  });

  it('rejects descriptors with empty / non-string names', () => {
    const bad = { name: '' } as McpToolDescriptor;
    expect(buildTier3ToolEntry(annotation, bad)).toBeNull();
  });

  it('Codex W2.3 review P2 fold — refuses names that collide with Tier 1 primitives', () => {
    // Connection literally named `contact` advertising a tool named
    // `search` would produce `contact.search`, colliding with the
    // Tier 1 `contact.search` primitive. The registry's dispatch
    // routes Tier 1 first, so Stage 2 would see the Tier 3 schema
    // while the call routes to the built-in. Substrate refusal at
    // projection time is the load-bearing fix.
    const collidingAnn = baseAnnotation('contact', {
      tool_overrides: {
        search: { enabled: true, classification: 'read' },
      },
      tools_list_cache: {
        tools: [{ name: 'search' }],
        cached_at: 100,
      },
    });
    expect(
      buildTier3ToolEntry(collidingAnn, { name: 'search' }),
    ).toBeNull();
  });

  it('Codex W2.3 review P2 fold — preserves explicit empty custom_topic_tags verbatim', () => {
    // Mary cleared per-tool tags to suppress connection-level topic
    // matching. The projection MUST honor the empty array; falling
    // back to the connection-level tags silently re-enables what she
    // turned off.
    const ann = baseAnnotation('exa', {
      topic_tags: ['web', 'research'],
      tool_overrides: {
        search: {
          enabled: true,
          classification: 'read',
          custom_topic_tags: [],
        },
      },
      tools_list_cache: { tools: [descriptor], cached_at: 100 },
    });
    const entry = buildTier3ToolEntry(ann, descriptor);
    expect(entry).not.toBeNull();
    expect([...entry!.topic_tags]).toEqual([]);
  });
});

describe('D-137 W2.3 — buildTier3Catalog flat-map projection', () => {
  it('returns the empty array when annotations is empty', () => {
    expect(buildTier3Catalog([])).toEqual([]);
  });

  it('flat-maps across connections and sorts by formatted name asc', () => {
    const exaAnn = baseAnnotation('exa', {
      tool_overrides: {
        search: { enabled: true, classification: 'read' },
        contents: { enabled: true, classification: 'read' },
        delete_index: { enabled: true, classification: 'write' },
      },
      tools_list_cache: {
        tools: [
          { name: 'search' },
          { name: 'contents' },
          { name: 'delete_index', destructive_hint: true },
        ],
        cached_at: 100,
      },
    });
    const githubAnn = baseAnnotation('github', {
      tool_overrides: {
        list_issues: { enabled: true, classification: 'read' },
      },
      tools_list_cache: {
        tools: [{ name: 'list_issues' }],
        cached_at: 100,
      },
    });
    const catalog = buildTier3Catalog([exaAnn, githubAnn]);
    expect(catalog.map((e) => e.name)).toEqual([
      'exa.contents',
      'exa.delete_index',
      'exa.search',
      'github.list_issues',
    ]);
  });

  it('Codex W2.3 review P2 fold — Tier 1 colliding names are dropped from buildTier3Catalog', () => {
    const ann = baseAnnotation('contact', {
      tool_overrides: {
        search: { enabled: true, classification: 'read' },
        scoped_lookup: { enabled: true, classification: 'read' },
      },
      tools_list_cache: {
        tools: [{ name: 'search' }, { name: 'scoped_lookup' }],
        cached_at: 100,
      },
    });
    const catalog = buildTier3Catalog([ann]);
    // `contact.search` colliding with Tier 1 — dropped.
    // `contact.scoped_lookup` non-colliding — surfaces.
    expect(catalog.map((e) => e.name)).toEqual(['contact.scoped_lookup']);
  });

  it('drops disabled + unclassified tools from the catalog projection', () => {
    const ann = baseAnnotation('exa', {
      tool_overrides: {
        search: { enabled: true, classification: 'read' },
        contents: { enabled: false, classification: 'read' }, // disabled
        delete_index: { enabled: true, classification: 'unknown' }, // unclassified
        // similar: missing override entirely → invisible
      },
      tools_list_cache: {
        tools: [
          { name: 'search' },
          { name: 'contents' },
          { name: 'delete_index' },
          { name: 'similar' },
        ],
        cached_at: 100,
      },
    });
    const catalog = buildTier3Catalog([ann]);
    expect(catalog.map((e) => e.name)).toEqual(['exa.search']);
  });
});

describe('D-137 W2.3 — computeConnectionMcpDisabledTier3Names', () => {
  it('returns an empty set when no annotations exist', () => {
    expect(computeConnectionMcpDisabledTier3Names([]).size).toBe(0);
  });

  it('flags every cached descriptor that does NOT pass both gates', () => {
    const ann = baseAnnotation('exa', {
      tool_overrides: {
        search: { enabled: true, classification: 'read' },
        contents: { enabled: false, classification: 'read' },
        delete_index: { enabled: true, classification: 'unknown' },
      },
      tools_list_cache: {
        tools: [
          { name: 'search' },
          { name: 'contents' },
          { name: 'delete_index' },
          { name: 'similar' }, // no override at all
        ],
        cached_at: 100,
      },
    });
    const disabled = computeConnectionMcpDisabledTier3Names([ann]);
    expect([...disabled].sort()).toEqual([
      'exa.contents',
      'exa.delete_index',
      'exa.similar',
    ]);
    expect(disabled.has('exa.search')).toBe(false);
  });

  it('handles empty-name descriptors defensively', () => {
    const ann = baseAnnotation('exa', {
      tools_list_cache: {
        tools: [
          { name: '' } as McpToolDescriptor,
          { name: 'search' },
        ],
        cached_at: 100,
      },
    });
    const disabled = computeConnectionMcpDisabledTier3Names([ann]);
    // Only `search` surfaces (empty-name descriptor is silently dropped).
    expect(disabled.has('exa.search')).toBe(true);
    expect(disabled.size).toBe(1);
  });

  it('Codex W2.3 review P2 fold — Tier 1 colliding names are excluded from the disabled set', () => {
    // `contact.search` colliding with Tier 1 must not surface as
    // "disabled" either — the substrate refused it entirely; from
    // the user's perspective the tool acts as if it was never
    // advertised (preserves the Tier 1 primitive's identity).
    const ann = baseAnnotation('contact', {
      tool_overrides: {
        search: { enabled: true, classification: 'read' },
        scoped_lookup: { enabled: false, classification: 'read' },
      },
      tools_list_cache: {
        tools: [{ name: 'search' }, { name: 'scoped_lookup' }],
        cached_at: 100,
      },
    });
    const disabled = computeConnectionMcpDisabledTier3Names([ann]);
    expect(disabled.has('contact.search')).toBe(false);
    expect(disabled.has('contact.scoped_lookup')).toBe(true);
  });

  it('aggregates across multiple connections', () => {
    const exa = baseAnnotation('exa', {
      tools_list_cache: {
        tools: [{ name: 'search' }, { name: 'delete_index' }],
        cached_at: 100,
      },
      tool_overrides: {
        search: { enabled: true, classification: 'read' },
      },
    });
    const github = baseAnnotation('github', {
      tools_list_cache: {
        tools: [{ name: 'list_issues' }],
        cached_at: 100,
      },
      // no overrides at all → list_issues is disabled
    });
    const disabled = computeConnectionMcpDisabledTier3Names([exa, github]);
    expect([...disabled].sort()).toEqual([
      'exa.delete_index',
      'github.list_issues',
    ]);
  });
});

describe('D-137 W2.3 — CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES closed list', () => {
  it('exports every issue code (15 base + 4 P4 recued_signature codes + 5 P5 chat_mode codes)', () => {
    expect(CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES.length).toBe(24);
    expect([...CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES]).toContain(
      'connection_name_invalid',
    );
    expect([...CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES]).toContain(
      'tool_overrides_not_object',
    );
    // D-137 P4 § A.3 — recued_signature payload validation codes.
    expect([...CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES]).toContain(
      'recued_signature_shape_invalid',
    );
    expect([...CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES]).toContain(
      'recued_signature_server_kind_invalid',
    );
    expect([...CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES]).toContain(
      'recued_signature_version_invalid',
    );
    expect([...CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES]).toContain(
      'recued_signature_instance_id_invalid',
    );
    // D-137 P5 § A.7.1 + § A.10 — chat_mode payload validation codes.
    expect([...CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES]).toContain(
      'chat_mode_shape_invalid',
    );
    expect([...CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES]).toContain(
      'chat_mode_offered_invalid',
    );
    expect([...CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES]).toContain(
      'chat_mode_session_cap_shape_invalid',
    );
    expect([...CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES]).toContain(
      'chat_mode_session_cap_per_day_invalid',
    );
    expect([...CONNECTION_MCP_ANNOTATION_VALIDATION_ISSUE_CODES]).toContain(
      'chat_mode_session_cap_concurrent_invalid',
    );
  });
});

describe('D-137 W2.3 — validateConnectionMcpAnnotationInput', () => {
  it('rejects non-object input with input_not_object', () => {
    const r = validateConnectionMcpAnnotationInput(null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0]!.code).toBe('input_not_object');
    }
  });

  it('rejects payloads missing connection_name', () => {
    const r = validateConnectionMcpAnnotationInput({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.some((i) => i.code === 'connection_name_invalid')).toBe(true);
    }
  });

  it('accepts a minimal connection_name-only payload', () => {
    const r = validateConnectionMcpAnnotationInput({ connection_name: 'exa' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.connection_name).toBe('exa');
      expect([...r.value.topic_tags]).toEqual([]);
      expect(Object.keys(r.value.tool_overrides)).toEqual([]);
      expect(r.value.tools_list_cache.tools).toEqual([]);
      expect(r.value.tools_list_cache.cached_at).toBe(0);
    }
  });

  it('rejects topic_tags shape errors', () => {
    const r1 = validateConnectionMcpAnnotationInput({
      connection_name: 'exa',
      topic_tags: 'web',
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.issues.some((i) => i.code === 'topic_tags_not_array')).toBe(true);
    }
    const r2 = validateConnectionMcpAnnotationInput({
      connection_name: 'exa',
      topic_tags: ['web', 42, ''],
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.issues.some((i) => i.code === 'topic_tag_member_invalid')).toBe(true);
    }
    const r3 = validateConnectionMcpAnnotationInput({
      connection_name: 'exa',
      topic_tags: ['web', 'web'],
    });
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.issues.some((i) => i.code === 'topic_tag_duplicate')).toBe(true);
    }
  });

  it('rejects tool_overrides shape errors', () => {
    const r1 = validateConnectionMcpAnnotationInput({
      connection_name: 'exa',
      tool_overrides: [],
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.issues.some((i) => i.code === 'tool_overrides_not_object')).toBe(true);
    }
    const r2 = validateConnectionMcpAnnotationInput({
      connection_name: 'exa',
      tool_overrides: { search: { enabled: 'yes', classification: 'read' } },
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.issues.some((i) => i.code === 'tool_override_enabled_invalid')).toBe(true);
    }
    const r3 = validateConnectionMcpAnnotationInput({
      connection_name: 'exa',
      tool_overrides: { search: { enabled: true, classification: 'execute' } },
    });
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.issues.some((i) => i.code === 'tool_override_classification_invalid')).toBe(true);
    }
  });

  it('rejects tools_list_cache shape errors', () => {
    const r1 = validateConnectionMcpAnnotationInput({
      connection_name: 'exa',
      tools_list_cache: { tools: 'not an array', cached_at: 0 },
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.issues.some((i) => i.code === 'tools_list_cache_shape_invalid')).toBe(true);
    }
    const r2 = validateConnectionMcpAnnotationInput({
      connection_name: 'exa',
      tools_list_cache: {
        tools: [{ name: 'search' }, { name: 'search' }],
        cached_at: 0,
      },
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.issues.some((i) => i.code === 'tools_list_cache_duplicate_tool')).toBe(true);
    }
    const r3 = validateConnectionMcpAnnotationInput({
      connection_name: 'exa',
      tools_list_cache: { tools: [], cached_at: -1 },
    });
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.issues.some((i) => i.code === 'tools_list_cache_cached_at_invalid')).toBe(true);
    }
  });

  it('rejects custom_topic_tags shape errors', () => {
    const r1 = validateConnectionMcpAnnotationInput({
      connection_name: 'exa',
      tool_overrides: {
        search: {
          enabled: true,
          classification: 'read',
          custom_topic_tags: 'web',
        },
      },
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.issues.some((i) => i.code === 'tool_override_custom_tag_invalid')).toBe(true);
    }
  });

  it('canonicalizes a full valid payload', () => {
    const r = validateConnectionMcpAnnotationInput({
      connection_name: 'exa',
      topic_tags: ['web', 'research'],
      tool_overrides: {
        search: {
          enabled: true,
          classification: 'read',
          custom_topic_tags: ['search'],
        },
        delete_index: {
          enabled: true,
          classification: 'write',
        },
      },
      tools_list_cache: {
        tools: [
          { name: 'search', description: 'Search the web', destructive_hint: false },
          { name: 'delete_index', destructive_hint: true },
        ],
        cached_at: 1700000000,
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.connection_name).toBe('exa');
      expect([...r.value.topic_tags]).toEqual(['web', 'research']);
      expect(Object.keys(r.value.tool_overrides).sort()).toEqual([
        'delete_index',
        'search',
      ]);
      expect(r.value.tools_list_cache.cached_at).toBe(1700000000);
      expect(r.value.tools_list_cache.tools.length).toBe(2);
    }
  });
});
