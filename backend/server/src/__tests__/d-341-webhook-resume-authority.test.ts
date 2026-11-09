/** D-341 slice B2 — a webhook run's approved local write resumes under its live door
 *  (`approval-resume-authority.ts`). A resumed Records or calendar write re-reads its run's authority
 *  (`localMutations`), and a webhook run's is its door: before this, every such approval was refused
 *  ("no live bearer resolver exists for approval source 'webhook/anonymous'"; D-339 slice 2, live).
 *  Slice B4 does the same for a reception form's run, whose door its runner reads. */

import type { ExecutionSource, IngredientManifest } from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import {
  createApprovalResumeAuthorityResolver,
  type ApprovalResumeAuthorityResolverDeps,
} from '../approval-resume-authority.js';

const NOW = 1_800_000_000_000;

const door = (contract_id: string, over: Record<string, unknown> = {}) => ({
  contract_id,
  grant_kind: 'standing',
  status: 'active',
  minted_at: NOW - 10,
  door_types: ['webhook'],
  max_risk_without_approval: 'admin',
  scope: { channels: ['webhook'], actors: ['anonymous'], ingredient_ids: ['records-notes'] },
  ...over,
});

const webhook = (contract_id?: string): ExecutionSource => ({
  channel: 'webhook', actor: 'anonymous', vendor: 'generic', webhook_secret_id: 'whi_1',
  ...(contract_id !== undefined ? { contract_id } : {}),
}) as ExecutionSource;

const manifests = { slugs: () => ['records-notes'], get: () => ({ slug: 'records-notes' } as unknown as IngredientManifest) } as
  unknown as ApprovalResumeAuthorityResolverDeps['manifests'];

const storeOf = (doors: Record<string, ReturnType<typeof door>>) => ({ get: (id: string) => (doors[id] ?? null) as never });

const resolver = (
  doors: Record<string, ReturnType<typeof door>> | undefined,
  formDoors?: Record<string, ReturnType<typeof door>>,
) => createApprovalResumeAuthorityResolver({
  manifests,
  ...(doors !== undefined ? { webhookDoors: { definitionStore: storeOf(doors) } } : {}),
  ...(formDoors !== undefined ? { receptionDoors: { definitionStore: storeOf(formDoors) as never } } : {}),
  now: () => NOW,
});

// What the local write's own check passes (`execute-handler.ts`, `ordinaryLocalMutations`).
const input = (source: ExecutionSource) => ({
  execution_source: source, required_bearer_tool_names: ['recued_runRecipe'], require_live_owner_credential: true,
});

describe('D-341 slice B2 — a webhook run resumes under its live door', () => {
  it('admits the run as it ran, with its door\'s snapshot built fresh, borrowing none of its ceiling', () => {
    const result = resolver({ 'door-1': door('door-1') }).resolve(input(webhook('door-1')));
    expect(result).toMatchObject({ admitted: true, execution_source: webhook('door-1') });
    if (!result.admitted) throw new Error('refused');
    expect(result.contract_snapshot).toMatchObject({ contract_id: 'door-1', allowed_tools: ['records-notes'] });
    // `'recipe'` — a recipe run never borrows the door's authored ceiling (D-209 §1.4, the owner's 2026-08-12 ruling).
    expect(result.contract_snapshot).not.toHaveProperty('max_risk_without_approval');
  });

  it('refuses a door revoked, expired or gone, one that is not a webhook\'s, and a door-less run', () => {
    const cases: Array<[Record<string, ReturnType<typeof door>>, ExecutionSource, string]> = [
      [{ 'door-1': door('door-1', { revoked_at: NOW - 1 }) }, webhook('door-1'), 'contract_unavailable'],
      [{ 'door-1': door('door-1', { expiry_at: NOW - 1 }) }, webhook('door-1'), 'contract_unavailable'],
      [{}, webhook('door-1'), 'contract_unavailable'],
      [{ 'door-1': door('door-1', { door_types: ['reception'] }) }, webhook('door-1'), 'door_type_denied'],
      [{ 'door-1': door('door-1') }, webhook(), 'contract_unavailable'],
    ];
    for (const [doors, source, reason] of cases) {
      expect(resolver(doors).resolve(input(source)), `${reason} ${JSON.stringify(doors)}`).toMatchObject({ admitted: false, reason });
    }
  });

  it('without the door store it refuses, as before', () => {
    expect(resolver(undefined).resolve(input(webhook('door-1')))).toMatchObject({
      admitted: false, reason: 'unsupported_source',
      detail: "no live bearer resolver exists for approval source 'webhook/anonymous'",
    });
  });

  it('leaves a reception form\'s run as it was without the form\'s door store', () => {
    expect(resolver({ 'door-1': door('door-1', { door_types: ['reception'] }) }).resolve(input(form('door-1'))))
      .toMatchObject({ admitted: false, reason: 'unsupported_source' });
  });
});

const formDoor = (contract_id: string, over: Record<string, unknown> = {}) => door(contract_id, {
  door_types: ['reception'], max_risk_without_approval: undefined,
  scope: { channels: ['reception'], actors: ['anonymous'], ingredient_ids: ['records-notes'], operation_ids: ['notes.note.create'] },
  ...over,
});

// A reception endpoint's id is base64url: it may start with `-`.
const form = (contract_id?: string): ExecutionSource => ({
  channel: 'reception', actor: 'anonymous', reception_id: '-ep_1',
  ...(contract_id !== undefined ? { contract_id } : {}),
}) as ExecutionSource;

describe('D-341 slice B4 — a reception form\'s run resumes under its live door', () => {
  it('admits the run as it ran, with its door\'s snapshot built as its runner builds it', () => {
    const result = resolver(undefined, { 'door-r1': formDoor('door-r1') }).resolve(input(form('door-r1')));
    expect(result).toMatchObject({ admitted: true, execution_source: form('door-r1') });
    if (!result.admitted) throw new Error('refused');
    expect(result.contract_snapshot).toMatchObject({ contract_id: 'door-r1', allowed_tools: ['records-notes'] });
    expect(result.contract_snapshot).not.toHaveProperty('max_risk_without_approval');
    // No standing closure unless the owner opted in at the bind, as the run's own snapshot.
    expect(result.contract_snapshot).not.toHaveProperty('standing_closure_operation_ids');
    const opted = resolver(undefined, { 'door-r1': formDoor('door-r1', { door_execution_policy: { standing_closure: true } }) })
      .resolve(input(form('door-r1')));
    expect(opted).toMatchObject({ admitted: true, contract_snapshot: { standing_closure_operation_ids: ['notes.note.create'] } });
  });

  it('refuses a door revoked, expired or gone, one that is not a form\'s, and a door-less run', () => {
    const cases: Array<[Record<string, ReturnType<typeof door>>, ExecutionSource, string]> = [
      [{ 'door-r1': formDoor('door-r1', { revoked_at: NOW - 1 }) }, form('door-r1'), 'contract_unavailable'],
      [{ 'door-r1': formDoor('door-r1', { expiry_at: NOW - 1 }) }, form('door-r1'), 'contract_unavailable'],
      [{}, form('door-r1'), 'contract_unavailable'],
      [{ 'door-r1': formDoor('door-r1', { door_types: ['webhook'] }) }, form('door-r1'), 'door_type_denied'],
      [{ 'door-r1': formDoor('door-r1') }, form(), 'contract_unavailable'],
    ];
    for (const [doors, source, reason] of cases) {
      expect(resolver(undefined, doors).resolve(input(source)), `${reason} ${JSON.stringify(doors)}`)
        .toMatchObject({ admitted: false, reason });
    }
  });

  it('a form\'s door does not admit a webhook\'s run, nor a contracted visitor\'s', () => {
    expect(resolver(undefined, { 'door-1': formDoor('door-1') }).resolve(input(webhook('door-1'))))
      .toMatchObject({ admitted: false, reason: 'unsupported_source' });
    // A contracted visitor's run has no resolver: refused as unsupported, not by a builder that throws.
    const contracted = { ...form('door-r1'), actor: 'contracted_user' } as ExecutionSource;
    expect(resolver(undefined, { 'door-r1': formDoor('door-r1') }).resolve(input(contracted)))
      .toMatchObject({ admitted: false, reason: 'unsupported_source' });
  });
});
