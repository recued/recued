/** Trusted `context.caller` projection and resolver contract. */

import { describe, expect, it } from 'vitest';
import {
  contextCallerFromExecutionSource,
  installContextCaller,
  type ContextCaller,
} from '../context.js';
import type { ExecutionSource } from '../commits.js';
import { resolveRef, type NamespaceStores } from '../resolve.js';

const storesFor = (caller: ContextCaller): NamespaceStores => ({
  vault: {},
  config: {},
  context: { caller },
  meta: {},
  step: {},
});

describe('context.caller projection', () => {
  it('exposes only channel, actor, and the authenticated contract id', () => {
    const source: ExecutionSource = {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-private',
      tool_call_id: 'call-private',
      mcp_token_id: 'token-private',
      contract_id: 'ct_project_staff',
    };

    const caller = contextCallerFromExecutionSource(source);

    expect(caller).toEqual({
      channel: 'mcp',
      actor: 'contracted_user',
      contract_id: 'ct_project_staff',
    });
    expect(caller).not.toHaveProperty('agent_id');
    expect(caller).not.toHaveProperty('tool_call_id');
    expect(caller).not.toHaveProperty('mcp_token_id');
    expect(resolveRef('{{context.caller.contract_id}}', storesFor(caller)))
      .toBe('ct_project_staff');
  });

  it('keeps the authority projection immutable through exact-object refs', () => {
    const caller = contextCallerFromExecutionSource({
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-private',
      tool_call_id: 'call-private',
      mcp_token_id: 'token-private',
      contract_id: 'ct_project_staff',
    });
    const resolved = resolveRef(
      '{{context.caller}}',
      storesFor(caller),
    ) as ContextCaller;

    // Exact object refs deliberately preserve value types and identity. The
    // host-owned caller projection therefore has to defend itself: an
    // in-process consumer must not be able to rewrite what a later recipe
    // condition reads as the authenticated contract.
    expect(resolved).toBe(caller);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Reflect.set(resolved, 'contract_id', 'ct_forged')).toBe(false);
    expect(caller.contract_id).toBe('ct_project_staff');
  });

  it('seals the caller property against whole-context replacement or insertion', () => {
    const source: ExecutionSource = {
      channel: 'mcp',
      actor: 'contracted_user',
      agent_id: 'agent-private',
      tool_call_id: 'call-private',
      mcp_token_id: 'token-private',
      contract_id: 'ct_project_staff',
    };
    const context: Record<string, unknown> = {
      caller: { contract_id: 'ct_forged_before_install' },
      entity_id: 'project-1',
    };
    const installed = installContextCaller(context, source);
    const stores: NamespaceStores = {
      vault: {},
      config: {},
      context,
      meta: {},
      step: {},
    };
    const resolvedContext = resolveRef('{{context}}', stores) as Record<
      string,
      unknown
    >;

    expect(resolvedContext).toBe(context);
    expect(resolvedContext.caller).toBe(installed);
    expect(Reflect.set(resolvedContext, 'caller', {
      contract_id: 'ct_forged_after_install',
    })).toBe(false);
    expect(Reflect.deleteProperty(resolvedContext, 'caller')).toBe(false);
    expect(resolveRef('{{context.caller.contract_id}}', stores))
      .toBe('ct_project_staff');

    const sourceLessContext: Record<string, unknown> = {};
    installContextCaller(sourceLessContext);
    expect(Object.keys(sourceLessContext)).not.toContain('caller');
    expect(resolveRef('{{context.caller}}', {
      ...stores,
      context: sourceLessContext,
    })).toBeUndefined();
    expect(Reflect.set(sourceLessContext, 'caller', {
      contract_id: 'ct_inserted',
    })).toBe(false);
  });

  it('omits contract_id for an unrestricted execution source', () => {
    const caller = contextCallerFromExecutionSource({
      channel: 'user',
      actor: 'user_self',
      user_id: 'local',
      client_token_id: 'paired-client',
    });

    expect(caller).toEqual({ channel: 'user', actor: 'user_self' });
    expect(resolveRef('{{context.caller.contract_id}}', storesFor(caller)))
      .toBeUndefined();
  });

  it('does not confuse an anonymous contract-less visitor with user_self', () => {
    const reception = contextCallerFromExecutionSource({
      channel: 'reception',
      actor: 'anonymous',
      reception_id: 'public-form-1',
    });
    const webhook = contextCallerFromExecutionSource({
      channel: 'webhook',
      actor: 'anonymous',
      vendor: 'example',
      webhook_secret_id: 'ingress-1',
    });

    expect(reception).toEqual({ channel: 'reception', actor: 'anonymous' });
    expect(webhook).toEqual({ channel: 'webhook', actor: 'anonymous' });
    expect(reception.actor).not.toBe('user_self');
    expect(webhook.actor).not.toBe('user_self');
    expect(reception.contract_id).toBeUndefined();
    expect(webhook.contract_id).toBeUndefined();
  });
});
