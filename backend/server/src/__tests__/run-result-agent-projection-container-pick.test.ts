/** D-192 Slice 6b — the agent-facing projection of a container-pick-held run.
 *  A create blocked on an ambiguous container is a clean third-state (not a bare
 *  success:false), with S4 messages keyed on ask-raise state and create permission. */

import { describe, expect, it } from 'vitest';

import {
  CONTAINER_PICK_CREATE_GRANTED_MESSAGE,
  CONTAINER_PICK_NO_CREATE_PERMISSION_MESSAGE,
  CONTAINER_PICK_RAISED_MESSAGE,
  CONTAINER_PICK_UNRAISED_MESSAGE,
  CREATE_PLAN_RAISED_MESSAGE,
  CREATE_PLAN_UNRAISED_MESSAGE,
  projectRunResultForAgent,
} from '../run-result-agent-projection.js';
import type { ExecuteResponse } from '../types.js';
import type { PlannedDependencyCreate } from '@recued/contracts';

const OPTIONS = [
  { entity_pk: 'team-eng', label: 'Engineering' },
  { entity_pk: 'team-design', label: 'Design' },
];

const heldOnContainer = (overrides: Partial<ExecuteResponse['container_pick_required']> = {}): ExecuteResponse => ({
  recipe_id: 'run-ingredient',
  recipe_hash: 'hash-1',
  success: false,
  output: { render: [], sidebar: [] },
  steps: [],
  errors: [],
  duration_ms: 5,
  container_pick_required: {
    source_id: 'connection:linear:conn-1',
    kind: 'task',
    dependency_ref: 'team',
    options: OPTIONS,
    can_create: false,
    ...overrides,
  },
});

describe('projectRunResultForAgent — container_pick_required', () => {
  it('ask raised (ask_id present) → RAISED message + the choice set, no bare success:false', () => {
    const projected = projectRunResultForAgent(heldOnContainer({
      ask_id: 'ask-9',
      create_op: 'recued-core/asana.project.create',
      can_create_new_container: true,
    })) as Record<string, unknown>;
    expect(projected.status).toBe('container_pick_required');
    expect(projected.container_pick_required).toBe(true);
    expect(projected.dependency_ref).toBe('team');
    expect(projected.options).toEqual(OPTIONS);
    expect(projected.message).toBe(CONTAINER_PICK_RAISED_MESSAGE);
    expect(projected.can_create_new_container).toBe(true);
    expect(projected.success).toBeUndefined(); // the contradictory flag never reaches the agent
  });

  it('no ask raised (ask_id absent) → UNRAISED message + STILL carries the choice set', () => {
    const projected = projectRunResultForAgent(heldOnContainer()) as Record<string, unknown>;
    expect(projected.status).toBe('container_pick_required');
    expect(projected.message).toBe(CONTAINER_PICK_UNRAISED_MESSAGE);
    expect(projected.can_create_new_container).toBe(false);
    // The unraised path is the ONLY way a contracted agent learns the choices —
    // the options must survive (a UNRAISED result with no options strands it).
    expect(projected.options).toEqual(OPTIONS);
    expect(projected.dependency_ref).toBe('team');
    // The messages must differ — the honesty fix depends on it.
    expect(CONTAINER_PICK_RAISED_MESSAGE).not.toBe(CONTAINER_PICK_UNRAISED_MESSAGE);
  });

  it('no ask + may create a new container → CREATE_GRANTED message + true boolean', () => {
    const projected = projectRunResultForAgent(heldOnContainer({
      create_op: 'recued-core/asana.project.create',
      target_write_op: 'recued-core/asana.task.create',
      can_create_new_container: true,
    })) as Record<string, unknown>;
    expect(projected.status).toBe('container_pick_required');
    expect(projected.message).toBe(CONTAINER_PICK_CREATE_GRANTED_MESSAGE);
    expect(projected.can_create_new_container).toBe(true);
  });

  it('no ask + create op present but not admitted → NO_CREATE_PERMISSION message + false boolean', () => {
    const projected = projectRunResultForAgent(heldOnContainer({
      create_op: 'recued-core/asana.project.create',
      target_write_op: 'recued-core/asana.task.create',
      can_create_new_container: false,
    })) as Record<string, unknown>;
    expect(projected.status).toBe('container_pick_required');
    expect(projected.message).toBe(CONTAINER_PICK_NO_CREATE_PERMISSION_MESSAGE);
    expect(projected.can_create_new_container).toBe(false);
  });

  it('an owner cancellation (run_terminated) wins over container_pick_required, full cancelled shape', () => {
    const result = { ...heldOnContainer({ ask_id: 'ask-9' }), run_terminated: 'killed' as const };
    const projected = projectRunResultForAgent(result) as Record<string, unknown>;
    expect(projected.status).toBe('cancelled');
    expect(projected.cancelled).toBe(true);
    expect(projected.recipe_id).toBe('run-ingredient');
    expect(typeof projected.message).toBe('string');
    // The container-pick shape must NOT bleed through a cancellation.
    expect(projected.container_pick_required).toBeUndefined();
  });

  it('a normal result with no container_pick_required passes through unchanged', () => {
    const ok: ExecuteResponse = {
      recipe_id: 'r', recipe_hash: 'h', success: true,
      output: { render: [], sidebar: [] }, steps: [], errors: [], duration_ms: 1,
    };
    expect(projectRunResultForAgent(ok)).toBe(ok);
  });
});

const PLAN: PlannedDependencyCreate = {
  ref: 'project', create_op: 'project.create', name: 'Roadmap',
  args: { 'body.data': { name: 'Roadmap' } }, result_path: 'data', id_field: 'gid',
};

const heldOnCreatePlan = (overrides: Partial<ExecuteResponse['create_plan_required']> = {}): ExecuteResponse => ({
  recipe_id: 'run-ingredient', recipe_hash: 'hash-1', success: false,
  output: { render: [], sidebar: [] }, steps: [], errors: [], duration_ms: 5,
  create_plan_required: {
    source_id: 'asana.conn-1.task', kind: 'task', plans: [PLAN],
    target_summary: "task 'Ship it'", ...overrides,
  },
});

describe('projectRunResultForAgent — create_plan_required', () => {
  it('confirm raised (ask_id present) → RAISED message + the container names, no bare success:false', () => {
    const projected = projectRunResultForAgent(heldOnCreatePlan({ ask_id: 'ask-9' })) as Record<string, unknown>;
    expect(projected.status).toBe('create_plan_required');
    expect(projected.create_plan_required).toBe(true);
    expect(projected.containers).toEqual(["project 'Roadmap'"]);
    expect(projected.message).toBe(CREATE_PLAN_RAISED_MESSAGE);
    expect(projected.success).toBeUndefined();
  });

  it('no confirm raised (ask_id absent) → UNRAISED message + STILL names the container', () => {
    const projected = projectRunResultForAgent(heldOnCreatePlan()) as Record<string, unknown>;
    expect(projected.status).toBe('create_plan_required');
    expect(projected.message).toBe(CREATE_PLAN_UNRAISED_MESSAGE);
    expect(projected.containers).toEqual(["project 'Roadmap'"]);
    expect(CREATE_PLAN_RAISED_MESSAGE).not.toBe(CREATE_PLAN_UNRAISED_MESSAGE);
  });

  it('an owner cancellation wins over create_plan_required', () => {
    const result = { ...heldOnCreatePlan({ ask_id: 'ask-9' }), run_terminated: 'killed' as const };
    const projected = projectRunResultForAgent(result) as Record<string, unknown>;
    expect(projected.status).toBe('cancelled');
    expect(projected.create_plan_required).toBeUndefined();
  });
});
