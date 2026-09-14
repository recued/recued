/** Production shell and routes, with only pairing and transport replaced. */
import { bootstrapWebclient, type BootstrapWebclientOptions } from '../../src/webclient-bootstrap.js';
import { createInMemoryWebclientLocalStore } from '../../src/storage/local-store.js';
import type { WebclientWsTransport, WebclientWsState } from '../../src/realtime/ws-client.js';
import { HARNESS_SERVER_PUBLIC_KEY } from './server-identity.js';

const messages = new Set<(message: unknown) => void>();
const states = new Set<(state: WebclientWsState) => void>();
const transport: WebclientWsTransport = {
  async open() { for (const state of states) state('connected'); },
  async close() {},
  onMessage(listener) { messages.add(listener); return () => messages.delete(listener); },
  onState(listener) { states.add(listener); return () => states.delete(listener); },
  async send(payload) {
    const rpc = payload as { type: string; request_id: string; method: string; args?: unknown };
    if (rpc.type !== 'rpc') return;
    // Unrelated shell inventories are left pending, as in full-app-harness.
    if (!/^(chat\.|data\.file\.|collection\.(list|get|connection.list)|recipe.list$|server.getLLMConfig$|prefs.get$)/.test(rpc.method)) return;
    const response = await fetch('/existing-files-rpc', { method: 'POST', body: JSON.stringify({ method: rpc.method, args: rpc.args ?? {} }) });
    const envelope = await response.json() as { result?: unknown; error?: string };
    for (const listener of messages) listener({ type: 'rpc_result', request_id: rpc.request_id,
      ...(envelope.error ? { error: { code: 'bad_request', message: envelope.error } } : { result: envelope.result }) });
  },
};
const hashListeners = new Set<(hash: string) => void>();
window.addEventListener('hashchange', () => { for (const listener of hashListeners) listener(location.hash); });
const token = { token_id: 'fixture', ciphertext_b64: 'ZmFrZQ==', iv_b64: 'ZmFrZQ==', issued_at: Date.now() };
const options: BootstrapWebclientOptions = { root: document.getElementById('app')!, document, transport,
  localStore: createInMemoryWebclientLocalStore({ server_url: 'wss://fixture.invalid/ws', server_public_key: HARNESS_SERVER_PUBLIC_KEY,
    webclient_token: token, pair_metadata: { paired_at: Date.now(), server_passport_fingerprint: 'fixture', server_handle_at_pair: 'fixture', instance_id: 'file-browser' }, cert_pin_state: null }),
  tokenStore: { wrap: async () => token, unwrap: async () => 'fixture-bearer' },
  hashSource: { getHash: () => location.hash, setHash: hash => { location.hash = hash; },
    onChange: listener => { hashListeners.add(listener); return () => hashListeners.delete(listener); } },
  exposureProfile: 'community-shareable', enablePassportFetchVerify: false,
};
let app = await bootstrapWebclient(options);
Object.assign(window, { queueTestEvent: (event: unknown) => { for (const listener of messages) listener(event); },
  fileTestReconnect: () => { for (const state of states) state('disconnected'); for (const state of states) state('connected'); },
  fileTestRePair: async () => {
    const recovery = app.captureRecoverySnapshot(); await app.dispose();
    app = await bootstrapWebclient({ ...options, reauthRecovery: recovery });
  },
});
document.body.setAttribute('data-ready', 'true');
