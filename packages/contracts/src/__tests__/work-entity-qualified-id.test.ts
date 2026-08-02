import { describe, expect, it } from 'vitest';

import type { IngredientManifest } from '../ingredient.js';
import type { WorkEntitySourceDeclarableKind } from '../work-entity-sources.js';
import {
  parseQualifiedWorkEntityId,
  qualifyWorkEntityId,
  QualifiedWorkEntityIdError,
  routeQualifiedWorkEntityOperationArgs,
} from '../work-entity-qualified-id.js';

const taskManifest = (vendor: string): IngredientManifest => ({
  slug: `${vendor}-catalog`,
  operations: {
    'task.update': { risk_tier: 'write' },
    'task.delete': { risk_tier: 'destructive' },
  },
  work_entity_sources: [{
    kind: 'task',
    source_id_template: `${vendor}.\${connection_id}.task`,
    remote: { entity: 'task' },
    ops: { update: 'task.update', delete: 'task.delete' },
    op_bindings: {
      update: { id_arg: 'task_id' },
      delete: { id_arg: 'task_id' },
    },
  }],
} as unknown as IngredientManifest);

const sourceManifest = (
  vendor: string,
  kind: WorkEntitySourceDeclarableKind,
): IngredientManifest => ({
  slug: `${vendor}-${kind}-catalog`,
  operations: {
    [`${kind}.read`]: { risk_tier: 'read' },
    [`${kind}.update`]: { risk_tier: 'write' },
    [`${kind}.delete`]: { risk_tier: 'write' },
  },
  work_entity_sources: [{
    kind,
    source_id_template: `${vendor}.\${connection_id}.${kind}`,
    remote: { entity: kind },
    ops: {
      read: `${kind}.read`,
      update: `${kind}.update`,
      delete: `${kind}.delete`,
    },
    op_bindings: {
      read: { id_arg: `${kind}_id` },
      update: { id_arg: `${kind}_id` },
      delete: { id_arg: `${kind}_id` },
    },
  }],
} as unknown as IngredientManifest);

describe('qualified work-entity ids', () => {
  it('round-trips an injective, delimiter-safe source identity', () => {
    const id = qualifyWorkEntityId({
      kind: 'task',
      source_id: 'todoist.team:west/日本.task',
      source_record_id: 'task:123/%',
      local_id: 'local-is-not-emitted',
    });

    expect(parseQualifiedWorkEntityId(id)).toEqual({
      version: 'we1',
      kind: 'task',
      source_id: 'todoist.team:west/日本.task',
      identity: 'source',
      record_id: 'task:123/%',
    });
    expect(id).not.toContain('local-is-not-emitted');
  });

  it('uses a source-bound local fallback when no provider id exists', () => {
    const id = qualifyWorkEntityId({
      kind: 'booking',
      source_id: 'recued.builtin.booking',
      local_id: 'booking-1',
    });

    expect(parseQualifiedWorkEntityId(id)).toMatchObject({
      kind: 'booking',
      source_id: 'recued.builtin.booking',
      identity: 'local',
      record_id: 'booking-1',
    });
  });

  it('rejects malformed spellings that claim the qualified namespace', () => {
    expect(() => parseQualifiedWorkEntityId('we1:task:todoist%2eprod.task:source:123'))
      .toThrowError(QualifiedWorkEntityIdError);
    expect(() => parseQualifiedWorkEntityId('we1:task:only-four:parts'))
      .toThrow(/QUALIFIED_ID_INVALID/);
    expect(parseQualifiedWorkEntityId('legacy-task-123')).toBeNull();
  });

  it('unwraps a matching provider id and leaves a legacy native id alone', () => {
    const manifest = taskManifest('todoist');
    const qualified = qualifyWorkEntityId({
      kind: 'task',
      source_id: 'todoist.personal.task',
      source_record_id: 'native-123',
      local_id: 'local-123',
    });

    expect(routeQualifiedWorkEntityOperationArgs({
      manifest,
      operation: 'task.update',
      connection_name: 'personal',
      args: { task_id: qualified, body: { content: 'Next' } },
    })).toMatchObject({
      args: { task_id: 'native-123', body: { content: 'Next' } },
      routed: {
        kind: 'task',
        source_id: 'todoist.personal.task',
        source_record_id: 'native-123',
        id_arg: 'task_id',
        retry_with: 'data.task.update',
      },
    });

    const legacyArgs = { task_id: 'native-123' };
    expect(routeQualifiedWorkEntityOperationArgs({
      manifest,
      operation: 'task.update',
      connection_name: 'personal',
      args: legacyArgs,
    }).args).toBe(legacyArgs);
  });

  it('routes read/update/delete for every externally Source-capable entity kind', () => {
    for (const kind of ['task', 'note', 'project'] as const) {
      const qualified = qualifyWorkEntityId({
        kind,
        source_id: `acme.personal.${kind}`,
        source_record_id: `${kind}-native-123`,
        local_id: `${kind}-local-123`,
      });
      for (const operation of ['read', 'update', 'delete'] as const) {
        expect(routeQualifiedWorkEntityOperationArgs({
          manifest: sourceManifest('acme', kind),
          operation: `${kind}.${operation}`,
          connection_name: 'personal',
          args: { [`${kind}_id`]: qualified, body: { title: 'Next' } },
        })).toMatchObject({
          args: {
            [`${kind}_id`]: `${kind}-native-123`,
            body: { title: 'Next' },
          },
          routed: {
            kind,
            source_id: `acme.personal.${kind}`,
            source_record_id: `${kind}-native-123`,
            id_arg: `${kind}_id`,
            retry_with: operation === 'read'
              ? 'work.read'
              : `data.${kind}.${operation}`,
          },
        });
      }
    }
  });

  it('fails loud on a wrong provider or account and suggests the generic retry', () => {
    const todoistId = qualifyWorkEntityId({
      kind: 'task',
      source_id: 'todoist.personal.task',
      source_record_id: 'native-123',
      local_id: 'local-123',
    });

    for (const [manifest, connection] of [
      [taskManifest('hubspot'), 'sales'],
      [taskManifest('todoist'), 'work'],
    ] as const) {
      try {
        routeQualifiedWorkEntityOperationArgs({
          manifest,
          operation: 'task.update',
          connection_name: connection,
          args: { task_id: todoistId },
        });
        expect.fail('expected SOURCE_MISMATCH');
      } catch (error) {
        expect(error).toBeInstanceOf(QualifiedWorkEntityIdError);
        expect(error).toMatchObject({
          code: 'SOURCE_MISMATCH',
          retry_with: 'data.task.update',
          actual_source: 'todoist.personal.task',
        });
        expect((error as Error).message).toContain('No provider call was made');
        expect((error as Error).message).toContain("Retry with 'data.task.update'");
      }
    }
  });

  it('uses the declared delete slot for providers that call deletion archive', () => {
    const manifest = taskManifest('todoist');
    manifest.operations = {
      'task.archive': {
        operation_id: 'todoist/task.archive',
        risk_tier: 'destructive',
      },
    };
    manifest.work_entity_sources![0]!.ops = { delete: 'task.archive' };
    manifest.work_entity_sources![0]!.op_bindings = {
      delete: { id_arg: 'task_id' },
    };
    const otherAccountId = qualifyWorkEntityId({
      kind: 'task',
      source_id: 'todoist.personal.task',
      source_record_id: 'native-123',
      local_id: 'local-123',
    });

    expect(() => routeQualifiedWorkEntityOperationArgs({
      manifest,
      operation: 'task.archive',
      connection_name: 'work',
      args: { task_id: otherAccountId },
    })).toThrowError(expect.objectContaining({
      code: 'SOURCE_MISMATCH',
      retry_with: 'data.task.delete',
    }));
  });

  it('does not infer whole-entity deletion from a nested sibling remove verb', () => {
    const manifest = taskManifest('quo');
    manifest.operations = {
      ...manifest.operations,
      'task.due_date.remove': {
        operation_id: 'quo/task.due_date.remove',
        risk_tier: 'write',
      },
    };
    const otherAccountId = qualifyWorkEntityId({
      kind: 'task',
      source_id: 'quo.personal.task',
      source_record_id: 'native-123',
      local_id: 'local-123',
    });

    expect(() => routeQualifiedWorkEntityOperationArgs({
      manifest,
      operation: 'task.due_date.remove',
      connection_name: 'work',
      args: { task_id: otherAccountId },
    })).toThrowError(expect.objectContaining({
      code: 'SOURCE_MISMATCH',
      retry_with: 'data.task.update',
    }));
  });
});
