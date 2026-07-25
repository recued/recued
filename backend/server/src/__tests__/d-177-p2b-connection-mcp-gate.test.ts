/** D-177 P2b -- connection MCP classification gate tests. */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  CONNECTION_MCP_READ_SLUG,
  CONNECTION_MCP_WRITE_SLUG,
  buildDefaultConnectionMcpAnnotation,
  type ConnectionKind,
  type ConnectionMcpAnnotationState,
  type ConnectionRow,
} from '@recued/contracts';
import { IngredientError, type ConnectionAdapterDeps, type ResolvedCall } from '@recued/ingredients';
import {
  createConnectionMcpClassificationGate,
  createConnectionMcpGateFromDb,
} from '../connection-mcp-gate.js';
import {
  createChatConnectionMcpStore,
  ensureChatConnectionMcpAnnotationSchema,
} from '../storage/chat-connection-mcp-store.js';

type GateArgs = Parameters<NonNullable<ConnectionAdapterDeps['gateDispatch']>>[0];

const mkRow = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  pk: `${overrides.kind ?? 'mcp'}:${overrides.name ?? 'exa'}`,
  kind: overrides.kind ?? 'mcp',
  name: overrides.name ?? 'exa',
  display_name: overrides.display_name ?? 'Exa',
  config_json: overrides.config_json ?? '{}',
  auth_ciphertext: overrides.auth_ciphertext ?? 'opaque',
  enrolled_at: overrides.enrolled_at ?? 1_700_000_000_000,
  updated_at: overrides.updated_at ?? 1_700_000_000_000,
  ...(overrides.subtype !== undefined ? { subtype: overrides.subtype } : {}),
});

const mkCall = (slug: string): ResolvedCall => ({
  slug,
  risk_tier: slug === CONNECTION_MCP_READ_SLUG ? 'read' : 'write',
  input: {},
  output: {},
});

const mkArgs = (
  overrides: Partial<GateArgs> & { slug?: string } = {},
): GateArgs => {
  const kind = overrides.kind ?? 'mcp';
  return {
    kind,
    record: overrides.record ?? mkRow({ kind, name: 'exa' }),
    params: overrides.params ?? { tool: 'search' },
    call: overrides.call ?? mkCall(overrides.slug ?? CONNECTION_MCP_READ_SLUG),
  };
};

const annotation = (
  tool_overrides: ConnectionMcpAnnotationState['tool_overrides'] = {},
): ConnectionMcpAnnotationState => ({
  ...buildDefaultConnectionMcpAnnotation('exa'),
  tool_overrides,
});

const expectMcpGateError = (fn: () => void): IngredientError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(IngredientError);
    expect((error as IngredientError).code).toBe('MCP_TOOL_NOT_CLASSIFIED');
    return error as IngredientError;
  }
  throw new Error('expected MCP_TOOL_NOT_CLASSIFIED');
};

const annotationTableExists = (db: Database.Database): boolean =>
  Boolean(
    db.prepare(
      `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name = 'chat_connection_mcp_annotations'`,
    ).get(),
  );

describe('D-177 P2b createConnectionMcpClassificationGate', () => {
  it('passes non-listed slugs untouched and does not read annotations', () => {
    const getAnnotation = vi.fn(() => annotation());
    const gate = createConnectionMcpClassificationGate({ getAnnotation });

    expect(() => gate(mkArgs({
      slug: 'slack-post',
      kind: 'api',
      record: mkRow({ kind: 'api', name: 'slack' }),
      params: {},
    }))).not.toThrow();

    expect(getAnnotation).not.toHaveBeenCalled();
  });

  it.each([CONNECTION_MCP_READ_SLUG, CONNECTION_MCP_WRITE_SLUG])(
    'throws MCP_TOOL_NOT_CLASSIFIED when %s dispatches with kind other than mcp',
    (slug) => {
      const getAnnotation = vi.fn(() => annotation());
      const gate = createConnectionMcpClassificationGate({ getAnnotation });

      const error = expectMcpGateError(() => gate(mkArgs({
        slug,
        kind: 'api',
        record: mkRow({ kind: 'api', name: 'hubspot' }),
      })));

      expect(error.details).toMatchObject({ slug, kind: 'api', name: 'hubspot' });
      expect(getAnnotation).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing', {}],
    ['empty', { tool: '' }],
    ['blank', { tool: '   ' }],
  ])('throws MCP_TOOL_NOT_CLASSIFIED when tool param is %s', (_label, params) => {
    const getAnnotation = vi.fn(() => annotation());
    const gate = createConnectionMcpClassificationGate({ getAnnotation });

    expectMcpGateError(() => gate(mkArgs({ params })));

    expect(getAnnotation).not.toHaveBeenCalled();
  });

  it('throws when the annotation has no override for the named tool', () => {
    const getAnnotation = vi.fn(() => annotation({}));
    const gate = createConnectionMcpClassificationGate({ getAnnotation });

    expectMcpGateError(() => gate(mkArgs({ params: { tool: 'search' } })));

    expect(getAnnotation).toHaveBeenCalledWith('exa');
  });

  it('throws when the tool override is disabled', () => {
    const getAnnotation = vi.fn(() => annotation({
      search: { enabled: false, classification: 'read' },
    }));
    const gate = createConnectionMcpClassificationGate({ getAnnotation });

    expectMcpGateError(() => gate(mkArgs()));
  });

  it('throws when the tool override classification is unknown', () => {
    const getAnnotation = vi.fn(() => annotation({
      search: { enabled: true, classification: 'unknown' },
    }));
    const gate = createConnectionMcpClassificationGate({ getAnnotation });

    expectMcpGateError(() => gate(mkArgs()));
  });

  it('throws when the read kernel slug dispatches a write-classified tool', () => {
    const getAnnotation = vi.fn(() => annotation({
      search: { enabled: true, classification: 'write' },
    }));
    const gate = createConnectionMcpClassificationGate({ getAnnotation });

    const error = expectMcpGateError(() => gate(mkArgs({ slug: CONNECTION_MCP_READ_SLUG })));

    expect(error.details).toMatchObject({ classification: 'write' });
  });

  it('passes when the read kernel slug dispatches a read-classified tool', () => {
    const getAnnotation = vi.fn(() => annotation({
      search: { enabled: true, classification: 'read' },
    }));
    const gate = createConnectionMcpClassificationGate({ getAnnotation });

    expect(() => gate(mkArgs({ slug: CONNECTION_MCP_READ_SLUG }))).not.toThrow();
  });

  it('passes when the write kernel slug dispatches a write-classified tool', () => {
    const getAnnotation = vi.fn(() => annotation({
      search: { enabled: true, classification: 'write' },
    }));
    const gate = createConnectionMcpClassificationGate({ getAnnotation });

    expect(() => gate(mkArgs({ slug: CONNECTION_MCP_WRITE_SLUG }))).not.toThrow();
  });

  it('passes when the write kernel slug dispatches a read-classified tool', () => {
    const getAnnotation = vi.fn(() => annotation({
      search: { enabled: true, classification: 'read' },
    }));
    const gate = createConnectionMcpClassificationGate({ getAnnotation });

    expect(() => gate(mkArgs({ slug: CONNECTION_MCP_WRITE_SLUG }))).not.toThrow();
  });

  it.each(['__proto__', 'constructor'])(
    'does not match prototype-polluted override key %s',
    (tool) => {
      const pollutedPrototype = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(pollutedPrototype, tool, {
        value: { enabled: true, classification: 'read' },
        enumerable: true,
      });
      const pollutedOverrides =
        Object.create(pollutedPrototype) as ConnectionMcpAnnotationState['tool_overrides'];
      const getAnnotation = vi.fn(() => annotation(pollutedOverrides));
      const gate = createConnectionMcpClassificationGate({ getAnnotation });

      expectMcpGateError(() => gate(mkArgs({ params: { tool } })));
    },
  );
});

describe('D-177 P2b createConnectionMcpGateFromDb', () => {
  it('is lazy, skips db access for non-listed slugs, then ensures schema and reads rows for kernel slugs', () => {
    const db = new Database(':memory:');
    try {
      const gate = createConnectionMcpGateFromDb(db);
      expect(annotationTableExists(db)).toBe(false);

      expect(() => gate(mkArgs({
        slug: 'slack-post',
        params: {},
      }))).not.toThrow();
      expect(annotationTableExists(db)).toBe(false);

      expectMcpGateError(() => gate(mkArgs({
        slug: CONNECTION_MCP_READ_SLUG,
        params: { tool: 'search' },
      })));
      expect(annotationTableExists(db)).toBe(true);

      ensureChatConnectionMcpAnnotationSchema(db);
      createChatConnectionMcpStore(db).setAnnotation({
        value: {
          connection_name: 'exa',
          topic_tags: [],
          tool_overrides: {
            search: { enabled: true, classification: 'read' },
          },
          tools_list_cache: { tools: [{ name: 'search' }], cached_at: 1 },
        },
        now: 2,
      });

      expect(() => gate(mkArgs({
        slug: CONNECTION_MCP_READ_SLUG,
        params: { tool: 'search' },
      }))).not.toThrow();
    } finally {
      db.close();
    }
  });
});
