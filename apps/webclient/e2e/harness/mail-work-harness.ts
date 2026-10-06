import { bootstrapWebclient } from '../../src/webclient-bootstrap.js';
import { createInMemoryWebclientLocalStore } from '../../src/storage/local-store.js';
import type { WebclientWsTransport, WebclientWsState } from '../../src/realtime/ws-client.js';
import { HARNESS_SERVER_PUBLIC_KEY } from './server-identity.js';

const messages = new Set<(message: unknown) => void>();
const states = new Set<(state: WebclientWsState) => void>();
const connectionReady = new Promise<void>(resolve => {
  Object.assign(window, { mailWorkReleaseConnection: resolve });
  if (new URL(location.href).searchParams.get('hold_connection') !== '1') resolve();
});
Object.assign(window, { mailWorkTestEvent: (event: unknown) => {
  for (const listener of messages) listener(event);
} });
const transport: WebclientWsTransport = {
  async open() { await connectionReady; for (const listener of states) listener('connected'); }, async close() {},
  onMessage(listener) { messages.add(listener); return () => messages.delete(listener); },
  onState(listener) { states.add(listener); return () => states.delete(listener); },
  async send(payload) {
    const rpc = payload as { type: string; request_id: string; method: string; args?: unknown };
    if (rpc.type !== 'rpc' || !/^(mail\.|mail_fact\.|chat\.|collection\.|data.timeline$|recipe.list$|server.getLLMConfig$|prefs.get$)/u.test(rpc.method)) return;
    const response = await fetch('/mail-work-rpc', { method: 'POST', body: JSON.stringify({ method: rpc.method, args: rpc.args ?? {} }) });
    const envelope = await response.json() as { result?: unknown; error?: string };
    for (const listener of messages) listener({ type: 'rpc_result', request_id: rpc.request_id,
      ...(envelope.error ? { error: { code: 'bad_request', message: envelope.error } } : { result: envelope.result }) });
  },
};
const token = { token_id: 'fixture', ciphertext_b64: 'ZmFrZQ==', iv_b64: 'ZmFrZQ==', issued_at: Date.now() };
// No hashSource: the shell's own browser source, so Back and in-place Chat
// handoffs use the shipped History behavior rather than a harness stand-in.
await bootstrapWebclient({ root: document.getElementById('app')!, document, transport,
  localStore: createInMemoryWebclientLocalStore({ server_url: 'wss://fixture.invalid/ws', server_public_key: HARNESS_SERVER_PUBLIC_KEY,
    webclient_token: token, pair_metadata: { paired_at: Date.now(), server_passport_fingerprint: 'fixture', server_handle_at_pair: 'fixture', instance_id: 'mail-work-browser' }, cert_pin_state: null }),
  tokenStore: { wrap: async () => token, unwrap: async () => 'fixture-bearer' },
  exposureProfile: 'community-shareable', enablePassportFetchVerify: false,
});
document.body.setAttribute('data-ready', 'true');
