/**
 * Full-app webclient render harness (Playwright e2e, "Path B" — fake transport).
 *
 * The whole PWA — every IA route — dispatches INSIDE the paired bootstrap, so a
 * cold staging load (no paired recued-server) only ever shows the pair-form
 * (staging-smoke.spec covers that). The REAL end-to-end (a booted server + the
 * pair→WS handshake) lives in `recued-substrate-bench/review-render/render.mjs`
 * and produces the populated screenshots; that rig proves the data-render path.
 *
 * This harness is the REPEATABLE, server-free twin: it boots the SAME app the
 * bootstrap dispatches — `bootstrapWebclient` — but against the deterministic
 * fakes the `src/__tests__/webclient-bootstrap.test.ts` suite already proves
 * boot the full shell (a paired in-memory local store, an echo token store, a
 * loopback WS transport, a manual hash source). No crypto pairing, no network,
 * no server. It's the jsdom bootstrap acceptance lifted into a real Chromium —
 * real CSS, real layout, screenshottable — so `full-app.spec.ts` can drive each
 * route hash and assert it MOUNTS + RENDERS without throwing.
 *
 * Scope, honestly: the fake transport's `send` is a no-op (verbatim from the
 * unit suite), so route rpcs never resolve — routes render their real shell +
 * chrome + loading placeholders, NOT populated data. Mount + real-browser render
 * + client-side interaction (drawer, tabs) is exactly what this proves; the
 * populated visual pass is render.mjs's job. The route-root marker
 * (`data-recued-<route>-route`) is stamped synchronously by every route the
 * instant it mounts — before any rpc — so it is the durable "this route mounted"
 * signal (the same contract the unit suite asserts).
 *
 * `window.__app` exposes the drive hooks the spec uses:
 *   - `ready`          — true once `bootstrapWebclient` resolved.
 *   - `setHash(hash)`  — drive navigation (fires the hash listener → re-mount).
 *   - `activeRoute()`  — the bootstrap's tracked active route id.
 *   - `fireMessage(m)` — inject an inbound WS frame (e.g. a server_heartbeat).
 */
import {
  bootstrapWebclient,
  type WebclientHashSource,
} from '../../src/webclient-bootstrap.js';
import type {
  WebclientLocalKey,
  WebclientLocalStorage,
  WebclientTokenRecord,
} from '@recued/contracts';
import type { WebclientLocalStore } from '../../src/storage/local-store.js';
import type {
  WebclientTokenStore,
  WebclientTokenAad,
} from '../../src/storage/token-store.js';
import type {
  WebclientWsState,
  WebclientWsTransport,
} from '../../src/realtime/ws-client.js';

// ──────────────────────────────────────────────────────────────────
// Fakes — ported verbatim from webclient-bootstrap.test.ts (the shapes
// that suite proves boot the full app). Only the import depth changed
// (`../` → `../../src/`); the semantics are identical so the browser boot
// matches the jsdom acceptance byte-for-byte.
// ──────────────────────────────────────────────────────────────────

const FIXED_NOW = 1_700_000_000_000;

const sampleToken = (token_id = 'tok-abc'): WebclientTokenRecord => ({
  token_id,
  ciphertext_b64: 'ZmFrZS1jaXBoZXJ0ZXh0', // base64('fake-ciphertext')
  iv_b64: 'ZmFrZS1pdg==', // base64('fake-iv')
  issued_at: FIXED_NOW,
});

const buildPairedStore = (): WebclientLocalStore => {
  const data: Partial<WebclientLocalStorage> = {
    server_url: 'wss://alice.recued.cloud:8443/ws',
    server_public_key: 'spki-base64',
    webclient_token: sampleToken(),
    pair_metadata: {
      paired_at: FIXED_NOW,
      server_passport_fingerprint: 'fp',
      server_handle_at_pair: 'alice',
    },
    cert_pin_state: null,
  };
  return {
    async get<K extends WebclientLocalKey>(key: K) {
      return (data[key] ?? null) as WebclientLocalStorage[K] | null;
    },
    async set<K extends WebclientLocalKey>(key: K, value: WebclientLocalStorage[K]) {
      (data as Record<string, unknown>)[key] = value;
    },
    async remove(key) {
      delete data[key];
    },
    async inspect() {
      return {
        server_url: data.server_url ?? null,
        webclient_token: data.webclient_token ?? null,
        server_public_key: data.server_public_key ?? null,
        pair_metadata: data.pair_metadata ?? null,
        cert_pin_state: data.cert_pin_state ?? null,
      };
    },
    async clear() {
      for (const k of Object.keys(data)) delete (data as Record<string, unknown>)[k];
    },
  };
};

const buildFakeTokenStore = (): WebclientTokenStore => ({
  async wrap() {
    throw new Error('not used');
  },
  async unwrap(record: WebclientTokenRecord, _aad: WebclientTokenAad) {
    return `bearer-${record.token_id}`;
  },
});

interface FakeTransportControls {
  transport: WebclientWsTransport;
  fireMessage(message: unknown): void;
}

const buildFakeTransport = (): FakeTransportControls => {
  const states = new Set<(s: WebclientWsState) => void>();
  const messages = new Set<(m: unknown) => void>();
  return {
    transport: {
      async open() {
        // Mirror the production transport's handshake-complete signal so the
        // connection chip / server pill render a `connected` frame.
        for (const l of [...states]) l('connected');
      },
      async close() {
        /* no-op */
      },
      async send() {
        // No-op — route rpcs stay pending (routes render their loading shell).
        // This is the unit suite's shape; answering rpcs is render.mjs's job.
      },
      onMessage(listener) {
        messages.add(listener);
        return () => messages.delete(listener);
      },
      onState(listener) {
        states.add(listener);
        return () => states.delete(listener);
      },
    },
    fireMessage: (msg) => {
      for (const l of [...messages]) l(msg);
    },
  };
};

interface BrowserHashSource extends WebclientHashSource {
  setHash(hash: string): void;
}

// A REAL bridge to `window.location.hash` + the native `hashchange` event —
// i.e. what the production webclient hash source does. In a real Chromium this
// is both faithful AND makes anchor navigation (the drawer's `<a href="#data">`
// links) work for free: clicking one updates `location.hash`, the browser fires
// `hashchange`, and the bootstrap's listener re-mounts. `setHash` (the Playwright
// drive hook) just sets `location.hash`, which fires the same event — so a route
// change lands whether it was driven programmatically or by a real click. The
// unit suite's isolated fake hash source can't observe href navigation, which is
// why it only ever drives via `setHash`; here the bridge covers both paths.
const buildBrowserHashSource = (): BrowserHashSource => {
  const listeners = new Set<(h: string) => void>();
  window.addEventListener('hashchange', () => {
    const hash = window.location.hash;
    for (const l of [...listeners]) l(hash);
  });
  return {
    getHash: () => window.location.hash,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setHash(hash) {
      // Fires the native `hashchange` → the registered listeners above.
      window.location.hash = hash;
    },
  };
};

// ──────────────────────────────────────────────────────────────────
// Window drive bridge
// ──────────────────────────────────────────────────────────────────

interface FullAppHooks {
  ready: boolean;
  setHash(hash: string): void;
  activeRoute(): string;
  fireMessage(message: unknown): void;
}

declare global {
  interface Window {
    __app: FullAppHooks;
  }
}

const root = document.getElementById('root');
if (root === null) throw new Error('full-app harness: #root missing');

const localStore = buildPairedStore();
const tokenStore = buildFakeTokenStore();
const transport = buildFakeTransport();
// Real `location.hash` bridge — the harness page loads with no fragment, so the
// bootstrap resolves the default landing (chat); the spec drives every other
// route via `window.__app.setHash` (and the drawer test via real anchor clicks).
const hashSource = buildBrowserHashSource();

void (async (): Promise<void> => {
  try {
    const handle = await bootstrapWebclient({
      root,
      localStore,
      tokenStore,
      transport: transport.transport,
      exposureProfile: 'community-shareable',
      hashSource,
      document,
      now: () => FIXED_NOW,
      // Bespoke composition, no server to answer `passport.fetch` — the interface
      // documents opting out here for exactly this case (the verify pipeline is a
      // fire-and-forget round-trip that has nothing to talk to on the fake).
      enablePassportFetchVerify: false,
    });

    window.__app = {
      ready: true,
      setHash: (hash) => hashSource.setHash(hash),
      activeRoute: () => handle.activeRoute(),
      fireMessage: (message) => transport.fireMessage(message),
    };
  } catch (err) {
    // Surface a boot failure as an uncaught error so the spec's `pageerror` gate
    // reports the real message — an unhandled rejection would otherwise manifest
    // only as a vague `waitForFunction(() => __app.ready)` timeout.
    setTimeout(() => {
      throw err;
    });
  }
})();
