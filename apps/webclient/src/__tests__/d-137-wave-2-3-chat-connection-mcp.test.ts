/** D-137 W2.3 § A.1.1 + § A.10 — Settings → Connections MCP tools
 *  renderer.
 *
 *  Acceptance:
 *    - CHAT_CONNECTION_MCP_CLASSIFICATION_COPY exhaustive over
 *      Tier3ToolClassification
 *    - isChatConnectionMcpToolVisible — substrate-correct visibility
 *      gate (enabled + classified)
 *    - buildChatConnectionMcpToolRow projects descriptor + override
 *      into one row with correct visible flag + topic-tag fallback
 *    - buildChatConnectionMcpAnnotationModel returns 'pending' on
 *      missing / shape-broken snapshots; resolves with counts when
 *      shape is valid; rows sorted by tool name ascending
 *    - projectToggledConnectionMcpTool flips enabled flag; seeds an
 *      `'unknown'` row when no prior override exists
 *    - projectClassifiedConnectionMcpTool overwrites classification;
 *      seeds disabled+classification row when no prior override exists
 *    - reduceChatConnectionMcpAnnotationChanged absorbs the broadcast
 *      shape into the resolved model
 */

import { describe, it, expect } from 'vitest';
import {
  CHAT_CONNECTION_MCP_CLASSIFICATION_COPY,
  buildChatConnectionMcpAnnotationModel,
  buildChatConnectionMcpClassificationOptions,
  buildChatConnectionMcpToolRow,
  isChatConnectionMcpToolVisible,
  projectClassifiedConnectionMcpTool,
  projectToggledConnectionMcpTool,
  reduceChatConnectionMcpAnnotationChanged,
} from '../settings/chat-connection-mcp.js';
import type {
  ConnectionMcpAnnotationState,
  ConnectionMcpToolOverride,
  McpToolDescriptor,
  Tier3ToolClassification,
} from '@recued/contracts';

describe('CHAT_CONNECTION_MCP_CLASSIFICATION_COPY exhaustive over Tier3ToolClassification', () => {
  it('covers all 3 classifications', () => {
    expect(Object.keys(CHAT_CONNECTION_MCP_CLASSIFICATION_COPY).sort()).toEqual([
      'read',
      'unknown',
      'write',
    ]);
  });

  it('safe-tier for read, risky-tier for write, unset for unknown', () => {
    expect(CHAT_CONNECTION_MCP_CLASSIFICATION_COPY.read.risk_tier).toBe('safe');
    expect(CHAT_CONNECTION_MCP_CLASSIFICATION_COPY.write.risk_tier).toBe('risky');
    expect(CHAT_CONNECTION_MCP_CLASSIFICATION_COPY.unknown.risk_tier).toBe('unset');
  });
});

describe('isChatConnectionMcpToolVisible', () => {
  it('returns false when override is undefined', () => {
    expect(isChatConnectionMcpToolVisible(undefined)).toBe(false);
  });

  it('returns false when disabled', () => {
    const ov: ConnectionMcpToolOverride = {
      enabled: false,
      classification: 'read',
    };
    expect(isChatConnectionMcpToolVisible(ov)).toBe(false);
  });

  it('returns false when classification is unknown', () => {
    const ov: ConnectionMcpToolOverride = {
      enabled: true,
      classification: 'unknown',
    };
    expect(isChatConnectionMcpToolVisible(ov)).toBe(false);
  });

  it('returns true when enabled + classified', () => {
    expect(isChatConnectionMcpToolVisible({ enabled: true, classification: 'read' })).toBe(true);
    expect(isChatConnectionMcpToolVisible({ enabled: true, classification: 'write' })).toBe(true);
  });
});

describe('buildChatConnectionMcpToolRow', () => {
  it('builds an "unset" row when no override exists', () => {
    const desc: McpToolDescriptor = { name: 'search', description: 'web search' };
    const row = buildChatConnectionMcpToolRow(desc, undefined);
    expect(row.tool_name).toBe('search');
    expect(row.override.kind).toBe('unset');
    expect(row.description).toBe('web search');
    expect(row.destructive_hint).toBe(false);
    expect(row.visible).toBe(false);
  });

  it('builds a "set" row when override exists', () => {
    const desc: McpToolDescriptor = { name: 'search' };
    const row = buildChatConnectionMcpToolRow(desc, {
      enabled: true,
      classification: 'read',
    });
    expect(row.override.kind).toBe('set');
    if (row.override.kind === 'set') {
      expect(row.override.value.classification).toBe('read');
    }
    expect(row.visible).toBe(true);
  });

  it('surfaces upstream destructive_hint', () => {
    const desc: McpToolDescriptor = { name: 'delete_index', destructive_hint: true };
    const row = buildChatConnectionMcpToolRow(desc, undefined);
    expect(row.destructive_hint).toBe(true);
  });
});

const baseAnnotation = (
  overrides: Partial<ConnectionMcpAnnotationState> = {},
): ConnectionMcpAnnotationState => ({
  connection_name: 'exa',
  topic_tags: [],
  tool_overrides: {},
  tools_list_cache: { tools: [], cached_at: 0 },
  updated_at: 0,
  ...overrides,
});

describe('buildChatConnectionMcpAnnotationModel', () => {
  it('returns pending when snapshot is null', () => {
    const model = buildChatConnectionMcpAnnotationModel(null);
    expect(model.kind).toBe('pending');
  });

  it('returns pending when connection_name is missing', () => {
    const model = buildChatConnectionMcpAnnotationModel({
      // @ts-expect-error — testing wire-shape rejection
      connection_name: 0,
    });
    expect(model.kind).toBe('pending');
  });

  it('resolves when snapshot is valid', () => {
    const snapshot = baseAnnotation({
      topic_tags: ['web'],
      tool_overrides: {
        search: { enabled: true, classification: 'read' },
        delete_index: { enabled: true, classification: 'unknown' },
      },
      tools_list_cache: {
        tools: [{ name: 'delete_index' }, { name: 'search' }],
        cached_at: 100,
      },
      updated_at: 5_000,
    });
    const model = buildChatConnectionMcpAnnotationModel(snapshot);
    expect(model.kind).toBe('resolved');
    if (model.kind === 'resolved') {
      expect(model.connection_name).toBe('exa');
      expect(model.topic_tags).toEqual(['web']);
      // Rows sorted ascending by tool name.
      expect(model.rows.map((r) => r.tool_name)).toEqual(['delete_index', 'search']);
      expect(model.total_count).toBe(2);
      expect(model.visible_count).toBe(1); // only search passes both gates
      expect(model.unclassified_count).toBe(1); // delete_index is unknown
      expect(model.cached_at).toBe(100);
      expect(model.updated_at).toBe(5_000);
    }
  });

  it('rows excluded when missing override OR disabled OR unknown', () => {
    const snapshot = baseAnnotation({
      tool_overrides: {
        search: { enabled: true, classification: 'read' },
        contents: { enabled: false, classification: 'read' },
        delete_index: { enabled: true, classification: 'unknown' },
        // similar — no override row at all
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
    const model = buildChatConnectionMcpAnnotationModel(snapshot);
    if (model.kind === 'resolved') {
      expect(model.total_count).toBe(4);
      expect(model.visible_count).toBe(1);
      // unclassified = override missing OR classification unknown
      // (similar + delete_index)
      expect(model.unclassified_count).toBe(2);
    }
  });
});

describe('projectToggledConnectionMcpTool', () => {
  it('flips an existing override\'s enabled flag', () => {
    const current: Record<string, ConnectionMcpToolOverride> = {
      search: { enabled: true, classification: 'read' },
    };
    const next = projectToggledConnectionMcpTool({
      current,
      tool_name: 'search',
      next_enabled: false,
    });
    expect(next.search.enabled).toBe(false);
    expect(next.search.classification).toBe('read');
  });

  it('seeds an unknown row when no prior override exists', () => {
    const next = projectToggledConnectionMcpTool({
      current: {},
      tool_name: 'newly_advertised',
      next_enabled: true,
    });
    expect(next.newly_advertised.enabled).toBe(true);
    expect(next.newly_advertised.classification).toBe('unknown');
  });

  it('is idempotent on no-op toggles', () => {
    const current: Record<string, ConnectionMcpToolOverride> = {
      search: { enabled: true, classification: 'read' },
    };
    const next = projectToggledConnectionMcpTool({
      current,
      tool_name: 'search',
      next_enabled: true,
    });
    expect(next.search).toEqual({ enabled: true, classification: 'read' });
  });

  it('preserves other entries', () => {
    const current: Record<string, ConnectionMcpToolOverride> = {
      search: { enabled: true, classification: 'read' },
      contents: { enabled: true, classification: 'read' },
    };
    const next = projectToggledConnectionMcpTool({
      current,
      tool_name: 'search',
      next_enabled: false,
    });
    expect(next.contents.enabled).toBe(true);
  });
});

describe('projectClassifiedConnectionMcpTool', () => {
  it('overwrites classification on an existing override', () => {
    const current: Record<string, ConnectionMcpToolOverride> = {
      search: { enabled: true, classification: 'unknown' },
    };
    const next = projectClassifiedConnectionMcpTool({
      current,
      tool_name: 'search',
      next_classification: 'read',
    });
    expect(next.search.classification).toBe('read');
    expect(next.search.enabled).toBe(true);
  });

  it('seeds a disabled+classified row when no prior override exists', () => {
    const next = projectClassifiedConnectionMcpTool({
      current: {},
      tool_name: 'newly_advertised',
      next_classification: 'write',
    });
    expect(next.newly_advertised.enabled).toBe(false);
    expect(next.newly_advertised.classification).toBe('write');
  });

  it('rejects off-list classifications silently (returns unchanged map)', () => {
    const current: Record<string, ConnectionMcpToolOverride> = {
      search: { enabled: true, classification: 'read' },
    };
    const next = projectClassifiedConnectionMcpTool({
      current,
      tool_name: 'search',
      next_classification: 'execute' as Tier3ToolClassification,
    });
    expect(next.search.classification).toBe('read');
  });
});

describe('reduceChatConnectionMcpAnnotationChanged', () => {
  it('replaces the model with the broadcast-supplied annotation', () => {
    const initial = buildChatConnectionMcpAnnotationModel(null);
    const event = {
      connection_name: 'exa',
      annotation: baseAnnotation({
        topic_tags: ['web'],
        tool_overrides: {
          search: { enabled: true, classification: 'read' },
        },
        tools_list_cache: {
          tools: [{ name: 'search' }],
          cached_at: 100,
        },
        updated_at: 3_000,
      }),
    };
    const next = reduceChatConnectionMcpAnnotationChanged(initial, event);
    expect(next.kind).toBe('resolved');
    if (next.kind === 'resolved') {
      expect(next.connection_name).toBe('exa');
      expect(next.rows.length).toBe(1);
      expect(next.visible_count).toBe(1);
    }
  });

  it('falls back to default model when annotation is malformed', () => {
    const initial = buildChatConnectionMcpAnnotationModel(null);
    const event = {
      connection_name: 'exa',
      annotation: null,
    };
    const next = reduceChatConnectionMcpAnnotationChanged(initial, event);
    expect(next.kind).toBe('resolved');
    if (next.kind === 'resolved') {
      expect(next.connection_name).toBe('exa');
      expect(next.rows.length).toBe(0);
    }
  });
});

describe('buildChatConnectionMcpClassificationOptions', () => {
  it('returns one entry per Tier3ToolClassification in canonical order', () => {
    const opts = buildChatConnectionMcpClassificationOptions();
    expect(opts.map((o) => o.value)).toEqual(['read', 'write', 'unknown']);
  });

  it('mirrors copy + risk_tier from CHAT_CONNECTION_MCP_CLASSIFICATION_COPY', () => {
    const opts = buildChatConnectionMcpClassificationOptions();
    for (const o of opts) {
      const copy = CHAT_CONNECTION_MCP_CLASSIFICATION_COPY[o.value];
      expect(o.label).toBe(copy.label);
      expect(o.risk_tier).toBe(copy.risk_tier);
    }
  });
});
