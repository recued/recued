import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { createReceptionPortHandler } from '../../../backend/server/src/ports/reception/handler.js';
import { createReceptionRateLimiter } from '../../../backend/server/src/ports/reception/rate-limiter.js';
import { createReceptionRegistryCache } from '../../../backend/server/src/ports/reception/registry-cache.js';
import { computeBearerHmac, deriveReceptionPepper } from '../../../backend/server/src/ports/reception/server-secret-pepper.js';
import { createPublicEndpointRegistryStore } from '../../../backend/server/src/storage/public-endpoint-registry-store.js';
import { ensureReceptionSchema } from '../../../backend/server/src/storage/reception-store.js';

test.use({ javaScriptEnabled: false, viewport: { width: 1280, height: 620 } });

const now = Date.UTC(2026, 10, 24, 16);
const bearer = 'closed-link-fixture';
const displayName = 'Fixture Studio';
const linkKinds = [
  ['intake', 'intake_form', { packet_kind: 'intake_form_packet', source_query_ref: { kind: 'reception_form_definition', form_definition_id: 'fixture-form' } }],
  ['scheduling', 'scheduling_link', { packet_kind: 'scheduling_link_packet', source_query_ref: { kind: 'data.calendar.combined' } }],
  ['drop', 'drop_link', { packet_kind: 'drop_link_packet', source_query_ref: { kind: 'reception_drop_config', drop_config_id: 'fixture-drop' } }],
  ['status', 'status_link', { packet_kind: 'status_link_packet', source_query_ref: { kind: 'data.event', event_id: 'fixture-event' } }],
  ['approve', 'approval_link', { packet_kind: 'approval_link_packet', source_query_ref: { kind: 'reception_approval_intent', intent_id: 'fixture-approval' } }],
] as const;

const startClosedLinks = async () => {
  const db = new Database(':memory:');
  ensureReceptionSchema(db);
  const registry = createPublicEndpointRegistryStore(db);
  const cache = createReceptionRegistryCache();
  const limiter = createReceptionRateLimiter({ db });
  const pepper = deriveReceptionPepper(Buffer.alloc(32, 0x4a));
  const createdAt = now - 3_600_000;
  const links = linkKinds.flatMap(([slug, kind, packetDeclaration]) =>
    (['expired', 'revoked'] as const).map(state => {
      const endpointId = `fixture-${slug}-${state}`;
      registry.create({
        endpoint_id: endpointId,
        kind,
        packet_declaration: packetDeclaration,
        bearer_secret_hmac: computeBearerHmac(bearer, pepper),
        created_at: createdAt,
        created_by_client_id: 'fixture',
        expires_at: state === 'expired' ? now - 1 : now + 3_600_000,
        long_lived_acknowledged_at: null,
        metadata: { display_name: displayName },
      });
      registry.enable(endpointId, createdAt);
      if (state === 'revoked') registry.revoke({ endpoint_id: endpointId, now, reason: 'Fixture' });
      return { label: `${slug} ${state}`, path: `/reception/${slug}/${endpointId}?t=${bearer}` };
    }),
  );
  const handler = createReceptionPortHandler({
    getStore: () => registry,
    getCache: () => cache,
    getRateLimiter: () => limiter,
    getPepper: () => pepper,
    now: () => now,
  });
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unavailable link listener did not start');
  return {
    links: links.map(({ label, path }) => ({ label, url: `http://127.0.0.1:${address.port}${path}` })),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
    },
  };
};

test('expired and revoked public links show the same unavailable page', async ({ page }) => {
  const reception = await startClosedLinks();
  try {
    let unavailableHtml: string | undefined;
    for (const { label, url } of reception.links) {
      const response = await page.goto(url);
      expect(response?.status(), label).toBe(410);
      expect(await response?.headerValue('content-type'), label).toBe('text/html; charset=utf-8');
      expect(await response?.headerValue('cache-control'), label).toBe('no-store');
      expect(await response?.headerValue('referrer-policy'), label).toBe('no-referrer');
      await expect(page.getByRole('heading', { name: 'This link is unavailable', level: 1 })).toBeVisible();
      await expect(page.getByText('Ask the sender for a new link.', { exact: true })).toBeVisible();
      const html = await response!.text();
      unavailableHtml ??= html;
      expect(html, label).toBe(unavailableHtml);
    }
    expect(unavailableHtml).not.toContain(displayName);
    expect(unavailableHtml).not.toContain(bearer);
  } finally {
    await reception.close();
  }
});
