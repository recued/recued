import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_REVIEW_DOCUMENT_LIMIT, type BridgeCapabilityProfile } from '@recued/contracts';
import { createBridgeRegistry, buildContextBridge } from '../bridges/registry.js';
import { createBridgeDispatcher, createBridgeResultListener, type DispatchRequest } from '../bridges/dispatcher.js';
import { handleBridgeCapabilityProfilePush } from '../bridge-capability-handler.js';

const document = { tab_id: 1, document_id: 'chrome-document-1', url: 'https://example.test/draft' };
const profile: BridgeCapabilityProfile = { software_version: '1', chrome_version: '120', permissions_granted: ['scripting', 'tabs'],
  granted_origins: ['https://example.test/*'], offscreen_supported: false, alarms_supported: true,
  dom_documents: { version: 1, documents: [document] } };
const request: DispatchRequest = { recipe_run_id: 'actual-run', step_id: 'write',
  ingredient: { publisher_id: 'core', slug: 'dom-write', version: '1', surface_kind: 'authoring',
    domain_allowlist: ['https://example.test/*'], domain_allowlist_signature: '' },
  action: 'fill', args: { selector: '#draft', value: 'Reviewed' }, expects_output_keys: ['filled'], idempotency_key: 'actual-iteration' };
const registryWithDocument = () => {
  const registry = createBridgeRegistry();
  registry.attach({ client_token_id: 'paired-browser', session_id: 'socket-1', online_since: 1, last_seen_at: 1, capabilities: profile });
  return registry;
};

describe('D-261 browser document boundary', () => {
  it.each([null, { version: 2, documents: [] }, { version: 1, documents: [{ ...document, tab_id: -1 }] },
    { version: 1, documents: [{ ...document, url: 'file:///private' }] }, { version: 1, documents: [{ ...document, approved: true }] },
    { version: 1, documents: [document, document] }, { version: 1, documents: Array(BRIDGE_REVIEW_DOCUMENT_LIMIT + 1).fill(document) }])(
    'rejects an invalid authenticated inventory before updating the registry: %j', dom_documents => {
      const registry = registryWithDocument();
      expect(() => handleBridgeCapabilityProfilePush({ registry }, 'paired-browser',
        { profile: { ...profile, dom_documents } } as never)).toThrow('document inventory is invalid');
      expect(registry.documents!('paired-browser')).toEqual([document]);
    });

  it('keeps document metadata out of all public presence projections and isolates returned snapshots', () => {
    const registry = registryWithDocument();
    expect(registry.list()[0]!.capabilities.dom_documents).toBeUndefined();
    expect(buildContextBridge(registry).capabilities?.dom_documents).toBeUndefined();
    registry.documents!('paired-browser')[0]!.document_id = 'caller-changed-copy';
    expect(registry.documents!('paired-browser')).toEqual([document]);
    registry.detach('paired-browser'); expect(registry.documents!('paired-browser')).toEqual([]);
    registry.attach({ client_token_id: 'paired-browser', session_id: 'socket-2', online_since: 2, last_seen_at: 2,
      capabilities: { ...profile, dom_documents: undefined } });
    expect(registry.documents!('paired-browser')).toEqual([]);
  });

  it('checks the live claim again after queue-full and retires command ownership when it loses', async () => {
    const registry = registryWithDocument(); const listener = createBridgeResultListener();
    const send = vi.fn(async () => ({ ok: false, reason: 'queue_full' as const }));
    const dispatcher = createBridgeDispatcher({ registry, listener, transport: { send, cancel: async () => ({ ok: true }) },
      generateCommandId: () => 'command-1', sleep: async () => {} });
    let checks = 0;
    await expect(dispatcher.dispatch(request, { binding: { client_token_id: 'paired-browser', document },
      beforeSend: async () => { if (++checks === 2) throw new Error('Owner revoked this attempt'); } })).rejects.toThrow('Owner revoked');
    expect(send).toHaveBeenCalledTimes(1); expect(checks).toBe(2);
    expect(dispatcher.canResolve('command-1', 'paired-browser')).toBe(false); listener.clear?.();
  });

  it('refuses another document or browser even when an ordinary target lookup could use it', async () => {
    const registry = registryWithDocument(); const listener = createBridgeResultListener();
    const send = vi.fn(async () => ({ ok: true }));
    const dispatcher = createBridgeDispatcher({ registry, listener, transport: { send, cancel: async () => ({ ok: true }) } });
    const binding = dispatcher.describeDocument!(request)!;
    registry.detach('paired-browser');
    registry.attach({ client_token_id: 'replacement-browser', session_id: 'replacement-socket', online_since: 2, last_seen_at: 2, capabilities: profile });
    expect(dispatcher.describeDocument!(request)?.client_token_id).toBe('replacement-browser');
    await expect(dispatcher.dispatch(request, { binding, beforeSend: async () => {} })).rejects.toMatchObject({ code: 'preapproval_stale' });
    expect(send).not.toHaveBeenCalled(); listener.clear?.();
  });
});
